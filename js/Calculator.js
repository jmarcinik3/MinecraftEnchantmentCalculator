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
    } else if (data.message === "merge_preview") {
        // One merge of two entries (the page's drag preview), with no level limit, so the
        // page can say "Too expensive!" itself.
        try {
            const engine = engines[data.edition] || engines.java;
            const node = engine.combine(engine.makeLeaf(data.left), engine.makeLeaf(data.right), Infinity);
            postMessage({ message: "merge_previewed", request_id: data.request_id, ok: Boolean(node), levels: node ? node.merge_levels : 0, enchantments: node ? node.enchantments : [] });
        } catch {
            postMessage({ message: "merge_previewed", request_id: data.request_id, ok: false, levels: 0, enchantments: [] });
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
