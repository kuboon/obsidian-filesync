export interface Config {
    appId: string;
    roomId: string;
    passphrase: string;
    relays: string[];
    peerName: string;
    vaultDir: string;
    autoAccept: string;
}

function getEnv(key: string): string | undefined {
    return Deno.env.get(key);
}

export function loadConfig(): Config {
    return {
        appId: getEnv("FILESYNC_APPID") ?? "obsidian-filesync",
        roomId: getEnv("FILESYNC_ROOMID") ?? "",
        passphrase: getEnv("FILESYNC_PASSPHRASE") ?? "",
        relays: (getEnv("FILESYNC_RELAYS") ?? "wss://exp-relay.vrtmrz.net/")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        peerName: getEnv("FILESYNC_PEER_NAME") ?? "filesync-server",
        vaultDir: getEnv("FILESYNC_VAULT_DIR") ?? "./vault",
        autoAccept: getEnv("FILESYNC_AUTO_ACCEPT") ?? ".*",
    };
}

export function validateConfig(config: Config): void {
    if (!config.roomId) {
        throw new Error("FILESYNC_ROOMID is required");
    }
    if (!config.passphrase) {
        throw new Error("FILESYNC_PASSPHRASE is required");
    }
}
