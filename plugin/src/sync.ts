import { Vault, TFile, normalizePath, Notice } from "obsidian";
import type { RPCClient } from "./rpc";
import type { SyncPair, FileChangeEvent, FileData } from "./types";

async function computeHash(data: ArrayBuffer): Promise<string> {
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(hashBuffer))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}

function isTextFile(path: string): boolean {
    const textExtensions = new Set([
        ".md", ".txt", ".json", ".yaml", ".yml", ".toml", ".xml",
        ".html", ".htm", ".css", ".js", ".ts", ".csv", ".svg",
        ".canvas",
    ]);
    const dotIdx = path.lastIndexOf(".");
    if (dotIdx === -1) return true;
    return textExtensions.has(path.slice(dotIdx).toLowerCase());
}

export class SyncEngine {
    private recentRemotePuts = new Map<string, number>();

    constructor(
        private vault: Vault,
        private pairs: SyncPair[],
    ) {}

    updatePairs(pairs: SyncPair[]): void {
        this.pairs = pairs;
    }

    // ─── Path resolution ──────────────────────────────────────────

    /** Check if a vault path belongs to any sync pair */
    resolveVaultPath(vaultPath: string): { pair: SyncPair; relativePath: string } | null {
        for (const pair of this.pairs) {
            const prefix = pair.vaultFolder.endsWith("/") ? pair.vaultFolder : pair.vaultFolder + "/";
            if (vaultPath.startsWith(prefix)) {
                return { pair, relativePath: vaultPath.slice(prefix.length) };
            }
            if (vaultPath === pair.vaultFolder) {
                return { pair, relativePath: "" };
            }
        }
        return null;
    }

    /** Convert scope + relative path to vault path */
    toVaultPath(scope: string, relativePath: string): string | null {
        const pair = this.pairs.find((p) => p.serverScope === scope);
        if (!pair) return null;
        return normalizePath(pair.vaultFolder + "/" + relativePath);
    }

    private pairForScope(scope: string): SyncPair | undefined {
        return this.pairs.find((p) => p.serverScope === scope);
    }

    // ─── Suppress echo ───────────────────────────────────────────

    markRemotePut(vaultPath: string): void {
        this.recentRemotePuts.set(vaultPath, Date.now());
    }

    shouldSuppress(vaultPath: string): boolean {
        const ts = this.recentRemotePuts.get(vaultPath);
        if (ts && Date.now() - ts < 3000) return true;
        this.recentRemotePuts.delete(vaultPath);
        return false;
    }

    // ─── RPC server methods (called by remote peers) ─────────────

    /** Serve: return hashes for a given scope */
    async getLocalHashesForScope(scope: string): Promise<Record<string, string>> {
        const pair = this.pairForScope(scope);
        if (!pair) return {};
        return this.getLocalHashes(pair);
    }

    /** Serve: return file content for a given scope + path */
    async getLocalFile(scope: string, relativePath: string): Promise<FileData> {
        const vaultPath = this.toVaultPath(scope, relativePath);
        if (!vaultPath) throw new Error(`Unknown scope: ${scope}`);

        const file = this.vault.getAbstractFileByPath(vaultPath);
        if (!(file instanceof TFile)) throw new Error(`File not found: ${vaultPath}`);

        if (isTextFile(vaultPath)) {
            const text = await this.vault.read(file);
            return { data: text, mtime: file.stat.mtime };
        } else {
            const buf = await this.vault.readBinary(file);
            return { data: Array.from(new Uint8Array(buf)), mtime: file.stat.mtime };
        }
    }

    /** Serve: write a file from remote peer */
    async putLocalFile(scope: string, relativePath: string, data: string | number[], mtime: number): Promise<void> {
        const vaultPath = this.toVaultPath(scope, relativePath);
        if (!vaultPath) throw new Error(`Unknown scope: ${scope}`);

        this.markRemotePut(vaultPath);

        if (typeof data === "string") {
            const existing = this.vault.getAbstractFileByPath(vaultPath);
            if (existing instanceof TFile) {
                await this.vault.modify(existing, data);
            } else {
                await this.vault.create(vaultPath, data);
            }
        } else {
            const binary = new Uint8Array(data).buffer;
            const existing = this.vault.getAbstractFileByPath(vaultPath);
            if (existing instanceof TFile) {
                await this.vault.modifyBinary(existing, binary);
            } else {
                await this.vault.createBinary(vaultPath, binary);
            }
        }
    }

    /** Serve: delete a file requested by remote peer */
    async deleteLocalFile(scope: string, relativePath: string): Promise<void> {
        const vaultPath = this.toVaultPath(scope, relativePath);
        if (!vaultPath) return;

        this.markRemotePut(vaultPath);
        const existing = this.vault.getAbstractFileByPath(vaultPath);
        if (existing instanceof TFile) {
            await this.vault.delete(existing);
        }
    }

    // ─── Sync orchestration (client role) ────────────────────────

    /** Full sync for all pairs with a peer */
    async fullSync(peerId: string, client: RPCClient): Promise<void> {
        for (const pair of this.pairs) {
            await this.syncPair(peerId, client, pair);
        }
    }

    /** Sync a single pair: bidirectional hash-based diff */
    async syncPair(peerId: string, client: RPCClient, pair: SyncPair): Promise<void> {
        console.log(`[filesync] Syncing: vault:${pair.vaultFolder} ↔ scope:${pair.serverScope}`);

        const [localHashes, remoteHashes] = await Promise.all([
            this.getLocalHashes(pair),
            client.call("getFileHashes", [pair.serverScope], peerId) as Promise<Record<string, string>>,
        ]);

        // Pull: remote has file we don't, or content differs
        for (const [path, remoteHash] of Object.entries(remoteHashes)) {
            if (localHashes[path] !== remoteHash) {
                await this.pullFile(peerId, client, pair, path);
            }
        }

        // Push: we have file remote doesn't
        for (const path of Object.keys(localHashes)) {
            if (!(path in remoteHashes)) {
                await this.pushFile(peerId, client, pair, path);
            }
        }

        new Notice(`FileSync: synced ${pair.vaultFolder}`);
    }

    async getLocalHashes(pair: SyncPair): Promise<Record<string, string>> {
        const hashes: Record<string, string> = {};
        const prefix = pair.vaultFolder.endsWith("/") ? pair.vaultFolder : pair.vaultFolder + "/";

        for (const file of this.vault.getFiles()) {
            if (!file.path.startsWith(prefix)) continue;
            const relativePath = file.path.slice(prefix.length);
            const content = await this.vault.readBinary(file);
            hashes[relativePath] = await computeHash(content);
        }

        return hashes;
    }

    async pullFile(peerId: string, client: RPCClient, pair: SyncPair, relativePath: string): Promise<void> {
        const fileData = (await client.call(
            "getFile",
            [pair.serverScope, relativePath],
            peerId,
        )) as FileData;

        const vaultPath = normalizePath(pair.vaultFolder + "/" + relativePath);
        console.log(`[filesync] Pull: ${vaultPath}`);

        this.markRemotePut(vaultPath);

        if (typeof fileData.data === "string") {
            const existing = this.vault.getAbstractFileByPath(vaultPath);
            if (existing instanceof TFile) {
                await this.vault.modify(existing, fileData.data);
            } else {
                await this.vault.create(vaultPath, fileData.data);
            }
        } else {
            const binary = new Uint8Array(fileData.data).buffer;
            const existing = this.vault.getAbstractFileByPath(vaultPath);
            if (existing instanceof TFile) {
                await this.vault.modifyBinary(existing, binary);
            } else {
                await this.vault.createBinary(vaultPath, binary);
            }
        }
    }

    async pushFile(peerId: string, client: RPCClient, pair: SyncPair, relativePath: string): Promise<void> {
        const vaultPath = normalizePath(pair.vaultFolder + "/" + relativePath);
        const file = this.vault.getAbstractFileByPath(vaultPath);
        if (!(file instanceof TFile)) return;

        console.log(`[filesync] Push: ${vaultPath}`);

        let data: string | number[];
        if (isTextFile(vaultPath)) {
            data = await this.vault.read(file);
        } else {
            const buf = await this.vault.readBinary(file);
            data = Array.from(new Uint8Array(buf));
        }

        await client.call("putFile", [pair.serverScope, relativePath, data, file.stat.mtime], peerId);
    }

    // ─── Local change handling (push to peers) ───────────────────

    /** Handle a vault file change — push to a specific peer */
    async handleLocalChange(
        file: TFile,
        peerId: string,
        client: RPCClient,
        deleted = false,
    ): Promise<void> {
        const resolved = this.resolveVaultPath(file.path);
        if (!resolved) return;
        if (this.shouldSuppress(file.path)) return;

        const { pair, relativePath } = resolved;

        if (deleted) {
            console.log(`[filesync] Local delete: ${file.path}`);
            await client.call("deleteFile", [pair.serverScope, relativePath], peerId);
        } else {
            await this.pushFile(peerId, client, pair, relativePath);
        }
    }

    // ─── Remote change handling (pull from peer) ─────────────────

    /** Handle a remote change notification */
    async handleRemoteChange(
        event: FileChangeEvent,
        peerId: string,
        client: RPCClient,
    ): Promise<void> {
        const vaultPath = this.toVaultPath(event.scope, event.path);
        if (!vaultPath) return;

        if (event.kind === "remove") {
            console.log(`[filesync] Remote delete: ${vaultPath}`);
            this.markRemotePut(vaultPath);
            const existing = this.vault.getAbstractFileByPath(vaultPath);
            if (existing instanceof TFile) {
                await this.vault.delete(existing);
            }
        } else {
            const pair = this.pairForScope(event.scope);
            if (!pair) return;
            await this.pullFile(peerId, client, pair, event.path);
        }
    }
}
