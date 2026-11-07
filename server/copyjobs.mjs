#!/usr/bin/env node
// copyjobs: the optional server half of the copypaste plugin.
//
// The plugin copies through the browser by default, so a big file over 4G is the phone's link,
// twice. This service runs the very same engine (../src/engine.js) on the server instead: the
// plugin sends a job (sources, destination, copy or move) and the bytes travel Filestash -> this
// process -> Filestash on the server's own network. The phone only polls for progress, and can
// go away.
//
// It is a client of Filestash, never a second way into the storage: every request goes to
// Filestash's own API with the cookie of the person who started the job, so the backend (Samba)
// sees that person's own login and its rules apply. The cookie is read from the request, kept in
// memory while the job runs and never written to disk or logged.
//
// Zero dependencies, Node >= 20. Configuration (environment):
//   FILESTASH_URL     where Filestash answers from here          default http://127.0.0.1:8334/
//   PORT / HOST       where this service listens                 default 8335 / 0.0.0.0
//   ALLOWED_ORIGINS   comma list of the Filestash origins allowed to call this service, e.g.
//                     http://nas.lan:8334. If empty, any port on the host the request came to
//                     is allowed (convenient, weaker: set it).
//   MAX_JOBS          jobs copying at the same time              default 2
//   STATE_DIR         where jobs.json is kept (no credentials)   default ./state
//   KEEP_HOURS        how long finished jobs stay listed         default 24
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { config, plan, planRename, execute, removeSources, CopyError } from "../src/engine.js";

const FILESTASH = new URL(process.env.FILESTASH_URL || "http://127.0.0.1:8334/");
const PORT = Number(process.env.PORT || 8335);
const HOST = process.env.HOST || "0.0.0.0";
const ORIGINS = (process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean);
const MAX_JOBS = Math.max(1, Number(process.env.MAX_JOBS || 2));
const STATE_DIR = process.env.STATE_DIR || "./state";
const KEEP_MS = Number(process.env.KEEP_HOURS || 24) * 3600 * 1000;
const CONFIRM_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_SOURCES = 5000;
const BASE = "/api/copyjobs";
if (process.env.CHUNK_BYTES) config.chunk = Number(process.env.CHUNK_BYTES); // tests: small chunks, so TUS runs on small files

// ---------------------------------------------------------------- Filestash, as the job's owner

const als = new AsyncLocalStorage();
config.fetch = (url, opts = {}) => {
    const { cookie } = als.getStore() ?? {};
    if (!cookie) throw new Error("no session in this context");
    return fetch(new URL(url, FILESTASH), { ...opts, headers: { ...(opts.headers || {}), cookie } });
};

// Only Filestash's own cookie goes on: cookies are not isolated by port, so the browser also sends
// whatever the other apps on this host set.
function authCookie(req) {
    const kept = (req.headers.cookie || "").split(";").map((c) => c.trim()).filter((c) => /^auth\d*=/.test(c));
    return kept.join("; ");
}

// Who is calling: Filestash itself says whether the cookie is a live session, and gives a stable
// id for the connection (the same login gives the same id), which keys the jobs. Returns null if
// there is no live session.
async function whoIs(cookie) {
    if (!cookie) return null;
    try {
        const res = await fetch(new URL("api/session", FILESTASH), {
            headers: { cookie, "X-Requested-With": "XmlHttpRequest" },
            signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) return null;
        const { result } = await res.json();
        return result?.is_authenticated && result.backendID ? String(result.backendID) : null;
    } catch (_) {
        return null;
    }
}

// ---------------------------------------------------------------- jobs

/** @type {Map<string, object>} public, serialisable part of every job */
const jobs = new Map();
/** @type {Map<string, {cookie: string, abort: AbortController, confirm: ((ok: boolean) => void) | null}>} */
const secrets = new Map();

let stopping = false; // the service is shutting down: aborted jobs are "interrupted", not "cancelled"
const ACTIVE = new Set(["queued", "planning", "awaiting_confirm", "running", "removing"]);

function newJob(owner, { sources, destination, move, label }) {
    const job = {
        id: crypto.randomUUID(),
        owner,
        move,
        sources,
        destination,
        label,
        status: "planning",
        created: Date.now(),
        started: 0,
        finished: 0,
        files: 0, // copied so far
        totalFiles: 0,
        bytes: 0,
        totalBytes: 0,
        renamed: 0,
        current: "",
        confirm: null, // { files, bytes } while status is awaiting_confirm
        note: "", // "ALREADY_HERE" | "RENAMED"
        kept: [], // what a move left in the source
        error: null, // { code, path, detail, status }
    };
    jobs.set(job.id, job);
    return job;
}

function finish(job, status, extra = {}) {
    Object.assign(job, extra, { status, finished: Date.now(), current: "", confirm: null });
    secrets.delete(job.id);
    log(job, status + (job.error ? ` ${job.error.code} ${job.error.detail}` : ""));
    save();
}

function log(job, text) {
    console.log(`${new Date().toISOString()} job ${job.id.slice(0, 8)} ${job.move ? "move" : "copy"} ${text}`);
}

// A semaphore on the copying part; scanning and waiting for a confirmation don't hold a slot.
let running = 0;
const waiting = [];
async function slot(signal) {
    if (running >= MAX_JOBS) {
        await new Promise((resolve, reject) => {
            const waiter = { resolve };
            waiting.push(waiter);
            signal.addEventListener("abort", () => {
                const i = waiting.indexOf(waiter);
                if (i !== -1) waiting.splice(i, 1);
                reject(signal.reason);
            }, { once: true });
        });
    } else {
        running += 1;
    }
    return () => {
        const next = waiting.shift();
        if (next) next.resolve(); // the slot passes on
        else running -= 1;
    };
}

async function run(job) {
    const secret = secrets.get(job.id);
    const { signal } = secret.abort;
    let release = null;
    let removing = false;
    try {
        await als.run({ cookie: secret.cookie }, async () => {
            const { sources, destination, move, label } = job;
            let toCopy = sources;
            if (move) {
                const renames = await planRename(sources, destination, { signal, label });
                if (renames.ops.length === 0) return finish(job, "done", { note: "ALREADY_HERE" });
                const result = await execute(renames, { signal });
                job.renamed = result.renamed;
                toCopy = result.unsupported;
                if (toCopy.length === 0) return finish(job, "done", { note: "RENAMED" });
            }

            const todo = await plan(toCopy, destination, { signal, label, move, onScan: (n) => { job.totalFiles = n; } });
            job.totalFiles = todo.files;
            job.totalBytes = todo.bytes;

            // Deleting the source is what the person has to agree to, as in the browser
            if (move) {
                job.status = "awaiting_confirm";
                job.confirm = { files: todo.files, bytes: todo.bytes };
                const ok = await new Promise((resolve) => {
                    const timer = setTimeout(() => resolve(false), CONFIRM_TIMEOUT_MS);
                    secret.confirm = (answer) => { clearTimeout(timer); resolve(answer); };
                    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(false); }, { once: true });
                });
                secret.confirm = null;
                job.confirm = null;
                if (!ok) return finish(job, "cancelled");
            }

            job.status = "queued";
            release = await slot(signal);
            job.status = "running";
            job.started = Date.now();
            log(job, `running: ${todo.files} files, ${todo.bytes} bytes`);
            const result = await execute(todo, {
                signal,
                onProgress: (files, bytes, op) => {
                    job.files = files;
                    job.bytes = bytes;
                    job.current = op?.src ?? job.current;
                },
            });
            if (!move) return finish(job, "done", { files: result.files, bytes: result.bytes });

            removing = true;
            job.status = "removing";
            job.current = "";
            const { kept } = await removeSources(todo, { signal });
            finish(job, "done", { files: result.files, bytes: result.bytes, kept });
        });
    } catch (err) {
        if (signal.aborted && stopping) {
            finish(job, "interrupted");
        } else if (signal.aborted) {
            finish(job, "cancelled", removing ? { note: "CANCELLED_REMOVING" } : {});
        } else if (err instanceof CopyError) {
            finish(job, "failed", { error: { code: err.code, path: err.path, detail: err.detail, status: err.status } });
        } else {
            console.error(`job ${job.id.slice(0, 8)}:`, err);
            finish(job, "failed", { error: { code: "INTERNAL", path: "", detail: String(err?.message || err), status: 0 } });
        }
    } finally {
        release?.();
    }
}

// ---------------------------------------------------------------- persistence (no credentials)

const STATE_FILE = path.join(STATE_DIR, "jobs.json");
let saveTimer = null;
function save() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        try {
            fs.mkdirSync(STATE_DIR, { recursive: true });
            fs.writeFileSync(STATE_FILE + ".tmp", JSON.stringify([...jobs.values()]), { mode: 0o600 });
            fs.renameSync(STATE_FILE + ".tmp", STATE_FILE);
        } catch (err) {
            console.error("cannot save jobs.json:", err.message);
        }
    }, 1000);
}

function load() {
    let list = [];
    try {
        list = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    } catch (_) {}
    for (const job of list) {
        // a restart kills what was running; the cookie is gone with it
        if (ACTIVE.has(job.status)) Object.assign(job, { status: "interrupted", finished: Date.now(), current: "", confirm: null });
        jobs.set(job.id, job);
    }
}

function prune() {
    const limit = Date.now() - KEEP_MS;
    for (const job of jobs.values()) {
        if (!ACTIVE.has(job.status) && job.finished < limit) jobs.delete(job.id);
    }
    save();
}

// ---------------------------------------------------------------- HTTP

function originAllowed(req) {
    const origin = (req.headers.origin || "").replace(/\/$/, "");
    if (!origin) return null;
    if (ORIGINS.length > 0) return ORIGINS.includes(origin) ? origin : null;
    try { // any port of the host this request came to
        return new URL(origin).hostname === new URL("http://" + req.headers.host).hostname ? origin : null;
    } catch (_) {
        return null;
    }
}

function send(res, status, body, headers = {}) {
    const payload = body === undefined ? "" : JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
    res.end(payload);
}

async function readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > 1_000_000) throw Object.assign(new Error("body too large"), { http: 413 });
        chunks.push(chunk);
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    } catch (_) {
        throw Object.assign(new Error("invalid JSON"), { http: 400 });
    }
}

function validate(body) {
    const bad = (m) => Object.assign(new Error(m), { http: 400 });
    const { sources, destination, move, label } = body;
    const okPath = (p) => typeof p === "string" && p.startsWith("/") && p.length < 4096 && !p.split("/").includes("..") && !p.includes("\0");
    if (!Array.isArray(sources) || sources.length === 0 || sources.length > MAX_SOURCES || !sources.every(okPath)) throw bad("sources");
    if (!okPath(destination) || !destination.endsWith("/") || destination === "/") throw bad("destination");
    return {
        sources: sources.slice(),
        destination,
        move: move === true,
        label: typeof label === "string" && /^[^/\\\0]{1,24}$/.test(label) ? label : "copy",
    };
}

const view = ({ owner, ...job }) => job; // the owner id stays on the server

async function handle(req, res) {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/healthz") return send(res, 200, { ok: true });
    if (!url.pathname.startsWith(BASE)) return send(res, 404, { message: "not found" });

    const origin = originAllowed(req);
    const cors = origin
        ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Credentials": "true", "Vary": "Origin" }
        : { "Vary": "Origin" };
    if (req.method === "OPTIONS") {
        if (!origin) return send(res, 403, { message: "origin not allowed" });
        return send(res, 204, undefined, {
            ...cors,
            "Access-Control-Allow-Methods": "GET, POST, DELETE",
            "Access-Control-Allow-Headers": "Content-Type, X-Requested-With",
            "Access-Control-Max-Age": "600",
        });
    }
    // A write needs the header a plain cross-site form cannot send, and an origin we know
    if (req.method !== "GET") {
        if (!origin || req.headers["x-requested-with"] !== "XmlHttpRequest") return send(res, 403, { message: "forbidden" }, cors);
    }

    const cookie = authCookie(req);
    const owner = await whoIs(cookie);
    if (!owner) return send(res, 401, { message: "not logged in" }, cors);

    const parts = url.pathname.slice(BASE.length).split("/").filter(Boolean);
    try {
        if (parts.length === 0 && req.method === "GET") {
            prune();
            const list = [...jobs.values()].filter((j) => j.owner === owner).sort((a, b) => b.created - a.created);
            return send(res, 200, { jobs: list.map(view), now: Date.now() }, cors);
        }
        if (parts.length === 0 && req.method === "POST") {
            const data = validate(await readJson(req));
            const mine = [...jobs.values()].filter((j) => j.owner === owner && ACTIVE.has(j.status));
            if (mine.length >= 10) return send(res, 429, { message: "too many jobs" }, cors);
            const job = newJob(owner, data);
            secrets.set(job.id, { cookie, abort: new AbortController(), confirm: null });
            log(job, `${data.sources.length} source(s) -> ${data.destination}`);
            run(job);
            save();
            return send(res, 202, { job: view(job) }, cors);
        }
        const job = jobs.get(parts[0]);
        if (!job || job.owner !== owner) return send(res, 404, { message: "no such job" }, cors);
        const secret = secrets.get(job.id);
        if (parts.length === 2 && parts[1] === "cancel" && req.method === "POST") {
            secret?.abort.abort();
            return send(res, 202, { job: view(job) }, cors);
        }
        if (parts.length === 2 && parts[1] === "confirm" && req.method === "POST") {
            if (job.status !== "awaiting_confirm" || !secret?.confirm) return send(res, 409, { message: "nothing to confirm" }, cors);
            secret.confirm((await readJson(req)).ok === true);
            return send(res, 202, { job: view(job) }, cors);
        }
        if (parts.length === 1 && req.method === "DELETE") {
            if (ACTIVE.has(job.status)) return send(res, 409, { message: "still running" }, cors);
            jobs.delete(job.id);
            save();
            return send(res, 200, { ok: true }, cors);
        }
        return send(res, 404, { message: "not found" }, cors);
    } catch (err) {
        if (err.http) return send(res, err.http, { message: err.message }, cors);
        console.error(err);
        return send(res, 500, { message: "internal error" }, cors);
    }
}

// ---------------------------------------------------------------- start

load();
if (ORIGINS.length === 0) console.warn("ALLOWED_ORIGINS is empty: any port of this host may call the service. Set it to your Filestash origin.");
const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
        console.error(err);
        if (!res.headersSent) send(res, 500, { message: "internal error" });
    });
});
server.listen(PORT, HOST, () => console.log(`copyjobs on ${HOST}:${PORT} -> ${FILESTASH.href} (max ${MAX_JOBS} jobs)`));

// A stop aborts every job: the engine removes the half-written file, then the jobs are marked.
for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, async () => {
        console.log(`${sig}: stopping`);
        stopping = true;
        server.close();
        for (const { abort } of secrets.values()) abort.abort();
        const deadline = Date.now() + 8000;
        while ([...jobs.values()].some((j) => ACTIVE.has(j.status)) && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 200));
        }
        for (const job of jobs.values()) {
            if (ACTIVE.has(job.status)) Object.assign(job, { status: "interrupted", finished: Date.now() });
        }
        try {
            fs.mkdirSync(STATE_DIR, { recursive: true });
            fs.writeFileSync(STATE_FILE, JSON.stringify([...jobs.values()]), { mode: 0o600 });
        } catch (_) {}
        process.exit(0);
    });
}
