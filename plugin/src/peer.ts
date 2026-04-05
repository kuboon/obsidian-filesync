import { joinRoom } from "trystero/nostr";
import type { Room } from "trystero";
import {
    RPCClient,
    RPCServer,
    type Payload,
    type Request,
    type Response,
    DIRECTION_REQUEST,
    DIRECTION_RESPONSE,
} from "./rpc";
import type { FileSyncSettings, FileChangeEvent, Advertisement } from "./types";
import type { SyncEngine } from "./sync";

export class FileSyncPeer {
    private room: Room | null = null;
    private rpcClients = new Map<string, RPCClient>();
    private rpcServer = new RPCServer();
    private sendRpc!: (data: Payload, peerId?: string) => void;
    private sendNotify!: (data: FileChangeEvent, peerId?: string) => void;
    private selfId = crypto.randomUUID().slice(0, 20);

    onPeerConnected?: (peerId: string) => void;
    onPeerDisconnected?: (peerId: string) => void;

    constructor(
        private settings: FileSyncSettings,
        private syncEngine: SyncEngine,
    ) {
        this.registerRPCHandlers();
    }

    get isConnected(): boolean {
        return this.room !== null;
    }

    get connectedPeerIds(): string[] {
        return [...this.rpcClients.keys()];
    }

    getClient(peerId: string): RPCClient | undefined {
        return this.rpcClients.get(peerId);
    }

    updateSettings(settings: FileSyncSettings): void {
        this.settings = settings;
    }

    /** Register RPC handlers so other peers can call us */
    private registerRPCHandlers(): void {
        this.rpcServer.register("getFileHashes", (scope: unknown) =>
            this.syncEngine.getLocalHashesForScope(scope as string),
        );

        this.rpcServer.register("getFile", (scope: unknown, path: unknown) =>
            this.syncEngine.getLocalFile(scope as string, path as string),
        );

        this.rpcServer.register(
            "putFile",
            async (scope: unknown, path: unknown, data: unknown, mtime: unknown) => {
                await this.syncEngine.putLocalFile(
                    scope as string,
                    path as string,
                    data as string | number[],
                    mtime as number,
                );
                return { ok: true };
            },
        );

        this.rpcServer.register("deleteFile", async (scope: unknown, path: unknown) => {
            await this.syncEngine.deleteLocalFile(scope as string, path as string);
            return { ok: true };
        });
    }

    connect(): void {
        if (this.room) return;

        const relays = this.settings.relays
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);

        console.log(`[filesync] Connecting to room: ${this.settings.roomId}`);

        this.room = joinRoom(
            {
                appId: this.settings.appId,
                password: this.settings.passphrase,
                relayUrls: relays,
            },
            this.settings.roomId,
        );

        const [sendRpc, onRpc] = this.room.makeAction<Payload>("rpc");
        this.sendRpc = sendRpc as (data: Payload, peerId?: string) => void;

        const [sendAd, onAd] = this.room.makeAction<Advertisement>("ad");

        const [sendNotify, onNotify] = this.room.makeAction<FileChangeEvent>("notify");
        this.sendNotify = sendNotify as (data: FileChangeEvent, peerId?: string) => void;

        // Handle incoming RPC — dispatch to server or match to client response
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
            console.log(`[filesync] Advertisement from ${ad.name} (${peerId})`);
        });

        // Remote change notifications
        onNotify((event: FileChangeEvent, peerId: string) => {
            const client = this.rpcClients.get(peerId);
            if (!client) return;
            console.log(`[filesync] Remote notify: ${event.kind} ${event.scope}/${event.path}`);
            this.syncEngine.handleRemoteChange(event, peerId, client).catch((err) => {
                console.error(`[filesync] Failed to handle remote change:`, err);
            });
        });

        // Peer lifecycle — support multiple peers
        this.room.onPeerJoin((peerId: string) => {
            console.log(`[filesync] Peer joined: ${peerId}`);

            const client = new RPCClient((payload: Request, targetPeerId?: string) => {
                this.sendRpc(payload, targetPeerId ?? peerId);
            });
            this.rpcClients.set(peerId, client);

            (sendAd as (data: Advertisement, peerId?: string) => void)(
                {
                    peerId: this.selfId,
                    name: this.settings.peerName,
                    platform: "obsidian",
                },
                peerId,
            );

            this.onPeerConnected?.(peerId);

            if (this.settings.autoSync) {
                setTimeout(() => {
                    const c = this.rpcClients.get(peerId);
                    if (!c) return;
                    this.syncEngine.fullSync(peerId, c).catch((err) => {
                        console.error("[filesync] Auto-sync failed:", err);
                    });
                }, 2000);
            }
        });

        this.room.onPeerLeave((peerId: string) => {
            console.log(`[filesync] Peer left: ${peerId}`);
            this.rpcClients.delete(peerId);
            this.onPeerDisconnected?.(peerId);
        });

        console.log("[filesync] Connected to relay. Waiting for peers...");
    }

    disconnect(): void {
        this.room?.leave();
        this.room = null;
        this.rpcClients.clear();
        console.log("[filesync] Disconnected");
    }

    /** Broadcast a change notification to all connected peers */
    broadcastChange(event: FileChangeEvent): void {
        if (this.sendNotify) {
            this.sendNotify(event);
        }
    }

    /** Trigger full sync with all peers */
    async triggerSync(): Promise<void> {
        if (this.rpcClients.size === 0) {
            throw new Error("Not connected to any peer");
        }
        for (const [peerId, client] of this.rpcClients) {
            await this.syncEngine.fullSync(peerId, client);
        }
    }
}
