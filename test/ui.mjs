// Offline test of copy.js, the toolbar and drop logic, under node: Filestash's modules and the
// DOM are stubbed, the files API is an in-memory imitation (mv refuses to cross top-level
// folders with 501, like the Samba backend).
//   node test/ui.mjs [language]      (default es-ES; the expected texts come from src/locales)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const language = process.argv[2] || "es-ES";
const src = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "copypaste-ui-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
const A = path.join(root, "public/assets");
const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(A, rel)), { recursive: true });
    fs.writeFileSync(path.join(A, rel), text);
};
write("pages/filespage/state_selection.js", `
const subs = []; let sel = [];
export const getSelection$ = () => ({ subscribe(fn) { subs.push(fn); } });
export const expandSelection = () => sel.map((path) => ({ path }));
export const lengthSelection = () => sel.length;
export const clearSelection = () => { sel = []; subs.forEach((f) => f()); };
export const __select = (s) => { sel = s; subs.forEach((f) => f()); };`);
write("pages/filespage/helper.js", "export const currentPath = () => globalThis.__path;");
write("pages/filespage/model_files.js", "export const refresh = () => { globalThis.__refreshes += 1; };");
write("components/notification.js", `const n = (kind) => (msg) => globalThis.__notes.push([kind, msg]);
export default { info: n("info"), success: n("success"), error: n("error") };`);
for (const f of ["copy.js", "engine.js", "i18n.js"]) write(`plugin/copypaste.zip/${f}`, fs.readFileSync(path.join(src, f), "utf8"));
for (const f of fs.readdirSync(path.join(src, "locales"))) write(`plugin/copypaste.zip/locales/${f}`, fs.readFileSync(path.join(src, "locales", f), "utf8"));

// ---------------------------------------------------------------- the expected texts
const { pickLanguage } = await import(pathToFileURL(path.join(src, "i18n.js")));
const lang = pickLanguage(language);
const en = JSON.parse(fs.readFileSync(path.join(src, "locales/en.json"), "utf8"));
const dict = lang === "en" ? {} : JSON.parse(fs.readFileSync(path.join(src, `locales/${lang}.json`), "utf8"));
const rules = new Intl.PluralRules(lang);
const T = (key, vars = {}) => {
    let v = dict[key] ?? en[key];
    if (typeof v === "object") v = v[rules.select(vars.count ?? 0)] ?? v.other;
    return v.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
};

// ---------------------------------------------------------------- DOM stubs
class El {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.style = {}; this.listeners = {}; this.className = ""; this.innerHTML = ""; this.textContent = ""; this.id = ""; this.parent = null; }
    addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
    appendChild(el) { el.parent = this; this.children.push(el); return el; }
    prepend(el) { el.parent = this; this.children.unshift(el); }
    after(el) { el.parent = this.parent; this.parent.children.splice(this.parent.children.indexOf(this) + 1, 0, el); }
    querySelector(sel) {
        const cls = { ":scope > .plg-copypaste": "plg-copypaste", ":scope > .action.left": "action left" }[sel];
        return this.children.find((c) => c.className.includes(cls)) || null;
    }
}
const wrapper = new El("div");
const menu = wrapper.appendChild(new El("div"));
menu.appendChild(new El("div")).className = "action left";
const head = new El("head");
const winListeners = {};
const def = (k, v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
let confirmAnswer = true;
let confirms = 0;
const store = new Map();
def("navigator", { language });
def("localStorage", { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) });
def("document", {
    head, body: new El("body"),
    createElement: (t) => new El(t),
    getElementById: (id) => head.children.find((c) => c.id === id) || null,
    querySelectorAll: () => [],
    querySelector: (sel) => ({
        '[is="component_submenu"] > .component_submenu': menu,
        '[is="component_submenu"]': wrapper,
        '[is="component_submenu"] > .component_submenu > .plg-copypaste': menu.querySelector(":scope > .plg-copypaste"),
    })[sel] ?? null,
    addEventListener() {},
});
def("location", { pathname: "/files/", search: "" });
def("CSS", { escape: (s) => s.replace(/[^a-zA-Z0-9_-]/g, (c) => "\\" + c) });
def("MutationObserver", class { observe() {} });
def("Element", class {});
def("window", {
    addEventListener: (t, f) => { (winListeners[t] ||= []).push(f); },
    confirm: () => { confirms += 1; return confirmAnswer; },
    getSelection: () => "",
});
const nodeFetch = globalThis.fetch;
def("fetch", async (url, opts) => {
    const u = new URL(url);
    if (u.protocol === "file:") return new Response(fs.readFileSync(fileURLToPath(u))); // the locale files
    return nodeFetch(url, opts);
});
globalThis.__notes = [];
globalThis.__refreshes = 0;
globalThis.__path = "/";

// ---------------------------------------------------------------- files API stub
const files = new Map([["/", null], ["/a/", null], ["/b/", null], ["/a/m/", null], ["/a/m/one.txt", "1"], ["/a/loose.txt", "22"], ["/a/d/", null]]);
const calls = [];
const { config } = await import(pathToFileURL(path.join(A, "plugin/copypaste.zip/engine.js")) + "?v=__V__");
config.fetch = async (url, { method = "GET", body = null } = {}) => {
    const u = new URL(url, "http://x/");
    const action = u.pathname.split("/").pop();
    const p = u.searchParams.get("path") ?? u.searchParams.get("from");
    calls.push(`${method} ${action} ${p}`);
    const ok = (obj = { status: "ok" }) => new Response(JSON.stringify(obj), { status: 200 });
    const under = (dir) => [...files.keys()].filter((k) => k === dir || (dir.endsWith("/") && k.startsWith(dir)));
    switch (action) {
    case "ls": return ok({ results: [...files.keys()].filter((k) => k !== p && k.startsWith(p) && /^[^/]+\/?$/.test(k.slice(p.length)))
        .map((k) => ({ name: k.slice(p.length).replace(/\/$/, ""), type: files.get(k) === null ? "directory" : "file", size: files.get(k)?.length ?? 0 })) });
    case "cat": return new Response(files.get(p));
    case "save": files.set(p, await new Response(body).text()); return ok();
    case "mkdir": files.set(p, null); return ok();
    case "rm": under(p).forEach((k) => files.delete(k)); return ok();
    case "mv": {
        const to = u.searchParams.get("to");
        if (p.split("/")[1] !== to.split("/")[1]) return new Response(JSON.stringify({ status: "error", message: "Not Implemented" }), { status: 501 });
        under(p).forEach((k) => { const v = files.get(k); files.delete(k); files.set(to + k.slice(p.length), v); });
        return ok();
    }
    }
    return new Response("{}", { status: 404 });
};

store.set("plg_copypaste_clipboard", JSON.stringify(["/a/loose.txt"])); // the format of v1.0
const sel = await import(pathToFileURL(path.join(A, "pages/filespage/state_selection.js")));
await import(pathToFileURL(path.join(A, "plugin/copypaste.zip/copy.js")));

// ---------------------------------------------------------------- helpers
let failures = 0;
const check = (ok, label, extra = "") => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
    if (!ok) failures += 1;
};
const box = () => menu.querySelector(":scope > .plg-copypaste");
const decode = (s) => s.replace(/&#(\d+);/g, (m, c) => String.fromCharCode(c));
const buttons = () => [...box().innerHTML.matchAll(/data-plg="(\w+)"[^>]*>([^<]*)</g)].map((m) => `${m[1]}:${decode(m[2])}`);
const go = (p) => { globalThis.__path = p; location.pathname = "/files" + p; sel.__select([]); };
const settle = async (before) => {
    for (let i = 0; i < 200 && globalThis.__refreshes === before; i++) await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 0));
};
const click = async (name) => {
    const before = globalThis.__refreshes;
    box().listeners.click[0]({ target: { closest: () => ({ dataset: { plg: name } }) }, preventDefault() {}, stopPropagation() {} });
    if (name === "paste") await settle(before);
};
const clip = () => JSON.parse(store.get("plg_copypaste_clipboard"));
const cutCss = () => head.children.find((c) => c.id === "plg-copypaste-cut")?.textContent ?? "";
const lastNote = () => globalThis.__notes.at(-1)?.join(": ");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------- run
console.log(`language ${language} → ${lang}`);
go("/b/");
check(same(buttons(), [`paste:${T("PASTE_HERE")} (1)`, "clear:×"]), "a clipboard in the v1.0 format still pastes", JSON.stringify(buttons()));

go("/a/");
sel.__select(["/a/m/", "/a/loose.txt"]);
check(same(buttons(), [`copy:${T("COPY")}`, `cut:${T("CUT")}`]), "a selection shows Copy + Cut", JSON.stringify(buttons()));

await click("cut");
check(same(clip(), { mode: "cut", paths: ["/a/m/", "/a/loose.txt"] }), "Cut → clipboard in cut mode", store.get("plg_copypaste_clipboard"));
check(lastNote() === `info: ${T("CUT_DONE", { count: 2, button: T("MOVE_HERE") })}`, "Cut → notification", lastNote());
check(cutCss() === '.component_thing[data-path="\\/a\\/m\\/"],.component_thing[data-path="\\/a\\/loose\\.txt"]{opacity:0.5}', "cut items dimmed", cutCss());
check(same(buttons(), [`paste:${T("MOVE_HERE")} (2)`, "clear:×"]), "selection cleared → Move here (2)", JSON.stringify(buttons()));

await click("paste");
check(lastNote() === `info: ${T("ALREADY_HERE")}` && clip().paths.length === 2 && files.has("/a/m/one.txt"), "Move here in its own folder → nothing, clipboard kept", lastNote());

go("/a/d/");
calls.length = 0;
confirms = 0;
await click("paste");
check(files.get("/a/d/m/one.txt") === "1" && files.get("/a/d/loose.txt") === "22" && !files.has("/a/m/") && !files.has("/a/loose.txt"), "Move here inside the share → moved");
check(calls.filter((c) => !c.startsWith("GET ls")).join(",") === "POST mv /a/m/,POST mv /a/loose.txt" && confirms === 0, "… with two mv requests and no confirmation", JSON.stringify(calls));
check(lastNote() === `success: ${T("MOVED_ITEMS", { count: 2 })}`, "… notification", lastNote());
check(clip().paths.length === 0 && cutCss() === "" && buttons().length === 0, "… clipboard emptied, nothing dimmed", JSON.stringify({ clip: clip(), css: cutCss() }));

// keyboard: Ctrl+X, then across shares, first answering "no" to the confirmation
sel.__select(["/a/d/m/"]);
winListeners.keydown[0]({ ctrlKey: true, key: "x", target: { tagName: "DIV" }, preventDefault() {} });
check(same(clip(), { mode: "cut", paths: ["/a/d/m/"] }), "Ctrl+X → cut", store.get("plg_copypaste_clipboard"));
go("/b/");
confirmAnswer = false;
confirms = 0;
calls.length = 0;
await click("paste");
check(calls.includes("POST mv /a/d/m/") && confirms === 1 && files.has("/a/d/m/one.txt") && !files.has("/b/m/") && clip().paths.length === 1,
    "across shares: mv refused (501) → confirmation; \"no\" changes nothing, clipboard kept", lastNote());
confirmAnswer = true;
await click("paste");
check(files.get("/b/m/one.txt") === "1" && !files.has("/a/d/m/") && clip().paths.length === 0, "across shares, \"yes\" → copied, source removed, clipboard emptied", lastNote());
check(lastNote() === `success: ${T("MOVED_FILES", { count: 1, size: "1 B" })}`, "… notification", lastNote());

// Copy keeps the source and the clipboard, and dims nothing
sel.__select(["/b/m/one.txt"]);
await click("copy");
check(cutCss() === "", "Copy → nothing dimmed");
go("/a/");
await click("paste");
check(files.get("/a/one.txt") === "1" && files.has("/b/m/one.txt") && same(clip(), { mode: "copy", paths: ["/b/m/one.txt"] }), "Paste here (copy) keeps the source and the clipboard", lastNote());
check(lastNote() === `success: ${T("COPY_DONE", { count: 1, size: "1 B" })}`, "… notification", lastNote());

// a cut made in another tab
store.set("plg_copypaste_clipboard", JSON.stringify({ mode: "cut", paths: ["/a/one.txt"] }));
winListeners.storage[0]({ key: "plg_copypaste_clipboard" });
check(cutCss().includes("one\\.txt") && same(buttons(), [`paste:${T("MOVE_HERE")} (1)`, "clear:×"]), "a cut in another tab → dimmed here, Move here (1)", JSON.stringify(buttons()));
await click("clear");
check(cutCss() === "" && clip().paths.length === 0, "× → clipboard emptied, nothing dimmed");

// drag and drop: onto a sidebar folder of another share, and inside one share (left to Filestash)
const dropOn = (from, to) => {
    let stopped = false;
    const $link = { hasAttribute: (a) => a === "href", parentElement: { getAttribute: () => to } };
    const target = Object.assign(new Element(), { closest: (s) => (s === "li[data-path] > a" ? $link : null) });
    winListeners.drop[0]({ target, dataTransfer: { getData: (k) => (k === "path" ? from : "") }, preventDefault() {}, stopImmediatePropagation() { stopped = true; } });
    return stopped;
};
check(dropOn("/a/one.txt", "/a/d/") === false, "a drop inside one share is left to Filestash");
let before = globalThis.__refreshes;
check(dropOn("/a/one.txt", "/b/") === true, "a drop onto another share is taken over");
await settle(before);
check(files.get("/b/one.txt") === "1" && !files.has("/a/one.txt"), "… and moves it (copy + remove, after the confirmation)", lastNote());

console.log(failures === 0 ? "ALL PASSED" : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
