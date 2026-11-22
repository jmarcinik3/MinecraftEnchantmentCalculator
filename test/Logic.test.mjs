// Run with: node test/Logic.test.mjs
// js/Logic.js is a browser ES module in a folder without "type": "module",
// so load its source through a data: URL instead of a normal import.
import assert from "assert";
import { readFileSync } from "fs";

const read = path => readFileSync(new URL(path, import.meta.url), "utf8");
const { createLogic } = await import("data:text/javascript," + encodeURIComponent(read("../js/Logic.js")));
const meta = JSON.parse(read("../json/metadata.json"));
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

const baseState = item => ({ item, wanted: {}, auto_books: true, books: [], objective: "levels" });

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
        objective: "xp"
    };
    const loaded = logic.deserialize(logic.serialize(state), () => 1);
    assert.deepStrictEqual(loaded.books, [{ id: 1, type: "book", enchantments: { sharpness: 5 }, prior_work: 6 }]);
    assert.strictEqual(loaded.objective, "xp");
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

console.log(`${passed} passed`);
