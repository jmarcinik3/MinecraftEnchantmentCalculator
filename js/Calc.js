// The search: the worker, requests and results.
import { MAX_GROUPS, searchSize } from "./Logic.js";
import { TEXT } from "./Text.js";
import { engineMeta, language, logic, state } from "./Store.js";
import { stepLimit } from "./Options.js";
import { renderResults } from "./Results.js";
import { applyCarriedProgress } from "./Link.js";

const WORKER_URL = "js/Calculator.js";
const CALC_DELAY_MS = 250;      // wait for the user to stop clicking
const PROGRESS_DELAY_MS = 300;  // only show the progress bar for slow runs
let worker = null;
let worker_failed = false; // the worker hit an error of its own: the next search starts a new one
let request_id = 0;
export let running = false;
export let show_progress = false;
let calc_timer = null;
let progress_timer = null;
// A long search: how far it is, and since when, so the bar can say how long is left.
let started_at = 0;
let progress_share = 0;
let progress_clock = null;
const ESTIMATE_AFTER_S = 5;      // say the time once a search has run this long
const ESTIMATE_FROM_SHARE = 0.005; // and guess what is left once this much is done
export let last_result = null; // { status: "ok" | "empty" | "cancelled" | "error", node?, error? }
// When the search found no order within the level limit: a second search with no limit, for the order
// whose biggest step is smallest, to show which step breaks the limit. { status: "running" | "done" | "failed", node? }
export let last_break = null;
let break_worker = null;
let break_id = 0;

export function startWorker() {
    worker = new Worker(WORKER_URL);
    worker.onmessage = handleWorkerMessage;
    worker.onerror = event => {
        event.preventDefault();
        worker_failed = true;
        stopRunning();
        last_result = { status: "error", error: TEXT.results.worker_failed };
        renderResults();
    };
    worker.postMessage({ message: "instantiate_metadata", metadata: engineMeta() });
}

function restartWorker() {
    worker.terminate();
    worker_failed = false;
    startWorker();
}

// The game data changed (a mod was turned on or off): every worker starts again with the new data.
export function resetWorkers() {
    stopBreakSearch();
    stopRunning();
    if (preview_worker) preview_worker.terminate();
    preview_worker = null;
    restartWorker();
}

// What the search is doing, on <html data-search>: "pending" (waiting out the debounce), "running" or "idle".
// Nothing in the page reads it: the browser tests wait on it instead of sleeping.
function markSearch(status) {
    document.documentElement.dataset.search = status;
}

function stopRunning() {
    markSearch("idle");
    running = false;
    show_progress = false;
    clearTimeout(progress_timer);
    clearInterval(progress_clock);
}

// "37%", then "2% · 40 seconds so far", then "4% · about 12 minutes left". The time ticks
// on its own, so a slow start doesn't look stuck.
export function progressLabel() {
    // Under 10%, one decimal, so a slow search still moves ("0.4%").
    const share = Math.min(100, progress_share * 100);
    const shown = share < 10 ? Math.floor(share * 10) / 10 : Math.floor(share);
    const percent = shown.toLocaleString(language, { maximumFractionDigits: 1 });
    const elapsed = (performance.now() - started_at) / 1000;
    if (elapsed < ESTIMATE_AFTER_S) return TEXT.results.search_percent({ percent });
    if (progress_share < ESTIMATE_FROM_SHARE) return TEXT.results.search_elapsed({ percent, time: duration(elapsed) });
    return TEXT.results.search_left({ percent, time: duration(elapsed * (1 - progress_share) / progress_share) });
}

function duration(seconds) {
    const [value, unit] = seconds >= 5400 ? [Math.round(seconds / 3600), "hour"]
        : seconds >= 90 ? [Math.round(seconds / 60), "minute"]
            : [Math.max(1, Math.round(seconds)), "second"];
    return new Intl.NumberFormat(language, { style: "unit", unit, unitDisplay: "long" }).format(value);
}

function showProgress() {
    const fill = document.getElementById("progress-fill");
    const text = document.getElementById("progress-text");
    if (fill) fill.style.width = Math.min(100, progress_share * 100).toFixed(1) + "%";
    if (text) text.textContent = progressLabel();
}

export function scheduleCalculation() {
    clearTimeout(calc_timer);
    // The setup changed: a result still on its way is for the old one, so it must not be shown.
    request_id++;
    markSearch("pending");
    calc_timer = setTimeout(runCalculation, CALC_DELAY_MS);
}

// Where the limit breaks: the cheapest biggest step with no limit (its own worker, so the main search and
// the drag previews are not held up). Only the biggest step matters, so that is what it ranks first.
function findBreak() {
    const id = ++break_id;
    last_break = { status: "running" };
    break_worker = new Worker(WORKER_URL);
    break_worker.onmessage = event => {
        const data = event.data;
        if (data.request_id !== id || data.message === "progress") return;
        last_break = data.message === "optimal_searched" ? { status: "done", node: data.result } : { status: "failed" };
        stopBreakSearch(false);
        renderResults();
    };
    break_worker.onerror = event => {
        event.preventDefault();
        if (id !== break_id) return;
        last_break = { status: "failed" };
        stopBreakSearch(false);
        renderResults();
    };
    break_worker.postMessage({ message: "instantiate_metadata", metadata: engineMeta() });
    break_worker.postMessage({
        message: "calculate_optimal", request_id: id, item_entries: logic.buildEntries(state),
        priority: ["max_step", "levels", "xp", "prior_work"], max_merge_levels: Infinity, edition: state.edition, rename: state.rename
    });
}

function stopBreakSearch(forget = true) {
    if (break_worker) break_worker.terminate();
    break_worker = null;
    if (forget) last_break = null;
}

export function runCalculation() {
    clearTimeout(calc_timer);
    stopBreakSearch();
    // The search is one synchronous call, so a newer request has to replace the worker.
    if (running || worker_failed) restartWorker();
    stopRunning();

    const entries = logic.buildEntries(state);
    if (entries.length < 2) {
        last_result = { status: "empty" };
        renderResults();
        return;
    }
    if (searchSize(entries).groups > MAX_GROUPS) {
        last_result = { status: "error", error: TEXT.results.too_many_different };
        renderResults();
        return;
    }

    request_id++;
    running = true;
    markSearch("running");
    started_at = performance.now();
    progress_share = 0;
    progress_timer = setTimeout(() => {
        show_progress = true;
        renderResults();
        progress_clock = setInterval(showProgress, 1000);
    }, PROGRESS_DELAY_MS);
    worker.postMessage({
        message: "calculate_optimal",
        request_id: request_id,
        item_entries: entries,
        priority: state.priority,
        max_merge_levels: stepLimit(),
        edition: state.edition,
        rename: state.rename
    });
    renderResults();
}

// What merging two entries would cost, from a second worker so a running search isn't
// disturbed (section 2's drag preview). `left` is the first slot, `right` the second; both
// are [item or "book", [[enchantment, level], ...], prior work]. Resolves { ok, levels, enchantments }.
let preview_worker = null;
let preview_id = 0;
const preview_waiting = new Map();

export function previewMerge(left, right) {
    if (!preview_worker) {
        preview_worker = new Worker(WORKER_URL);
        preview_worker.onmessage = event => {
            const resolve = preview_waiting.get(event.data.request_id);
            preview_waiting.delete(event.data.request_id);
            if (resolve) resolve(event.data);
        };
        preview_worker.postMessage({ message: "instantiate_metadata", metadata: engineMeta() });
    }
    return new Promise(resolve => {
        const id = ++preview_id;
        preview_waiting.set(id, resolve);
        preview_worker.postMessage({ message: "merge_preview", request_id: id, edition: state.edition, left, right });
    });
}

export function cancelCalculation() {
    if (!running) return;
    restartWorker();
    stopRunning();
    last_result = { status: "cancelled" };
    renderResults();
}

function handleWorkerMessage(event) {
    const data = event.data;
    if (data.request_id !== request_id) return;

    if (data.message === "progress") {
        progress_share = data.total ? data.done / data.total : 0;
        showProgress();
    } else if (data.message === "optimal_searched") {
        stopRunning();
        last_result = { status: "ok", node: data.result };
        if (!data.result && !state.no_step_limit) findBreak();
        applyCarriedProgress(data.result);
        renderResults();
    } else if (data.message === "calculation_failed") {
        stopRunning();
        last_result = { status: "error", error: data.error };
        renderResults();
    }
}
