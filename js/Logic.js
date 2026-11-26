// Pure helpers for the page: no DOM access, so they can be tested on their own.

export const MAX_STEP_LEVELS = 39; // a step costing 40+ levels is "Too Expensive!"
export const MAX_COPIES = 64;      // copies of one entry (a stack of books)
// Highest prior work an entry may have (a link with more is cut to it): its penalty, 2^30 - 1
// levels, is already far past any limit, and a bigger one would only overflow.
export const MAX_PRIOR_WORK = 30;

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

// A share link's edition field (`e`, an index into EDITIONS) as an edition; Java for anything else.
function linkEditionOf(index) {
    return Number.isInteger(index) && EDITIONS[index] ? EDITIONS[index] : EDITIONS[0];
}

// Longest name the anvil accepts, per edition (Minecraft Wiki, "Anvil mechanics").
export const MAX_NAME_LENGTH = { java: 50, bedrock: 30 };

// A rename as the anvil would take it: text only, cut to the edition's length. The game
// counts UTF-16 units (Java's String.length, like the box's maxlength), so an emoji is 2;
// the cut never splits one in half.
export function cleanName(name, edition) {
    const text = typeof name === "string" ? name.replace(/[\u0000-\u001f\u007f]/g, "") : "";
    const limit = MAX_NAME_LENGTH[edition] || MAX_NAME_LENGTH.java;
    let kept = "";
    for (const character of text) {
        if (kept.length + character.length > limit) break;
        kept += character;
    }
    return kept;
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

// Mods whose enchantments can be added (Game rules > Mods). Each has a data file, json/mods/<id>.json:
// { id, label, note, source, enchantments: {ns: {incompatible, items, max_level, weight}} (as in metadata.json,
// keyed by the mod's own ids), names: {en: {ns: name}, <language>: ...}, descriptions: likewise }. Java only.
export const MOD_IDS = ["fancy_enchantments", "spellbound"];

// The metadata with the given mods' enchantments added. They list after the game's own in a tooltip, and a
// conflict naming an enchantment that is not there (one the app can't show) is dropped.
export function withMods(meta, mods) {
    if (!mods.length) return meta;
    const enchantments = { ...meta.enchantments };
    const tooltip_order = [...(meta.tooltip_order || [])];
    for (const mod of mods) {
        for (const [ns, data] of Object.entries(mod.enchantments)) {
            enchantments[ns] = { ...data, mod: mod.label };
            tooltip_order.push(ns);
        }
    }
    for (const mod of mods) {
        for (const ns of Object.keys(mod.enchantments)) {
            enchantments[ns] = { ...enchantments[ns], incompatible: enchantments[ns].incompatible.filter(other => other in enchantments) };
        }
    }
    return { ...meta, enchantments, tooltip_order };
}

// The mods' names and descriptions in one language (English where a mod has none in it), shaped like `names`.
export function modNames(mods, language) {
    const pick = (mod, kind) => ({ ...(mod[kind] && mod[kind].en), ...(mod[kind] && mod[kind][language]) });
    return {
        enchantments: Object.assign({}, ...mods.map(mod => pick(mod, "names"))),
        descriptions: Object.assign({}, ...mods.map(mod => pick(mod, "descriptions")))
    };
}

// The mods a share link names (so their data can be loaded before the link is read).
export function linkMods(text) {
    try {
        const data = JSON.parse(fromLinkText(text));
        return Array.isArray(data.d) ? MOD_IDS.filter(id => data.d.includes(id)) : [];
    } catch {
        return [];
    }
}

// The edition a share link names (so it can be read with that edition's helpers: Bedrock
// offers enchantments Java does not, such as Curse of Vanishing on a recovery compass).
export function linkEdition(text) {
    try {
        return linkEditionOf(JSON.parse(fromLinkText(text)).e);
    } catch {
        return EDITIONS[0];
    }
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

// Each anvil use has a 12% chance to damage the anvil (Java and Bedrock alike), and a
// new anvil breaks on its 3rd damage (anvil -> chipped -> damaged -> gone).
const ANVIL_DAMAGE_CHANCE = 0.12;
const ANVIL_DAMAGE_STAGES = 3;

// The chance that a new anvil breaks somewhere in `uses` uses: 3 or more damages.
export function anvilBreakChance(uses) {
    if (uses < ANVIL_DAMAGE_STAGES) return 0;
    const p = ANVIL_DAMAGE_CHANCE;
    let survive = 0; // chance of fewer than 3 damages
    let term = (1 - p) ** uses; // chance of exactly k damages, starting at k = 0
    for (let k = 0; k < ANVIL_DAMAGE_STAGES && k <= uses; k++) {
        survive += term;
        term *= ((uses - k) / (k + 1)) * (p / (1 - p));
    }
    return Math.max(0, 1 - survive);
}

// Follows the player's level through the steps in order (each step needs at least its
// cost, which it then takes). When a step costs more than the player has, `short` is how
// many levels to gain first; they are then assumed to have exactly enough, so 0 after.
// Returns { steps: [{ before, after, short }], end, short } with the totals.
export function levelTrack(costs, start_level) {
    let level = Math.max(0, Math.floor(Number(start_level) || 0));
    let total_short = 0;
    const steps = costs.map(cost => {
        const before = level;
        const short = Math.max(0, cost - level);
        total_short += short;
        level = Math.max(0, level - cost);
        return { before, after: level, short };
    });
    return { steps, end: level, short: total_short };
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

// The well-known swaps from the best set, each offered as a preset of its own: the best
// set with this one in place of what it conflicts with (Silk Touch for Fortune...).
const PRESET_SWAPS = ["silk_touch", "frost_walker", "smite", "bane_of_arthropods", "breach", "infinity", "piercing", "riptide"];

export function roman(number) {
    const numerals = [[100, "C"], [90, "XC"], [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];
    let out = "";
    for (const [value, symbol] of numerals) {
        while (number >= value) {
            out += symbol;
            number -= value;
        }
    }
    return out;
}

// `names`: the item and enchantment names in the page's language, { items: {ns: name},
// enchantments: {ns: name} } (`names` in json/text/<language>.json). A missing name
// shows as its namespace.
export function createLogic(meta, names = {}) {
    const enchantments = meta.enchantments;
    const items = new Set(meta.items);

    const enchName = ns => (names.enchantments && names.enchantments[ns]) || ns;
    const maxLevel = ns => Number(enchantments[ns].max_level);
    const isCurse = ns => ns.endsWith("_curse");
    const itemName = ns => (names.items && names.items[ns]) || ns;
    // What an enchantment does, in a few words ("" when the language has none).
    const describe = ns => (names.descriptions && names.descriptions[ns]) || "";

    function conflicts(a, b) {
        if (a === b) return false;
        return enchantments[a].incompatible.includes(b) || enchantments[b].incompatible.includes(a);
    }

    // The enchantments `item` can take that conflict with `ns`.
    function conflictsWith(ns, item) {
        return applicable(item).filter(other => conflicts(ns, other));
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

    // The name of the mod an enchantment comes from, or null for the game's own.
    const modOf = ns => enchantments[ns].mod || null;

    // Enchantments that can go on an item, alphabetical, curses last, then the mods' (so their
    // conflict groups follow the game's own).
    function applicable(item) {
        return Object.keys(enchantments)
            .filter(ns => enchantments[ns].items.includes(item))
            .sort((a, b) => (Boolean(modOf(a)) - Boolean(modOf(b))) || String(modOf(a)).localeCompare(String(modOf(b))) || (isCurse(a) - isCurse(b)) || enchName(a).localeCompare(enchName(b)));
    }

    // Applicable enchantments split into conflict groups (linked by incompatibility), in
    // `applicable` order: each group sits where its first member would, so curses stay last.
    // In an `exclusive` group every pair conflicts, so at most one can be chosen.
    // `own_only`: leave out the mods' enchantments (their conflicts then do not link or add groups).
    function enchantmentGroups(item, own_only = false) {
        const list = applicable(item).filter(ns => !own_only || !modOf(ns));
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

    // The conflicts of a bracket as a tree, found by splitting it again and again (a cograph): sets that never conflict with each other, or
    // enchantments that conflict with all the rest of a set. A node is a leaf (one enchantment), "each" (parts that do not conflict with each
    // other: pick from every part) or "side" (parts that all conflict with each other: pick one part, and inside it whatever that part
    // allows). A clique is a "side" of leaves (Pick one); an "each" node is cliques that never conflict (Pick any);
    // Pick a side is a "side" of "each"s of leaves. An enchantment that conflicts with everything else (Selfish) is just a leaf part. When the
    // bracket cannot be split as it is (a path of four, such as Pyromaniac joining a chestplate's protections to its shields), as few
    // strays as it takes (up to three, the ones with the fewest conflicts first) are set apart so the rest splits. Returns
    // { tree, strays }, or null for any bracket that still cannot be split.
    const tree_cache = new Map();
    function conflictTree(members) {
        const key = members.join();
        if (tree_cache.has(key)) return tree_cache.get(key);
        const found = members.length > 32 ? null : findTree(members);
        tree_cache.set(key, found);
        return found;
    }
    function findTree(members) {
        const linked = (ids, joined) => {
            const left = new Set(ids), found = [];
            for (const start of ids) {
                if (!left.has(start)) continue;
                left.delete(start);
                const part = new Set([start]), todo = [start];
                while (todo.length) {
                    const ns = todo.pop();
                    for (const other of ids) if (left.has(other) && joined(ns, other)) { left.delete(other); part.add(other); todo.push(other); }
                }
                found.push(ids.filter(ns => part.has(ns)));
            }
            return found;
        };
        const build = ids => {
            if (ids.length === 1) return { kind: "leaf", ns: ids[0] };
            const apart = linked(ids, conflicts);
            const kind = apart.length > 1 ? "each" : "side";
            const parts = apart.length > 1 ? apart : linked(ids, (a, b) => !conflicts(a, b));
            if (parts.length < 2) return null;
            const children = parts.map(build);
            return children.every(Boolean) ? { kind, children } : null;
        };
        const degree = ns => members.filter(other => conflicts(ns, other)).length;
        const order = [...members].sort((a, b) => degree(a) - degree(b) || members.indexOf(a) - members.indexOf(b));
        const choose = (count, from, taken) => (count === 0 ? [taken] : from.flatMap((ns, i) => choose(count - 1, from.slice(i + 1), [...taken, ns])));
        for (let count = 0; count <= 3; count++) {
            for (const strays of choose(count, order, [])) {
                const rest = members.filter(ns => !strays.includes(ns));
                if (!rest.length) continue;
                const tree = build(rest);
                if (tree && tree.kind !== "leaf") return { tree, strays };
            }
        }
        return null;
    }

    function enchantableItems() {
        return meta.items.filter(item => item !== "book" && applicable(item).length > 0);
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
        return Number.isInteger(n) && n >= 0 ? Math.min(MAX_PRIOR_WORK, n) : 0;
    }

    function maxAll(item, wanted, allow_incompatible = false) {
        const result = { ...wanted };
        // Only the game's own enchantments: a mod's are chosen by hand.
        const options = applicable(item).filter(ns => !isCurse(ns) && !modOf(ns));
        const ordered = [...PREFERRED.filter(ns => options.includes(ns)), ...options.filter(ns => !PREFERRED.includes(ns))];
        for (const ns of ordered) {
            if (ns in result || allow_incompatible || !Object.keys(result).some(other => conflicts(other, ns))) result[ns] = maxLevel(ns);
        }
        return result;
    }

    // Section 1's presets: "best" (Max all from nothing), then one per swap in
    // PRESET_SWAPS that the item can take and the best set leaves out. Each is
    // { key: "best" | swap namespace, wanted }. None for the plain book (it takes every
    // enchantment, so a "best" set means little). The same presets whether or not conflicts are allowed.
    function presets(item) {
        if (!item || item === "book") return [];
        const best = maxAll(item, {});
        const list = [{ key: "best", wanted: best }];
        const options = applicable(item);
        for (const ns of PRESET_SWAPS) {
            if (options.includes(ns) && !(ns in best)) list.push({ key: ns, wanted: maxAll(item, { [ns]: maxLevel(ns) }) });
        }
        return list;
    }

    // Roughly what adding `ns` at `level` from a book costs on its own: the level times
    // the book multiplier, before any prior work (the hint beside a chosen enchantment).
    function bookCost(ns, level) {
        return level * Number(enchantments[ns].weight);
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
    // Unless conflicts are allowed, the enchantments on other entries that conflict with `ns`
    // are taken off them (as the picker does), and a book left with none is dropped:
    // `dropped` lists them, [{ ns, level }].
    // A new book takes the place of the first entry it replaces (at the end if it
    // replaces none). New entries have id null; the page gives them one.
    function addBook(state, ns, level) {
        const plain = book => book.type === "book" && book.prior_work === 0;
        const only = (book, name) => Object.keys(book.enchantments).length === 1 && name in book.enchantments;
        let books = state.books.map(book => ({ ...book, enchantments: { ...book.enchantments } }));
        const dropped = [];
        const removed = [];
        if (!state.allow_incompatible) {
            const emptied = new Set();
            for (const book of books) {
                for (const [other, other_level] of Object.entries(book.enchantments)) {
                    if (!conflicts(other, ns)) continue;
                    delete book.enchantments[other];
                    dropped.push({ ns: other, level: other_level });
                    if (book.type === "book" && !Object.keys(book.enchantments).length) emptied.add(book);
                }
            }
            books = books.filter(book => !emptied.has(book));
        }
        const position = new Map(books.map((book, index) => [book, index]));
        const same = books.find(book => plain(book) && only(book, ns) && book.enchantments[ns] === level);
        const added = same ? null : { id: null, type: "book", enchantments: { [ns]: level }, prior_work: 0, copies: 1 };
        if (same) same.copies = Math.min(MAX_COPIES, (same.copies || 1) + 1);
        else books.push(added);

        const wanted = state.wanted[ns] || level;
        const reaches = list => (bestLevels({ ...state, auto_books: false, books: list })[ns] || 0) >= wanted;
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
        if (added && removed.length) {
            const first = Math.min(...removed.map(book => position.get(book)));
            books = books.filter(book => book !== added);
            books.splice(books.filter(book => position.get(book) < first).length, 0, added);
        }
        return { books, removed, dropped, merged: Boolean(same) };
    }

    // Books typed in a box, e.g. "prot 4, mending, unb 3 + thorns": commas (or new lines)
    // between books, "+" between the enchantments on one book. Each enchantment is the
    // start of its name in the page's language (or its namespace), accents and case
    // ignored, optionally followed by a level (4 or IV; the max if left out, capped at
    // it). Returns { books: [{ns: level}], unknown: [parts it couldn't read] }; a book with
    // a part it couldn't read is left out whole.
    function parseBooks(text, item) {
        const options = applicable(item);
        const key = value => value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[\s_]+/g, " ").trim();
        // A Roman numeral as the game writes it (any level: Spellbound's Dullness goes to X), or null.
        const ROMAN_VALUES = { i: 1, v: 5, x: 10, l: 50, c: 100 };
        const fromRoman = word => {
            if (!/^[ivxlc]+$/.test(word)) return null;
            let value = 0;
            for (let index = 0; index < word.length; index++) {
                const here = ROMAN_VALUES[word[index]];
                const next = ROMAN_VALUES[word[index + 1]] || 0;
                value += here < next ? -here : here;
            }
            return roman(value).toLowerCase() === word ? value : null;
        };
        const names = options.map(ns => ({ ns, names: [key(enchName(ns)), key(ns)] }));
        const find = query => {
            const exact = names.find(entry => entry.names.includes(query));
            if (exact) return exact.ns;
            const words = query.split(" ");
            const matches = names.filter(entry => entry.names.some(name =>
                name.startsWith(query) || words.every(word => name.split(" ").some(part => part.startsWith(word)))));
            matches.sort((a, b) => (Boolean(modOf(a.ns)) - Boolean(modOf(b.ns))) || a.names[0].length - b.names[0].length);
            return matches.length ? matches[0].ns : null;
        };
        const books = [];
        const unknown = [];
        for (const piece of String(text).split(/[,;\n]+/)) {
            const enchantments = {};
            let readable = true;
            for (const part of piece.split("+")) {
                const words = key(part).split(" ").filter(Boolean);
                if (!words.length) continue;
                let level = null;
                const last = words[words.length - 1];
                if (words.length > 1 && (/^\d+$/.test(last) || fromRoman(last))) {
                    level = /^\d+$/.test(last) ? Number(last) : fromRoman(last);
                    words.pop();
                }
                // Level 0 is no level at all: the part can't be read.
                const ns = level === 0 ? null : find(words.join(" "));
                if (!ns) {
                    unknown.push(part.trim());
                    readable = false;
                    continue;
                }
                enchantments[ns] = Math.min(maxLevel(ns), level || maxLevel(ns));
            }
            if (readable && Object.keys(enchantments).length) books.push(enchantments);
        }
        return { books, unknown };
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

    // The checklist after ticking or unticking step `number` (collectSteps' numbers; `done`
    // is the Set of ticked ones, left as it is). A step can only be done once the steps
    // that made its two inputs are, so ticking one also ticks those, all the way down;
    // unticking one also unticks the later steps that use its result, all the way up.
    function tickStep(steps, done, number, checked) {
        const by_number = new Map(steps.map(step => [step.number, step]));
        const used_by = new Map();
        for (const step of steps) {
            for (const side of [step.left, step.right]) {
                if (side.kind === "step") used_by.set(side.index, step.number);
            }
        }
        const next = new Set(done);
        const spread = (start, neighbours) => {
            const queue = [start];
            while (queue.length) {
                const current = queue.pop();
                if (checked) next.add(current);
                else next.delete(current);
                for (const other of neighbours(current)) queue.push(other);
            }
        };
        if (checked) {
            spread(number, n => [by_number.get(n).left, by_number.get(n).right].filter(side => side.kind === "step").map(side => side.index));
        } else {
            spread(number, n => (used_by.has(n) ? [used_by.get(n)] : []));
        }
        return next;
    }

    // Splits collectSteps' list into its rounds: [[steps of round 1], [round 2], ...].
    function stepRounds(steps) {
        const rounds = [];
        for (const step of steps) (rounds[step.round - 1] ||= []).push(step);
        return rounds;
    }

    // `progress`: { key, done } (the ticked steps of the order on screen; `key` names that
    // order) to carry along, so a link can carry on from where another device stopped.
    function serialize(state, progress = null) {
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
            d: state.mods && state.mods.length ? state.mods : undefined,
            r: state.rename ? 1 : 0,
            m: state.rename_to || undefined,
            t: progress && progress.done.length ? progress.done : undefined,
            k: progress && progress.done.length ? progress.key : undefined
        };
        return toLinkText(JSON.stringify(data));
    }

    function deserialize(text, makeId) {
        const data = JSON.parse(fromLinkText(text));
        const item = typeof data.i === "string" && items.has(data.i) && data.i !== "book" ? data.i : null;
        if (!item) return null;
        // Entries that are not [enchantments, prior work, type, copies] are skipped.
        const books = Array.isArray(data.b) ? data.b.filter(Array.isArray) : [];
        const allow_incompatible = data.x === 1;
        const edition = linkEditionOf(data.e);
        return {
            item,
            edition,
            rename: data.r === 1,
            rename_to: cleanName(data.m, edition),
            allow_incompatible,
            mods: Array.isArray(data.d) ? MOD_IDS.filter(id => data.d.includes(id)) : [],
            wanted: sanitizeEnchantments(data.w, item, allow_incompatible),
            auto_books: data.a !== 0,
            // Only the item's enchantments are offered, so others are dropped.
            books: sanitizeBooks(books.map(([enchants, prior_work, type_flag, copies]) => ({
                id: makeId(),
                type: type_flag === 1 ? "item" : "book",
                enchantments: enchants,
                prior_work: clampPriorWork(prior_work),
                copies: clampCopies(copies)
            })), item, allow_incompatible),
            // Older links stored one objective: `o` = 1 meant least XP.
            priority: Array.isArray(data.p)
                ? normalizePriority(data.p.map(index => CRITERIA[index]))
                : normalizePriority(data.o === 1 ? ["xp", "levels"] : []),
            max_step: data.c == null ? MAX_STEP_LEVELS : clampStepLimit(data.c),
            no_step_limit: data.n === 1,
            // Ticked steps carried by the link (see serialize), or null. Only whole numbers
            // survive; the page uses them only if the link's key names the order it finds.
            progress: Array.isArray(data.t) && typeof data.k === "string"
                ? { key: data.k, done: data.t.filter(number => Number.isInteger(number) && number > 0 && number < 1000) }
                : null
        };
    }

    return {
        isItem: ns => items.has(ns), enchName, describe, presets, bookCost, maxLevel, isCurse, itemName, conflicts, rarity, displayName, tooltipSort, summary,
        modOf, conflictsWith, applicable, enchantmentGroups, conflictTree, enchantableItems, sanitizeEnchantments, sanitizeBooks, clampPriorWork, clampCopies, maxAll,
        bestLevels, checkBooks, addBook, twinOf, parseBooks,
        currentBooks, buildEntries, missing, extra, collectSteps, stepRounds, tickStep, serialize, deserialize
    };
}
