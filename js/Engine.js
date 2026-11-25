// Pure anvil-combination engine. No DOM access: usable from the Web Worker
// (via importScripts) and from Node (via require) for tests.
(function (root) {
    "use strict";

    // Java Edition survival: a merge costing 40+ levels is "Too Expensive!".
    const MAXIMUM_MERGE_LEVELS = 39;

    // Most groups of entries the search may remember: as many as 20 all-different entries.
    const MAXIMUM_GROUPS = 2 ** 20;

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

    // Game rules differ by edition (see `preview`). Metadata entries may carry a `bedrock`
    // object whose fields replace theirs in Bedrock Edition, e.g. { "weight": 1 }, or
    // { "items": [] } for an enchantment Bedrock does not have.
    const EDITIONS = ["java", "bedrock"];

    function createEngine(metadata, options = {}) {
        const edition = options.edition === "bedrock" ? "bedrock" : "java";
        // Java charges an enchantment's final level on the result; Bedrock only the levels
        // it gains over the target's (Minecraft Wiki, "Anvil mechanics").
        const charge_increase_only = edition === "bedrock";
        const enchantments = {};
        for (const [namespace, raw] of Object.entries(metadata.enchantments)) {
            const data = edition === "bedrock" && raw.bedrock ? { ...raw, ...raw.bedrock } : raw;
            enchantments[namespace] = {
                weight: Number(data.weight),
                max_level: Number(data.max_level),
                items: new Set(data.items)
            };
        }
        const item_namespaces = new Set(metadata.items);

        function canApply(item_namespace, enchantment_namespace) {
            return item_namespace === "book" || enchantments[enchantment_namespace].items.has(item_namespace);
        }

        function enchantmentValue(node) {
            return node.enchantments.reduce((sum, e) => sum + e.level * enchantments[e.namespace].weight, 0);
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

        // Scratch space for `preview`: the enchantments a merge would produce. The search
        // previews far more merges than it keeps, so these are reused instead of
        // allocating a list per merge; only merges that survive become nodes.
        const scratch_names = [];
        const scratch_levels = [];
        let scratch_count = 0;

        function pushScratch(namespace, level) {
            scratch_names[scratch_count] = namespace;
            scratch_levels[scratch_count] = level;
            scratch_count++;
        }

        // Works out putting `left` in the first anvil slot and `right` in the second,
        // without building a node: the resulting enchantments go into the scratch space
        // (sorted by name, like every node's list) and the step's cost in levels is
        // returned, or -1 if the game would not allow it or it would cost more than
        // `max_merge_levels` (Infinity: no limit, as with mods that remove "Too Expensive!").
        // Both enchantment lists are sorted by name, so one pass merges them.
        // Conflicts between enchantments are not checked here: the page sends conflicting
        // enchantments together only when "Allow conflicts" is on.
        // `extra_levels` is added to the step before the limit check (1 for a rename).
        function preview(left, right, max_merge_levels, extra_levels = 0) {
            const right_is_book = right.item_namespace === "book";
            if (!right_is_book && left.item_namespace !== right.item_namespace) return -1;

            const multiplier = right_is_book ? 1 : 2;
            const left_list = left.enchantments;
            const right_list = right.enchantments;
            let i = 0;
            let j = 0;
            let merge_levels = 0;
            scratch_count = 0;

            while (i < left_list.length || j < right_list.length) {
                // Only on the left: kept as it is, at no cost.
                if (j >= right_list.length || (i < left_list.length && left_list[i].namespace < right_list[j].namespace)) {
                    pushScratch(left_list[i].namespace, left_list[i].level);
                    i++;
                    continue;
                }
                const { namespace, level } = right_list[j];
                j++;
                const on_left = i < left_list.length && left_list[i].namespace === namespace;
                const existing = on_left ? left_list[i].level : 0;
                if (on_left) i++;
                if (!canApply(left.item_namespace, namespace)) {
                    if (on_left) pushScratch(namespace, existing);
                    continue;
                }
                const data = enchantments[namespace];
                const final_level = existing === level ? Math.min(level + 1, data.max_level) : Math.max(existing, level);
                pushScratch(namespace, final_level);
                const charged_levels = charge_increase_only ? final_level - existing : final_level;
                merge_levels += charged_levels * data.weight * multiplier;
            }

            // Java gives nothing for a merge that adds nothing (an unenchanted item in the
            // second slot), unless it also renames: the anvil's own cost must be above 0.
            if (merge_levels === 0 && extra_levels === 0 && !charge_increase_only) return -1;
            merge_levels += priorWorkPenalty(left.prior_work) + priorWorkPenalty(right.prior_work) + extra_levels;
            // A huge prior work makes the penalty Infinity, which would pass an Infinity limit.
            if (!(merge_levels <= max_merge_levels) || !Number.isFinite(merge_levels)) return -1;
            return merge_levels;
        }

        // Memo key for the previewed merge: its prior work and enchantments, which fully
        // determine how it behaves in later merges. `layout` (from `keyLayout`) packs them
        // into one number; without one, a text key is used.
        function previewKey(prior_work, layout) {
            if (layout) {
                let key = prior_work * layout.prior_work_place;
                for (let k = 0; k < scratch_count; k++) {
                    key += scratch_levels[k] * layout.place.get(scratch_names[k]);
                }
                return key;
            }
            let key = prior_work + "|";
            for (let k = 0; k < scratch_count; k++) {
                key += (k > 0 ? "," : "") + scratch_names[k] + ":" + scratch_levels[k];
            }
            return key;
        }

        // Number-key layout for one search. Merges only combine the enchantments already on
        // the inputs, so each of those gets a "digit" wide enough for its max level, and
        // prior work goes above them:
        //   key = level_0 + level_1 * (max_0 + 1) + ... + prior_work * (product of all widths)
        // Text keys are used instead if the largest key could pass 2^53, where JavaScript
        // numbers stop being exact (about 16+ different enchantments).
        function keyLayout(leaves) {
            const names = [...new Set(leaves.flatMap(leaf => leaf.enchantments.map(e => e.namespace)))];
            const place = new Map();
            let width = 1;
            for (const namespace of names) {
                place.set(namespace, width);
                width *= enchantments[namespace].max_level + 1;
            }
            // Prior work rises by at most 1 per merge.
            const highest_prior_work = Math.max(...leaves.map(leaf => leaf.prior_work)) + leaves.length - 1;
            if (width * (highest_prior_work + 1) > Number.MAX_SAFE_INTEGER) return null;
            return { place, prior_work_place: width };
        }

        // Fills `totals` with what the previewed merge would score on each criterion.
        function previewTotals(left, right, merge_levels, totals) {
            totals.prior_work = Math.max(left.prior_work, right.prior_work) + 1;
            totals.cumulative_levels = left.cumulative_levels + right.cumulative_levels + merge_levels;
            totals.cumulative_xp = left.cumulative_xp + right.cumulative_xp + experienceFromLevel(merge_levels);
            totals.max_step = Math.max(left.max_step, right.max_step, merge_levels);
            return totals;
        }

        // Turns the previewed merge into a node (the scratch list is already sorted).
        function buildNode(left, right, merge_levels, totals) {
            const list = new Array(scratch_count);
            for (let k = 0; k < scratch_count; k++) {
                list[k] = { namespace: scratch_names[k], level: scratch_levels[k] };
            }
            return {
                item_namespace: left.item_namespace,
                enchantments: list,
                prior_work: totals.prior_work,
                merge_levels,
                cumulative_levels: totals.cumulative_levels,
                cumulative_xp: totals.cumulative_xp,
                max_step: totals.max_step,
                left,
                right
            };
        }

        // Put `left` in the first anvil slot and `right` in the second.
        // Returns the resulting node, or null if the game would not allow it or the
        // step would cost more than `max_merge_levels` (see `preview`).
        function combine(left, right, max_merge_levels = MAXIMUM_MERGE_LEVELS, extra_levels = 0) {
            const merge_levels = preview(left, right, max_merge_levels, extra_levels);
            if (merge_levels < 0) return null;
            return buildNode(left, right, merge_levels, previewTotals(left, right, merge_levels, {}));
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
        // at most one node per distinct max step, so at most 39 with the vanilla limit).
        function dominance(priority) {
            const ranked = priority.filter(c => c !== "prior_work"); // equal within a bucket
            if (ranked[ranked.length - 1] === "max_step") {
                const compare = lexicographic(ranked);
                return (a, b) => compare(a, b) <= 0;
            }
            const compare_totals = lexicographic(ranked.filter(c => c !== "max_step"));
            return (a, b) => a.max_step <= b.max_step && compare_totals(a, b) <= 0;
        }

        // Groups identical leaves (same item, prior work and enchantments, which are kept
        // sorted) into kinds, in order of first appearance: [{ leaf, copies }].
        function groupKinds(leaves) {
            const by_signature = new Map();
            for (const leaf of leaves) {
                const signature = leaf.item_namespace + "|" + leaf.prior_work + "|" +
                    leaf.enchantments.map(e => e.namespace + ":" + e.level).join(",");
                const kind = by_signature.get(signature);
                if (kind) kind.copies++;
                else by_signature.set(signature, { leaf, copies: 1 });
            }
            return [...by_signature.values()];
        }

        // Finds the cheapest anvil order that yields the best possible enchantments.
        // Returns the root node of the merge tree, or null if no valid order exists.
        function solve(entries, options = {}) {
            const priority = priorityFromOptions(options);
            const compare = lexicographic(priority);
            const dominates = dominance(priority);
            const cap = options.max_merge_levels == null ? MAXIMUM_MERGE_LEVELS : Number(options.max_merge_levels);
            if (cap !== Infinity && (!Number.isInteger(cap) || cap < 1)) {
                throw new Error("Level limit must be a positive integer or Infinity");
            }
            const leaves = entries.map(makeLeaf);
            const count = leaves.length;
            if (count === 0) return null;
            const layout = keyLayout(leaves);

            // Identical entries (same item, enchantments and prior work) are interchangeable,
            // so a group of entries is described by how many of each kind it holds, not by
            // which ones: with 4 identical books, "any 2 of them" is one group, not 6.
            // The counts are packed into one number (`code`) with a digit per kind, digit k
            // running 0..copies[k] and worth place[k]. Codes are linear, so the code of
            // "everything in A that is not in B" is code(A) - code(B).
            const kinds = groupKinds(leaves);
            const kind_count = kinds.length;
            const copies = kinds.map(kind => kind.copies);
            const place = new Array(kind_count);
            let code_count = 1;
            for (let k = 0; k < kind_count; k++) {
                place[k] = code_count;
                code_count *= copies[k] + 1;
            }
            // The memo has one slot per group. Repeats are cheap (40 copies of one book is
            // only 41 groups); 20 all-different entries is the most allowed (about 1 million).
            if (code_count > MAXIMUM_GROUPS) {
                throw new Error("Too many different entries. Repeated books are fine, but at most 20 different ones.");
            }

            // For each group keep the best nodes per (prior work, resulting enchantments):
            // those two fully determine how a node behaves in later merges (see `dominance`
            // for which nodes are kept).
            const memo = new Array(code_count);
            kinds.forEach((kind, k) => { memo[place[k]] = [kind.leaf]; });

            // Progress = (left, right) splits examined, out of the total over every group.
            // A group with a_k of each kind has prod(a_k + 1) - 2 splits; summed over all
            // groups that is prod over kinds of (c + 1)(c + 2) / 2, minus 2 prod(c + 1), plus 1.
            // With no repeats (every c = 1) that is 3^n - 2^(n+1) + 1.
            const on_progress = typeof options.onProgress === "function" ? options.onProgress : null;
            const total_splits = copies.reduce((product, c) => product * (c + 1) * (c + 2) / 2, 1) - 2 * code_count + 1;
            const report_every = Math.max(1, Math.floor(total_splits / 2000)); // the bar moves in 0.05% steps
            let splits_done = 0;

            // The group with every entry (every digit full) is only ever the final step.
            // Renaming there adds 1 level to that step, which can push it past the limit, so
            // it is counted while searching rather than added afterwards.
            const everything = code_count - 1;
            const rename_levels = options.rename ? 1 : 0;

            // Reused for every previewed merge; a node is built only once it is kept.
            const totals = {};

            function isBeaten(kept, candidate) {
                for (let k = 0; k < kept.length; k++) {
                    if (dominates(kept[k], candidate)) return true;
                }
                return false;
            }

            function frontier(code) {
                const cached = memo[code];
                if (cached) return cached;

                // The kinds this group holds, how many of each, and the left part's count
                // of each. Every left part from "one item" up to "all but one" is tried, as
                // an odometer: bump the first digit, carrying into the next when it is full.
                const active = [];
                const have = [];
                for (let k = 0; k < kind_count; k++) {
                    const held = Math.floor(code / place[k]) % (copies[k] + 1);
                    if (held > 0) {
                        active.push(k);
                        have.push(held);
                    }
                }
                const take = new Array(active.length).fill(0);
                let left_code = 0;

                const best = new Map();
                for (;;) {
                    let digit = 0;
                    while (digit < active.length) {
                        const k = active[digit];
                        if (take[digit] < have[digit]) {
                            take[digit]++;
                            left_code += place[k];
                            break;
                        }
                        left_code -= take[digit] * place[k];
                        take[digit] = 0;
                        digit++;
                    }
                    if (digit === active.length || left_code === code) break; // all splits done

                    splits_done++;
                    if (on_progress && splits_done % report_every === 0) {
                        on_progress(splits_done, total_splits);
                    }
                    const left_nodes = frontier(left_code);
                    if (left_nodes.length === 0) continue;
                    const right_nodes = frontier(code - left_code);
                    for (const left of left_nodes) {
                        for (const right of right_nodes) {
                            const merge_levels = preview(left, right, cap, code === everything ? rename_levels : 0);
                            if (merge_levels < 0) continue;
                            previewTotals(left, right, merge_levels, totals);
                            const key = previewKey(totals.prior_work, layout);
                            const kept = best.get(key);

                            // Most merges lose to one already kept: skip them before
                            // building anything.
                            if (kept && isBeaten(kept, totals)) continue;
                            const node = buildNode(left, right, merge_levels, totals);
                            if (!kept) {
                                best.set(key, [node]);
                                continue;
                            }
                            // Drop the kept nodes the new one beats, in place.
                            let write = 0;
                            for (let read = 0; read < kept.length; read++) {
                                if (!dominates(node, kept[read])) kept[write++] = kept[read];
                            }
                            kept.length = write;
                            kept.push(node);
                        }
                    }
                }

                const result = [].concat(...best.values());
                memo[code] = result;
                return result;
            }

            const candidates = frontier(everything);
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
            if (chosen && rename_levels > 0) chosen.renamed = true;
            return chosen;
        }

        return { solve, combine, makeLeaf };
    }

    const api = { createEngine, experienceFromLevel, priorWorkPenalty, normalizePriority, CRITERIA, EDITIONS, MAXIMUM_MERGE_LEVELS, MAXIMUM_GROUPS };
    if (typeof module !== "undefined" && module.exports) {
        module.exports = api;
    } else {
        root.EnchantEngine = api;
    }
})(typeof self !== "undefined" ? self : this);
