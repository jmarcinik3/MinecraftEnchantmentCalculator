// Web Worker entry point: runs the engine off the UI thread.
importScripts("engine.js");

let engine = null;

onmessage = function(event) {
    const data = event.data;

    if (data.message === "instantiate_metadata") {
        engine = EnchantEngine.createEngine(data.metadata);
    } else if (data.message === "calculate_optimal") {
        try {
            if (!engine) throw new Error("Metadata has not loaded yet");
            const result = engine.solve(data.item_entries, { objective: data.objective });
            postMessage({ message: "optimal_searched", result: result });
        } catch (error) {
            postMessage({ message: "calculation_failed", error: error.message });
        }
    }
};
