// Offline test of engine.js against an in-memory imitation of Filestash's files API
// (ls, cat, save classic + TUS with the same eviction rule as handler_save.go, mkdir, rm, and mv,
// which like plg_backend_samba refuses to cross shares and never replaces an existing name).
//   node test/mock.mjs
import crypto from "node:crypto";
import { config, plan, planRename, execute, removeSources, CopyError } from "../src/engine.js";

const fs = new Map(); // path -> Buffer for files, null for directories ("/x/")
const uploads = new Map(); // path -> { size, parts: [] }
const log = [];
const hooks = { onSave: () => {}, denyRm: new Set(), mvStatus: 0 };
const put = (path, buf) => fs.set(path, buf);
put("/", null);

function finalize(path) { // what Close() on the evicted chunkedUpload amounts to
    const u = uploads.get(path);
    uploads.delete(path);
    fs.set(path, Buffer.concat(u.parts));
}

const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
const err = (status, message) => json(status, { status: "error", message });

config.chunk = 1024;
config.fetch = async (url, { method = "GET", headers = {}, body = null, signal = null } = {}) => {
    signal?.throwIfAborted();
    const u = new URL(url, "http://x/");
    const action = u.pathname.split("/").pop();
    const path = u.searchParams.get("path") ?? u.searchParams.get("from");
    log.push(`${method} ${action} ${path}`);
    if (headers["X-Requested-With"] !== "XmlHttpRequest") return err(405, "Not Allowed");
    const bytes = async () => Buffer.from(await new Response(body).arrayBuffer());
    if (action === "ls") {
        if (fs.get(path) !== null) return err(404, "Not Found");
        const results = [];
        for (const [p, v] of fs) {
            if (p === path || !p.startsWith(path)) continue;
            const rest = p.slice(path.length);
            if (v === null && /^[^/]+\/$/.test(rest)) results.push({ name: rest.slice(0, -1), type: "directory", size: 0 });
            else if (v !== null && !rest.includes("/")) results.push({ name: rest, type: "file", size: v.length });
        }
        return json(200, { status: "ok", results });
    }
    if (action === "cat") {
        const v = fs.get(path);
        if (!v) return err(404, "Not Found");
        const out = path.endsWith(".svg") && v.includes("entity") ? Buffer.alloc(0) : v; // plg_security_svg
        return new Response(out, { status: 200 });
    }
    if (action === "mkdir") {
        if (fs.has(path)) return err(409, "Already exist");
        fs.set(path, null);
        return json(200, { status: "ok" });
    }
    if (action === "rm") {
        if (hooks.denyRm.has(path)) return err(403, "Permission denied");
        for (const p of [...fs.keys()]) if (p === path || (path.endsWith("/") && p.startsWith(path))) fs.delete(p);
        return json(200, { status: "ok" });
    }
    if (action === "mv") {
        const to = u.searchParams.get("to");
        if (hooks.mvStatus) return err(hooks.mvStatus, "Permission denied");
        if (path.split("/")[1] !== to.split("/")[1]) return err(501, "Not Implemented");
        if (!fs.has(path)) return err(404, "Not Found");
        if (fs.has(to)) return err(409, "Already exist");
        for (const p of [...fs.keys()]) {
            if (p !== path && !(path.endsWith("/") && p.startsWith(path))) continue;
            const v = fs.get(p);
            fs.delete(p);
            fs.set(to + p.slice(path.length), v);
        }
        return json(200, { status: "ok" });
    }
    if (action === "save" && headers["Tus-Resumable"]) {
        if (method === "POST") {
            if (uploads.has(path)) finalize(path);
            uploads.set(path, { size: Number(headers["Upload-Length"]), parts: [] });
            fs.set(path, Buffer.alloc(0)); // share.Create truncates right away
            return new Response(null, { status: 201 });
        }
        const up = uploads.get(path);
        if (!up) return err(409, "Conflict");
        const offset = up.parts.reduce((n, b) => n + b.length, 0);
        if (Number(headers["Upload-Offset"]) !== offset) return err(400, "Not Valid");
        up.parts.push(await bytes());
        const now = offset + up.parts.at(-1).length;
        if (now > up.size) { finalize(path); return err(403, "aborted - offset larger than total size"); }
        if (now === up.size) finalize(path);
        return new Response(null, { status: 204 });
    }
    if (action === "save" && method === "POST") {
        fs.set(path, await bytes());
        hooks.onSave(path);
        return json(200, { status: "ok" });
    }
    return err(404, "Not Found");
};

let failures = 0;
const check = (ok, label, extra = "") => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
    if (!ok) failures += 1;
};
const h = (b) => crypto.createHash("sha256").update(b).digest("hex");

// fixtures: two shares
put("/a/", null); put("/b/", null);
put("/a/d/", null); put("/a/d/sub/", null);
put("/a/d/small.txt", crypto.randomBytes(100));
put("/a/d/empty", Buffer.alloc(0));
put("/a/d/big.bin", crypto.randomBytes(2 * 1024 + 7)); // 3 TUS chunks
put("/a/d/exact.bin", crypto.randomBytes(2 * 1024)); // ends on a boundary
put("/a/d/sub/x.tar.gz", crypto.randomBytes(1500));
put("/a/pic.svg", Buffer.from("<svg><!-- entity --></svg>"));

// 1. plan + execute across shares
const p = await plan(["/a/d/"], "/b/", { label: "copia" });
check(p.files === 5 && p.ops[0].mkdir === "/b/d/", "plan: 5 files, mkdir first", JSON.stringify(p.ops.map((o) => o.mkdir || o.dst)));
const r = await execute(p);
const same = [...fs.keys()].filter((k) => k.startsWith("/a/d/") && fs.get(k) !== null)
    .every((k) => fs.get(k.replace("/a/", "/b/")) && h(fs.get(k)) === h(fs.get(k.replace("/a/", "/b/"))));
check(r.files === 5 && same, "execute: all files identical in /b/d/");
check(log.filter((l) => l.startsWith("PATCH save /b/d/big.bin")).length === 3, "big.bin sent as 3 TUS chunks");
check(log.filter((l) => l.startsWith("PATCH save /b/d/exact.bin")).length === 2, "exact.bin sent as 2 TUS chunks");
check(uploads.size === 0, "no TUS upload left open");

// 2. names are never reused
await execute(await plan(["/a/d/", "/a/d/small.txt"], "/b/", { label: "copia" }));
check(fs.has("/b/d (copia)/") && fs.has("/b/small.txt"), "second paste → \"d (copia)\", new file keeps its name");
await execute(await plan(["/a/d/sub/x.tar.gz", "/a/d/sub/x.tar.gz"], "/a/d/sub/", { label: "copia" }));
check(fs.has("/a/d/sub/x.tar (copia).gz") && fs.has("/a/d/sub/x.tar (copia 2).gz"), "duplicates → \"x.tar (copia).gz\", \"x.tar (copia 2).gz\"");

// 3. refusals
for (const [src, dst, code] of [["/a/d/", "/a/d/sub/", "INTO_ITSELF"], ["/a/d/", "/a/d/", "INTO_ITSELF"], ["/a/nope.txt", "/b/", "NOT_FOUND"], ["/a/d/small.txt/", "/b/", "NOT_FOUND"]]) {
    try {
        await plan([src], dst);
        check(false, `refuse ${src} → ${dst}`);
    } catch (e) {
        check(e instanceof CopyError && e.code === code, `refuse ${src} → ${dst}`, e.code);
    }
}

// 4. cancel after the first TUS chunk: file removed, writer released
put("/c/", null);
const abort = new AbortController();
try {
    await execute(await plan(["/a/d/big.bin"], "/c/"), {
        signal: abort.signal,
        onProgress: (_f, bytes) => { if (bytes > 1024 + 10) abort.abort(); },
    });
    check(false, "cancel throws");
} catch (e) {
    check(abort.signal.aborted && e.name === "AbortError", "cancel throws AbortError", e.name);
}
check(!fs.has("/c/big.bin") && uploads.size === 0, "cancelled file removed, no TUS writer left", JSON.stringify([...fs.keys()].filter((k) => k.startsWith("/c/"))));

// 5. size changed between plan and copy, both ways
for (const [label, grow] of [["file grew (TUS)", 600], ["file shrank (TUS)", -600]]) {
    const todo = await plan(["/a/d/big.bin"], "/c/");
    put("/a/d/big.bin", crypto.randomBytes(2 * 1024 + 7 + grow));
    try {
        await execute(todo);
        check(false, label);
    } catch (e) {
        check(e.code === "SIZE_MISMATCH" && !fs.has("/c/big.bin") && uploads.size === 0, `${label}: refused, nothing left`, e.code);
    }
    put("/a/d/big.bin", crypto.randomBytes(2 * 1024 + 7));
}
try {
    await execute(await plan(["/a/pic.svg"], "/c/"));
    check(false, "rewritten svg");
} catch (e) {
    check(e.code === "SIZE_MISMATCH" && !fs.has("/c/pic.svg"), "rewritten svg: refused, nothing left", e.code);
}

// 6. move = copy, then removeSources
const tree = (prefix) => [...fs.keys()].filter((k) => k.startsWith(prefix)).sort();
const mk = () => {
    put("/a/m/", null); put("/a/m/deep/", null);
    put("/a/m/one.txt", crypto.randomBytes(50));
    put("/a/m/deep/two.bin", crypto.randomBytes(3000)); // TUS
};
mk();
const original = Object.fromEntries(tree("/a/m/").filter((k) => fs.get(k)).map((k) => [k, h(fs.get(k))]));
let todo = await plan(["/a/m/"], "/b/", { move: true });
await execute(todo);
let res = await removeSources(todo);
const movedOk = Object.entries(original).every(([k, v]) => fs.get(k.replace("/a/", "/b/")) && h(fs.get(k.replace("/a/", "/b/"))) === v);
check(movedOk && tree("/a/m").length === 0 && res.kept.length === 0 && res.removed === 2, "move folder: copied identical, source gone", JSON.stringify(tree("/a/m")));
check(todo.renames === 0 && !log.some((l) => l.startsWith("POST mv")), "move across shares: never asks the backend for mv");

// a file that appears in the source during the copy is kept, with its folders
mk();
hooks.onSave = (path) => { if (path === "/c/m/one.txt") put("/a/m/deep/new.txt", Buffer.from("added meanwhile")); };
todo = await plan(["/a/m/"], "/c/", { move: true });
await execute(todo);
hooks.onSave = () => {};
res = await removeSources(todo);
check(JSON.stringify(tree("/a/m")) === JSON.stringify(["/a/m/", "/a/m/deep/", "/a/m/deep/new.txt"]) && res.removed === 2,
    "move: file added meanwhile survives, with its folders", JSON.stringify({ left: tree("/a/m"), kept: res.kept }));
for (const k of tree("/a/m")) fs.delete(k);
for (const k of tree("/c/m")) fs.delete(k);

// a source file that can't be removed is reported, the rest still goes
mk();
hooks.denyRm.add("/a/m/one.txt");
todo = await plan(["/a/m/"], "/c/", { move: true });
await execute(todo);
res = await removeSources(todo);
hooks.denyRm.clear();
check(JSON.stringify(res.kept) === JSON.stringify(["/a/m/one.txt", "/a/m/"]) && !fs.has("/a/m/deep/") && fs.has("/c/m/one.txt"),
    "move: undeletable file reported, the rest removed", JSON.stringify(res.kept));
for (const k of tree("/a/m")) fs.delete(k);

// a share itself can't be moved; copying one is fine
try {
    await plan(["/a/"], "/b/", { move: true });
    check(false, "move of a whole share refused");
} catch (e) {
    check(e.code === "SHARE_ROOT", "move of a whole share refused", e.code);
}
check((await plan(["/a/"], "/b/")).files > 0, "copy of a whole share allowed");

// 7. a move starts as one mv per source: inside one share that is all it takes
mk();
put("/a/loose.txt", Buffer.from("loose"));
put("/a/d/sub/m/", null); // a name already taken in the destination
const before = Object.fromEntries(tree("/a/m/").filter((k) => fs.get(k)).map((k) => [k, h(fs.get(k))]));
log.length = 0;
todo = await planRename(["/a/m/", "/a/loose.txt"], "/a/d/sub/", { label: "copia" });
check(todo.renames === 2 && todo.files === 0 && JSON.stringify(todo.ops.map((o) => o.dst)) === JSON.stringify(["/a/d/sub/m (copia)/", "/a/d/sub/loose.txt"]),
    "cut in one share: two renames, taken name → \"m (copia)\"", JSON.stringify(todo.ops));
const renamed = await execute(todo);
res = await removeSources(todo);
const renamedOk = Object.entries(before).every(([k, v]) => h(fs.get(k.replace("/a/m/", "/a/d/sub/m (copia)/"))) === v);
check(renamed.renamed === 2 && renamed.unsupported.length === 0 && renamedOk && tree("/a/m").length === 0 && !fs.has("/a/loose.txt") && fs.has("/a/d/sub/loose.txt"),
    "cut in one share: moved, content identical", JSON.stringify(tree("/a/d/sub/")));
check(log.filter((l) => /^(GET cat|POST save|POST rm|POST mkdir)/.test(l)).length === 0 && log.filter((l) => l.startsWith("POST mv")).length === 2 && res.removed === 0 && res.kept.length === 0,
    "cut in one share: only mv requests", JSON.stringify(log.filter((l) => !l.startsWith("GET ls"))));

// pasting a cut where it already is does nothing
todo = await planRename(["/a/d/sub/loose.txt"], "/a/d/sub/");
check(todo.ops.length === 0 && fs.has("/a/d/sub/loose.txt"), "cut pasted in its own folder: nothing to do");

// a folder can't be cut into itself, in one share either
try {
    await planRename(["/a/d/"], "/a/d/sub/");
    check(false, "cut folder into itself refused");
} catch (e) {
    check(e.code === "INTO_ITSELF", "cut folder into itself refused", e.code);
}

// a source that vanished since it was cut
try {
    await planRename(["/a/m/"], "/a/d/");
    check(false, "cut source gone refused");
} catch (e) {
    check(e.code === "NOT_FOUND", "cut source gone: refused", e.code);
}

// 8. across shares the backend answers 501: nothing changes, the sources come back for a copy
for (const k of tree("/b/m")) fs.delete(k);
mk();
log.length = 0;
const across = await execute(await planRename(["/a/m/"], "/b/"));
check(across.renamed === 0 && JSON.stringify(across.unsupported) === JSON.stringify(["/a/m/"]) && fs.has("/a/m/one.txt") && !fs.has("/b/m/"),
    "rename across shares: 501 → unsupported, nothing changed", JSON.stringify(across));
todo = await plan(across.unsupported, "/b/", { move: true });
await execute(todo);
res = await removeSources(todo);
check(fs.has("/b/m/deep/two.bin") && tree("/a/m").length === 0 && res.kept.length === 0, "… then copy + removeSources moves it");
for (const k of tree("/b/m")) fs.delete(k);

// any other mv error is an error
mk();
hooks.mvStatus = 403;
try {
    await execute(await planRename(["/a/m/"], "/a/d/"));
    check(false, "mv refused with 403 throws");
} catch (e) {
    check(e.code === "HTTP" && e.status === 403 && fs.has("/a/m/one.txt"), "mv refused with 403 throws, nothing moved", `${e.code} ${e.status}`);
}
hooks.mvStatus = 0;
for (const k of tree("/a/m")) fs.delete(k);

console.log(failures === 0 ? "ALL PASSED" : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
