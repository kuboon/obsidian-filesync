export interface SyncPair {
    /** Folder path within the Obsidian vault (e.g. "agent-a/output") */
    vaultFolder: string;
    /** Scope name on the server (maps to a subdirectory under server's vaultDir) */
    serverScope: string;
}

export interface FileSyncSettings {
    appId: string;
    roomId: string;
    passphrase: string;
    relays: string;
    peerName: string;
    syncPairs: SyncPair[];
    autoSync: boolean;
}

export const DEFAULT_SETTINGS: FileSyncSettings = {
    appId: "obsidian-filesync",
    roomId: "",
    passphrase: "",
    relays: "wss://exp-relay.vrtmrz.net/",
    peerName: "obsidian",
    syncPairs: [],
    autoSync: true,
};

export interface FileChangeEvent {
    kind: "create" | "modify" | "remove";
    path: string;
    scope: string;
}

export interface FileData {
    data: string | number[];
    mtime: number;
}

export interface Advertisement {
    peerId: string;
    name: string;
    platform: string;
}
