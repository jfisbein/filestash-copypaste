// End-to-end test of engine.js against a live Filestash, through its HTTP API.
//
//   FILESTASH_USER=… FILESTASH_PASSWORD=… node test/e2e.mjs --base http://host:8334/ --shares one,two
//   node test/e2e.mjs --base http://host:8334/ --shares one,two <credentials-file>
//   (--label <connection> picks the login connection; default: the first in /api/config)
//
// --shares names one or two top-level folders (Samba shares) it may write in. It creates a
// scratch folder ".copypaste-test-<ts>" in each, copies and moves between them, checks every
// byte (sha256), then removes the scratch folders. The password is never printed. The
// credentials file may be "user=…" / "password=…" lines, "user:password", or two lines.
// Exit code 0 = all passed.
import fs from "node:fs";
import crypto from "node:crypto";
import { config, plan, planRename, execute, removeSources, ls, CopyError } from "../src/engine.js";

const args = process.argv.slice(2);
const opt = (name) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? undefined : args.splice(i, 2)[1];
};
const BASE = opt("base");
const LABEL = opt("label"); // the Filestash connection to log in to; default: the first one
const SHARES = (opt("shares") || "").split(",").map((s) => s.trim()).filter(Boolean);
const [credFile] = args;
if (!BASE || SHARES.length === 0 || SHARES.length > 2) {
    console.error("usage: node test/e2e.mjs --base <url> --shares <share>[,<share>] [credentials-file]");
    process.exit(2);
}
const CHUNK = 4 * 1024 * 1024; // small, so the TUS path is exercised with ~8 MB files
config.chunk = CHUNK;

// ---------------------------------------------------------------- credentials

function parseCredentials(text) {
    let user = "";
    let pass = "";
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
        const m = line.match(/^([^:=]{1,40}?)\s*[:=]\s*(.+)$/);
        if (!m) continue;
        const key = m[1].toLowerCase();
        if (!user && /(user|login|name)/.test(key)) user = m[2].trim();
        else if (!pass && /(pass|pwd|secret)/.test(key)) pass = m[2].trim();
    }
    if (!user || !pass) {
        if (lines.length === 2 && !/[:=]/.test(lines[0])) [user, pass] = lines;
        else if (lines.length === 1 && lines[0].includes(":")) {
            const i = lines[0].indexOf(":");
            [user, pass] = [lines[0].slice(0, i).trim(), lines[0].slice(i + 1).trim()];
        }
    }
    if (!user || !pass) {
        // describe the shape only, never the values
        const shape = lines.map((l) => (l.match(/^([^:=]{1,40}?)\s*[:=]/)?.[1] ?? "<no key>") + ` (${l.length} chars)`);
        throw new Error(`could not find user and password in the file; its lines: ${JSON.stringify(shape)}`);
    }
    return { user, pass };
}

function credentials() {
    if (process.env.FILESTASH_USER && process.env.FILESTASH_PASSWORD) {
        return { user: process.env.FILESTASH_USER, pass: process.env.FILESTASH_PASSWORD };
    }
    if (!credFile) throw new Error("no credentials: set FILESTASH_USER and FILESTASH_PASSWORD, or pass a credentials file");
    return parseCredentials(fs.readFileSync(credFile, "utf8"));
}

// ---------------------------------------------------------------- http

let cookie = "";
config.fetch = (url, opts = {}) => fetch(new URL(url, BASE), {
    ...opts,
    headers: { ...(opts.headers || {}), cookie },
});

async function login({ user, pass }) {
    // the login form posts to the connection it was opened for: ?label=<connection label>
    const { result } = await (await fetch(new URL("api/config", BASE))).json();
    const label = LABEL || result?.connections?.[0]?.label;
    if (!label) throw new Error("no connection in /api/config: pass --label");
    const res = await fetch(new URL(`api/session/auth/?label=${encodeURIComponent(label)}`, BASE), {
        method: "POST",
        redirect: "manual",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ user, password: pass }).toString(),
    });
    cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const session = await (await config.fetch("api/session", { headers: { "X-Requested-With": "XmlHttpRequest" } })).json();
    if (!session.result?.is_authenticated) throw new Error(`login failed for user "${user}" (HTTP ${res.status})`);
}

const H = { "X-Requested-With": "XmlHttpRequest" };
async function call(method, action, path, body = null) {
    const res = await config.fetch(`api/files/${action}?path=${encodeURIComponent(path)}`, { method, body, headers: H });
    if (!res.ok) throw new Error(`${action} ${path}: HTTP ${res.status} ${await res.text()}`);
    return res;
}
const save = (path, bytes) => call("POST", "save", path, new Blob([bytes]));
const mkdir = (path) => call("POST", "mkdir", path);
const rm = (path) => call("POST", "rm", path);
const sha = async (path) => crypto.createHash("sha256").update(Buffer.from(await (await call("GET", "cat", path)).arrayBuffer())).digest("hex");

// ---------------------------------------------------------------- helpers

let failures = 0;
function check(ok, label, extra = "") {
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
    if (!ok) failures += 1;
}

async function tree(dir) {
    const out = {};
    for (const e of await ls(dir)) {
        if (e.type === "directory") {
            for (const [k, v] of Object.entries(await tree(`${dir}${e.name}/`))) out[`${e.name}/${k}`] = v;
        } else out[e.name] = e.size;
    }
    return out;
}

async function sameContent(srcDir, dstDir) {
    const a = await tree(srcDir);
    const b = await tree(dstDir);
    const names = JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
    if (!names) return [false, `listings differ: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`];
    for (const rel of Object.keys(a)) {
        if (await sha(srcDir + rel) !== await sha(dstDir + rel)) return [false, `content differs: ${rel}`];
    }
    return [true, `${Object.keys(a).length} files, sha256 identical`];
}

// the move the UI makes: the backend's rename first, a copy for what it refuses
async function move(sources, dest) {
    const first = await execute(await planRename(sources, dest, { label: "copy" }));
    if (first.unsupported.length === 0) return { renamed: first.renamed, kept: [] };
    const todo = await plan(first.unsupported, dest, { move: true, label: "copy" });
    await execute(todo);
    const { kept } = await removeSources(todo);
    return { renamed: first.renamed, copied: todo.files, kept };
}

const rand = (n) => crypto.randomBytes(n);

// ---------------------------------------------------------------- run

const created = [];
try {
    const creds = credentials();
    await login(creds);
    console.log(`logged in as "${creds.user}" on ${BASE}`);

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    for (const share of SHARES) {
        const dir = `/${share}/.copypaste-test-${stamp}/`;
        await mkdir(dir);
        created.push(dir);
    }
    const A = created[0];
    let B = created[1];
    if (!B) {
        console.log("NOTE  only one share: the copies stay inside it, and the move across shares is skipped");
        B = `${A}dest/`;
        await mkdir(B);
    }
    console.log(`scratch folders: ${created.join(" ")}`);

    // fixtures in A
    const F = `${A}fixtures/`;
    await mkdir(F);
    await mkdir(`${F}sub/`);
    await mkdir(`${F}sub/más hondo/`);
    await save(`${F}pequeño ñ.txt`, rand(1000));
    await save(`${F}vacío.bin`, Buffer.alloc(0));
    await save(`${F}medio.bin`, rand(3 * 1024 * 1024));
    await save(`${F}grande.bin`, rand(2 * CHUNK + 12345)); // TUS, 3 chunks
    await save(`${F}exacto.bin`, rand(2 * CHUNK)); // TUS, ends on a chunk boundary
    await save(`${F}sub/dentro.txt`, rand(10));
    await save(`${F}sub/más hondo/hondo.bin`, rand(1536 * 1024));

    // 1. folder copy between shares
    const t = performance.now();
    const r1 = await execute(await plan([F], B, { label: "copy" }));
    const secs = (performance.now() - t) / 1000;
    check(r1.files === 7, "copy folder A → B: 7 files", `${(r1.bytes / 1048576).toFixed(1)} MiB in ${secs.toFixed(1)} s`);
    const [same, detail] = await sameContent(F, `${B}fixtures/`);
    check(same, "copy folder A → B: content", detail);

    // 2. the same paste again never overwrites
    await execute(await plan([F], B, { label: "copy" }));
    const namesB = (await ls(B)).map((e) => e.name).filter((n) => n.startsWith("fixtures")).sort();
    check(JSON.stringify(namesB) === JSON.stringify(["fixtures", "fixtures (copy)"]), "second paste → \"fixtures (copy)\"", JSON.stringify(namesB));

    // 3. duplicate a file in its own folder
    await execute(await plan([`${F}pequeño ñ.txt`], F, { label: "copy" }));
    const dup = (await ls(F)).some((e) => e.name === "pequeño ñ (copy).txt");
    check(dup && await sha(`${F}pequeño ñ.txt`) === await sha(`${F}pequeño ñ (copy).txt`), "duplicate in place → \"pequeño ñ (copy).txt\"");
    await rm(`${F}pequeño ñ (copy).txt`);

    // 4. a folder into itself is refused before anything is written
    try {
        await plan([F], `${F}sub/`, { label: "copy" });
        check(false, "folder into itself refused");
    } catch (err) {
        check(err instanceof CopyError && err.code === "INTO_ITSELF", "folder into itself refused", err.code);
    }

    // 5. cancel in the middle of a TUS upload: no leftover, server not stuck
    const C = `${B}cancel/`;
    await mkdir(C);
    const abort = new AbortController();
    try {
        await execute(await plan([`${F}grande.bin`], C), {
            signal: abort.signal,
            onProgress: (_files, bytes) => { if (bytes > CHUNK + 256 * 1024) abort.abort(); }, // after the first PATCH landed
        });
        check(false, "cancel during TUS upload throws");
    } catch (err) {
        check(abort.signal.aborted, "cancel during TUS upload throws", err.name);
    }
    check((await ls(C)).length === 0, "cancelled file removed", JSON.stringify((await ls(C)).map((e) => e.name)));
    await execute(await plan([`${F}grande.bin`], C));
    check(await sha(`${F}grande.bin`) === await sha(`${C}grande.bin`), "copy after a cancel works (same path, sha256 identical)");

    // 6. an SVG the server rewrites on download (plg_security_svg) must not be copied silently
    await save(`${A}drawing.svg`, Buffer.from(`<?xml version="1.0"?>\n<!-- entity -->\n<svg xmlns="http://www.w3.org/2000/svg"/>\n`));
    try {
        await execute(await plan([`${A}drawing.svg`], C));
        check(await sha(`${A}drawing.svg`) === await sha(`${C}drawing.svg`), "svg copied unchanged (server does not rewrite it)");
    } catch (err) {
        check(err instanceof CopyError && err.code === "SIZE_MISMATCH", "rewritten svg detected, not copied", err.code);
        check(!(await ls(C)).some((e) => e.name === "drawing.svg"), "no partial svg left");
    }

    // 7. move a folder between shares: the rename is refused, so copy, then remove the source
    if (created[1]) {
        const M = `${A}to-move/`;
        await mkdir(M);
        await mkdir(`${M}inner/`);
        await save(`${M}a.bin`, rand(5000));
        await save(`${M}inner/b.bin`, rand(2 * CHUNK + 1)); // TUS
        const before = [await sha(`${M}a.bin`), await sha(`${M}inner/b.bin`)];
        const moved = await move([M], B);
        const after = [await sha(`${B}to-move/a.bin`), await sha(`${B}to-move/inner/b.bin`)];
        const leftInA = (await ls(A)).some((e) => e.name === "to-move");
        check(moved.renamed === 0 && moved.copied === 2 && moved.kept.length === 0 && !leftInA && JSON.stringify(after) === JSON.stringify(before),
            "move folder A → B: copied (mv refused), identical, source removed", JSON.stringify(moved));
    }

    // 8. move inside one share: the backend's own mv, which keeps the dates
    const R = `${A}to-rename/`;
    await mkdir(R);
    await save(`${R}c.bin`, rand(7000));
    const shaR = await sha(`${R}c.bin`);
    const timeR = (await ls(R)).find((e) => e.name === "c.bin").time;
    await new Promise((done) => setTimeout(done, 2000)); // a copy would now get a visibly newer time
    const T = `${A}rename-target/`;
    await mkdir(T);
    const renamed = await move([R], T);
    const movedFile = (await ls(`${T}to-rename/`)).find((e) => e.name === "c.bin");
    check(renamed.renamed === 1 && !renamed.copied && !(await ls(A)).some((e) => e.name === "to-rename")
        && await sha(`${T}to-rename/c.bin`) === shaR, "move inside a share: renamed, source gone, sha256 identical");
    check(typeof timeR === "number" && movedFile?.time === timeR, "move inside a share keeps the modification time", `${timeR} → ${movedFile?.time}`);
} catch (err) {
    failures += 1;
    console.log(`FAIL  ${err.message}`);
} finally {
    for (const dir of created) {
        try {
            await rm(dir);
            console.log(`cleanup  removed ${dir}`);
        } catch (err) {
            console.log(`cleanup  could NOT remove ${dir}: ${err.message}`);
        }
    }
    console.log(failures === 0 ? "ALL PASSED" : `${failures} FAILED`);
    process.exit(failures === 0 ? 0 : 1);
}
