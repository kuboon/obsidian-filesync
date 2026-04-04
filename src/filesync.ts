import { resolve, relative, dirname } from "@std/path";
import { walk } from "@std/fs/walk";

export interface FileMeta {
    path: string;
    mtime: number;
    size: number;
    hash: string;
}

export interface FileData {
    data: string | number[];
    mtime: number;
}

function isTextFile(path: string): boolean {
    const textExtensions = new Set([
        ".md", ".txt", ".json", ".yaml", ".yml", ".toml", ".xml",
        ".html", ".htm", ".css", ".js", ".ts", ".csv", ".svg",
        ".tex", ".bib", ".ini", ".cfg", ".conf", ".sh", ".bash",
        ".py", ".rb", ".rs", ".go", ".java", ".c", ".h", ".cpp",
        ".hpp", ".lua", ".vim", ".el", ".org", ".rst", ".adoc",
        ".log", ".env", ".gitignore", ".dockerignore",
    ]);
    const dotIdx = path.lastIndexOf(".");
    if (dotIdx === -1) return true; // no extension → treat as text
    return textExtensions.has(path.slice(dotIdx).toLowerCase());
}

export async function computeHash(data: Uint8Array): Promise<string> {
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(hashBuffer))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}

function safePath(vaultDir: string, filePath: string): string {
    const resolved = resolve(vaultDir, filePath);
    const vaultResolved = resolve(vaultDir);
    if (!resolved.startsWith(vaultResolved + "/") && resolved !== vaultResolved) {
        throw new Error(`Path traversal detected: ${filePath}`);
    }
    return resolved;
}

export async function listFiles(vaultDir: string): Promise<FileMeta[]> {
    const results: FileMeta[] = [];
    const vaultResolved = resolve(vaultDir);

    for await (const entry of walk(vaultResolved, { includeFiles: true, includeDirs: false })) {
        const relPath = relative(vaultResolved, entry.path);
        // Skip hidden files/dirs (starting with .)
        if (relPath.split("/").some((p) => p.startsWith("."))) continue;

        const stat = await Deno.stat(entry.path);
        const content = await Deno.readFile(entry.path);
        const hash = await computeHash(content);

        results.push({
            path: relPath,
            mtime: stat.mtime?.getTime() ?? 0,
            size: stat.size,
            hash,
        });
    }

    return results;
}

export async function getFileHashes(vaultDir: string): Promise<Record<string, string>> {
    const files = await listFiles(vaultDir);
    const hashes: Record<string, string> = {};
    for (const f of files) {
        hashes[f.path] = f.hash;
    }
    return hashes;
}

export async function getFile(vaultDir: string, path: string): Promise<FileData> {
    const fullPath = safePath(vaultDir, path);
    const stat = await Deno.stat(fullPath);

    if (isTextFile(path)) {
        const text = await Deno.readTextFile(fullPath);
        return { data: text, mtime: stat.mtime?.getTime() ?? 0 };
    } else {
        const bytes = await Deno.readFile(fullPath);
        return { data: Array.from(bytes), mtime: stat.mtime?.getTime() ?? 0 };
    }
}

export async function putFile(
    vaultDir: string,
    path: string,
    data: string | number[],
    mtime: number,
): Promise<void> {
    const fullPath = safePath(vaultDir, path);
    const dir = dirname(fullPath);
    await Deno.mkdir(dir, { recursive: true });

    if (typeof data === "string") {
        await Deno.writeTextFile(fullPath, data);
    } else {
        await Deno.writeFile(fullPath, new Uint8Array(data));
    }

    // Set mtime
    if (mtime > 0) {
        const mDate = new Date(mtime);
        await Deno.utime(fullPath, mDate, mDate);
    }
}

export async function deleteFile(vaultDir: string, path: string): Promise<void> {
    const fullPath = safePath(vaultDir, path);
    try {
        await Deno.remove(fullPath);
    } catch (err) {
        if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
}

export interface FileChangeEvent {
    kind: "create" | "modify" | "remove";
    path: string; // relative path
}

export async function* watchFiles(
    vaultDir: string,
): AsyncGenerator<FileChangeEvent> {
    const vaultResolved = resolve(vaultDir);
    const watcher = Deno.watchFs(vaultResolved, { recursive: true });

    for await (const event of watcher) {
        for (const absPath of event.paths) {
            const relPath = relative(vaultResolved, absPath);
            // Skip hidden files
            if (relPath.split("/").some((p) => p.startsWith("."))) continue;

            let kind: FileChangeEvent["kind"];
            if (event.kind === "create") kind = "create";
            else if (event.kind === "modify") kind = "modify";
            else if (event.kind === "remove") kind = "remove";
            else continue;

            yield { kind, path: relPath };
        }
    }
}
