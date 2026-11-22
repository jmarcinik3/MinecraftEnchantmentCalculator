// Web Worker entry point: runs the engine off the UI thread.
// Cancelling is done by the page terminating this worker and starting a new one.
importScripts("engine.js");

let engine = null;

onmessage = function(event) {
    const data = event.data;

    if (data.message === "instantiate_metadata") {
        engine = EnchantEngine.createEngine(data.metadata);
    } else if (data.message === "calculate_optimal") {
        const request_id = data.request_id;
        try {
            if (!engine) throw new Error("Metadata has not loaded yet");
            const result = engine.solve(data.item_entries, {
                objective: data.objective,
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
