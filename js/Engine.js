// Pure anvil-combination engine. No DOM access: usable from the Web Worker
// (via importScripts) and from Node (via require) for tests.
(function (root) {
    "use strict";

    // Java Edition survival: a merge costing 40+ levels is "Too Expensive!".
    const MAXIMUM_MERGE_LEVELS = 39;

    // Total XP points needed to go from level 0 to `level`.
    function experienceFromLevel(level) {
        if (level <= 0) return 0;
        if (level <= 16) return level * level + 6 * level;
        if (level <= 31) return 2.5 * level * level - 40.5 * level + 360;
        return 4.5 * level * level - 162.5 * level + 2220;
    }

    function priorWorkPenalty(prior_work) {
        return 2 ** prior_work - 1;
    }

    // Ranking criteria, compared in the order the user lists them.
    //   levels: total levels spent, xp: total XP points spent,
    //   max_step: the most expensive single step, prior_work: the final item's anvil uses.
    const CRITERIA = ["levels", "xp", "max_step", "prior_work"];
    const CRITERION_FIELD = { levels: "cumulative_levels", xp: "cumulative_xp", max_step: "max_step", prior_work: "prior_work" };

    // Valid, de-duplicated priority list; unlisted criteria are appended in default order.
    function normalizePriority(priority) {
        const listed = Array.isArray(priority) ? priority.filter(c => CRITERIA.includes(c)) : [];
        const unique = [...new Set(listed)];
        return [...unique, ...CRITERIA.filter(c => !unique.includes(c))];
    }

    // Lexicographic comparator over the given criteria.
    function lexicographic(criteria) {
        const fields = criteria.map(c => CRITERION_FIELD[c]);
        return (a, b) => {
            for (const field of fields) {
                const diff = a[field] - b[field];
                if (diff !== 0) return diff;
            }
            return 0;
        };
    }

    function createEngine(metadata) {
        const enchantments = {};
        for (const [namespace, data] of Object.entries(metadata.enchantments)) {
            enchantments[namespace] = {
                weight: Number(data.weight),
                max_level: Number(data.max_level),
                items: new Set(data.items),
                incompatible: new Set(data.incompatible)
            };
        }
        const item_namespaces = new Set(Object.keys(metadata.items));

        function isIncompatible(a, b) {
            return a !== b && (enchantments[a].incompatible.has(b) || enchantments[b].incompatible.has(a));
        }

        function canApply(item_namespace, enchantment_namespace) {
            return item_namespace === "book" || enchantments[enchantment_namespace].items.has(item_namespace);
        }

        function enchantmentValue(node) {
            return node.enchantments.reduce((sum, e) => sum + e.level * enchantments[e.namespace].weight, 0);
        }

        function signature(node) {
            return node.enchantments.map(e => e.namespace + ":" + e.level).join(",");
        }

        function makeNode(item_namespace, enchantment_list, prior_work, merge_levels, cumulative_levels, cumulative_xp, max_step, left, right) {
            enchantment_list.sort((a, b) => (a.namespace < b.namespace ? -1 : a.namespace > b.namespace ? 1 : 0));
            return { item_namespace, enchantments: enchantment_list, prior_work, merge_levels, cumulative_levels, cumulative_xp, max_step, left, right };
        }

        function makeLeaf(entry) {
            const [item_namespace, enchantment_entries, prior_work = 0] = entry;
            if (!item_namespaces.has(item_namespace)) {
                throw new Error(`Unknown item "${item_namespace}"`);
            }
            if (!Number.isInteger(prior_work) || prior_work < 0) {
                throw new Error("Prior work must be a non-negative integer");
            }
            const seen = new Set();
            const list = enchantment_entries.map(([namespace, raw_level]) => {
                const data = enchantments[namespace];
                if (!data) throw new Error(`Unknown enchantment "${namespace}"`);
                const level = Number(raw_level);
                if (!Number.isInteger(level) || level < 1 || level > data.max_level) {
                    throw new Error(`Invalid level ${raw_level} for ${namespace}`);
                }
                if (!canApply(item_namespace, namespace)) {
                    throw new Error(`${namespace} cannot be applied to ${item_namespace}`);
                }
                if (seen.has(namespace)) throw new Error(`Duplicate enchantment ${namespace}`);
                seen.add(namespace);
                return { namespace, level };
            });
            return makeNode(item_namespace, list, prior_work, 0, 0, 0, 0, null, null);
        }

        // Put `left` in the first anvil slot and `right` in the second.
        // Returns the resulting node, or null if the game would not allow it or the
        // step would cost more than `max_merge_levels`.
        function combine(left, right, max_merge_levels = MAXIMUM_MERGE_LEVELS) {
            const right_is_book = right.item_namespace === "book";
            if (!right_is_book && left.item_namespace !== right.item_namespace) return null;

            const multiplier = right_is_book ? 1 : 2;
            const levels = new Map(left.enchantments.map(e => [e.namespace, e.level]));
            let merge_levels = 0;

            for (const { namespace, level } of right.enchantments) {
                if (!canApply(left.item_namespace, namespace)) continue;
                if (left.enchantments.some(e => isIncompatible(e.namespace, namespace))) {
                    merge_levels += 1; // incompatible enchantments are dropped but still cost 1
                    continue;
                }
                const existing = levels.get(namespace) || 0;
                const max_level = enchantments[namespace].max_level;
                const final_level = existing === level ? Math.min(level + 1, max_level) : Math.max(existing, level);
                levels.set(namespace, final_level);
                merge_levels += final_level * enchantments[namespace].weight * multiplier;
            }

            merge_levels += priorWorkPenalty(left.prior_work) + priorWorkPenalty(right.prior_work);
            if (merge_levels > Math.min(max_merge_levels, MAXIMUM_MERGE_LEVELS)) return null;

            const list = Array.from(levels, ([namespace, level]) => ({ namespace, level }));
            return makeNode(
                left.item_namespace,
                list,
                Math.max(left.prior_work, right.prior_work) + 1,
                merge_levels,
                left.cumulative_levels + right.cumulative_levels + merge_levels,
                left.cumulative_xp + right.cumulative_xp + experienceFromLevel(merge_levels),
                Math.max(left.max_step, right.max_step, merge_levels),
                left,
                right
            );
        }

        // `objective` ("levels" | "xp") is the older single-choice option.
        function priorityFromOptions(options) {
            if (options.priority) return normalizePriority(options.priority);
            return normalizePriority(options.objective === "xp" ? ["xp", "levels"] : ["levels", "xp"]);
        }

        // Within one memo bucket (same prior work and enchantments) a node can be dropped
        // only if another node stays at least as good after any further merges.
        // Totals (levels, XP) just add the same amount to both, so their lexicographic order
        // is kept. The max step is not: max(30, 36) ties max(35, 36), letting a node that
        // lost on max step win later on totals. So if max step outranks a total, keep every
        // node that is not beaten on both the max step and the totals (a Pareto front,
        // at most 39 nodes since steps cost 1-39 levels).
        function dominance(priority) {
            const ranked = priority.filter(c => c !== "prior_work"); // equal within a bucket
            if (ranked[ranked.length - 1] === "max_step") {
                const compare = lexicographic(ranked);
                return (a, b) => compare(a, b) <= 0;
            }
            const compare_totals = lexicographic(ranked.filter(c => c !== "max_step"));
            return (a, b) => a.max_step <= b.max_step && compare_totals(a, b) <= 0;
        }

        // Finds the cheapest anvil order that yields the best possible enchantments.
        // Returns the root node of the merge tree, or null if no valid order exists.
        function solve(entries, options = {}) {
            const priority = priorityFromOptions(options);
            const compare = lexicographic(priority);
            const dominates = dominance(priority);
            const cap = options.max_merge_levels == null ? MAXIMUM_MERGE_LEVELS : Number(options.max_merge_levels);
            if (!Number.isInteger(cap) || cap < 1) throw new Error("Step limit must be a positive integer");
            const leaves = entries.map(makeLeaf);
            const count = leaves.length;
            if (count === 0) return null;
            if (count > 20) throw new Error("Too many items (maximum 20)");

            // Memoize on the subset of items (bitmask). For each subset keep the cheapest
            // nodes per (prior work, resulting enchantments): those two fully determine how
            // the node behaves in later merges (see `dominance` for which nodes are kept).
            const memo = new Map();
            leaves.forEach((leaf, index) => memo.set(1 << index, [leaf]));

            // Progress = (left, right) splits examined, out of the total over every subset:
            // sum over subsets S of (2^|S| - 2) = 3^n - 2^(n+1) + 1.
            const on_progress = typeof options.onProgress === "function" ? options.onProgress : null;
            const total_splits = 3 ** count - 2 ** (count + 1) + 1;
            const report_every = Math.max(1, Math.floor(total_splits / 200));
            let splits_done = 0;

            function frontier(mask) {
                const cached = memo.get(mask);
                if (cached) return cached;

                const best = new Map();
                for (let sub = (mask - 1) & mask; sub > 0; sub = (sub - 1) & mask) {
                    splits_done++;
                    if (on_progress && splits_done % report_every === 0) {
                        on_progress(splits_done, total_splits);
                    }
                    const left_nodes = frontier(sub);
                    if (left_nodes.length === 0) continue;
                    const right_nodes = frontier(mask ^ sub);
                    for (const left of left_nodes) {
                        for (const right of right_nodes) {
                            const node = combine(left, right, cap);
                            if (!node) continue;
                            const key = node.prior_work + "|" + signature(node);
                            const kept = best.get(key);
                            if (!kept) {
                                best.set(key, [node]);
                            } else if (!kept.some(other => dominates(other, node))) {
                                const survivors = kept.filter(other => !dominates(node, other));
                                survivors.push(node);
                                best.set(key, survivors);
                            }
                        }
                    }
                }

                const result = [].concat(...best.values());
                memo.set(mask, result);
                return result;
            }

            const candidates = frontier((1 << count) - 1);
            if (on_progress) on_progress(total_splits, total_splits);
            let chosen = null;
            for (const node of candidates) {
                if (!chosen) {
                    chosen = node;
                    continue;
                }
                const value_diff = enchantmentValue(node) - enchantmentValue(chosen);
                if (value_diff > 0 || (value_diff === 0 && compare(node, chosen) < 0)) chosen = node;
            }
            return chosen;
        }

        return { solve, combine, makeLeaf };
    }

    const api = { createEngine, experienceFromLevel, priorWorkPenalty, normalizePriority, CRITERIA, MAXIMUM_MERGE_LEVELS };
    if (typeof module !== "undefined" && module.exports) {
        module.exports = api;
    } else {
        root.EnchantEngine = api;
    }
})(typeof self !== "undefined" ? self : this);
