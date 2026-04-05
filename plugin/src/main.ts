import { Plugin, TFile, Notice } from "obsidian";
import type { FileSyncSettings, FileChangeEvent } from "./types";
import { DEFAULT_SETTINGS } from "./types";
import { SyncEngine } from "./sync";
import { FileSyncPeer } from "./peer";
import { FileSyncSettingTab } from "./settings";

export default class FileSyncPlugin extends Plugin {
    settings!: FileSyncSettings;
    syncEngine!: SyncEngine;
    peer!: FileSyncPeer;

    async onload() {
        await this.loadSettings();

        this.syncEngine = new SyncEngine(this.app.vault, this.settings.syncPairs);
        this.peer = new FileSyncPeer(this.settings, this.syncEngine);

        this.peer.onPeerConnected = (peerId) => {
            new Notice(`FileSync: connected to ${peerId}`);
        };

        this.peer.onPeerDisconnected = (peerId) => {
            new Notice(`FileSync: disconnected from ${peerId}`);
        };

        this.addSettingTab(new FileSyncSettingTab(this.app, this));

        this.addCommand({
            id: "connect",
            name: "Connect to relay",
            callback: () => {
                if (!this.settings.roomId || !this.settings.passphrase) {
                    new Notice("FileSync: Please configure Room ID and Passphrase first");
                    return;
                }
                if (this.settings.syncPairs.length === 0) {
                    new Notice("FileSync: Please add at least one sync pair");
                    return;
                }
                this.peer.connect();
                new Notice("FileSync: Connecting...");
            },
        });

        this.addCommand({
            id: "disconnect",
            name: "Disconnect from relay",
            callback: () => {
                this.peer.disconnect();
                new Notice("FileSync: Disconnected");
            },
        });

        this.addCommand({
            id: "sync-now",
            name: "Sync now",
            callback: async () => {
                try {
                    await this.peer.triggerSync();
                    new Notice("FileSync: Sync complete");
                } catch (err) {
                    new Notice(`FileSync: ${err}`);
                }
            },
        });

        // Watch vault changes — push to ALL connected peers
        const pushChange = (file: TFile, deleted: boolean) => {
            const resolved = this.syncEngine.resolveVaultPath(file.path);
            if (!resolved) return;

            // Broadcast notification to all peers
            const event: FileChangeEvent = {
                kind: deleted ? "remove" : "modify",
                path: resolved.relativePath,
                scope: resolved.pair.serverScope,
            };
            this.peer.broadcastChange(event);

            // Push data to each peer
            for (const peerId of this.peer.connectedPeerIds) {
                const client = this.peer.getClient(peerId);
                if (!client) continue;
                this.syncEngine
                    .handleLocalChange(file, peerId, client, deleted)
                    .catch((err) => console.error(`[filesync] Push to ${peerId} failed:`, err));
            }
        };

        this.registerEvent(
            this.app.vault.on("modify", (file) => {
                if (file instanceof TFile) pushChange(file, false);
            }),
        );

        this.registerEvent(
            this.app.vault.on("create", (file) => {
                if (file instanceof TFile) pushChange(file, false);
            }),
        );

        this.registerEvent(
            this.app.vault.on("delete", (file) => {
                if (file instanceof TFile) pushChange(file, true);
            }),
        );

        // Auto-connect on load
        if (
            this.settings.autoSync &&
            this.settings.roomId &&
            this.settings.passphrase &&
            this.settings.syncPairs.length > 0
        ) {
            setTimeout(() => this.peer.connect(), 3000);
        }
    }

    onunload() {
        this.peer.disconnect();
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
        this.syncEngine.updatePairs(this.settings.syncPairs);
        this.peer.updateSettings(this.settings);
    }
}
