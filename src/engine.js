// Copy engine of the copypaste plugin. No DOM in here, so the tests can run it under node.
//
// Every copied file goes through the client: GET /api/files/cat, then POST /api/files/save, in
// one request up to `config.chunk` bytes and as TUS chunks above that (the server pipes the
// chunks straight into the backend's Save, nothing is staged on disk). Nothing is ever
// overwritten: a name already taken in the destination gets a " (copy)" suffix.
//
// A move first asks the backend to rename (POST /api/files/mv: instant, keeps the dates). Only
// what the backend refuses with 501 Not Implemented (Samba across shares, for one) is copied,
// and removed from the source once the whole copy has succeeded.

const MiB = 1024 * 1024;
const MAX_DEPTH = 64; // a symlink loop on the backend would otherwise recurse forever

export const config = {
    fetch: (url, opts) => fetch(url, opts),
    chunk: 32 * MiB,
};

const HEADERS = {
    "X-Requested-With": "XmlHttpRequest", // SecureOrigin rejects writes without it
    "Cache-Control": "no-store",
    "Pragma": "no-cache",
};
const TUS = { "Tus-Resumable": "1.0.0" };

export class CopyError extends Error {
    constructor(code, path, detail = "", status = 0) {
        super(`${code} ${path}${detail ? ": " + detail : ""}`);
        this.code = code;
        this.path = path;
        this.detail = detail;
        this.status = status;
    }
}

// `query` is a path, or the parameters themselves ({ from, to } for mv)
async function api(method, action, query, { headers = {}, body = null, signal = null } = {}) {
    const params = typeof query === "string" ? { path: query } : query;
    const path = params.path ?? params.from;
    const search = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
    const res = await config.fetch(`api/files/${action}?${search}`, {
        method,
        body,
        signal,
        credentials: "same-origin",
        headers: { ...HEADERS, ...headers },
    });
    if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try {
            detail = (await res.json()).message || detail;
        } catch (_) {}
        throw new CopyError("HTTP", path, detail, res.status);
    }
    return res;
}

export async function ls(path, signal = null) {
    const res = await api("GET", "ls", path, { signal });
    return (await res.json()).results || [];
}

// "/a/b/c.txt" -> "a": the first folder level, which is a share on Samba
export const shareOf = (path) => path.split("/")[1] || "";

// "/a/b/" -> ["/a/", "b"], "/a/b.txt" -> ["/a/", "b.txt"]
export function splitPath(path) {
    const trimmed = path.replace(/\/$/, "");
    const i = trimmed.lastIndexOf("/");
    return [trimmed.slice(0, i + 1), trimmed.slice(i + 1)];
}

export function uniqueName(name, isDirectory, taken, label) {
    if (!taken.has(name)) return name;
    const dot = isDirectory ? -1 : name.lastIndexOf(".");
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
    for (let n = 1; ; n++) {
        const candidate = `${stem} (${label}${n > 1 ? " " + n : ""})${ext}`;
        if (!taken.has(candidate)) return candidate;
    }
}

// Checks each source and picks its name in destDir. Yields { src, isDirectory, entry, target }.
async function* resolve(sources, destDir, { signal, label, skipInPlace }) {
    const taken = new Set((await ls(destDir, signal)).map(({ name }) => name));
    const listings = new Map();
    for (const src of sources) {
        const isDirectory = src.endsWith("/");
        if (isDirectory && destDir.startsWith(src)) throw new CopyError("INTO_ITSELF", src);
        const [parent, name] = splitPath(src);
        if (skipInPlace && parent === destDir) continue;
        if (!listings.has(parent)) listings.set(parent, await ls(parent, signal));
        const entry = listings.get(parent).find((e) => e.name === name);
        if (!entry || (entry.type === "directory") !== isDirectory) throw new CopyError("NOT_FOUND", src);
        const target = uniqueName(name, isDirectory, taken, label);
        taken.add(target);
        yield { src, isDirectory, entry, target };
    }
}

// The first half of a move: one { rename, dst } per source. A source already in destDir is
// skipped, so the plan can be empty.
export async function planRename(sources, destDir, { signal = null, label = "copy" } = {}) {
    const ops = [];
    for await (const { src, isDirectory, target } of resolve(sources, destDir, { signal, label, skipInPlace: true })) {
        ops.push({ rename: src, dst: destDir + target + (isDirectory ? "/" : "") });
    }
    return { ops, files: 0, bytes: 0, renames: ops.length };
}

// Walks the sources and returns the copy operations to run, in order: { mkdir, srcDir } for
// folders, { src, dst, size } for files. Sources are Filestash paths, folders end with "/".
// With `move` (the sources are removed afterwards by removeSources), a top-level folder
// ("/name/", a share on Samba) is refused: removeSources would empty it.
export async function plan(sources, destDir, { signal = null, onScan = () => {}, label = "copy", move = false } = {}) {
    const ops = [];
    let files = 0;
    let bytes = 0;
    const addFile = (src, dst, size) => {
        ops.push({ src, dst, size });
        files += 1;
        bytes += size;
        onScan(files, bytes);
    };
    const walk = async (srcDir, dstDir, depth) => {
        if (depth > MAX_DEPTH) throw new CopyError("TOO_DEEP", srcDir);
        ops.push({ mkdir: dstDir, srcDir });
        for (const entry of await ls(srcDir, signal)) {
            if (entry.type === "directory") await walk(`${srcDir}${entry.name}/`, `${dstDir}${entry.name}/`, depth + 1);
            else addFile(srcDir + entry.name, dstDir + entry.name, entry.size);
        }
    };
    if (move) {
        const root = sources.find((src) => src.split("/").filter(Boolean).length < 2);
        if (root) throw new CopyError("SHARE_ROOT", root);
    }
    for await (const { src, isDirectory, entry, target } of resolve(sources, destDir, { signal, label, skipInPlace: false })) {
        if (isDirectory) await walk(src, `${destDir}${target}/`, 0);
        else addFile(src, destDir + target, entry.size);
    }
    return { ops, files, bytes, renames: 0 };
}

// Runs a plan. A rename the backend refuses with 501 is not an error: its source is returned in
// `unsupported`, for the caller to copy instead.
export async function execute({ ops }, { signal = null, onProgress = () => {} } = {}) {
    let files = 0;
    let bytes = 0;
    let renamed = 0;
    const unsupported = [];
    for (const op of ops) {
        signal?.throwIfAborted();
        if (op.mkdir) {
            await api("POST", "mkdir", op.mkdir, { signal });
            continue;
        }
        if (op.rename) {
            try {
                await api("POST", "mv", { from: op.rename, to: op.dst }, { signal });
            } catch (err) {
                if (err.status !== 501) throw err;
                unsupported.push(op.rename);
                continue;
            }
            renamed += 1;
            onProgress(files, bytes, op);
            continue;
        }
        await copyFile(op, signal, (n) => {
            bytes += n;
            onProgress(files, bytes, op);
        });
        files += 1;
        onProgress(files, bytes, op);
    }
    return { files, bytes, renamed, unsupported };
}

// The second half of a copy-based move, run only after execute() succeeded: deletes each copied
// file, then each source folder only if it is empty by now, deepest first. Anything that
// appeared in a source folder during the copy is kept (and listed in `kept`). Failures don't
// stop it. Renames have nothing left behind.
export async function removeSources({ ops }, { signal = null, onProgress = () => {} } = {}) {
    const kept = [];
    let removed = 0;
    for (const op of ops) {
        if (!op.src) continue;
        signal?.throwIfAborted();
        try {
            await api("POST", "rm", op.src, { signal });
            removed += 1;
            onProgress(removed);
        } catch (err) {
            if (signal?.aborted) throw err;
            kept.push(op.src);
        }
    }
    for (const op of ops.filter((o) => o.mkdir).reverse()) {
        signal?.throwIfAborted();
        try {
            if ((await ls(op.srcDir, signal)).length === 0) await api("POST", "rm", op.srcDir, { signal });
            else kept.push(op.srcDir);
        } catch (err) {
            if (signal?.aborted) throw err;
            kept.push(op.srcDir);
        }
    }
    return { removed, kept };
}

async function copyFile({ src, dst, size }, signal, onBytes) {
    const res = await api("GET", "cat", src, { signal });

    // case 1: small file, one request each way
    if (size <= config.chunk) {
        const blob = await res.blob();
        // also catches a download the server rewrote, e.g. an SVG emptied by plg_security_svg
        if (blob.size !== size) throw new CopyError("SIZE_MISMATCH", src, `${blob.size} != ${size}`);
        try {
            await api("POST", "save", dst, {
                body: new Blob([blob], { type: "application/octet-stream" }),
                signal,
            });
        } catch (err) {
            await discard(dst, false);
            throw err;
        }
        onBytes(size);
        return;
    }

    // case 2: TUS upload, fed from the download stream; memory stays around one chunk
    const reader = res.body.getReader();
    try {
        await api("POST", "save", dst, { headers: { ...TUS, "Upload-Length": String(size) }, signal });
    } catch (err) {
        reader.cancel().catch(() => {});
        throw err;
    }
    let parts = [];
    let buffered = 0;
    let offset = 0;
    const send = async (blob) => {
        if (offset + blob.size > size) throw new CopyError("SIZE_MISMATCH", src, `more than ${size}`);
        await api("PATCH", "save", dst, {
            headers: {
                ...TUS,
                "Upload-Offset": String(offset),
                "Content-Type": "application/offset+octet-stream",
            },
            body: blob,
            signal,
        });
        offset += blob.size;
    };
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            parts.push(value);
            buffered += value.byteLength;
            onBytes(value.byteLength);
            while (buffered >= config.chunk) { // chunks of exactly config.chunk bytes
                const all = new Blob(parts);
                await send(all.slice(0, config.chunk));
                const rest = all.slice(config.chunk);
                parts = [rest];
                buffered = rest.size;
            }
        }
        if (buffered > 0) await send(new Blob(parts));
        if (offset !== size) throw new CopyError("SIZE_MISMATCH", src, `${offset} != ${size}`);
    } catch (err) {
        reader.cancel().catch(() => {});
        await discard(dst, true);
        throw err;
    }
}

// Removes a half-written destination file. Runs without the abort signal, on purpose.
async function discard(dst, tus) {
    if (tus) {
        // The server still holds a writer for the unfinished upload. A new TUS creation for the
        // same path evicts it (its pipe closes and Save returns), and the empty PATCH completes the
        // new zero-length upload, so nothing is left open on the backend when rm runs.
        try {
            await api("POST", "save", dst, { headers: { ...TUS, "Upload-Length": "0" } });
            await api("PATCH", "save", dst, {
                headers: { ...TUS, "Upload-Offset": "0", "Content-Type": "application/offset+octet-stream" },
                body: new Blob([]),
            });
        } catch (_) {}
    }
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            await api("POST", "rm", dst);
            return;
        } catch (_) {
            await new Promise((done) => setTimeout(done, 500));
        }
    }
}
