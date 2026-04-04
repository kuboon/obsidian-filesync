import { joinRoom } from "trystero/nostr";
import type { Room } from "trystero";
import type { Config } from "./config.ts";
import {
    RPCServer,
    RPCClient,
    type Payload,
    type Request,
    type Response,
    DIRECTION_REQUEST,
    DIRECTION_RESPONSE,
} from "./rpc.ts";
import {
    listFiles,
    getFileHashes,
    getFile,
    putFile,
    deleteFile,
    watchFiles,
} from "./filesync.ts";
import type { FileChangeEvent } from "./filesync.ts";

export interface Advertisement {
    peerId: string;
    name: string;
    platform: string;
}

export class FileSyncPeer {
    private room: Room | null = null;
    private rpcServer = new RPCServer();
    private rpcClients = new Map<string, RPCClient>();
    private sendRpc!: (data: Payload, peerId?: string) => void;
    private sendAd!: (data: Advertisement, peerId?: string) => void;
    private sendNotify!: (data: FileChangeEvent, peerId?: string) => void;
    private selfId = crypto.randomUUID().slice(0, 20);
    private watchedScopes = new Set<string>();

    constructor(private config: Config) {
        this.registerHandlers();
    }

    private registerHandlers(): void {
        // All RPC handlers take scope as first arg
        this.rpcServer.register("listFiles", (scope: unknown) =>
            listFiles(this.config.vaultDir, scope as string),
        );

        this.rpcServer.register("getFileHashes", (scope: unknown) =>
            getFileHashes(this.config.vaultDir, scope as string),
        );

        this.rpcServer.register("getFile", (scope: unknown, path: unknown) =>
            getFile(this.config.vaultDir, scope as string, path as string),
        );

        this.rpcServer.register(
            "putFile",
            async (scope: unknown, path: unknown, data: unknown, mtime: unknown) => {
                await putFile(
                    this.config.vaultDir,
                    scope as string,
                    path as string,
                    data as string | number[],
                    mtime as number,
                );
                this.ensureWatching(scope as string);
                return { ok: true };
            },
        );

        this.rpcServer.register("deleteFile", async (scope: unknown, path: unknown) => {
            await deleteFile(this.config.vaultDir, scope as string, path as string);
            return { ok: true };
        });
    }

    /** Start watching a scope directory for local changes if not already watching */
    private ensureWatching(scope: string): void {
        if (this.watchedScopes.has(scope)) return;
        this.watchedScopes.add(scope);

        (async () => {
            console.log(`[peer] Watching scope "${scope}" for local changes`);
            for await (const event of watchFiles(this.config.vaultDir, scope)) {
                // Broadcast change to all peers
                this.sendNotify(event);
            }
        })().catch((err) => {
            console.error(`[peer] Watch error for scope "${scope}":`, err);
            this.watchedScopes.delete(scope);
        });
    }

    async start(): Promise<void> {
        await Deno.mkdir(this.config.vaultDir, { recursive: true });

        console.log(`[peer] Joining room: ${this.config.roomId}`);
        console.log(`[peer] Relays: ${this.config.relays.join(", ")}`);
        console.log(`[peer] Vault: ${this.config.vaultDir}`);

        this.room = joinRoom(
            {
                appId: this.config.appId,
                password: this.config.passphrase,
                relayUrls: this.config.relays,
            },
            this.config.roomId,
        );

        // Set up actions
        const [sendRpc, onRpc] = this.room.makeAction<Payload>("rpc");
        this.sendRpc = sendRpc as (data: Payload, peerId?: string) => void;

        const [sendAd, onAd] = this.room.makeAction<Advertisement>("ad");
        this.sendAd = sendAd as (data: Advertisement, peerId?: string) => void;

        const [sendNotify, onNotify] = this.room.makeAction<FileChangeEvent>("notify");
        this.sendNotify = sendNotify as (data: FileChangeEvent, peerId?: string) => void;

        // Handle incoming RPC messages
        onRpc((payload: Payload, peerId: string) => {
            if (payload.direction === DIRECTION_REQUEST) {
                this.rpcServer.dispatch(payload, (resp: Response) => {
                    this.sendRpc(resp, peerId);
                });
            } else if (payload.direction === DIRECTION_RESPONSE) {
                const client = this.rpcClients.get(peerId);
                client?.handleResponse(payload);
            }
        });

        onAd((ad: Advertisement, peerId: string) => {
            console.log(`[peer] Advertisement from ${ad.name} (${peerId})`);
        });

        // Change notifications from remote peers — apply locally
        onNotify(async (event: FileChangeEvent, peerId: string) => {
            const client = this.rpcClients.get(peerId);
            if (!client) return;

            const key = `${event.scope}/${event.path}`;
            console.log(`[peer] Remote change: ${event.kind} ${key}`);

            try {
                if (event.kind === "remove") {
                    await deleteFile(this.config.vaultDir, event.scope, event.path);
                } else {
                    const fileData = (await client.call("getFile", [event.scope, event.path], peerId)) as {
                        data: string | number[];
                        mtime: number;
                    };
                    await putFile(this.config.vaultDir, event.scope, event.path, fileData.data, fileData.mtime);
                }
            } catch (err) {
                console.error(`[peer] Failed to apply remote change ${key}:`, err);
            }
        });

        // Peer lifecycle
        this.room.onPeerJoin((peerId: string) => {
            console.log(`[peer] Peer joined: ${peerId}`);

            const client = new RPCClient((payload: Request, targetPeerId?: string) => {
                this.sendRpc(payload, targetPeerId ?? peerId);
            });
            this.rpcClients.set(peerId, client);

            this.sendAd(
                {
                    peerId: this.selfId,
                    name: this.config.peerName,
                    platform: "filesync-server",
                },
                peerId,
            );
        });

        this.room.onPeerLeave((peerId: string) => {
            console.log(`[peer] Peer left: ${peerId}`);
            this.rpcClients.delete(peerId);
        });

        console.log(`[peer] Connected to relay. Waiting for peers...`);
    }

    stop(): void {
        this.room?.leave();
        this.room = null;
        console.log(`[peer] Disconnected`);
    }
}
