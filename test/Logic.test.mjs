// Run with: node test/Logic.test.mjs
// js/Logic.js is a browser ES module in a folder without "type": "module",
// so load its source through a data: URL instead of a normal import.
import assert from "assert";
import { readFileSync } from "fs";
import { createRequire } from "module";

const read = path => readFileSync(new URL(path, import.meta.url), "utf8");
// A module's source as a data: URL, with its imports of other files in js/ turned into
// data: URLs too (a data: URL has no folder to resolve "./" against).
const moduleUrl = path => "data:text/javascript," + encodeURIComponent(read(path)
    .replace(/from "\.\/([A-Za-z]+\.js)"/g, (_, file) => `from "${moduleUrl("../js/" + file)}"`));
const { createLogic, editionMetadata, levelTrack, anvilBreakChance, cleanName, MAX_NAME_LENGTH, MAX_COPIES, normalizePriority, movePriority, clampStepLimit, maxPriorWork, searchSize, MAX_GROUPS, CRITERIA, EDITIONS, MOD_IDS, withMods, modNames, linkMods } = await import(moduleUrl("../js/Logic.js"));
const meta = JSON.parse(read("../json/metadata.json"));
const { TEXT, LANGUAGES, compileText, setText } = await import(moduleUrl("../js/Text.js"));
const TEXTS = Object.fromEntries(Object.keys(LANGUAGES).map(code => [code, JSON.parse(read(`../json/text/${code}.json`))]));
setText(TEXTS.en, "en");
const logic = createLogic(meta, TEXTS.en.names);

let passed = 0;
function test(name, fn) {
    try {
        fn();
        passed++;
        console.log("  ok  " + name);
    } catch (error) {
        console.error("  FAIL " + name);
        console.error(error);
        process.exitCode = 1;
    }
}

const baseState = item => ({ item, wanted: {}, auto_books: true, books: [], priority: [...CRITERIA], max_step: 39, no_step_limit: false, allow_incompatible: false, edition: "java", rename: false, rename_to: "" });

test("every item has an icon file", () => {
    for (const item of meta.items) {
        const file = `${item}.svg`;
        assert.doesNotThrow(() => readFileSync(new URL(`../img/${file}`, import.meta.url)), file);
    }
});

test("Max all picks common defaults and skips curses", () => {
    assert.deepStrictEqual(Object.keys(logic.maxAll("mace", {})).sort(),
        ["density", "fire_aspect", "mending", "unbreaking", "wind_burst"]);
    const sword = logic.maxAll("sword", {});
    assert.strictEqual(sword.sharpness, 5);
    assert.ok(!("smite" in sword) && !("vanishing_curse" in sword));
});

test("automatic mode is one plain item plus one book per enchantment", () => {
    const state = { ...baseState("spear"), wanted: { lunge: 3, unbreaking: 3 } };
    assert.deepStrictEqual(logic.buildEntries(state), [
        ["spear", [], 0],
        ["book", [["lunge", 3]], 0],
        ["book", [["unbreaking", 3]], 0]
    ]);
});

test("customizing keeps the plain item as an entry", () => {
    const books = logic.currentBooks({ ...baseState("boots"), wanted: { feather_falling: 4 } });
    assert.deepStrictEqual(books.map(b => b.type), ["item", "book"]);
});

test("extra copies of the item are entered as that item, not as books", () => {
    const state = {
        ...baseState("helmet"),
        auto_books: false,
        books: [
            { id: 1, type: "item", enchantments: { protection: 4 }, prior_work: 1 },
            { id: 2, type: "book", enchantments: { respiration: 3 }, prior_work: 0 },
            { id: 3, type: "item", enchantments: {}, prior_work: 0 }
        ]
    };
    assert.deepStrictEqual(logic.buildEntries(state), [
        ["helmet", [["protection", 4]], 1],
        ["book", [["respiration", 3]], 0],
        ["helmet", [], 0]
    ]);
    const loaded = logic.deserialize(logic.serialize(state), () => 0);
    assert.deepStrictEqual(loaded.books.map(b => b.type), ["item", "book", "item"]);
});

test("tooltips use the game's fixed enchantment order", () => {
    const list = [
        { namespace: "mending", level: 1 },
        { namespace: "unbreaking", level: 3 },
        { namespace: "sharpness", level: 5 },
        { namespace: "vanishing_curse", level: 1 },
        { namespace: "looting", level: 3 }
    ];
    assert.deepStrictEqual(logic.tooltipSort(list).map(e => e.namespace),
        ["vanishing_curse", "sharpness", "looting", "unbreaking", "mending"]);
    assert.strictEqual(logic.summary(list.slice(0, 3)), "Sharpness V, Unbreaking III, Mending");
    assert.deepStrictEqual([...meta.tooltip_order].sort(), Object.keys(meta.enchantments).sort());
});

test("name rarity follows Java rules", () => {
    const cases = [
        ["sword", false, "common"], ["sword", true, "rare"],
        ["book", false, "common"], ["book", true, "rare"],
        ["recovery_compass", false, "uncommon"], ["recovery_compass", true, "rare"],
        ["trident", false, "rare"], ["trident", true, "epic"],
        ["mace", false, "epic"], ["mace", true, "epic"],
        ["elytra", false, "epic"]
    ];
    for (const [item, enchanted, expected] of cases) {
        assert.strictEqual(logic.rarity(item, enchanted), expected, `${item} enchanted=${enchanted}`);
    }
});

test("shared links round-trip and drop invalid data", () => {
    const state = {
        ...baseState("sword"),
        wanted: { sharpness: 5 },
        auto_books: false,
        books: [{ id: 1, enchantments: { sharpness: 5, smite: 5, power: 2 }, prior_work: 9 }],
        priority: ["max_step", "xp", "levels", "prior_work"],
        max_step: 25,
        no_step_limit: true
    };
    const loaded = logic.deserialize(logic.serialize(state), () => 1);
    assert.deepStrictEqual(loaded.books, [{ id: 1, type: "book", enchantments: { sharpness: 5 }, prior_work: 9, copies: 1 }]);
    assert.deepStrictEqual(loaded.priority, ["max_step", "xp", "levels", "prior_work"]);
    assert.strictEqual(loaded.max_step, 25);
    assert.strictEqual(loaded.no_step_limit, true);
});

test("old single-objective links still load", () => {
    const encode = data => btoa(JSON.stringify(data)).replace(/=+$/, "");
    const old = logic.deserialize(encode({ i: "sword", w: {}, a: 1, b: [], o: 1 }), () => 0);
    assert.deepStrictEqual(old.priority, ["xp", "levels", "max_step", "prior_work"]);
    assert.strictEqual(old.max_step, 39);
    assert.strictEqual(old.no_step_limit, false);
    const bad = logic.deserialize(encode({ i: "sword", w: {}, a: 1, b: [], p: [2, 2, 9], c: 99 }), () => 0);
    assert.deepStrictEqual(bad.priority, ["max_step", "levels", "xp", "prior_work"]);
    assert.strictEqual(bad.max_step, 39);
});

test("ranking criteria match the engine's", () => {
    const engine_api = createRequire(import.meta.url)("../js/Engine.js");
    assert.deepStrictEqual(CRITERIA, engine_api.CRITERIA);
});

test("Text.js has every ranking criterion and every page string", () => {
    assert.deepStrictEqual(Object.keys(TEXT.ranking.criteria), CRITERIA);
    for (const { label, help } of Object.values(TEXT.ranking.criteria)) assert.ok(label && help);
    const keys = [...read("../index.html").matchAll(/data-text(?:-label)?="([a-z_]+)\.([a-z_]+)"/g)];
    assert.ok(keys.length >= 6);
    for (const [, section, key] of keys) assert.strictEqual(typeof TEXT[section][key], "string", section + "." + key);
});

test("every language has the same text entries as English, of the same kind", () => {
    // Each entry's path, kind (plain, template or plural) and the values it fills in.
    const placeholders = text => [...new Set([...text.matchAll(/\{([a-z_]+)\}/g)].map(m => m[1]))].sort().join(",");
    const shape = (text, path = "") => Object.entries(text).flatMap(([key, value]) => {
        if (key === "names") return [];
        if (typeof value === "string") return [path + key + " " + (placeholders(value) ? "template:" + placeholders(value) : "plain")];
        if (value && "plural" in value) {
            assert.ok(value.other, path + key + " needs an \"other\" form");
            const forms = Object.keys(value).filter(form => form !== "plural");
            return [path + key + " plural:" + value.plural + ":" + [...new Set(forms.map(form => placeholders(value[form])))].join("|")];
        }
        return shape(value, path + key + ".");
    });
    const english = shape(TEXTS.en).sort();
    assert.deepStrictEqual(Object.keys(TEXTS), Object.keys(LANGUAGES));
    for (const [language, text] of Object.entries(TEXTS)) {
        assert.ok(LANGUAGES[language], language);
        assert.deepStrictEqual(shape(text).sort(), english, language);
        // Every item and enchantment is named, and nothing else.
        assert.deepStrictEqual(Object.keys(text.names.items).sort(), [...meta.items].sort(), language);
        assert.deepStrictEqual(Object.keys(text.names.enchantments).sort(), Object.keys(meta.enchantments).sort(), language);
        assert.deepStrictEqual(Object.keys(text.names.descriptions).sort(), Object.keys(meta.enchantments).sort(), language);
    }
});

test("text templates fill in values, plurals and lists in the language's way", () => {
    const english = compileText(TEXTS.en, "en"), spanish = compileText(TEXTS.es, "es");
    assert.strictEqual(english.books.add_book, "Add book");
    assert.strictEqual(english.wanted.replaces({ name: "Smite" }), "Replaces Smite");
    assert.strictEqual(english.results.text_totals({ levels: 1, xp: 1, max_step: 1 }), "1 level in total (1 XP), at most 1 in one step");
    assert.strictEqual(english.results.text_totals({ levels: 3, xp: 27, max_step: 2 }), "3 levels in total (27 XP), at most 2 in one step");
    assert.strictEqual(english.results.round({ number: 2, steps: 1 }), "Round 2");
    assert.strictEqual(english.results.round({ number: 2, steps: 3 }), "Round 2 · any order");
    assert.strictEqual(english.books.fix_replaces({ names: ["A", "B", "C"] }), "Replaces A, B, and C, no longer needed");
    assert.strictEqual(spanish.books.fix_replaces({ names: ["A", "B"] }), "Sustituye a A y B, que ya no hacen falta");
    assert.strictEqual(spanish.ranking.level_short_of({ short: 1, needed: 9 }), "Falta 1 nivel: este orden necesita 9");
    assert.strictEqual(english.names.items.boots, "Boots"); // names are kept as they are
    // TEXT is filled in place, so modules holding it see the language change.
    const held = TEXT;
    setText(TEXTS.es, "es");
    assert.strictEqual(held.books.add_book, "Añadir libro");
    setText(TEXTS.en, "en");
    assert.strictEqual(held.books.add_book, "Add book");
});

test("names come from the language's text, in every helper", () => {
    const spanish = createLogic(meta, TEXTS.es.names);
    assert.strictEqual(spanish.displayName("protection", 4), "Protección IV");
    assert.strictEqual(spanish.itemName("boots"), "Botas");
    assert.strictEqual(logic.displayName("protection", 4), "Protection IV");
    assert.strictEqual(createLogic(meta).itemName("boots"), "boots"); // no names: the namespace
    assert.ok(logic.isItem("boots") && !logic.isItem("boot"));
});

test("level track: the level before and after each step, and what is short", () => {
    assert.deepStrictEqual(levelTrack([3, 5, 10], 30), {
        steps: [{ before: 30, after: 27, short: 0 }, { before: 27, after: 22, short: 0 }, { before: 22, after: 12, short: 0 }],
        end: 12, short: 0
    });
    // 4 short at the last step, then 0 left; starting at 18 (the total) would be enough.
    const short = levelTrack([3, 5, 10], 14);
    assert.deepStrictEqual(short.steps[2], { before: 6, after: 0, short: 4 });
    assert.strictEqual(short.short, 4);
    assert.strictEqual(levelTrack([3, 5, 10], 18).short, 0);
    assert.strictEqual(levelTrack([2], "").steps[0].short, 2); // blank counts as 0
});

test("anvil break chance: 3 or more damages at 12% per use", () => {
    assert.strictEqual(anvilBreakChance(0), 0);
    assert.strictEqual(anvilBreakChance(2), 0);
    assert.ok(Math.abs(anvilBreakChance(3) - 0.12 ** 3) < 1e-12);
    // Brute force over every damage pattern for 8 uses.
    let expected = 0;
    for (let mask = 0; mask < 256; mask++) {
        let hits = 0;
        for (let bit = 0; bit < 8; bit++) hits += (mask >> bit) & 1;
        if (hits >= 3) expected += 0.12 ** hits * 0.88 ** (8 - hits);
    }
    assert.ok(Math.abs(anvilBreakChance(8) - expected) < 1e-12);
    assert.ok(anvilBreakChance(100) > 0.99);
});

test("search size counts identical entries once, matching the engine", () => {
    const engine_api = createRequire(import.meta.url)("../js/Engine.js");
    assert.strictEqual(MAX_GROUPS, engine_api.MAXIMUM_GROUPS);
    const engine = engine_api.createEngine(meta);
    const book = (ns, level, prior_work = 0) => ["book", [[ns, level]], prior_work];
    const inputs = [
        [["sword", [], 0], book("sharpness", 5), book("unbreaking", 3), book("mending", 1)],
        [["sword", [], 0], book("sharpness", 1), book("sharpness", 1), book("sharpness", 1), book("sharpness", 1, 1)],
        // Same enchantments listed in a different order are still identical.
        [["sword", [], 0], ["book", [["unbreaking", 1], ["looting", 1]], 0], ["book", [["looting", 1], ["unbreaking", 1]], 0]]
    ];
    for (const entries of inputs) {
        let total = null;
        engine.solve(entries, { onProgress: (done, all) => { total = all; } });
        assert.strictEqual(searchSize(entries).splits, total, JSON.stringify(entries));
    }
    assert.deepStrictEqual(searchSize(inputs[1]), { groups: 2 * 4 * 2, splits: 3 * 10 * 3 - 2 * 16 + 1 });
    // 40 copies of one book is tiny; 21 different entries is too many.
    assert.ok(searchSize(Array(40).fill(book("sharpness", 1))).groups <= MAX_GROUPS);
    const many = Array.from({ length: 21 }, (_, i) => book("sharpness", 1, i));
    assert.ok(searchSize(many).groups > MAX_GROUPS);
});

test("editions: Bedrock has no Sweeping Edge and cheaper Impaling", () => {
    assert.deepStrictEqual(EDITIONS, createRequire(import.meta.url)("../js/Engine.js").EDITIONS);
    const bedrock = createLogic(editionMetadata(meta, "bedrock"), TEXTS.en.names);
    assert.ok(logic.applicable("sword").includes("sweeping"));
    assert.ok(!bedrock.applicable("sword").includes("sweeping"));
    assert.strictEqual(editionMetadata(meta, "bedrock").enchantments.impaling.weight, 1);
    assert.strictEqual(editionMetadata(meta, "java"), meta);
    // Switching to Bedrock drops what it does not have.
    assert.deepStrictEqual(bedrock.sanitizeEnchantments({ sweeping: 3, sharpness: 5 }, "sword"), { sharpness: 5 });
});

test("shared links keep the edition and rename; old links default to Java", () => {
    const state = { ...baseState("sword"), edition: "bedrock", rename: true };
    const loaded = logic.deserialize(logic.serialize(state), () => 0);
    assert.strictEqual(loaded.edition, "bedrock");
    assert.strictEqual(loaded.rename, true);
    const old = logic.deserialize(btoa(JSON.stringify({ i: "sword", w: {}, a: 1, b: [] })).replace(/=+$/, ""), () => 0);
    assert.strictEqual(old.edition, "java");
    assert.strictEqual(old.rename, false);
    assert.strictEqual(old.rename_to, "");
});

test("the new name is saved in links and cut to the edition's length", () => {
    const state = { ...baseState("sword"), rename: true, rename_to: "Excalibur" };
    assert.strictEqual(logic.deserialize(logic.serialize(state), () => 0).rename_to, "Excalibur");
    // Any characters, not just Latin-1.
    const fancy = { ...state, rename_to: "Lumière ★ 剣 🗡" };
    assert.strictEqual(logic.deserialize(logic.serialize(fancy), () => 0).rename_to, "Lumière ★ 剣 🗡");
    const long = "x".repeat(60);
    assert.strictEqual(cleanName(long, "java").length, MAX_NAME_LENGTH.java);
    assert.strictEqual(cleanName(long, "bedrock").length, MAX_NAME_LENGTH.bedrock);
    assert.strictEqual(cleanName("a\nb", "java"), "ab");
    assert.strictEqual(cleanName(42, "java"), "");
    // Counted as the game does (UTF-16 units): 25 emoji fill a Java name, and none is cut in half.
    assert.strictEqual(cleanName("😀".repeat(60), "java"), "😀".repeat(25));
    assert.strictEqual(cleanName("a" + "😀".repeat(20), "bedrock"), "a" + "😀".repeat(14));
    const bedrock_link = logic.serialize({ ...state, edition: "bedrock", rename_to: long });
    assert.strictEqual(logic.deserialize(bedrock_link, () => 0).rename_to.length, MAX_NAME_LENGTH.bedrock);
});

test("copies: one entry per copy, saved in links, clamped", () => {
    const book = (enchantments, copies) => ({ id: 1, type: "book", enchantments, prior_work: 0, copies });
    const state = {
        ...baseState("sword"), auto_books: false,
        books: [{ id: 0, type: "item", enchantments: {}, prior_work: 0, copies: 1 }, book({ sharpness: 1 }, 4)]
    };
    const entries = logic.buildEntries(state);
    assert.strictEqual(entries.length, 5);
    assert.strictEqual(entries.filter(e => e[0] === "book").length, 4);
    const loaded = logic.deserialize(logic.serialize(state), () => 0);
    assert.deepStrictEqual(loaded.books.map(b => b.copies), [1, 4]);
    assert.strictEqual(logic.clampCopies(0), 1);
    assert.strictEqual(logic.clampCopies(999), MAX_COPIES);
    assert.strictEqual(logic.clampCopies("x"), 1);
    // Links from before copies existed load as single copies.
    const old = btoa(JSON.stringify({ i: "sword", w: {}, a: 0, b: [[{ sharpness: 1 }, 0, 0]] })).replace(/=+$/, "");
    assert.strictEqual(logic.deserialize(old, () => 0).books[0].copies, 1);
});

test("best levels follow the anvil: two equal levels make one higher", () => {
    const books = list => ({ ...baseState("sword"), auto_books: false, books: list.map(([enchantments, copies = 1]) => ({ id: 0, type: "book", enchantments, prior_work: 0, copies })) });
    assert.deepStrictEqual(logic.bestLevels(books([[{ sharpness: 1 }, 4]])), { sharpness: 3 });          // I+I=II, II+II=III
    assert.deepStrictEqual(logic.bestLevels(books([[{ sharpness: 1 }, 3]])), { sharpness: 2 });          // one I is left over
    assert.deepStrictEqual(logic.bestLevels(books([[{ sharpness: 4 }], [{ sharpness: 4 }]])), { sharpness: 5 });
    assert.deepStrictEqual(logic.bestLevels(books([[{ sharpness: 5 }, 8]])), { sharpness: 5 });          // capped at the max
    assert.deepStrictEqual(logic.bestLevels(books([[{ sharpness: 3 }], [{ sharpness: 2 }]])), { sharpness: 3 }); // unequal keep the higher
    assert.deepStrictEqual(logic.bestLevels(books([[{ sharpness: 2 }], [{ sharpness: 1 }, 2]])), { sharpness: 3 }); // I+I=II, then II+II=III
});

test("book checks: still needed and not chosen", () => {
    const state = {
        ...baseState("sword"),
        wanted: { sharpness: 5, mending: 1, unbreaking: 3 },
        auto_books: false,
        books: [
            { id: 0, type: "item", enchantments: {}, prior_work: 0, copies: 1 },
            { id: 1, type: "book", enchantments: { sharpness: 4 }, prior_work: 0, copies: 1 },
            { id: 2, type: "book", enchantments: { unbreaking: 3, knockback: 2 }, prior_work: 0, copies: 1 }
        ]
    };
    const check = logic.checkBooks(state);
    assert.deepStrictEqual(check.short, [{ ns: "sharpness", wanted: 5, best: 4 }, { ns: "mending", wanted: 1, best: 0 }]);
    assert.deepStrictEqual(check.unwanted, ["knockback"]);
    // A second Sharpness IV makes V, so Sharpness is no longer short.
    state.books[1].copies = 2;
    assert.deepStrictEqual(logic.checkBooks(state).short.map(s => s.ns), ["mending"]);
    // Automatic books always match what was chosen.
    assert.deepStrictEqual(logic.checkBooks({ ...state, auto_books: true }), { short: [], unwanted: [] });
});

test("extra enchantments on the result are the ones not chosen, in tooltip order", () => {
    const state = { ...baseState("sword"), wanted: { sharpness: 5 } };
    const node = { enchantments: [{ namespace: "knockback", level: 2 }, { namespace: "sharpness", level: 5 }, { namespace: "unbreaking", level: 3 }] };
    assert.deepStrictEqual(logic.extra(state, node), logic.tooltipSort(node.enchantments.filter(e => e.namespace !== "sharpness")).map(e => logic.displayName(e.namespace, e.level)));
    assert.deepStrictEqual(logic.extra({ ...state, wanted: { sharpness: 5, knockback: 2, unbreaking: 3 } }, node), []);
});

test("the fix, one book at the chosen level, replaces every lower book of it", () => {
    const entry = (enchantments, copies = 1) => ({ id: 1, type: "book", enchantments, prior_work: 0, copies });
    const boots = books => ({ ...baseState("boots"), wanted: { protection: 4 }, auto_books: false,
        books: [{ id: 0, type: "item", enchantments: {}, prior_work: 0, copies: 1 }, ...books] });
    for (const books of [[entry({ protection: 1 }), entry({ protection: 2 })], [entry({ protection: 3 })], [entry({ protection: 1 }, 5)], []]) {
        const state = boots(books);
        const [short] = logic.checkBooks(state).short;
        const { books: fixed, removed } = logic.addBook(state, short.ns, short.wanted);
        assert.strictEqual(removed.length, books.length, JSON.stringify(books));
        assert.deepStrictEqual(fixed.map(b => b.enchantments), [{}, { protection: 4 }]);
        assert.deepStrictEqual(logic.checkBooks({ ...state, books: fixed }).short, []);
    }
});

test("adding a suggested book: merges with an identical one, drops books it replaces", () => {
    const entry = (enchantments, copies = 1, prior_work = 0) => ({ id: 1, type: "book", enchantments, prior_work, copies });
    const boots = (books, wanted = { protection: 4 }) => ({ ...baseState("boots"), wanted, auto_books: false,
        books: [{ id: 0, type: "item", enchantments: {}, prior_work: 0, copies: 1 }, ...books] });

    // Protection IV replaces a Protection I and II.
    const one = entry({ protection: 1 }), two = entry({ protection: 2 });
    const state = boots([one, two]);
    const result = logic.addBook(state, "protection", 4);
    assert.deepStrictEqual(result.removed, [one, two]);
    assert.deepStrictEqual(result.books.map(b => b.enchantments), [{}, { protection: 4 }]);
    assert.strictEqual(result.merged, false);
    assert.strictEqual(state.books.length, 3); // the old list is not changed

    // The new book goes where the first book it replaces was, not at the end.
    const mending = entry({ mending: 1 });
    const in_place = logic.addBook(boots([entry({ protection: 1 }), mending]), "protection", 4);
    assert.deepStrictEqual(in_place.books.map(b => b.enchantments), [{}, { protection: 4 }, { mending: 1 }]);
    const nothing_replaced = logic.addBook(boots([mending]), "protection", 4);
    assert.deepStrictEqual(nothing_replaced.books.map(b => b.enchantments), [{}, { mending: 1 }, { protection: 4 }]);

    // A second Protection III becomes 2 copies; nothing lower to drop.
    const three = entry({ protection: 3 });
    const merged = logic.addBook(boots([three]), "protection", 3);
    assert.strictEqual(merged.merged, true);
    assert.deepStrictEqual(merged.books.map(b => [b.enchantments, b.copies]), [[{}, 1], [{ protection: 3 }, 2]]);

    // Kept: a lower book that is still needed, and one with other enchantments.
    const needed = logic.addBook(boots([entry({ protection: 2 }, 1)], { protection: 3 }), "protection", 2); // II + II = III
    assert.deepStrictEqual(needed.removed, []);
    const mixed = entry({ protection: 1, unbreaking: 3 });
    assert.deepStrictEqual(logic.addBook(boots([mixed]), "protection", 4).removed, []);

    // Replaced even with prior work, and items too, but never the last item.
    const worked = entry({ protection: 2 }, 1, 3);
    assert.deepStrictEqual(logic.addBook(boots([worked]), "protection", 4).removed, [worked]);
    const old_boots = { id: 7, type: "item", enchantments: { protection: 1 }, prior_work: 2, copies: 1 };
    assert.deepStrictEqual(logic.addBook(boots([old_boots]), "protection", 4).removed, [old_boots]); // the plain boots remain
    const only_boots = { ...baseState("boots"), wanted: { protection: 4 }, auto_books: false, books: [old_boots] };
    const kept = logic.addBook(only_boots, "protection", 4);
    assert.deepStrictEqual(kept.removed, []);
    assert.deepStrictEqual(kept.books.map(b => b.type), ["item", "book"]);
});

test("an entry's twin: same kind, enchantments (any order) and prior work", () => {
    const books = [
        { id: 1, type: "book", enchantments: { unbreaking: 3, mending: 1 }, prior_work: 0, copies: 1 },
        { id: 2, type: "book", enchantments: { mending: 1 }, prior_work: 1, copies: 1 }
    ];
    assert.strictEqual(logic.twinOf(books, { id: 3, type: "book", enchantments: { mending: 1, unbreaking: 3 }, prior_work: 0 }), books[0]);
    assert.strictEqual(logic.twinOf(books, { id: 4, type: "book", enchantments: { mending: 1 }, prior_work: 0 }), undefined);
    assert.strictEqual(logic.twinOf(books, { id: 5, type: "item", enchantments: { mending: 1 }, prior_work: 1 }), undefined);
    assert.strictEqual(logic.twinOf(books, books[0]), undefined); // not itself
});

test("ranking helpers", () => {
    assert.deepStrictEqual(movePriority(CRITERIA, 2, -1), ["levels", "max_step", "xp", "prior_work"]);
    assert.deepStrictEqual(movePriority(CRITERIA, 0, -1), CRITERIA);
    assert.deepStrictEqual(normalizePriority(["prior_work"]), ["prior_work", "levels", "xp", "max_step"]);
    assert.strictEqual(clampStepLimit(0), 1);
    assert.strictEqual(clampStepLimit("12"), 12);
    assert.strictEqual(clampStepLimit("x"), 39);
});

test("conflicting enchantments are grouped in list order", () => {
    const names = groups => groups.map(g => (g.exclusive ? "!" : "") + g.members.join("/"));
    const sword = logic.enchantmentGroups("sword");
    assert.ok(names(sword).includes("!bane_of_arthropods/sharpness/smite"));
    // Every applicable enchantment appears exactly once, in `applicable` order.
    assert.deepStrictEqual(sword.flatMap(g => g.members).sort(), logic.applicable("sword").sort());
    const firsts = sword.map(g => logic.applicable("sword").indexOf(g.members[0]));
    assert.deepStrictEqual(firsts, [...firsts].sort((a, b) => a - b));
    // Riptide conflicts with Loyalty and Channeling, which work together: not "pick one".
    assert.ok(names(logic.enchantmentGroups("trident")).includes("channeling/loyalty/riptide"));
    assert.ok(names(logic.enchantmentGroups("boots")).includes("!depth_strider/frost_walker"));
    for (const item of logic.enchantableItems()) {
        const groups = logic.enchantmentGroups(item);
        const curse_start = groups.findIndex(g => logic.isCurse(g.members[0]));
        if (curse_start >= 0) assert.ok(groups.slice(curse_start).every(g => logic.isCurse(g.members[0])), item);
    }
});

test("conflicts are kept only when allowed", () => {
    assert.deepStrictEqual(logic.sanitizeEnchantments({ sharpness: 5, smite: 5 }, "sword"), { sharpness: 5 });
    assert.deepStrictEqual(logic.sanitizeEnchantments({ sharpness: 5, smite: 5 }, "sword", true), { sharpness: 5, smite: 5 });
    const all = logic.maxAll("sword", {}, true);
    assert.ok(all.sharpness && all.smite && all.bane_of_arthropods);
    const state = { ...baseState("sword"), wanted: { sharpness: 5, smite: 5 }, allow_incompatible: true };
    const loaded = logic.deserialize(logic.serialize(state), () => 0);
    assert.strictEqual(loaded.allow_incompatible, true);
    assert.deepStrictEqual(loaded.wanted, { sharpness: 5, smite: 5 });
    const vanilla = logic.deserialize(logic.serialize({ ...state, allow_incompatible: false }), () => 0);
    assert.deepStrictEqual(vanilla.wanted, { sharpness: 5 });
});

test("mace: Density and Breach conflict, Wind Burst does not", () => {
    assert.strictEqual(logic.conflicts("density", "breach"), true);
    assert.strictEqual(logic.conflicts("density", "wind_burst"), false);
});

test("entries may not conflict with each other unless allowed", () => {
    const books = [
        { id: 1, type: "item", enchantments: { sharpness: 5 }, prior_work: 0 },
        { id: 2, type: "book", enchantments: { smite: 5, unbreaking: 3 }, prior_work: 0 },
        { id: 3, type: "book", enchantments: { sharpness: 4 }, prior_work: 0 }
    ];
    const vanilla = logic.sanitizeBooks(books, "sword");
    assert.deepStrictEqual(vanilla.map(b => b.enchantments), [{ sharpness: 5 }, { unbreaking: 3 }, { sharpness: 4 }]);
    const modded = logic.sanitizeBooks(books, "sword", true);
    assert.deepStrictEqual(modded.map(b => b.enchantments), books.map(b => b.enchantments));
    const state = { ...baseState("sword"), auto_books: false, books };
    const loaded = logic.deserialize(logic.serialize(state), () => 0);
    assert.deepStrictEqual(loaded.books.map(b => b.enchantments), vanilla.map(b => b.enchantments));
});

test("max prior work follows the step limit", () => {
    assert.deepStrictEqual([39, 31, 30, 20, 12, 1].map(maxPriorWork), [5, 5, 4, 4, 3, 1]);
    assert.strictEqual(maxPriorWork(Infinity), Infinity);
    assert.strictEqual(logic.clampPriorWork(12), 12);
    assert.strictEqual(logic.clampPriorWork(-1), 0);
    assert.strictEqual(logic.clampPriorWork(1.5), 0);
});

test("steps are listed children first", () => {
    const leaf = ns => ({ item_namespace: ns, enchantments: [], left: null, right: null });
    const inner = { item_namespace: "book", enchantments: [], left: leaf("book"), right: leaf("book") };
    const root = { item_namespace: "sword", enchantments: [], left: leaf("sword"), right: inner };
    const steps = logic.collectSteps(root);
    assert.strictEqual(steps.length, 2);
    assert.strictEqual(steps[0].node, inner);
    assert.deepStrictEqual([steps[1].right.kind, steps[1].right.index], ["step", 1]);
});

test("ticking a step ticks the steps before it; unticking one unticks the steps after it", () => {
    const leaf = ns => ({ item_namespace: ns, enchantments: [], left: null, right: null });
    const merge = (left, right, cost) => ({ item_namespace: left.item_namespace, enchantments: [], merge_levels: cost, left, right });
    // Numbers: 1 = b (2), 2 = a (5), 3 = c (b + book), 4 = sword + a, 5 = 4 + 3.
    const a = merge(leaf("book"), leaf("book"), 5);
    const b = merge(leaf("book"), leaf("book"), 2);
    const c = merge(b, leaf("book"), 7);
    const steps = logic.collectSteps(merge(merge(leaf("sword"), a, 9), c, 4));
    const sorted = set => [...set].sort((x, y) => x - y);
    assert.deepStrictEqual(sorted(logic.tickStep(steps, new Set(), 3, true)), [1, 3]);
    assert.deepStrictEqual(sorted(logic.tickStep(steps, new Set(), 5, true)), [1, 2, 3, 4, 5]);
    assert.deepStrictEqual(sorted(logic.tickStep(steps, new Set([1, 2, 3, 4, 5]), 1, false)), [2, 4]); // 3 and 5 used it
    assert.deepStrictEqual(sorted(logic.tickStep(steps, new Set([1, 2, 3, 4, 5]), 5, false)), [1, 2, 3, 4]);
    const done = new Set([2]);
    logic.tickStep(steps, done, 4, true);
    assert.deepStrictEqual(sorted(done), [2]); // the old set is not changed
});

test("presets: the best set, then each well-known swap the item can take", () => {
    const keys = item => logic.presets(item).map(p => p.key);
    assert.deepStrictEqual(keys("pickaxe"), ["best", "silk_touch"]);
    assert.deepStrictEqual(keys("boots"), ["best", "frost_walker"]);
    assert.deepStrictEqual(keys("book"), []);
    assert.deepStrictEqual(keys("sword"), logic.presets("sword").map(p => p.key)); // (the same presets with conflicts allowed: the page passes no flag)
    const [best, silk] = logic.presets("pickaxe");
    assert.deepStrictEqual(best.wanted, logic.maxAll("pickaxe", {}));
    assert.strictEqual(silk.wanted.silk_touch, 1);
    assert.ok(!("fortune" in silk.wanted) && silk.wanted.efficiency === 5);
    const trident = logic.presets("trident").find(p => p.key === "riptide").wanted;
    assert.ok(!("loyalty" in trident) && !("channeling" in trident));
    assert.strictEqual(logic.bookCost("thorns", 3), 12);
    assert.strictEqual(logic.bookCost("sharpness", 5), 5);
    assert.strictEqual(logic.describe("mending"), TEXTS.en.names.descriptions.mending);
});

test("typed books: names from their start, levels, commas between books and + within one", () => {
    const read = text => logic.parseBooks(text, "boots");
    assert.deepStrictEqual(read("prot 4, mending"), { books: [{ protection: 4 }, { mending: 1 }], unknown: [] });
    assert.deepStrictEqual(read("unb III + thorns").books, [{ unbreaking: 3, thorns: 3 }]); // no level: the max
    assert.deepStrictEqual(read("feather falling 9").books, [{ feather_falling: 4 }]); // capped
    assert.deepStrictEqual(read("fire prot 2").books, [{ fire_protection: 2 }]);
    assert.deepStrictEqual(read("curse vanish").books, [{ vanishing_curse: 1 }]); // every word a start
    assert.deepStrictEqual(read("soul_speed 1").books, [{ soul_speed: 1 }]); // namespaces too
    assert.deepStrictEqual(read("mending, sharpness 5 + unb"), { books: [{ mending: 1 }], unknown: ["sharpness 5"] }); // not on boots
    const spanish = createLogic(meta, TEXTS.es.names);
    assert.deepStrictEqual(spanish.parseBooks("proteccion 3, reparacion", "boots").books, [{ protection: 3 }, { mending: 1 }]);
});

test("steps are grouped into rounds of independent steps, cheapest first", () => {
    const leaf = ns => ({ item_namespace: ns, enchantments: [], left: null, right: null });
    const merge = (left, right, cost) => ({ item_namespace: left.item_namespace, enchantments: [], merge_levels: cost, left, right });
    // Two independent first steps (costs 5 and 2), then one using the cheap one, then the last.
    const a = merge(leaf("book"), leaf("book"), 5);
    const b = merge(leaf("book"), leaf("book"), 2);
    const c = merge(b, leaf("book"), 7);
    const root = merge(merge(leaf("sword"), a, 9), c, 4);
    const steps = logic.collectSteps(root);
    const shape = steps.map(s => [s.number, s.round, s.node.merge_levels]);
    assert.deepStrictEqual(shape, [[1, 1, 2], [2, 1, 5], [3, 2, 7], [4, 2, 9], [5, 3, 4]]);
    // Children always come before the steps that use them, and references use the new numbers.
    for (const step of steps) {
        for (const part of [step.left, step.right]) if (part.kind === "step") assert.ok(part.index < step.number);
    }
    assert.deepStrictEqual([steps[2].left.kind, steps[2].left.index], ["step", 1]); // c uses b, now step 1
    assert.deepStrictEqual(logic.stepRounds(steps).map(round => round.map(s => s.number)), [[1, 2], [3, 4], [5]]);
});

test("a share link can carry the ticked steps, and plain links carry none", () => {
    const state = { item: "sword", edition: "java", wanted: { sharpness: 5 }, auto_books: true, books: [],
        priority: ["levels"], max_step: 39, no_step_limit: false, allow_incompatible: false, rename: false, rename_to: "" };
    assert.strictEqual(logic.deserialize(logic.serialize(state), () => 0).progress, null);
    const link = logic.serialize(state, { key: "abc12", done: [1, 3] });
    assert.deepStrictEqual(logic.deserialize(link, () => 0).progress, { key: "abc12", done: [1, 3] });
    assert.strictEqual(logic.deserialize(logic.serialize(state, { key: "abc12", done: [] }), () => 0).progress, null);
    // Anything but whole step numbers is dropped.
    const bad = logic.deserialize(btoa(JSON.stringify({ i: "sword", w: {}, a: 1, b: [], t: [2, "x", -1, 1.5, 5000], k: "q" })).replace(/=+$/, ""), () => 0);
    assert.deepStrictEqual(bad.progress, { key: "q", done: [2] });
});

test("the recovery compass takes Curse of Vanishing in Bedrock only", () => {
    const bedrock = createLogic(editionMetadata(meta, "bedrock"), TEXTS.en.names);
    assert.ok(!logic.enchantableItems().includes("recovery_compass"));
    assert.ok(bedrock.enchantableItems().includes("recovery_compass"));
});

// ---------- Mods (json/mods/<id>.json) ----------
const MODS = Object.fromEntries(MOD_IDS.map(id => [id, JSON.parse(read(`../json/mods/${id}.json`))]));

test("every mod's data is well formed: items, levels, weights, conflicts and a name for each enchantment", () => {
    for (const [id, mod] of Object.entries(MODS)) {
        assert.strictEqual(mod.id, id);
        assert.ok(mod.label && mod.note && mod.source, id);
        for (const [ns, data] of Object.entries(mod.enchantments)) {
            assert.ok(ns.includes(":") && !(ns in meta.enchantments), ns);
            assert.ok(data.items.length && data.items.every(item => meta.items.includes(item)), ns);
            assert.ok(Number.isInteger(data.max_level) && data.max_level >= 1, ns);
            assert.ok(Number.isInteger(data.weight) && data.weight >= 1, ns);
            for (const other of data.incompatible) assert.ok(other in meta.enchantments || other in mod.enchantments, ns + " conflicts with unknown " + other);
            assert.ok(mod.names.en[ns], "name of " + ns);
            assert.ok(!(mod.descriptions.en[ns] || "").includes("§"), "colour code in " + ns);
        }
        for (const language of Object.keys(mod.names)) for (const ns of Object.keys(mod.names[language])) assert.ok(ns in mod.enchantments, ns);
    }
});

test("withMods adds the mods' enchantments after the game's own, tagged with the mod, and drops conflicts it can't show", () => {
    const fancy = MODS.fancy_enchantments;
    const merged = withMods(meta, [fancy]);
    assert.strictEqual(withMods(meta, []), meta);
    assert.strictEqual(Object.keys(merged.enchantments).length, Object.keys(meta.enchantments).length + Object.keys(fancy.enchantments).length);
    assert.deepStrictEqual(merged.tooltip_order.slice(0, meta.tooltip_order.length), meta.tooltip_order);
    const modded = createLogic(merged, { ...TEXTS.en.names, ...modNames([fancy], "en") });
    assert.strictEqual(modded.modOf("fancyenchantments:advanced_sharpness"), "Fancy Enchantments");
    assert.strictEqual(modded.modOf("sharpness"), null);
    assert.ok(modded.conflicts("sharpness", "fancyenchantments:advanced_sharpness"));
    assert.strictEqual(modded.enchName("fancyenchantments:advanced_sharpness"), "Advanced Sharpness");
    const odd = withMods(meta, [{ label: "Odd", enchantments: { "odd:one": { incompatible: ["odd:gone", "sharpness"], items: ["sword"], max_level: 1, weight: 1 } } }]);
    assert.deepStrictEqual(odd.enchantments["odd:one"].incompatible, ["sharpness"]);
    // The game's own listed first, a mod's last.
    const list = modded.applicable("sword");
    assert.ok(list.indexOf("fancyenchantments:air_attack") > list.indexOf("vanishing_curse"));
});

test("conflictTree splits a bracket again and again, with as few strays as it takes", () => {
    const make = edges => {
        const keys = [...new Set(Object.keys(edges).concat(...Object.values(edges)))];
        const enchantments = Object.fromEntries(keys.map(ns => [ns, { incompatible: keys.filter(other => edges[ns]?.includes(other) || edges[other]?.includes(ns)), items: ["sword"], max_level: 1, weight: 1 }]));
        return createLogic({ ...meta, enchantments: { ...meta.enchantments, ...enchantments } });
    };
    const show = node => (node.kind === "leaf" ? node.ns : (node.kind === "each" ? "each(" : "side(") + node.children.map(show).sort().join(" ") + ")");
    // h conflicts with everything; {p, q} and {r, s, t} are each every-pair-conflicting but never conflict with each other; u and v conflict with all of those but not each other.
    const nested = make({ h: [..."pqrstuv"], p: [..."quv"], q: [..."uv"], r: [..."stuv"], s: [..."tuv"], t: [..."uv"] });
    const found = nested.conflictTree([..."hpqrstuv"]);
    assert.strictEqual(show(found.tree), "side(each(side(p q) side(r s t)) each(u v) h)");
    assert.deepStrictEqual(found.strays, []);
    // Pick one in each: two cliques joined by an enchantment that conflicts with all of both.
    assert.strictEqual(show(make({ j: [..."abcd"], a: ["b"], c: ["d"] }).conflictTree([..."jabcd"]).tree), "side(each(side(a b) side(c d)) j)");
    // A path of four needs a stray (the one with the fewest conflicts first); a path of sixteen would need four.
    const path4 = make({ a: ["b"], b: ["c"], c: ["d"] });
    const stray = path4.conflictTree([..."abcd"]);
    assert.strictEqual(stray.strays.length, 1);
    const letters = "abcdefghijklmnop";
    const path16 = make(Object.fromEntries([...letters].slice(0, 15).map((ns, i) => [ns, [letters[i + 1]]])));
    assert.strictEqual(path16.conflictTree([...letters]), null);
    // Fancy Enchantments' chestplate: Pyromaniac is the one stray; the protections and the shields split around it.
    const fancy = createLogic(withMods(meta, [MODS.fancy_enchantments]), { ...TEXTS.en.names, ...modNames([MODS.fancy_enchantments], "en") });
    const group = fancy.enchantmentGroups("chestplate").find(each => each.members.length > 6 && !each.exclusive);
    assert.deepStrictEqual(fancy.conflictTree(group.members).strays, ["fancyenchantments:pyromaniac"]);
    // A clique is a Pick one: a side of leaves.
    assert.strictEqual(show(logic.conflictTree(["protection", "fire_protection", "blast_protection", "projectile_protection"]).tree), "side(blast_protection fire_protection projectile_protection protection)");
});

test("Max all and the presets never add a mod's enchantments, but typed books can name them", () => {
    const modded = createLogic(withMods(meta, [MODS.fancy_enchantments]), { ...TEXTS.en.names, ...modNames([MODS.fancy_enchantments], "en") });
    assert.deepStrictEqual(modded.maxAll("sword", {}), logic.maxAll("sword", {}));
    for (const preset of modded.presets("sword")) assert.ok(Object.keys(preset.wanted).every(ns => !modded.modOf(ns)));
    assert.ok("fancyenchantments:air_attack" in modded.parseBooks("air attack 2", "sword").books[0]);
    assert.ok("sharpness" in modded.parseBooks("sharp", "sword").books[0]);
});

test("a share link carries the mods, and reads their enchantments only with them", () => {
    const fancy = MODS.fancy_enchantments;
    const modded = createLogic(withMods(meta, [fancy]), { ...TEXTS.en.names, ...modNames([fancy], "en") });
    const state = { ...baseState("sword"), mods: ["fancy_enchantments"], wanted: { sharpness: 5, "fancyenchantments:air_attack": 2 } };
    const link = modded.serialize(state);
    assert.deepStrictEqual(linkMods(link), ["fancy_enchantments"]);
    const read_back = modded.deserialize(link, () => 0);
    assert.deepStrictEqual(read_back.mods, ["fancy_enchantments"]);
    assert.deepStrictEqual(read_back.wanted, { sharpness: 5, "fancyenchantments:air_attack": 2 });
    // Without the mod's data the enchantment is dropped; links without mods are unchanged and name none.
    assert.deepStrictEqual(logic.deserialize(link, () => 0).wanted, { sharpness: 5 });
    assert.deepStrictEqual(linkMods(logic.serialize(baseState("sword"))), []);
    assert.deepStrictEqual(linkMods("not a link"), []);
    assert.deepStrictEqual(logic.deserialize(logic.serialize({ ...baseState("sword"), mods: [] }), () => 0).mods, []);
});

console.log(`${passed} passed`);
