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
    private rpcClient: RPCClient | null = null;
    private rpcServer = new RPCServer();
    private connectedPeerId: string | null = null;
    private sendRpc!: (data: Payload, peerId?: string) => void;
    private sendNotify!: (data: FileChangeEvent, peerId?: string) => void;
    private selfId = crypto.randomUUID().slice(0, 20);

    onPeerConnected?: (peerId: string) => void;
    onPeerDisconnected?: (peerId: string) => void;

    constructor(
        private settings: FileSyncSettings,
        private syncEngine: SyncEngine,
    ) {}

    get isConnected(): boolean {
        return this.room !== null;
    }

    get currentPeerId(): string | null {
        return this.connectedPeerId;
    }

    get client(): RPCClient | null {
        return this.rpcClient;
    }

    updateSettings(settings: FileSyncSettings): void {
        this.settings = settings;
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

        // RPC action
        const [sendRpc, onRpc] = this.room.makeAction<Payload>("rpc");
        this.sendRpc = sendRpc as (data: Payload, peerId?: string) => void;

        // Advertisement action
        const [sendAd, onAd] = this.room.makeAction<Advertisement>("ad");

        // Notify action
        const [sendNotify, onNotify] = this.room.makeAction<FileChangeEvent>("notify");
        this.sendNotify = sendNotify as (data: FileChangeEvent, peerId?: string) => void;

        // Handle incoming RPC
        onRpc((payload: Payload, peerId: string) => {
            if (payload.direction === DIRECTION_REQUEST) {
                this.rpcServer.dispatch(payload, (resp: Response) => {
                    this.sendRpc(resp, peerId);
                });
            } else if (payload.direction === DIRECTION_RESPONSE) {
                this.rpcClient?.handleResponse(payload);
            }
        });

        // Handle advertisements
        onAd((ad: Advertisement, peerId: string) => {
            console.log(`[filesync] Advertisement from ${ad.name} (${peerId})`);
        });

        // Handle remote change notifications
        onNotify((event: FileChangeEvent, peerId: string) => {
            if (!this.rpcClient) return;
            console.log(`[filesync] Remote notify: ${event.kind} ${event.scope}/${event.path}`);
            this.syncEngine.handleRemoteChange(event, peerId, this.rpcClient).catch((err) => {
                console.error(`[filesync] Failed to handle remote change:`, err);
            });
        });

        // Peer lifecycle
        this.room.onPeerJoin((peerId: string) => {
            console.log(`[filesync] Peer joined: ${peerId}`);
            this.connectedPeerId = peerId;

            this.rpcClient = new RPCClient((payload: Request, targetPeerId?: string) => {
                this.sendRpc(payload, targetPeerId ?? peerId);
            });

            // Send our advertisement
            (sendAd as (data: Advertisement, peerId?: string) => void)(
                {
                    peerId: this.selfId,
                    name: this.settings.peerName,
                    platform: "obsidian",
                },
                peerId,
            );

            this.onPeerConnected?.(peerId);

            // Auto-sync
            if (this.settings.autoSync) {
                setTimeout(() => {
                    this.syncEngine.fullSync(peerId, this.rpcClient!).catch((err) => {
                        console.error("[filesync] Auto-sync failed:", err);
                    });
                }, 2000);
            }
        });

        this.room.onPeerLeave((peerId: string) => {
            console.log(`[filesync] Peer left: ${peerId}`);
            if (this.connectedPeerId === peerId) {
                this.connectedPeerId = null;
                this.rpcClient = null;
            }
            this.onPeerDisconnected?.(peerId);
        });

        console.log("[filesync] Connected to relay. Waiting for peers...");
    }

    disconnect(): void {
        this.room?.leave();
        this.room = null;
        this.rpcClient = null;
        this.connectedPeerId = null;
        console.log("[filesync] Disconnected");
    }

    /** Trigger full sync manually */
    async triggerSync(): Promise<void> {
        if (!this.connectedPeerId || !this.rpcClient) {
            throw new Error("Not connected to any peer");
        }
        await this.syncEngine.fullSync(this.connectedPeerId, this.rpcClient);
    }
}
