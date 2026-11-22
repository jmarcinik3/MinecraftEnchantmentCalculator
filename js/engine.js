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

        function makeNode(item_namespace, enchantment_list, prior_work, merge_levels, cumulative_levels, cumulative_xp, left, right) {
            enchantment_list.sort((a, b) => (a.namespace < b.namespace ? -1 : a.namespace > b.namespace ? 1 : 0));
            return { item_namespace, enchantments: enchantment_list, prior_work, merge_levels, cumulative_levels, cumulative_xp, left, right };
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
            return makeNode(item_namespace, list, prior_work, 0, 0, 0, null, null);
        }

        // Put `left` in the first anvil slot and `right` in the second.
        // Returns the resulting node, or null if the game would not allow it.
        function combine(left, right) {
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
            if (merge_levels > MAXIMUM_MERGE_LEVELS) return null;

            const list = Array.from(levels, ([namespace, level]) => ({ namespace, level }));
            return makeNode(
                left.item_namespace,
                list,
                Math.max(left.prior_work, right.prior_work) + 1,
                merge_levels,
                left.cumulative_levels + right.cumulative_levels + merge_levels,
                left.cumulative_xp + right.cumulative_xp + experienceFromLevel(merge_levels),
                left,
                right
            );
        }

        function comparator(objective) {
            if (objective === "xp") {
                return (a, b) => a.cumulative_xp - b.cumulative_xp || a.cumulative_levels - b.cumulative_levels;
            }
            return (a, b) => a.cumulative_levels - b.cumulative_levels || a.cumulative_xp - b.cumulative_xp;
        }

        // Finds the cheapest anvil order that yields the best possible enchantments.
        // Returns the root node of the merge tree, or null if no valid order exists.
        function solve(entries, options = {}) {
            const compare = comparator(options.objective);
            const leaves = entries.map(makeLeaf);
            const count = leaves.length;
            if (count === 0) return null;
            if (count > 20) throw new Error("Too many items (maximum 20)");

            // Memoize on the subset of items (bitmask). For each subset keep the cheapest
            // node per (prior work, resulting enchantments): those two fully determine how
            // the node behaves in later merges.
            const memo = new Map();
            leaves.forEach((leaf, index) => memo.set(1 << index, [leaf]));

            function frontier(mask) {
                const cached = memo.get(mask);
                if (cached) return cached;

                const best = new Map();
                for (let sub = (mask - 1) & mask; sub > 0; sub = (sub - 1) & mask) {
                    const left_nodes = frontier(sub);
                    if (left_nodes.length === 0) continue;
                    const right_nodes = frontier(mask ^ sub);
                    for (const left of left_nodes) {
                        for (const right of right_nodes) {
                            const node = combine(left, right);
                            if (!node) continue;
                            const key = node.prior_work + "|" + signature(node);
                            const current = best.get(key);
                            if (!current || compare(node, current) < 0) best.set(key, node);
                        }
                    }
                }

                const result = Array.from(best.values());
                memo.set(mask, result);
                return result;
            }

            const candidates = frontier((1 << count) - 1);
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

    const api = { createEngine, experienceFromLevel, priorWorkPenalty, MAXIMUM_MERGE_LEVELS };
    if (typeof module !== "undefined" && module.exports) {
        module.exports = api;
    } else {
        root.EnchantEngine = api;
    }
})(typeof self !== "undefined" ? self : this);
