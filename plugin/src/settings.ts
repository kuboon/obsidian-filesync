import { App, PluginSettingTab, Setting } from "obsidian";
import type FileSyncPlugin from "./main";
import type { SyncPair } from "./types";

export class FileSyncSettingTab extends PluginSettingTab {
    plugin: FileSyncPlugin;

    constructor(app: App, plugin: FileSyncPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        // Connection settings
        containerEl.createEl("h2", { text: "Connection" });

        new Setting(containerEl)
            .setName("Room ID")
            .setDesc("Shared room identifier (must match server)")
            .addText((text) =>
                text
                    .setPlaceholder("your-room-id")
                    .setValue(this.plugin.settings.roomId)
                    .onChange(async (value) => {
                        this.plugin.settings.roomId = value;
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
            .setName("Passphrase")
            .setDesc("Shared secret for encryption (must match server)")
            .addText((text) =>
                text
                    .setPlaceholder("your-passphrase")
                    .setValue(this.plugin.settings.passphrase)
                    .onChange(async (value) => {
                        this.plugin.settings.passphrase = value;
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
            .setName("Relay URLs")
            .setDesc("Comma-separated Nostr relay URLs")
            .addText((text) =>
                text
                    .setPlaceholder("wss://exp-relay.vrtmrz.net/")
                    .setValue(this.plugin.settings.relays)
                    .onChange(async (value) => {
                        this.plugin.settings.relays = value;
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
            .setName("App ID")
            .setDesc("Application identifier (must match server)")
            .addText((text) =>
                text
                    .setValue(this.plugin.settings.appId)
                    .onChange(async (value) => {
                        this.plugin.settings.appId = value;
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
            .setName("Peer name")
            .setDesc("Display name for this device")
            .addText((text) =>
                text
                    .setPlaceholder("obsidian")
                    .setValue(this.plugin.settings.peerName)
                    .onChange(async (value) => {
                        this.plugin.settings.peerName = value;
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
            .setName("Auto sync on connect")
            .setDesc("Automatically sync when a peer connects")
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.autoSync).onChange(async (value) => {
                    this.plugin.settings.autoSync = value;
                    await this.plugin.saveSettings();
                }),
            );

        // Sync pairs
        containerEl.createEl("h2", { text: "Sync Pairs" });
        containerEl.createEl("p", {
            text: "Map vault folders to server scopes. Each pair syncs a vault folder with a directory on the server.",
            cls: "setting-item-description",
        });

        for (let i = 0; i < this.plugin.settings.syncPairs.length; i++) {
            this.renderSyncPair(containerEl, i);
        }

        new Setting(containerEl).addButton((btn) =>
            btn.setButtonText("Add sync pair").onClick(async () => {
                this.plugin.settings.syncPairs.push({
                    vaultFolder: "",
                    serverScope: "",
                });
                await this.plugin.saveSettings();
                this.display();
            }),
        );
    }

    private renderSyncPair(containerEl: HTMLElement, index: number): void {
        const pair = this.plugin.settings.syncPairs[index];

        const pairEl = containerEl.createDiv({ cls: "filesync-pair-setting" });

        new Setting(pairEl)
            .setName(`Pair ${index + 1}`)
            .addText((text) =>
                text
                    .setPlaceholder("Vault folder (e.g. agent-a)")
                    .setValue(pair.vaultFolder)
                    .onChange(async (value) => {
                        this.plugin.settings.syncPairs[index].vaultFolder = value;
                        await this.plugin.saveSettings();
                    }),
            )
            .addText((text) =>
                text
                    .setPlaceholder("Server scope (e.g. agent-a)")
                    .setValue(pair.serverScope)
                    .onChange(async (value) => {
                        this.plugin.settings.syncPairs[index].serverScope = value;
                        await this.plugin.saveSettings();
                    }),
            )
            .addButton((btn) =>
                btn
                    .setIcon("trash")
                    .setTooltip("Remove this pair")
                    .onClick(async () => {
                        this.plugin.settings.syncPairs.splice(index, 1);
                        await this.plugin.saveSettings();
                        this.display();
                    }),
            );
    }
}
