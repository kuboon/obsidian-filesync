import type { RPCClient } from "./rpc.ts";
import type { FileChangeEvent } from "./filesync.ts";
import {
    getFileHashes,
    getFile,
    putFile,
    deleteFile,
    computeHash,
    watchFiles,
} from "./filesync.ts";

type SendNotify = (event: FileChangeEvent) => void;

/** Debounce file system events to avoid duplicate processing */
class ChangeDebouncer {
    private timers = new Map<string, number>();
    private recentPuts = new Map<string, number>(); // path → timestamp of last put from remote

    constructor(private delayMs = 500) {}

    /** Mark a path as recently written by remote, so we ignore the next FS event */
    markRemotePut(path: string): void {
        this.recentPuts.set(path, Date.now());
    }

    /** Check if this FS event should be suppressed (came from our own write) */
    shouldSuppress(path: string): boolean {
        const ts = this.recentPuts.get(path);
        if (ts && Date.now() - ts < 3000) {
            return true;
        }
        this.recentPuts.delete(path);
        return false;
    }

    debounce(path: string, fn: () => void): void {
        const existing = this.timers.get(path);
        if (existing) clearTimeout(existing);
        this.timers.set(
            path,
            setTimeout(() => {
                this.timers.delete(path);
                fn();
            }, this.delayMs) as unknown as number,
        );
    }
}

export class SyncManager {
    private debouncer = new ChangeDebouncer();
    private rpcClients = new Map<string, RPCClient>();
    private notifyPeers: SendNotify | undefined;

    constructor(private vaultDir: string) {}

    addPeer(peerId: string, client: RPCClient): void {
        this.rpcClients.set(peerId, client);
    }

    removePeer(peerId: string): void {
        this.rpcClients.delete(peerId);
    }

    setNotifyFn(fn: SendNotify): void {
        this.notifyPeers = fn;
    }

    /** Full bidirectional sync with a specific peer */
    async syncWithPeer(peerId: string): Promise<void> {
        const client = this.rpcClients.get(peerId);
        if (!client) return;

        console.log(`[sync] Starting full sync with peer ${peerId}`);

        const [localHashes, remoteHashes] = await Promise.all([
            getFileHashes(this.vaultDir),
            client.call("getFileHashes", [], peerId) as Promise<Record<string, string>>,
        ]);

        // Files that exist on remote but not locally, or differ
        for (const [path, remoteHash] of Object.entries(remoteHashes)) {
            if (localHashes[path] !== remoteHash) {
                console.log(`[sync] Pulling: ${path}`);
                const fileData = (await client.call("getFile", [path], peerId)) as {
                    data: string | number[];
                    mtime: number;
                };
                this.debouncer.markRemotePut(path);
                await putFile(this.vaultDir, path, fileData.data, fileData.mtime);
            }
        }

        // Files that exist locally but not on remote → push
        for (const [path, localHash] of Object.entries(localHashes)) {
            if (!(path in remoteHashes)) {
                console.log(`[sync] Pushing: ${path}`);
                const fileData = await getFile(this.vaultDir, path);
                await client.call("putFile", [path, fileData.data, fileData.mtime], peerId);
            }
        }

        console.log(`[sync] Full sync with ${peerId} complete`);
    }

    /** Handle a change notification from a remote peer */
    async handleRemoteChange(peerId: string, event: FileChangeEvent): Promise<void> {
        const client = this.rpcClients.get(peerId);
        if (!client) return;

        if (event.kind === "remove") {
            console.log(`[sync] Remote delete: ${event.path}`);
            this.debouncer.markRemotePut(event.path);
            await deleteFile(this.vaultDir, event.path);
        } else {
            console.log(`[sync] Remote change: ${event.path}`);
            const fileData = (await client.call("getFile", [event.path], peerId)) as {
                data: string | number[];
                mtime: number;
            };
            this.debouncer.markRemotePut(event.path);
            await putFile(this.vaultDir, event.path, fileData.data, fileData.mtime);
        }
    }

    /** Watch local filesystem and push changes to all peers */
    async startWatching(): Promise<void> {
        console.log(`[sync] Watching ${this.vaultDir} for changes`);

        for await (const event of watchFiles(this.vaultDir)) {
            if (this.debouncer.shouldSuppress(event.path)) continue;

            this.debouncer.debounce(event.path, async () => {
                console.log(`[sync] Local ${event.kind}: ${event.path}`);

                // Notify all peers
                this.notifyPeers?.(event);

                // Push to all peers
                for (const [peerId, client] of this.rpcClients) {
                    try {
                        if (event.kind === "remove") {
                            await client.call("deleteFile", [event.path], peerId);
                        } else {
                            const fileData = await getFile(this.vaultDir, event.path);
                            await client.call(
                                "putFile",
                                [event.path, fileData.data, fileData.mtime],
                                peerId,
                            );
                        }
                    } catch (err) {
                        console.error(`[sync] Failed to push ${event.path} to ${peerId}:`, err);
                    }
                }
            });
        }
    }
}
