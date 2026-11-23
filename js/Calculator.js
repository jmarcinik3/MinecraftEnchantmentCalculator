// Web Worker entry point: runs the engine off the UI thread.
// Cancelling is done by the page terminating this worker and starting a new one.
importScripts("Engine.js");

let engines = null; // one per game edition, since their anvil rules differ

onmessage = function(event) {
    const data = event.data;

    if (data.message === "instantiate_metadata") {
        engines = {};
        for (const edition of EnchantEngine.EDITIONS) {
            engines[edition] = EnchantEngine.createEngine(data.metadata, { edition });
        }
    } else if (data.message === "calculate_optimal") {
        const request_id = data.request_id;
        try {
            if (!engines) throw new Error("Metadata has not loaded yet");
            const engine = engines[data.edition] || engines.java;
            const result = engine.solve(data.item_entries, {
                priority: data.priority,
                max_merge_levels: data.max_merge_levels,
                rename: data.rename,
                next_best: data.next_best,
                onProgress: (done, total) => {
                    postMessage({ message: "progress", request_id: request_id, done: done, total: total });
                }
            });
            postMessage({ message: "optimal_searched", request_id: request_id, result: result });
        } catch (error) {
            postMessage({ message: "calculation_failed", request_id: request_id, error: error.message });
        }
    }
};
