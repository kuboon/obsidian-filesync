import polyfill from "node-datachannel/polyfill";
for (const prop in polyfill) {
    // @ts-ignore Applying WebRTC polyfill to globalThis
    globalThis[prop] = polyfill[prop];
}

import { loadConfig, validateConfig } from "./config.ts";
import { FileSyncPeer } from "./peer.ts";

const config = loadConfig();

// Log config (mask passphrase)
console.log("obsidian-filesync starting...");
console.log("Config:", {
    ...config,
    passphrase: config.passphrase.replace(/./g, "*"),
});

validateConfig(config);

const peer = new FileSyncPeer(config);

// Handle graceful shutdown
Deno.addSignalListener("SIGINT", () => {
    console.log("\nShutting down...");
    peer.stop();
    Deno.exit(0);
});

Deno.addSignalListener("SIGTERM", () => {
    console.log("\nShutting down...");
    peer.stop();
    Deno.exit(0);
});

await peer.start();
