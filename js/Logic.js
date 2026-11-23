// Pure helpers for the prototype UI: no DOM access, so they can be tested on their own.

export const MAX_STEP_LEVELS = 39; // a step costing 40+ levels is "Too Expensive!"
export const MAX_COPIES = 64;      // copies of one entry (a stack of books)

// Ranking criteria for the best order, in default order (must match Engine.js).
export const CRITERIA = ["levels", "xp", "max_step", "prior_work"];

// Valid, de-duplicated ranking; unlisted criteria are appended in default order.
export function normalizePriority(priority) {
    const listed = Array.isArray(priority) ? priority.filter(c => CRITERIA.includes(c)) : [];
    const unique = [...new Set(listed)];
    return [...unique, ...CRITERIA.filter(c => !unique.includes(c))];
}

// Moves the element at `index` by `offset` places, returning a new list (used for the
// ranking and for custom entries).
export function movePriority(priority, index, offset) {
    const target = index + offset;
    if (target < 0 || target >= priority.length) return priority;
    const result = [...priority];
    const [moved] = result.splice(index, 1);
    result.splice(target, 0, moved);
    return result;
}

// Highest prior work an item can have and still be used: each merge it is in costs at
// least its penalty, 2^n - 1 levels, so that must fit within the step limit.
// With no limit (Infinity) there is no maximum.
export function maxPriorWork(step_limit) {
    if (step_limit === Infinity) return Infinity;
    let prior_work = 0;
    while (2 ** (prior_work + 1) - 1 <= step_limit) prior_work++;
    return prior_work;
}

export function clampStepLimit(value) {
    const n = Number(value);
    return Number.isInteger(n) ? Math.min(MAX_STEP_LEVELS, Math.max(1, n)) : MAX_STEP_LEVELS;
}

// Game editions with their own anvil rules (must match Engine.js).
export const EDITIONS = ["java", "bedrock"];

// Longest name the anvil accepts, per edition (Minecraft Wiki, "Anvil mechanics").
export const MAX_NAME_LENGTH = { java: 50, bedrock: 30 };

// A rename as the anvil would take it: text only, cut to the edition's length.
export function cleanName(name, edition) {
    const text = typeof name === "string" ? name.replace(/[\u0000-\u001f\u007f]/g, "") : "";
    return [...text].slice(0, MAX_NAME_LENGTH[edition] || MAX_NAME_LENGTH.java).join("");
}

// The metadata as one edition sees it: an enchantment's `bedrock` object replaces its
// fields in Bedrock Edition, as Engine.js does (e.g. "items": [] where Bedrock has no
// such enchantment, so it is never offered).
export function editionMetadata(meta, edition) {
    if (edition !== "bedrock") return meta;
    const enchantments = {};
    for (const [ns, data] of Object.entries(meta.enchantments)) {
        enchantments[ns] = data.bedrock ? { ...data, ...data.bedrock } : data;
    }
    return { ...meta, enchantments };
}

// Share-link text: URL-safe base64 of the UTF-8 bytes, so names with any characters
// work (plain btoa only takes Latin-1). ASCII-only text encodes exactly as before, so
// older links still load.
function toLinkText(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromLinkText(link) {
    const binary = atob(link.replace(/-/g, "+").replace(/_/g, "/"));
    return new TextDecoder().decode(Uint8Array.from(binary, char => char.charCodeAt(0)));
}

// Most groups of entries the search may remember (must match Engine.js): as many as
// 20 all-different entries. Repeated entries add far fewer.
export const MAX_GROUPS = 2 ** 20;

// How big a search `entries` (from buildEntries) needs, counting identical entries once
// as Engine.js does: `groups` it must remember, and `splits` (left/right divisions) it
// tries, which is what the time grows with. With c copies of each kind:
//   groups = product of (c + 1), splits = product of (c + 1)(c + 2) / 2 - 2 groups + 1.
export function searchSize(entries) {
    const copies = new Map();
    for (const [item, enchantment_list, prior_work] of entries) {
        const sorted = [...enchantment_list].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        const kind = item + "|" + prior_work + "|" + sorted.map(([ns, level]) => ns + ":" + Number(level)).join(",");
        copies.set(kind, (copies.get(kind) || 0) + 1);
    }
    let groups = 1;
    let pairs = 1;
    for (const c of copies.values()) {
        groups *= c + 1;
        pairs *= (c + 1) * (c + 2) / 2;
    }
    return { groups, splits: pairs - 2 * groups + 1 };
}

// Common choices when enchantments conflict, used by "Max all".
const PREFERRED = ["sharpness", "density", "protection", "fortune", "mending", "depth_strider", "loyalty", "channeling", "multishot"];

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

    // Name color tier, as in Java Edition: items without a listed rarity are common, and
    // enchanting raises common/uncommon to rare and rare to epic (epic is the cap).
    // An enchanted book is a common book with enchantments, so it shows as rare.
    function rarity(item_ns, enchanted) {
        const base = (meta.rarity && meta.rarity[item_ns]) || "common";
        if (!enchanted) return base;
        return base === "rare" || base === "epic" ? "epic" : "rare";
    }

    function displayName(ns, level) {
        return maxLevel(ns) > 1 ? `${enchName(ns)} ${roman(level)}` : enchName(ns);
    }

    // Java Edition lists enchantments in tooltips in a fixed order (the
    // #minecraft:tooltip_order tag), not in the order they were added.
    const TOOLTIP_RANK = new Map((meta.tooltip_order || []).map((ns, index) => [ns, index]));

    function tooltipSort(list) {
        const rank = ns => (TOOLTIP_RANK.has(ns) ? TOOLTIP_RANK.get(ns) : Infinity);
        return [...list].sort((a, b) => rank(a.namespace) - rank(b.namespace));
    }

    function summary(list) {
        return tooltipSort(list).map(e => displayName(e.namespace, e.level)).join(", ");
    }

    // Enchantments that can go on an item, alphabetical, curses last.
    function applicable(item) {
        return Object.keys(enchantments)
            .filter(ns => enchantments[ns].items.includes(item))
            .sort((a, b) => (isCurse(a) - isCurse(b)) || enchName(a).localeCompare(enchName(b)));
    }

    // Applicable enchantments split into conflict groups (linked by incompatibility), in
    // `applicable` order: each group sits where its first member would, so curses stay last.
    // In an `exclusive` group every pair conflicts, so at most one can be chosen.
    function enchantmentGroups(item) {
        const list = applicable(item);
        const placed = new Set();
        const groups = [];
        for (const ns of list) {
            if (placed.has(ns)) continue;
            const linked = [ns];
            placed.add(ns);
            for (let i = 0; i < linked.length; i++) {
                for (const other of list) {
                    if (!placed.has(other) && conflicts(linked[i], other)) {
                        placed.add(other);
                        linked.push(other);
                    }
                }
            }
            const members = list.filter(other => linked.includes(other));
            const exclusive = members.length > 1 && members.every(a => members.every(b => a === b || conflicts(a, b)));
            groups.push({ members, exclusive });
        }
        return groups;
    }

    function enchantableItems() {
        return Object.keys(meta.items).filter(item => item !== "book" && applicable(item).length > 0);
    }

    // Keep only valid, applicable enchantments, dropping conflicts unless they are allowed.
    // `taken` lists enchantments already on other entries, which count as conflicts too.
    function sanitizeEnchantments(raw, item, allow_incompatible = false, taken = []) {
        const clean = {};
        if (!raw || typeof raw !== "object") return clean;
        const allowed = new Set(applicable(item));
        for (const [ns, value] of Object.entries(raw)) {
            const level = Number(value);
            if (!allowed.has(ns) || !Number.isInteger(level) || level < 1 || level > maxLevel(ns)) continue;
            if (!allow_incompatible && [...taken, ...Object.keys(clean)].some(other => conflicts(other, ns))) continue;
            clean[ns] = level;
        }
        return clean;
    }

    // Cleans each entry in order. The engine does not check conflicts, so without
    // `allow_incompatible` an enchantment that conflicts with one on an earlier entry is
    // dropped too: every enchantment on the anvil must be able to go together.
    function sanitizeBooks(books, item, allow_incompatible = false) {
        const taken = [];
        return books.map(book => {
            const enchantments = sanitizeEnchantments(book.enchantments, item, allow_incompatible, taken);
            taken.push(...Object.keys(enchantments));
            return { ...book, enchantments };
        });
    }

    function clampCopies(value) {
        const n = Number(value);
        return Number.isInteger(n) ? Math.min(MAX_COPIES, Math.max(1, n)) : 1;
    }

    function clampPriorWork(value) {
        const n = Number(value);
        return Number.isInteger(n) && n >= 0 ? n : 0;
    }

    function maxAll(item, wanted, allow_incompatible = false) {
        const result = { ...wanted };
        const options = applicable(item).filter(ns => !isCurse(ns));
        const ordered = [...PREFERRED.filter(ns => options.includes(ns)), ...options.filter(ns => !PREFERRED.includes(ns))];
        for (const ns of ordered) {
            if (ns in result) {
                result[ns] = maxLevel(ns);
            } else if (allow_incompatible || !Object.keys(result).some(other => conflicts(other, ns))) {
                result[ns] = maxLevel(ns);
            }
        }
        return result;
    }

    // Everything going on the anvil. Each entry has a `type` of "book" or "item" (a copy
    // of the item being enchanted). Automatic mode: one unenchanted item plus one book
    // per wanted enchantment.
    function currentBooks(state) {
        if (!state.auto_books) return state.books;
        const books = Object.entries(state.wanted)
            .map(([ns, level]) => ({ id: "auto-" + ns, type: "book", enchantments: { [ns]: level }, prior_work: 0 }));
        return [{ id: "auto-item", type: "item", enchantments: {}, prior_work: 0 }, ...books];
    }

    // Empty books do nothing and are skipped; items are kept even without enchantments,
    // since an unenchanted item is still something to enchant.
    function buildEntries(state) {
        if (!state.item) return [];
        return currentBooks(state)
            .filter(book => book.type === "item" || Object.keys(book.enchantments).length > 0)
            .flatMap(book => {
                const entry = [book.type === "item" ? state.item : "book", Object.entries(book.enchantments), book.prior_work];
                return Array.from({ length: book.copies || 1 }, () => entry);
            });
    }

    // Highest level of each enchantment the entries could make between them. Merging two
    // equal levels gives one level higher (up to the max) and unequal ones keep the
    // higher, so it works like carrying in addition: two IIs make a III, and so on.
    function bestLevels(state) {
        const best = {};
        for (const [ns, by_level] of Object.entries(levelCounts(currentBooks(state)))) best[ns] = topLevel(ns, by_level);
        return best;
    }

    // ns -> { level: how many copies have it }, over a list of entries.
    function levelCounts(books) {
        const counts = {};
        for (const book of books) {
            for (const [ns, level] of Object.entries(book.enchantments)) {
                counts[ns] = counts[ns] || {};
                counts[ns][level] = (counts[ns][level] || 0) + (book.copies || 1);
            }
        }
        return counts;
    }

    // Highest level `by_level` copies of `ns` can make (pairs carry up, as above).
    function topLevel(ns, by_level) {
        let carry = 0;
        let top = 0;
        for (let level = 1; level <= maxLevel(ns); level++) {
            const here = (by_level[level] || 0) + carry;
            if (here > 0) top = level;
            carry = level < maxLevel(ns) ? Math.floor(here / 2) : 0;
        }
        return top;
    }

    // The entry in `books` that `entry` is a copy of (same kind, enchantments and prior
    // work), or undefined.
    function twinOf(books, entry) {
        const key = book => book.type + "|" + book.prior_work + "|" +
            Object.entries(book.enchantments).sort(([a], [b]) => (a < b ? -1 : 1)).map(([ns, level]) => ns + level).join(",");
        return books.find(book => book !== entry && key(book) === key(entry));
    }

    // Adds one plain book with `ns` at `level` to the custom list, returning the new list
    // (the old one is not changed) and the entries it made unnecessary:
    //  - an identical plain book (same enchantments, no prior work) gets one more copy
    //    instead of a second entry;
    //  - entries whose only enchantment is that one at a lower level are dropped, books
    //    and items alike and whatever their prior work, lowest first, as long as the list
    //    still reaches the chosen level (Protection IV replaces a Protection I and II).
    //    Entries with other enchantments stay, and so does the last item entry, since
    //    without it there is nothing to enchant.
    // New entries have id null; the page gives them one.
    function addBook(state, ns, level) {
        const plain = book => book.type === "book" && book.prior_work === 0;
        const only = (book, name) => Object.keys(book.enchantments).length === 1 && name in book.enchantments;
        let books = state.books.map(book => ({ ...book }));
        const same = books.find(book => plain(book) && only(book, ns) && book.enchantments[ns] === level);
        if (same) same.copies = Math.min(MAX_COPIES, (same.copies || 1) + 1);
        else books.push({ id: null, type: "book", enchantments: { [ns]: level }, prior_work: 0, copies: 1 });

        const wanted = state.wanted[ns] || level;
        const reaches = list => (bestLevels({ ...state, auto_books: false, books: list })[ns] || 0) >= wanted;
        const removed = [];
        const lower = books
            .filter(book => only(book, ns) && book.enchantments[ns] < level)
            .sort((a, b) => a.enchantments[ns] - b.enchantments[ns]);
        for (const book of lower) {
            const without = books.filter(other => other !== book);
            const keeps_an_item = book.type !== "item" || without.some(other => other.type === "item");
            if (keeps_an_item && reaches(without)) {
                books = without;
                removed.push(book);
            }
        }
        return { books, removed, merged: Boolean(same) };
    }

    // Problems with a custom list that can be seen before calculating:
    //   short: wanted enchantments the entries cannot reach, [{ ns, wanted, best }]
    //          (best 0 means no entry has it);
    //   unwanted: enchantments on entries that were not chosen in section 2. They still
    //          end up on the item (the search keeps every enchantment it can), costing levels.
    function checkBooks(state) {
        if (state.auto_books || !state.item) return { short: [], unwanted: [] };
        const best = bestLevels(state);
        const short = Object.entries(state.wanted)
            .filter(([ns, level]) => (best[ns] || 0) < level)
            .map(([ns, level]) => ({ ns, wanted: level, best: best[ns] || 0 }));
        const unwanted = Object.keys(best).filter(ns => !(ns in state.wanted));
        return { short, unwanted };
    }

    // Wanted enchantments the result is missing or has at a lower level.
    function missing(state, node) {
        const have = Object.fromEntries(node.enchantments.map(e => [e.namespace, e.level]));
        return Object.entries(state.wanted)
            .filter(([ns, level]) => (have[ns] || 0) < level)
            .map(([ns, level]) => displayName(ns, level));
    }

    // Enchantments on the result that were not chosen (they came along on a book or item),
    // in tooltip order.
    function extra(state, node) {
        return tooltipSort(node.enchantments.filter(e => !(e.namespace in state.wanted)))
            .map(e => displayName(e.namespace, e.level));
    }

    // Flattens the merge tree into anvil steps, grouped into rounds. A step's round is one
    // after the latest round among the steps it needs (round 1 uses only starting items),
    // so steps in the same round don't depend on each other and can be done in any order.
    // Steps come round by round, cheapest first within a round, and are numbered 1, 2, ...
    // in that order. Each step is { left, right, node, round, number }, where `left` and
    // `right` are { kind: "leaf", node } or { kind: "step", index: <that step's number>, node }.
    function collectSteps(root) {
        const steps = [];
        function visit(node) {
            if (!node.left) return { kind: "leaf", node, round: 0 };
            const left = visit(node.left);
            const right = visit(node.right);
            const step = { left, right, node, round: Math.max(left.round, right.round) + 1 };
            steps.push(step);
            return { kind: "step", step, node, round: step.round };
        }
        visit(root);

        // Sort by round, then cost; ties keep the tree order (Array.prototype.sort is stable).
        steps.sort((a, b) => a.round - b.round || a.node.merge_levels - b.node.merge_levels);
        steps.forEach((step, position) => { step.number = position + 1; });
        for (const step of steps) {
            for (const side of ["left", "right"]) {
                const part = step[side];
                step[side] = part.kind === "step"
                    ? { kind: "step", index: part.step.number, node: part.node }
                    : { kind: "leaf", node: part.node };
            }
        }
        return steps;
    }

    // Splits collectSteps' list into its rounds: [[steps of round 1], [round 2], ...].
    function stepRounds(steps) {
        const rounds = [];
        for (const step of steps) (rounds[step.round - 1] ||= []).push(step);
        return rounds;
    }

    function serialize(state) {
        const data = {
            i: state.item,
            w: state.wanted,
            a: state.auto_books ? 1 : 0,
            // [enchantments, prior work, 1 if a copy of the item, copies (left out when 1)]
            b: state.auto_books ? [] : state.books.map(book => {
                const saved = [book.enchantments, book.prior_work, book.type === "item" ? 1 : 0];
                if ((book.copies || 1) > 1) saved.push(book.copies);
                return saved;
            }),
            p: state.priority.map(c => CRITERIA.indexOf(c)),
            c: state.max_step,
            n: state.no_step_limit ? 1 : 0,
            x: state.allow_incompatible ? 1 : 0,
            e: EDITIONS.indexOf(state.edition),
            r: state.rename ? 1 : 0,
            m: state.rename_to || undefined
        };
        return toLinkText(JSON.stringify(data));
    }

    function deserialize(text, makeId) {
        const data = JSON.parse(fromLinkText(text));
        const item = typeof data.i === "string" && data.i in meta.items && data.i !== "book" ? data.i : null;
        if (!item) return null;
        const books = Array.isArray(data.b) ? data.b : [];
        const allow_incompatible = data.x === 1;
        return {
            item,
            edition: EDITIONS[data.e] || EDITIONS[0],
            rename: data.r === 1,
            rename_to: cleanName(data.m, EDITIONS[data.e] || EDITIONS[0]),
            allow_incompatible,
            wanted: sanitizeEnchantments(data.w, item, allow_incompatible),
            auto_books: data.a !== 0,
            // Only the item's enchantments are offered, so others are dropped.
            books: sanitizeBooks(books.map(([enchants, prior_work, type_flag, copies]) => ({
                id: makeId(),
                type: type_flag === 1 ? "item" : "book",
                enchantments: enchants,
                prior_work: clampPriorWork(prior_work),
                copies: copies == null ? 1 : clampCopies(copies)
            })), item, allow_incompatible),
            // Older links stored one objective: `o` = 1 meant least XP.
            priority: Array.isArray(data.p)
                ? normalizePriority(data.p.map(index => CRITERIA[index]))
                : normalizePriority(data.o === 1 ? ["xp", "levels"] : []),
            max_step: data.c == null ? MAX_STEP_LEVELS : clampStepLimit(data.c),
            no_step_limit: data.n === 1
        };
    }

    return {
        enchName, maxLevel, isCurse, itemName, conflicts, rarity, displayName, tooltipSort, summary,
        applicable, enchantmentGroups, enchantableItems, sanitizeEnchantments, sanitizeBooks, clampPriorWork, clampCopies, maxAll,
        bestLevels, checkBooks, addBook, twinOf,
        currentBooks, buildEntries, missing, extra, collectSteps, stepRounds, serialize, deserialize
    };
}
