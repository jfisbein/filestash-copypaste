// copypaste: "Copy" / "Cut" / "Paste here" for Filestash, also between Samba shares, and
// drag-and-drop moves between shares (which Filestash refuses on its own).
//
// Loaded by the one-line patch at the top of ctrl_submenu.js. It keeps its own box in the
// files-page toolbar (found again with a MutationObserver whenever the page is re-rendered),
// so the patch never has to touch the toolbar code and survives upstream edits to it.
// The clipboard lives in localStorage, so it can be pasted from another tab. A cut is a move:
// the backend's own rename when it can, a copy and then removing the source when it can't.
import { getSelection$, expandSelection, lengthSelection, clearSelection } from "../../pages/filespage/state_selection.js";
import { currentPath } from "../../pages/filespage/helper.js";
import { refresh } from "../../pages/filespage/model_files.js";
import Notification from "../../components/notification.js";
import { plan, planRename, execute, removeSources, shareOf, splitPath, CopyError } from "./engine.js?v=__V__"; // __V__: set by build.py
import { load, t } from "./i18n.js?v=__V__";

const GiB = 1024 * 1024 * 1024;
const CONFIRM_FILES = 2000;
const CONFIRM_BYTES = 10 * GiB;
const STORAGE_KEY = "plg_copypaste_clipboard";

await load();

const state = {
    clipboard: loadClipboard(),
    job: null, // { abort, status }
};

// The optional server half (server/copyjobs.mjs): jobs that run on the server, so the data never
// goes through this browser. `available` is true once the service has answered with this session.
const bg = {
    available: false,
    jobs: [], // as the service lists them
    now: 0, // the service's clock, for rates
    open: false, // the panel
    timer: null,
    mine: new Set(), // jobs started from this page: their confirmation is asked here
    asked: new Set(),
    last: new Map(), // id -> status, to notice a job finishing
};
const ACTIVE = ["queued", "planning", "awaiting_confirm", "running", "removing"];

// { mode: "copy" | "cut", paths }
function loadClipboard() {
    try {
        let value = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
        if (Array.isArray(value)) value = { mode: "copy", paths: value }; // the format of v1.0
        const paths = Array.isArray(value?.paths) ? value.paths.filter((p) => typeof p === "string") : [];
        return { mode: value?.mode === "cut" ? "cut" : "copy", paths };
    } catch (_) {
        return { mode: "copy", paths: [] };
    }
}

function setClipboard(paths, mode = "copy") {
    state.clipboard = { mode, paths };
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state.clipboard));
    } catch (_) {}
    render();
}

// Cut items are dimmed in the list, wherever they are shown.
function markCut() {
    let $style = document.getElementById("plg-copypaste-cut");
    if (!$style) {
        $style = document.createElement("style");
        $style.id = "plg-copypaste-cut";
        document.head.appendChild($style);
    }
    const { mode, paths } = state.clipboard;
    const css = mode === "cut" && paths.length > 0
        ? paths.map((p) => `.component_thing[data-path="${CSS.escape(p)}"]`).join(",") + "{opacity:0.5}"
        : "";
    if ($style.textContent !== css) $style.textContent = css;
}

function destDir() {
    const path = currentPath();
    return path.endsWith("/") ? path : path + "/";
}

function canPasteHere() {
    return destDir() !== "/"; // on Samba the root lists the shares, nothing can be written there
}

function human(bytes) {
    const units = ["B", "KB", "MB", "GB", "TB"];
    let i = 0;
    while (bytes >= 1024 && i < units.length - 1) {
        bytes /= 1024;
        i += 1;
    }
    return `${bytes.toLocaleString(undefined, { maximumFractionDigits: i === 0 ? 0 : 1 })} ${units[i]}`;
}

function esc(str) {
    return String(str).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function errorText(err) {
    if (err instanceof CopyError) {
        const reason = err.code === "HTTP" ? err.detail : t(`ERROR_${err.code}`);
        return `${err.path}: ${reason}`;
    }
    return err.message || String(err);
}

// ---------------------------------------------------------------- view

const STATUS_STYLE = "padding:6px 10px;font-size:0.8rem;color:var(--light);line-height:15px;align-self:center;";

function view() {
    return mainView() + (bg.available ? jobsView() : "");
}

function mainView() {
    if (state.job) {
        return `<span style="${STATUS_STYLE}">${esc(state.job.status)}</span>`
            + `<button data-plg="cancel">${esc(t("CANCEL"))}</button>`;
    }
    if (lengthSelection() > 0) {
        return `<button data-plg="copy" title="${esc(t("COPY_TITLE"))}">${esc(t("COPY"))}</button>`
            + `<button data-plg="cut" title="${esc(t("CUT_TITLE"))}">${esc(t("CUT"))}</button>`;
    }
    const { mode, paths } = state.clipboard;
    if (paths.length > 0 && canPasteHere()) {
        return `<button data-plg="paste" title="${esc(paths.join("\n"))}">${esc(t(mode === "cut" ? "MOVE_HERE" : "PASTE_HERE"))} (${paths.length})</button>`
            + (bg.available ? `<button data-plg="paste-bg" title="${esc(t("BG_TITLE"))}">${esc(t(mode === "cut" ? "MOVE_BG" : "PASTE_BG"))}</button>` : "")
            + `<button data-plg="clear" title="${esc(t("CLEAR_CLIPBOARD"))}">×</button>`;
    }
    return "";
}

// ---------------------------------------------------------------- background jobs (server)

function serverUrl() {
    try {
        const value = localStorage.getItem("plg_copypaste_server"); // "off", or the service's URL
        if (value === "off") return null;
        if (value) return value.replace(/\/$/, "");
    } catch (_) {}
    return `${location.protocol}//${location.hostname}:8335`;
}

async function sv(method, path = "", body = undefined) {
    const base = serverUrl();
    if (!base) throw new Error("background service off");
    return fetch(`${base}/api/copyjobs${path}`, {
        method,
        credentials: "include", // Filestash's cookie: the service acts as this person, nobody else
        headers: { "X-Requested-With": "XmlHttpRequest", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
}

const isActive = (job) => ACTIVE.includes(job.status);

function jobTitle(job) {
    const [, name] = splitPath(job.sources[0]);
    return `${name}${job.sources.length > 1 ? ` (+${job.sources.length - 1})` : ""} → ${job.destination}`;
}

function jobError(job) {
    const e = job.error;
    return e ? errorText(new CopyError(e.code, e.path, e.detail, e.status)) : "";
}

function jobStatus(job) {
    const total = Math.max(job.totalFiles, 1);
    switch (job.status) {
    case "queued": return t("BG_QUEUED");
    case "planning": return t("SCANNING", { count: job.totalFiles });
    case "awaiting_confirm": return t("BG_WAITING");
    case "running": {
        const seconds = Math.max((bg.now - job.started) / 1000, 0.001);
        return t(job.move ? "MOVING" : "COPYING", {
            i: Math.min(job.files + 1, total), n: job.totalFiles,
            done: human(job.bytes), total: human(job.totalBytes), rate: human(job.bytes / seconds),
        });
    }
    case "removing": return t("BG_REMOVING");
    case "done":
        if (job.note === "ALREADY_HERE") return t("ALREADY_HERE");
        if (job.note === "RENAMED") return t("MOVED_ITEMS", { count: job.renamed });
        return t(job.move ? "MOVED_FILES" : "COPY_DONE", { count: job.files, size: human(job.bytes) })
            + (job.kept?.length ? ` · ${t("MOVED_KEPT", { count: job.kept.length })}` : "");
    case "failed": return `${t(job.move ? "MOVE_FAILED" : "COPY_FAILED")}: ${jobError(job)}`;
    case "cancelled": return job.note === "CANCELLED_REMOVING" ? t("MOVE_CANCELLED_REMOVING") : t("BG_CANCELLED");
    default: return t("BG_INTERRUPTED");
    }
}

const BTN = "padding:4px 10px;margin:4px 6px 0 0;font-size:0.85rem;border:1px solid var(--light,#888);border-radius:4px;background:transparent;color:inherit;cursor:pointer;";
const BOX = "background:var(--bg-color,#fff);color:var(--color,#333);border:1px solid var(--light,#888);border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,.25);line-height:1.35;";

const percent = (jobs) => {
    const total = jobs.reduce((n, j) => n + j.totalBytes, 0);
    return total > 0 ? Math.floor(100 * jobs.reduce((n, j) => n + j.bytes, 0) / total) : null;
};

const bar = (job) => (job.status === "running" && job.totalBytes > 0
    ? `<div style="height:5px;margin:5px 0;border-radius:3px;background:rgba(128,128,128,.35)"><div style="height:100%;border-radius:3px;width:${Math.min(100, 100 * job.bytes / job.totalBytes).toFixed(1)}%;background:var(--primary,#4a90e2)"></div></div>`
    : "");

// The toolbar button. On a phone the toolbar is wider than the screen and this button can be off
// the right edge, so the progress is also in the dock (below), which is always on screen.
function jobsView() {
    if (bg.jobs.length === 0) return "";
    const active = bg.jobs.filter(isActive);
    const pct = percent(active);
    return `<button data-plg="jobs" title="${esc(t("BG_JOBS_TITLE"))}">${esc(t("BG_JOBS", { count: bg.jobs.length }))}${active.length && pct !== null ? esc(` · ${pct}%`) : ""}</button>`;
}

function jobRows() {
    return bg.jobs.map((job) => {
        const id = esc(job.id);
        const actions = [];
        if (job.status === "awaiting_confirm") {
            actions.push(`<button data-plg="job-ok" data-job="${id}" style="${BTN}">${esc(t("BG_CONFIRM"))}</button>`);
        }
        if (isActive(job)) actions.push(`<button data-plg="job-cancel" data-job="${id}" style="${BTN}">${esc(t("CANCEL"))}</button>`);
        else actions.push(`<button data-plg="job-dismiss" data-job="${id}" style="${BTN}">${esc(t("BG_DISMISS"))}</button>`);
        return `<div style="padding:10px 0;border-top:1px solid var(--light,#888)">`
            + `<div style="font-size:0.95rem;word-break:break-all" title="${esc(job.sources.join("\n"))}">${esc(jobTitle(job))}</div>`
            + `<div style="font-size:0.85rem;opacity:.75;margin:2px 0">${esc(jobStatus(job))}</div>${bar(job)}<div>${actions.join("")}</div></div>`;
    }).join("");
}

// A box fixed at the bottom of the page, outside the toolbar: the list of jobs when it is open, and,
// while something runs, a strip with its progress (tap it to open the list).
function dockView() {
    if (!bg.available || bg.jobs.length === 0) return "";
    const active = bg.jobs.filter(isActive);
    let html = "";
    if (bg.open) {
        const clear = bg.jobs.some((j) => !isActive(j))
            ? `<div style="padding-top:6px"><button data-plg="jobs-clear" style="${BTN}">${esc(t("BG_CLEAR"))}</button> `
              + `<button data-plg="jobs" style="${BTN}">×</button></div>`
            : `<div style="padding-top:6px"><button data-plg="jobs" style="${BTN}">×</button></div>`;
        html += `<div class="plg-panel" style="${BOX}max-height:60vh;overflow:auto;padding:0 14px 10px">${jobRows()}${clear}</div>`;
    }
    if (active.length > 0 && !bg.open) {
        const job = active.find((j) => j.status === "awaiting_confirm") ?? active.find((j) => j.status === "running") ?? active[0];
        const more = active.length > 1 ? ` (+${active.length - 1})` : "";
        html += `<button data-plg="jobs" title="${esc(t("BG_JOBS_TITLE"))}" style="${BOX}display:block;width:100%;text-align:left;padding:10px 14px;font:inherit;cursor:pointer">`
            + `<div style="font-size:0.95rem;word-break:break-all">${esc(jobTitle(job))}${esc(more)}</div>`
            + `<div style="font-size:0.85rem;opacity:.75">${esc(jobStatus(job))}</div>${bar(job)}</button>`;
    }
    return html;
}

let $dock = null;
function renderDock() {
    const onFiles = !!document.querySelector(`[is="component_submenu"]`) && !new URLSearchParams(location.search).has("share");
    const html = onFiles ? dockView() : "";
    if (!$dock) {
        if (!html) return;
        $dock = document.createElement("div");
        $dock.className = "plg-dock no-select";
        $dock.style.cssText = "position:fixed;left:8px;right:8px;bottom:8px;max-width:460px;z-index:1000;display:flex;flex-direction:column;gap:6px;";
        $dock.addEventListener("click", onClick);
        document.body.appendChild($dock);
    }
    if ($dock.plgView !== html) {
        $dock.plgView = html;
        $dock.innerHTML = html;
    }
    $dock.style.display = html ? "flex" : "none";
}

async function pollJobs() {
    clearTimeout(bg.timer);
    bg.timer = null;
    try {
        const res = await sv("GET");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        bg.available = true;
        bg.jobs = data.jobs;
        bg.now = data.now;
        noticeChanges();
    } catch (_) {
        bg.available = false; // not installed, or not reachable from here: the page works as before
        bg.jobs = [];
        bg.open = false;
    }
    render();
    if (bg.available && bg.jobs.some(isActive)) bg.timer = setTimeout(pollJobs, 2000);
}

// A job finishing while the page is open is announced; a job of this page that now needs the
// person's OK (a move deletes its source) asks for it.
function noticeChanges() {
    let finished = false;
    for (const job of bg.jobs) {
        const before = bg.last.get(job.id);
        bg.last.set(job.id, job.status);
        if (before && ACTIVE.includes(before) && !isActive(job)) {
            finished = true;
            const text = `${jobTitle(job)}: ${jobStatus(job)}`;
            if (job.status === "done") Notification.success(text);
            else if (job.status === "cancelled") Notification.info(text);
            else Notification.error(text);
        }
        if (job.status === "awaiting_confirm" && bg.mine.has(job.id) && !bg.asked.has(job.id)) {
            bg.asked.add(job.id);
            setTimeout(() => askConfirm(job), 0);
        }
    }
    if (finished) refresh();
}

async function askConfirm(job) {
    if (!job) return;
    const ok = window.confirm(t("CONFIRM_MOVE", {
        dest: job.destination,
        count: job.confirm?.files ?? job.totalFiles,
        size: human(job.confirm?.bytes ?? job.totalBytes),
    }));
    await jobAction(job.id, "confirm", { ok });
}

async function jobAction(id, action, body = {}) {
    try {
        const res = await sv("POST", `/${encodeURIComponent(id)}/${action}`, body);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
        Notification.error(`${t("BG_ERROR")}: ${err.message}`);
    }
    pollJobs();
}

async function pasteBackground() {
    const { mode, paths } = state.clipboard;
    try {
        const res = await sv("POST", "", { sources: paths.slice(), destination: destDir(), move: mode === "cut", label: t("COPY_SUFFIX") });
        if (res.status === 401) throw new Error(t("BG_NOT_LOGGED"));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const { job } = await res.json();
        bg.mine.add(job.id);
        if (mode === "cut") setClipboard([]);
        Notification.info(t("BG_STARTED"));
    } catch (err) {
        Notification.error(`${t("BG_ERROR")}: ${err.message}`);
    }
    pollJobs();
}


let lastPathname = "";

function render() {
    lastPathname = location.pathname;
    markCut();
    renderDock();
    const $menu = document.querySelector(`[is="component_submenu"] > .component_submenu`);
    if (!$menu || new URLSearchParams(location.search).has("share")) return;
    let $box = $menu.querySelector(":scope > .plg-copypaste");
    if (!$box) {
        $box = document.createElement("div");
        $box.className = "action plg-copypaste no-select";
        $box.style.cssText = "display:flex;margin-right:auto;"; // the toolbar is space-between: stay next to the left actions
        $box.addEventListener("click", onClick);
        const $left = $menu.querySelector(":scope > .action.left");
        if ($left) $left.after($box);
        else $menu.prepend($box);
    }
    const html = view();
    if ($box.plgView !== html) {
        $box.plgView = html;
        $box.innerHTML = html;
    }

}

let pendingStatus = null;
function setStatus(text) {
    if (!state.job) return;
    state.job.status = text;
    if (pendingStatus) return;
    pendingStatus = setTimeout(() => {
        pendingStatus = null;
        render();
    }, 250);
}

// ---------------------------------------------------------------- actions

function onClick(e) {
    const $button = e.target.closest("button[data-plg]");
    if (!$button) return;
    e.preventDefault();
    e.stopPropagation();
    switch ($button.dataset.plg) {
    case "copy": copySelection("copy"); break;
    case "cut": copySelection("cut"); break;
    case "paste": paste(); break;
    case "clear": setClipboard([]); break;
    case "cancel": state.job?.abort.abort(); break;
    case "paste-bg": pasteBackground(); break;
    case "jobs": bg.open = !bg.open; render(); break;
    case "job-ok": askConfirm(bg.jobs.find((j) => j.id === $button.dataset.job)); break;
    case "job-cancel": jobAction($button.dataset.job, "cancel"); break;
    case "job-dismiss": sv("DELETE", `/${encodeURIComponent($button.dataset.job)}`).then(pollJobs, pollJobs); break;
    case "jobs-clear":
        Promise.all(bg.jobs.filter((j) => !isActive(j)).map((j) => sv("DELETE", `/${encodeURIComponent(j.id)}`).catch(() => {}))).then(pollJobs);
        break;
    }
}

function copySelection(mode) {
    const paths = expandSelection().map(({ path }) => path);
    if (paths.length === 0) return;
    setClipboard(paths, mode);
    clearSelection();
    Notification.info(mode === "cut"
        ? t("CUT_DONE", { count: paths.length, button: t("MOVE_HERE") })
        : t("COPIED", { count: paths.length, button: t("PASTE_HERE") }));
}

async function paste() {
    const { mode, paths } = state.clipboard;
    const touched = await runJob({ sources: paths.slice(), destination: destDir(), move: mode === "cut" });
    if (touched) setClipboard([]); // what was cut is no longer where the clipboard says
}

// A move is first a rename by the backend. What the backend can't rename is copied, then
// removed by removeSources() once the whole copy has succeeded; that part asks first.
// Returns whether the sources were changed.
async function runJob({ sources, destination, move }) {
    if (state.job) {
        Notification.error(t("BUSY"));
        return false;
    }
    const abort = new AbortController();
    state.job = { abort, status: t("SCANNING", { count: 0 }) };
    render();
    const { signal } = abort;
    const label = t("COPY_SUFFIX");
    let total = 0;
    let copied = 0;
    let removing = false;
    let touched = false;
    try {
        let renamed = 0;
        let toCopy = sources;
        if (move) {
            const renames = await planRename(sources, destination, { signal, label });
            if (renames.ops.length === 0) {
                Notification.info(t("ALREADY_HERE"));
                return false;
            }
            const result = await execute(renames, {
                signal,
                onProgress: () => { touched = true; },
            });
            renamed = result.renamed;
            toCopy = result.unsupported;
            if (toCopy.length === 0) {
                Notification.success(t("MOVED_ITEMS", { count: renamed }));
                return touched;
            }
        }

        const todo = await plan(toCopy, destination, {
            signal,
            label,
            move,
            onScan: (n) => setStatus(t("SCANNING", { count: n })),
        });
        total = todo.files;
        const size = human(todo.bytes);
        const question = move
            ? t("CONFIRM_MOVE", { dest: destination, count: todo.files, size })
            : (todo.files > CONFIRM_FILES || todo.bytes > CONFIRM_BYTES) ? t("CONFIRM_COPY", { count: todo.files, size }) : null;
        if (question && !window.confirm(question)) {
            abort.abort();
            signal.throwIfAborted();
        }
        const started = performance.now();
        const result = await execute(todo, {
            signal,
            onProgress: (files, bytes) => {
                copied = files;
                const seconds = Math.max((performance.now() - started) / 1000, 0.001);
                setStatus(t(move ? "MOVING" : "COPYING", {
                    i: Math.min(files + 1, total), n: total,
                    done: human(bytes), total: size, rate: human(bytes / seconds),
                }));
            },
        });
        if (!move) {
            Notification.success(t("COPY_DONE", { count: result.files, size: human(result.bytes) }));
            return false;
        }
        removing = touched = true;
        setStatus(t("REMOVING", { i: 0, n: total }));
        const { kept } = await removeSources(todo, {
            signal,
            onProgress: (n) => setStatus(t("REMOVING", { i: n, n: total })),
        });
        if (kept.length === 0) {
            Notification.success(t("MOVED_FILES", { count: result.files, size: human(result.bytes) }));
        } else {
            console.warn("[copypaste] still in the source:", kept);
            Notification.error(t("MOVED_KEPT", { count: kept.length }));
        }
    } catch (err) {
        if (signal.aborted) {
            Notification.info(!move
                ? t("COPY_CANCELLED", { done: copied, count: total })
                : removing ? t("MOVE_CANCELLED_REMOVING") : t("MOVE_CANCELLED", { done: copied, count: total }));
        } else {
            console.error("[copypaste]", err);
            const what = !move ? "COPY_FAILED" : touched ? "MOVE_FAILED_PARTLY" : "MOVE_FAILED";
            Notification.error(`${t(what)}: ${errorText(err)}`);
        }
    } finally {
        state.job = null;
        render();
        refresh();
    }
    return touched;
}

// ---------------------------------------------------------------- drag and drop between shares

// Where Filestash itself would move a drop to, mirroring its handlers: a folder in the list
// (thing.js), a folder in the sidebar tree (sidebar_files.js), a breadcrumb (breadcrumb.js),
// or, for a drag that started in another tab, the current folder (ctrl_move.js).
let localDrag = false;
function dropTarget(e) {
    const $el = e.target instanceof Element ? e.target : e.target?.parentElement;
    const $thing = $el?.closest(".component_thing");
    if ($thing?.getAttribute("data-droptarget") === "true") return $thing.getAttribute("data-path");
    const $sidebar = $el?.closest("li[data-path] > a");
    if ($sidebar?.hasAttribute("href")) return $sidebar.parentElement.getAttribute("data-path");
    const $crumb = $el?.closest("a.label")?.closest(".component_path-element[data-path]");
    if ($crumb) return $crumb.getAttribute("data-path");
    return localDrag ? null : destDir();
}

document.addEventListener("dragstart", () => { localDrag = true; }, true);
document.addEventListener("dragend", () => { localDrag = false; }, true);

// Capture phase on window, so it runs before Filestash's handlers. A move inside one top-level
// folder is left to Filestash; one across top-level folders (shares, on Samba) is taken over:
// runJob tries the rename first, so a backend that can do it still does.
window.addEventListener("drop", (e) => {
    if (!document.querySelector(`[is="component_submenu"]`)) return;
    const from = e.dataTransfer?.getData("path");
    if (!from) return; // files dragged in from the desktop: an upload
    const to = dropTarget(e);
    if (!to || to === "/" || shareOf(from) === shareOf(to)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    document.querySelectorAll("li[data-path] > a.highlight, .component_path-element.highlight, .component_thing.hover")
        .forEach(($n) => $n.classList.remove("highlight", "hover"));
    runJob({ sources: [from], destination: to, move: true });
}, true);

// ---------------------------------------------------------------- wiring

getSelection$().subscribe(() => render());

new MutationObserver(() => {
    const mounted = document.querySelector(`[is="component_submenu"] > .component_submenu > .plg-copypaste`);
    if (!mounted || location.pathname !== lastPathname) render();
}).observe(document.body, { childList: true, subtree: true });

window.addEventListener("storage", (e) => {
    if (e.key !== STORAGE_KEY) return;
    state.clipboard = loadClipboard();
    render();
});

window.addEventListener("beforeunload", (e) => {
    if (!state.job) return;
    e.preventDefault();
    e.returnValue = t("LEAVE");
});

// Ctrl/Cmd+C, X and V on the files page, unless the user is typing or has text selected
window.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    if (!document.querySelector(`[is="component_submenu"]`) || state.job) return;
    const $target = e.target;
    if ($target && ($target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test($target.tagName || ""))) return;
    if (String(window.getSelection?.() || "") !== "") return;
    const key = (e.key || "").toLowerCase();
    if ((key === "c" || key === "x") && lengthSelection() > 0) {
        e.preventDefault();
        copySelection(key === "x" ? "cut" : "copy");
    } else if (key === "v" && state.clipboard.paths.length > 0 && canPasteHere()) {
        e.preventDefault();
        paste();
    }
});

render();
pollJobs();
document.addEventListener("visibilitychange", () => { if (!document.hidden) pollJobs(); });
