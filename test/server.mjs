// End-to-end test of server/copyjobs.mjs against a live Filestash + Samba.
//
//   FILESTASH_USER=… FILESTASH_PASSWORD=… node test/server.mjs --base http://host:8334/ --shares one,two
//   (--label <connection> picks the login connection; default: the first in /api/config)
//
// Starts the service as a child process (port 0-ish: a random free port, small TUS chunks), logs in
// to Filestash, and drives the service over HTTP the way the plugin does, with the same cookie.
// It writes only inside a scratch folder ".copyjobs-test-<ts>" in each of the two shares and
// removes them at the end. The password is never printed. Exit code 0 = all passed.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";

const args = process.argv.slice(2);
const opt = (name) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? undefined : args.splice(i, 2)[1];
};
const BASE = opt("base");
const LABEL = opt("label");
const SHARES = (opt("shares") || "").split(",").map((s) => s.trim()).filter(Boolean);
if (!BASE || SHARES.length !== 2 || !process.env.FILESTASH_USER || !process.env.FILESTASH_PASSWORD) {
    console.error("usage: FILESTASH_USER=… FILESTASH_PASSWORD=… node test/server.mjs --base <url> --shares <a>,<b>");
    process.exit(2);
}
const ORIGIN = new URL(BASE).origin;
const CHUNK = 1024 * 1024;

let failures = 0;
function check(ok, label, extra = "") {
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
    if (!ok) failures += 1;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (n) => crypto.randomBytes(n);

// ---------------------------------------------------------------- Filestash, directly

let cookie = "";
const H = { "X-Requested-With": "XmlHttpRequest" };
const fs_ = (url, opts = {}) => fetch(new URL(url, BASE), { ...opts, headers: { ...H, ...(opts.headers || {}), cookie } });

async function login() {
    const { result } = await (await fetch(new URL("api/config", BASE))).json();
    const label = LABEL || result?.connections?.[0]?.label;
    const res = await fetch(new URL(`api/session/auth/?label=${encodeURIComponent(label)}`, BASE), {
        method: "POST",
        redirect: "manual",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ user: process.env.FILESTASH_USER, password: process.env.FILESTASH_PASSWORD }).toString(),
    });
    cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const session = await (await fs_("api/session")).json();
    if (!session.result?.is_authenticated) throw new Error("login failed");
}
const call = async (method, action, p, body = null) => {
    const res = await fs_(`api/files/${action}?path=${encodeURIComponent(p)}`, { method, body });
    if (!res.ok) throw new Error(`${action} ${p}: HTTP ${res.status} ${await res.text()}`);
    return res;
};
const save = (p, bytes) => call("POST", "save", p, new Blob([bytes]));
const mkdir = (p) => call("POST", "mkdir", p);
const rm = (p) => call("POST", "rm", p);
const ls = async (p) => (await (await call("GET", "ls", p)).json()).results || [];
const exists = async (p) => {
    const i = p.replace(/\/$/, "").lastIndexOf("/");
    return (await ls(p.slice(0, i + 1))).some((e) => e.name === p.replace(/\/$/, "").slice(i + 1));
};
const sha = async (p) => crypto.createHash("sha256").update(Buffer.from(await (await call("GET", "cat", p)).arrayBuffer())).digest("hex");

// ---------------------------------------------------------------- the service, as a child process

function freePort() {
    return new Promise((resolve) => {
        const srv = net.createServer().listen(0, "127.0.0.1", () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
    });
}
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "copyjobs-test-"));
const port = await freePort();
const SVC = `http://127.0.0.1:${port}`;
let child = null;
async function startService() {
    child = spawn(process.execPath, [new URL("../server/copyjobs.mjs", import.meta.url).pathname], {
        env: {
            ...process.env,
            FILESTASH_URL: BASE,
            PORT: String(port),
            HOST: "127.0.0.1",
            ALLOWED_ORIGINS: ORIGIN,
            CHUNK_BYTES: String(CHUNK),
            STATE_DIR: stateDir,
            FILESTASH_USER: "",
            FILESTASH_PASSWORD: "",
        },
        stdio: ["ignore", "pipe", "inherit"],
    });
    let output = "";
    child.stdout.on("data", (d) => { output += d; });
    for (let i = 0; i < 50; i++) {
        try {
            if ((await fetch(`${SVC}/healthz`)).ok) return () => output;
        } catch (_) {}
        await sleep(100);
    }
    throw new Error("service did not start");
}
async function stopService() {
    if (!child) return;
    const done = new Promise((r) => child.once("exit", r));
    child.kill("SIGTERM");
    await done;
    child = null;
}

const svc = (method, p = "", body = undefined, { origin = ORIGIN, cook = cookie, extra = {} } = {}) => fetch(`${SVC}/api/copyjobs${p}`, {
    method,
    headers: {
        ...(origin ? { Origin: origin } : {}),
        ...(method === "GET" ? {} : { "X-Requested-With": "XmlHttpRequest", "Content-Type": "application/json" }),
        ...(cook ? { Cookie: cook } : {}),
        ...extra,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
});
const start = async (job) => {
    const res = await svc("POST", "", job);
    if (res.status !== 202) throw new Error(`POST copyjobs: HTTP ${res.status} ${await res.text()}`);
    return (await res.json()).job;
};
const get = async (id) => (await (await svc("GET")).json()).jobs.find((j) => j.id === id);
async function until(id, wanted, ms = 60_000) {
    const end = Date.now() + ms;
    for (;;) {
        const job = await get(id);
        if (job && wanted.includes(job.status)) return job;
        if (Date.now() > end) throw new Error(`job ${id} stuck in ${job?.status}`);
        await sleep(100);
    }
}

// ---------------------------------------------------------------- run

const created = [];
try {
    const readOutput = await startService();
    await login();
    console.log(`logged in on ${BASE}; service on ${SVC}`);

    // --- who may call
    check((await svc("GET", "", undefined, { cook: "" })).status === 401, "no cookie: 401");
    check((await svc("GET", "", undefined, { cook: "auth=garbage" })).status === 401, "a cookie Filestash does not know: 401");
    check((await svc("POST", "", { sources: ["/a/b"], destination: "/c/" }, { origin: "http://evil.example" })).status === 403, "write from an unknown origin: 403");
    check((await svc("POST", "", { sources: ["/a/b"], destination: "/c/" }, { origin: "" })).status === 403, "write with no origin: 403");
    const pre = await fetch(`${SVC}/api/copyjobs`, { method: "OPTIONS", headers: { Origin: ORIGIN, "Access-Control-Request-Method": "POST" } });
    check(pre.status === 204 && pre.headers.get("access-control-allow-origin") === ORIGIN && pre.headers.get("access-control-allow-credentials") === "true",
        "preflight from the Filestash origin: allowed, with credentials");
    const bad = await svc("POST", "", { sources: ["/x/../etc"], destination: "/y/" });
    check(bad.status === 400, "a source with .. is refused: 400");
    const withOther = await svc("GET", "", undefined, { cook: cookie + "; other-app=secret" });
    check(withOther.status === 200, "extra cookies of other apps are ignored");

    // --- fixtures
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    for (const share of SHARES) {
        const dir = `/${share}/.copyjobs-test-${stamp}/`;
        await mkdir(dir);
        created.push(dir);
    }
    const [A, B] = created;
    const F = `${A}fixtures/`;
    await mkdir(F);
    await mkdir(`${F}sub/`);
    await save(`${F}pequeño ñ.txt`, rand(1000));
    await save(`${F}vacío.bin`, Buffer.alloc(0));
    await save(`${F}sub/medio.bin`, rand(300_000));
    await save(`${F}grande.bin`, rand(3 * CHUNK + 777)); // TUS, 4 chunks
    const shas = {};
    for (const rel of ["pequeño ñ.txt", "vacío.bin", "sub/medio.bin", "grande.bin"]) shas[rel] = await sha(F + rel);

    // --- copy a folder across shares
    let job = await start({ sources: [F], destination: B, move: false, label: "copy" });
    check(["planning", "queued", "running", "done"].includes(job.status) && !("owner" in job), "POST returns the job, without the owner id", job.status);
    job = await until(job.id, ["done", "failed", "cancelled"]);
    check(job.status === "done" && job.files === 4 && job.bytes === 3 * CHUNK + 777 + 1000 + 300_000, "copy job: done, 4 files, all the bytes", `${job.files} files, ${job.bytes} bytes`);
    let same = true;
    for (const [rel, h] of Object.entries(shas)) same = same && await sha(`${B}fixtures/${rel}`) === h;
    check(same, "the copied files are byte-identical (sha256), TUS path included");
    check(await exists(F), "the source of a copy is still there");

    // --- same copy again: nothing is overwritten
    job = await until((await start({ sources: [F], destination: B, move: false, label: "copy" })).id, ["done", "failed"]);
    check(job.status === "done" && await exists(`${B}fixtures (copy)/`), "a second copy gets the suffix, nothing overwritten");

    // --- a move across shares asks first, then removes the source
    const M = `${A}to-move/`;
    await mkdir(M);
    await save(`${M}m.bin`, rand(2 * CHUNK + 5));
    const shaM = await sha(`${M}m.bin`);
    job = await start({ sources: [M], destination: B, move: true, label: "copy" });
    job = await until(job.id, ["awaiting_confirm", "failed", "done"]);
    check(job.status === "awaiting_confirm" && job.confirm?.files === 1, "move across shares: waits for the person's OK", JSON.stringify(job.confirm));
    check(await exists(M) && !(await exists(`${B}to-move/`)), "…and has copied nothing yet");
    const refused = await svc("POST", `/${job.id}/confirm`, { ok: false });
    job = await until(job.id, ["cancelled", "failed", "done"]);
    check(refused.status === 202 && job.status === "cancelled" && await exists(`${M}m.bin`), "answering no cancels it and leaves the source");

    job = await start({ sources: [M], destination: B, move: true, label: "copy" });
    await until(job.id, ["awaiting_confirm"]);
    await svc("POST", `/${job.id}/confirm`, { ok: true });
    job = await until(job.id, ["done", "failed"]);
    check(job.status === "done" && !(await exists(M)) && await sha(`${B}to-move/m.bin`) === shaM && job.kept.length === 0,
        "answering yes: copied, sha256 identical, source removed");

    // --- a move inside one share is the backend's rename: no question
    const R = `${A}to-rename/`;
    await mkdir(R);
    await save(`${R}r.bin`, rand(5000));
    const T = `${A}rename-target/`;
    await mkdir(T);
    job = await until((await start({ sources: [R], destination: T, move: true, label: "copy" })).id, ["done", "failed", "awaiting_confirm"]);
    check(job.status === "done" && job.note === "RENAMED" && await exists(`${T}to-rename/`) && !(await exists(R)), "move inside a share: renamed, no question");

    // --- cancel in the middle of a big file: nothing half-written is left
    const big = `${A}big.bin`;
    await save(big, rand(48 * 1024 * 1024));
    job = await start({ sources: [big], destination: B, move: false, label: "copy" });
    const t0 = Date.now();
    while (Date.now() - t0 < 30_000 && (await get(job.id)).bytes === 0 && (await get(job.id)).status !== "done") await sleep(20);
    await svc("POST", `/${job.id}/cancel`, {});
    job = await until(job.id, ["cancelled", "done", "failed"]);
    if (job.status === "done") console.log("NOTE  the 48 MB file finished before the cancel could land; the cancel test proves nothing this run");
    else {
        await sleep(1500); // the cleanup runs after the abort
        check(job.status === "cancelled" && !(await exists(`${B}big.bin`)), "cancel mid-file: job cancelled, no half-written file left");
    }

    // --- a source that is not there
    job = await until((await start({ sources: [`${A}nope.bin`], destination: B, move: false, label: "copy" })).id, ["failed", "done"]);
    check(job.status === "failed" && job.error?.code === "NOT_FOUND", "a missing source fails with NOT_FOUND", JSON.stringify(job.error));

    // --- delete a finished job from the list; an unknown id is a 404
    check((await svc("DELETE", `/${job.id}`)).status === 200 && !(await get(job.id)), "a finished job can be dismissed");
    check((await svc("POST", `/${"0".repeat(8)}-0000-0000-0000-000000000000/cancel`, {})).status === 404, "an unknown job: 404");

    // --- restart: finished jobs are still listed, and no credentials are on disk
    const before = (await (await svc("GET")).json()).jobs.length;
    await new Promise((r) => setTimeout(r, 1200)); // jobs.json is written one second after a change
    await stopService();
    await startService();
    const after = (await (await svc("GET")).json()).jobs.length;
    check(before > 0 && after === before, "after a restart the finished jobs are still listed", `${before} → ${after}`);
    const disk = fs.readFileSync(path.join(stateDir, "jobs.json"), "utf8");
    check(!disk.includes(cookie.split("=")[1]?.slice(0, 40) || "\0") && !disk.includes(process.env.FILESTASH_PASSWORD), "jobs.json holds no cookie and no password");
    check(!readOutput().includes(cookie.split("=")[1]?.slice(0, 40) || "\0"), "the log holds no cookie");
} catch (err) {
    failures += 1;
    console.log(`FAIL  ${err.stack || err.message}`);
} finally {
    await stopService();
    for (const dir of created) {
        try {
            await rm(dir);
            console.log(`cleanup  removed ${dir}`);
        } catch (err) {
            console.log(`cleanup  could NOT remove ${dir}: ${err.message}`);
        }
    }
    fs.rmSync(stateDir, { recursive: true, force: true });
    console.log(failures === 0 ? "ALL PASSED" : `${failures} FAILED`);
    process.exit(failures === 0 ? 0 : 1);
}
