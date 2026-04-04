import { Plugin, TFile, Notice } from "obsidian";
import type { FileSyncSettings } from "./types";
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

        // Add settings tab
        this.addSettingTab(new FileSyncSettingTab(this.app, this));

        // Add commands
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

        // Watch vault changes and push to server
        this.registerEvent(
            this.app.vault.on("modify", (file) => {
                if (!(file instanceof TFile)) return;
                if (!this.peer.currentPeerId || !this.peer.client) return;
                this.syncEngine
                    .handleLocalChange(file, this.peer.currentPeerId, this.peer.client)
                    .catch((err) => console.error("[filesync] Push failed:", err));
            }),
        );

        this.registerEvent(
            this.app.vault.on("create", (file) => {
                if (!(file instanceof TFile)) return;
                if (!this.peer.currentPeerId || !this.peer.client) return;
                this.syncEngine
                    .handleLocalChange(file, this.peer.currentPeerId, this.peer.client)
                    .catch((err) => console.error("[filesync] Push failed:", err));
            }),
        );

        this.registerEvent(
            this.app.vault.on("delete", (file) => {
                if (!(file instanceof TFile)) return;
                if (!this.peer.currentPeerId || !this.peer.client) return;
                this.syncEngine
                    .handleLocalChange(file, this.peer.currentPeerId, this.peer.client, true)
                    .catch((err) => console.error("[filesync] Delete push failed:", err));
            }),
        );

        // Auto-connect on load
        if (this.settings.autoSync && this.settings.roomId && this.settings.passphrase && this.settings.syncPairs.length > 0) {
            // Delay to let Obsidian finish loading
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
