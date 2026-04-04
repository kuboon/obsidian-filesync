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

export interface FileChangeEvent {
    kind: "create" | "modify" | "remove";
    path: string; // relative path within the scope
    scope: string;
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
    if (dotIdx === -1) return true;
    return textExtensions.has(path.slice(dotIdx).toLowerCase());
}

export async function computeHash(data: Uint8Array): Promise<string> {
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(hashBuffer))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}

/** Resolve a scoped path, ensuring no directory traversal */
function scopedPath(vaultDir: string, scope: string, filePath: string): string {
    const scopeDir = resolve(vaultDir, scope);
    const resolved = resolve(scopeDir, filePath);
    if (!resolved.startsWith(scopeDir + "/") && resolved !== scopeDir) {
        throw new Error(`Path traversal detected: ${scope}/${filePath}`);
    }
    return resolved;
}

function scopeDir(vaultDir: string, scope: string): string {
    return resolve(vaultDir, scope);
}

export async function listFiles(vaultDir: string, scope: string): Promise<FileMeta[]> {
    const results: FileMeta[] = [];
    const baseDir = scopeDir(vaultDir, scope);

    try {
        await Deno.stat(baseDir);
    } catch {
        return results; // scope directory doesn't exist yet
    }

    for await (const entry of walk(baseDir, { includeFiles: true, includeDirs: false })) {
        const relPath = relative(baseDir, entry.path);
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

export async function getFileHashes(vaultDir: string, scope: string): Promise<Record<string, string>> {
    const files = await listFiles(vaultDir, scope);
    const hashes: Record<string, string> = {};
    for (const f of files) {
        hashes[f.path] = f.hash;
    }
    return hashes;
}

export async function getFile(vaultDir: string, scope: string, path: string): Promise<FileData> {
    const fullPath = scopedPath(vaultDir, scope, path);
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
    scope: string,
    path: string,
    data: string | number[],
    mtime: number,
): Promise<void> {
    const fullPath = scopedPath(vaultDir, scope, path);
    const dir = dirname(fullPath);
    await Deno.mkdir(dir, { recursive: true });

    if (typeof data === "string") {
        await Deno.writeTextFile(fullPath, data);
    } else {
        await Deno.writeFile(fullPath, new Uint8Array(data));
    }

    if (mtime > 0) {
        const mDate = new Date(mtime);
        await Deno.utime(fullPath, mDate, mDate);
    }
}

export async function deleteFile(vaultDir: string, scope: string, path: string): Promise<void> {
    const fullPath = scopedPath(vaultDir, scope, path);
    try {
        await Deno.remove(fullPath);
    } catch (err) {
        if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
}

export async function* watchFiles(
    vaultDir: string,
    scope: string,
): AsyncGenerator<FileChangeEvent> {
    const baseDir = scopeDir(vaultDir, scope);
    await Deno.mkdir(baseDir, { recursive: true });
    const watcher = Deno.watchFs(baseDir, { recursive: true });

    for await (const event of watcher) {
        for (const absPath of event.paths) {
            const relPath = relative(baseDir, absPath);
            if (relPath.split("/").some((p) => p.startsWith("."))) continue;

            let kind: FileChangeEvent["kind"];
            if (event.kind === "create") kind = "create";
            else if (event.kind === "modify") kind = "modify";
            else if (event.kind === "remove") kind = "remove";
            else continue;

            yield { kind, path: relPath, scope };
        }
    }
}
