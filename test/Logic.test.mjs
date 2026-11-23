// Run with: node test/Logic.test.mjs
// js/Logic.js is a browser ES module in a folder without "type": "module",
// so load its source through a data: URL instead of a normal import.
import assert from "assert";
import { readFileSync } from "fs";
import { createRequire } from "module";

const read = path => readFileSync(new URL(path, import.meta.url), "utf8");
const { createLogic, editionMetadata, cleanName, MAX_NAME_LENGTH, normalizePriority, movePriority, clampStepLimit, maxPriorWork, searchSize, MAX_GROUPS, CRITERIA, EDITIONS } = await import("data:text/javascript," + encodeURIComponent(read("../js/Logic.js")));
const meta = JSON.parse(read("../json/metadata.json"));
const { TEXT } = await import("data:text/javascript," + encodeURIComponent(read("../js/Text.js")));
const logic = createLogic(meta);

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
    for (const item of Object.keys(meta.items)) {
        const file = (meta.icons && meta.icons[item]) || `${item}.png`;
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
    assert.deepStrictEqual(loaded.books, [{ id: 1, type: "book", enchantments: { sharpness: 5 }, prior_work: 9 }]);
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
    const bedrock = createLogic(editionMetadata(meta, "bedrock"));
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
    const bedrock_link = logic.serialize({ ...state, edition: "bedrock", rename_to: long });
    assert.strictEqual(logic.deserialize(bedrock_link, () => 0).rename_to.length, MAX_NAME_LENGTH.bedrock);
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

console.log(`${passed} passed`);
