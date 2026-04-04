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
} from "./filesync.ts";
import { SyncManager } from "./sync.ts";
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
    private syncManager: SyncManager;
    private sendRpc!: (data: Payload, peerId?: string) => void;
    private sendAd!: (data: Advertisement, peerId?: string) => void;
    private selfId = crypto.randomUUID().slice(0, 20);

    constructor(private config: Config) {
        this.syncManager = new SyncManager(config.vaultDir);
        this.registerHandlers();
    }

    private registerHandlers(): void {
        this.rpcServer.register("listFiles", () => listFiles(this.config.vaultDir));

        this.rpcServer.register("getFileHashes", () =>
            getFileHashes(this.config.vaultDir),
        );

        this.rpcServer.register("getFile", (path: unknown) =>
            getFile(this.config.vaultDir, path as string),
        );

        this.rpcServer.register("putFile", async (path: unknown, data: unknown, mtime: unknown) => {
            await putFile(this.config.vaultDir, path as string, data as string | number[], mtime as number);
            return { ok: true };
        });

        this.rpcServer.register("deleteFile", async (path: unknown) => {
            await deleteFile(this.config.vaultDir, path as string);
            return { ok: true };
        });
    }

    async start(): Promise<void> {
        // Ensure vault directory exists
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

        // Set up RPC action
        const [sendRpc, onRpc] = this.room.makeAction<Payload>("rpc");
        this.sendRpc = sendRpc as (data: Payload, peerId?: string) => void;

        // Set up advertisement action
        const [sendAd, onAd] = this.room.makeAction<Advertisement>("ad");
        this.sendAd = sendAd as (data: Advertisement, peerId?: string) => void;

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

        // Handle advertisements
        onAd((ad: Advertisement, peerId: string) => {
            console.log(`[peer] Advertisement from ${ad.name} (${peerId})`);
        });

        // Set up change notification action
        const [sendNotify, onNotify] = this.room.makeAction<FileChangeEvent>("notify");

        // Handle incoming change notifications from remote peers
        onNotify((event: FileChangeEvent, peerId: string) => {
            console.log(`[peer] Change notification from ${peerId}: ${event.kind} ${event.path}`);
            this.syncManager.handleRemoteChange(peerId, event).catch((err) => {
                console.error(`[peer] Failed to handle remote change:`, err);
            });
        });

        // Wire up local change notifications to broadcast to peers
        this.syncManager.setNotifyFn((event: FileChangeEvent) => {
            sendNotify(event);
        });

        // Handle peer join
        this.room.onPeerJoin((peerId: string) => {
            console.log(`[peer] Peer joined: ${peerId}`);

            // Create RPC client for this peer
            const client = new RPCClient((payload: Request, targetPeerId?: string) => {
                this.sendRpc(payload, targetPeerId ?? peerId);
            });
            this.rpcClients.set(peerId, client);
            this.syncManager.addPeer(peerId, client);

            // Send our advertisement
            this.sendAd(
                {
                    peerId: this.selfId,
                    name: this.config.peerName,
                    platform: "filesync-server",
                },
                peerId,
            );

            // Trigger full sync after a short delay
            setTimeout(() => {
                this.syncManager.syncWithPeer(peerId).catch((err) => {
                    console.error(`[peer] Initial sync failed:`, err);
                });
            }, 2000);
        });

        // Handle peer leave
        this.room.onPeerLeave((peerId: string) => {
            console.log(`[peer] Peer left: ${peerId}`);
            this.rpcClients.delete(peerId);
            this.syncManager.removePeer(peerId);
        });

        console.log(`[peer] Connected to relay. Waiting for peers...`);

        // Start watching filesystem for changes
        this.syncManager.startWatching().catch((err) => {
            console.error(`[peer] File watcher error:`, err);
        });
    }

    stop(): void {
        this.room?.leave();
        this.room = null;
        console.log(`[peer] Disconnected`);
    }
}
