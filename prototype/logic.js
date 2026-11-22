// Pure helpers for the prototype UI: no DOM access, so they can be tested on their own.

export const MAX_PRIOR_WORK = 6;

// Common choices when enchantments conflict, used by "Max all".
const PREFERRED = ["sharpness", "protection", "fortune", "mending", "depth_strider", "loyalty", "channeling", "multishot"];

export function roman(number) {
    const numerals = [[10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];
    let out = "";
    for (const [value, symbol] of numerals) {
        while (number >= value) {
            out += symbol;
            number -= value;
        }
    }
    return out;
}

export function createLogic(meta) {
    const enchantments = meta.enchantments;

    const enchName = ns => enchantments[ns].stylized;
    const maxLevel = ns => Number(enchantments[ns].max_level);
    const isCurse = ns => ns.endsWith("_curse");
    const itemName = ns => meta.items[ns];

    function conflicts(a, b) {
        if (a === b) return false;
        return enchantments[a].incompatible.includes(b) || enchantments[b].incompatible.includes(a);
    }

    function displayName(ns, level) {
        return maxLevel(ns) > 1 ? `${enchName(ns)} ${roman(level)}` : enchName(ns);
    }

    function summary(list) {
        return list.map(e => displayName(e.namespace, e.level)).join(", ");
    }

    // Enchantments that can go on an item, alphabetical, curses last.
    function applicable(item) {
        return Object.keys(enchantments)
            .filter(ns => enchantments[ns].items.includes(item))
            .sort((a, b) => (isCurse(a) - isCurse(b)) || enchName(a).localeCompare(enchName(b)));
    }

    function enchantableItems() {
        return Object.keys(meta.items).filter(item => item !== "book" && applicable(item).length > 0);
    }

    // Keep only valid, applicable, non-conflicting enchantments.
    function sanitizeEnchantments(raw, item) {
        const clean = {};
        if (!raw || typeof raw !== "object") return clean;
        const allowed = new Set(applicable(item));
        for (const [ns, value] of Object.entries(raw)) {
            const level = Number(value);
            if (!allowed.has(ns) || !Number.isInteger(level) || level < 1 || level > maxLevel(ns)) continue;
            if (Object.keys(clean).some(other => conflicts(other, ns))) continue;
            clean[ns] = level;
        }
        return clean;
    }

    function clampPriorWork(value) {
        const n = Number(value);
        return Number.isInteger(n) ? Math.min(MAX_PRIOR_WORK, Math.max(0, n)) : 0;
    }

    function maxAll(item, wanted) {
        const result = { ...wanted };
        const options = applicable(item).filter(ns => !isCurse(ns));
        const ordered = [...PREFERRED.filter(ns => options.includes(ns)), ...options.filter(ns => !PREFERRED.includes(ns))];
        for (const ns of ordered) {
            if (ns in result) {
                result[ns] = maxLevel(ns);
            } else if (!Object.keys(result).some(other => conflicts(other, ns))) {
                result[ns] = maxLevel(ns);
            }
        }
        return result;
    }

    // Books the calculation will use. Automatic mode: one book per wanted enchantment
    // the item doesn't already have at that level.
    function currentBooks(state) {
        if (!state.autoBooks) return state.books;
        return Object.entries(state.wanted)
            .filter(([ns, level]) => !((state.existing[ns] || 0) >= level))
            .map(([ns, level]) => ({ id: "auto-" + ns, enchantments: { [ns]: level }, prior_work: 0 }));
    }

    function buildEntries(state) {
        if (!state.item) return [];
        const item = [state.item, Object.entries(state.existing), state.itemPriorWork];
        const books = currentBooks(state)
            .filter(book => Object.keys(book.enchantments).length > 0)
            .map(book => ["book", Object.entries(book.enchantments), book.prior_work]);
        return [item, ...books];
    }

    // Wanted enchantments the result is missing or has at a lower level.
    function missing(state, node) {
        const have = Object.fromEntries(node.enchantments.map(e => [e.namespace, e.level]));
        return Object.entries(state.wanted)
            .filter(([ns, level]) => (have[ns] || 0) < level)
            .map(([ns, level]) => displayName(ns, level));
    }

    // Flattens the merge tree into anvil steps, children before parents.
    function collectSteps(root) {
        const steps = [];
        function visit(node) {
            if (!node.left) return { kind: "leaf", node };
            const left = visit(node.left);
            const right = visit(node.right);
            steps.push({ left, right, node });
            return { kind: "step", index: steps.length, node };
        }
        visit(root);
        return steps;
    }

    function serialize(state) {
        const data = {
            i: state.item,
            w: state.wanted,
            a: state.autoBooks ? 1 : 0,
            b: state.autoBooks ? [] : state.books.map(book => [book.enchantments, book.prior_work]),
            e: state.existing,
            p: state.itemPriorWork,
            o: state.objective === "xp" ? 1 : 0
        };
        return btoa(JSON.stringify(data)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    }

    function deserialize(text, makeId) {
        const data = JSON.parse(atob(text.replace(/-/g, "+").replace(/_/g, "/")));
        const item = typeof data.i === "string" && data.i in meta.items && data.i !== "book" ? data.i : null;
        if (!item) return null;
        const books = Array.isArray(data.b) ? data.b : [];
        return {
            item,
            wanted: sanitizeEnchantments(data.w, item),
            autoBooks: data.a !== 0,
            books: books.map(([enchants, priorWork]) => ({
                id: makeId(),
                enchantments: sanitizeEnchantments(enchants, item), // books only offer the item's enchantments
                prior_work: clampPriorWork(priorWork)
            })),
            existing: sanitizeEnchantments(data.e, item),
            itemPriorWork: clampPriorWork(data.p),
            objective: data.o === 1 ? "xp" : "levels"
        };
    }

    return {
        enchName, maxLevel, isCurse, itemName, conflicts, displayName, summary,
        applicable, enchantableItems, sanitizeEnchantments, clampPriorWork, maxAll,
        currentBooks, buildEntries, missing, collectSteps, serialize, deserialize
    };
}
