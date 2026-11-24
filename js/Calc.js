// The search: the worker, requests and results.
import { MAX_GROUPS, searchSize } from "./Logic.js";
import { TEXT } from "./Text.js";
import { logic, meta, state } from "./Store.js";
import { stepLimit } from "./Options.js";
import { renderResults } from "./Results.js";
import { applyCarriedProgress } from "./Link.js";

const WORKER_URL = "js/Calculator.js";
const CALC_DELAY_MS = 250;      // wait for the user to stop clicking
const PROGRESS_DELAY_MS = 300;  // only show the progress bar for slow runs
let worker = null;
let request_id = 0;
export let running = false;
export let show_progress = false;
let calc_timer = null;
let progress_timer = null;
export let last_result = null; // { status: "ok" | "empty" | "cancelled" | "error", node?, error? }

export function startWorker() {
    worker = new Worker(WORKER_URL);
    worker.onmessage = handleWorkerMessage;
    worker.onerror = event => {
        event.preventDefault();
        stopRunning();
        last_result = { status: "error", error: TEXT.results.worker_failed };
        renderResults();
    };
    worker.postMessage({ message: "instantiate_metadata", metadata: meta });
}

function restartWorker() {
    worker.terminate();
    startWorker();
}

function stopRunning() {
    running = false;
    show_progress = false;
    clearTimeout(progress_timer);
}

export function scheduleCalculation() {
    clearTimeout(calc_timer);
    calc_timer = setTimeout(runCalculation, CALC_DELAY_MS);
}

export function runCalculation() {
    clearTimeout(calc_timer);
    // The search is one synchronous call, so a newer request has to replace the worker.
    if (running) restartWorker();
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
    progress_timer = setTimeout(() => { show_progress = true; renderResults(); }, PROGRESS_DELAY_MS);
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
        preview_worker.postMessage({ message: "instantiate_metadata", metadata: meta });
    }
    return new Promise(resolve => {
        const request_id = ++preview_id;
        preview_waiting.set(request_id, resolve);
        preview_worker.postMessage({ message: "merge_preview", request_id, edition: state.edition, left, right });
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
        const percent = Math.min(100, Math.floor((data.done / data.total) * 100));
        const fill = document.getElementById("progress-fill");
        const text = document.getElementById("progress-text");
        if (fill) fill.style.width = percent + "%";
        if (text) text.textContent = percent + "%";
    } else if (data.message === "optimal_searched") {
        stopRunning();
        last_result = { status: "ok", node: data.result };
        applyCarriedProgress(data.result);
        renderResults();
    } else if (data.message === "calculation_failed") {
        stopRunning();
        last_result = { status: "error", error: data.error };
        renderResults();
    }
}

// ---------- Shareable URL ----------
