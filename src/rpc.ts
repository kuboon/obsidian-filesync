export const DIRECTION_REQUEST = "request" as const;
export const DIRECTION_RESPONSE = "response" as const;

export interface Request {
    type: string;
    direction: typeof DIRECTION_REQUEST;
    seq: number;
    args: unknown[];
}

export interface Response {
    type: string;
    direction: typeof DIRECTION_RESPONSE;
    seq: number;
    data?: unknown;
    error?: string;
}

export type Payload = Request | Response;

export type RPCHandler = (...args: unknown[]) => Promise<unknown> | unknown;

const DEFAULT_TIMEOUT = 30_000;

export class RPCServer {
    private handlers = new Map<string, RPCHandler>();

    register(name: string, handler: RPCHandler): void {
        this.handlers.set(name, handler);
    }

    async dispatch(
        payload: Payload,
        sendResponse: (resp: Response) => void,
    ): Promise<void> {
        if (payload.direction !== DIRECTION_REQUEST) return;

        const handler = this.handlers.get(payload.type);
        if (!handler) {
            sendResponse({
                type: payload.type,
                direction: DIRECTION_RESPONSE,
                seq: payload.seq,
                error: `Unknown RPC: ${payload.type}`,
            });
            return;
        }

        try {
            const result = await handler(...payload.args);
            sendResponse({
                type: payload.type,
                direction: DIRECTION_RESPONSE,
                seq: payload.seq,
                data: result,
            });
        } catch (err) {
            sendResponse({
                type: payload.type,
                direction: DIRECTION_RESPONSE,
                seq: payload.seq,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
}

interface PendingCall {
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
    timer: number;
}

export class RPCClient {
    private seq = 0;
    private pending = new Map<number, PendingCall>();
    private sendFn: (payload: Request, peerId?: string) => void;

    constructor(sendFn: (payload: Request, peerId?: string) => void) {
        this.sendFn = sendFn;
    }

    call(
        type: string,
        args: unknown[],
        peerId?: string,
        timeout = DEFAULT_TIMEOUT,
    ): Promise<unknown> {
        const seq = ++this.seq;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(seq);
                reject(new Error(`RPC timeout: ${type} (seq=${seq})`));
            }, timeout);

            this.pending.set(seq, { resolve, reject, timer: timer as unknown as number });

            this.sendFn(
                { type, direction: DIRECTION_REQUEST, seq, args },
                peerId,
            );
        });
    }

    handleResponse(payload: Payload): boolean {
        if (payload.direction !== DIRECTION_RESPONSE) return false;

        const pending = this.pending.get(payload.seq);
        if (!pending) return false;

        clearTimeout(pending.timer);
        this.pending.delete(payload.seq);

        if (payload.error) {
            pending.reject(new Error(payload.error));
        } else {
            pending.resolve(payload.data);
        }
        return true;
    }
}
