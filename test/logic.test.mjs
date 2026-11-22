// Run with: node test/logic.test.mjs
// js/logic.js is a browser ES module in a folder without "type": "module",
// so load its source through a data: URL instead of a normal import.
import assert from "assert";
import { readFileSync } from "fs";

const read = path => readFileSync(new URL(path, import.meta.url), "utf8");
const { createLogic } = await import("data:text/javascript," + encodeURIComponent(read("../js/logic.js")));
const meta = JSON.parse(read("../json/metadata.json"));
const L = createLogic(meta);

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

const baseState = item => ({ item, wanted: {}, autoBooks: true, books: [], existing: {}, itemPriorWork: 0, objective: "levels" });

test("every item has an icon file", () => {
    for (const item of Object.keys(meta.items)) {
        const file = (meta.icons && meta.icons[item]) || `${item}.png`;
        assert.doesNotThrow(() => readFileSync(new URL(`../img/${file}`, import.meta.url)), file);
    }
});

test("Max all picks common defaults and skips curses", () => {
    assert.deepStrictEqual(Object.keys(L.maxAll("mace", {})).sort(),
        ["density", "fire_aspect", "mending", "unbreaking", "wind_burst"]);
    const sword = L.maxAll("sword", {});
    assert.strictEqual(sword.sharpness, 5);
    assert.ok(!("smite" in sword) && !("vanishing_curse" in sword));
});

test("automatic books skip enchantments the item already has", () => {
    const state = { ...baseState("spear"), wanted: { lunge: 3, unbreaking: 3 }, existing: { unbreaking: 3 } };
    assert.deepStrictEqual(L.buildEntries(state), [
        ["spear", [["unbreaking", 3]], 0],
        ["book", [["lunge", 3]], 0]
    ]);
});

test("shared links round-trip and drop invalid data", () => {
    const state = {
        ...baseState("sword"),
        wanted: { sharpness: 5 },
        autoBooks: false,
        books: [{ id: 1, enchantments: { sharpness: 5, smite: 5, power: 2 }, prior_work: 9 }],
        objective: "xp"
    };
    const loaded = L.deserialize(L.serialize(state), () => 1);
    assert.deepStrictEqual(loaded.books, [{ id: 1, enchantments: { sharpness: 5 }, prior_work: 6 }]);
    assert.strictEqual(loaded.objective, "xp");
});

test("steps are listed children first", () => {
    const leaf = ns => ({ item_namespace: ns, enchantments: [], left: null, right: null });
    const inner = { item_namespace: "book", enchantments: [], left: leaf("book"), right: leaf("book") };
    const root = { item_namespace: "sword", enchantments: [], left: leaf("sword"), right: inner };
    const steps = L.collectSteps(root);
    assert.strictEqual(steps.length, 2);
    assert.strictEqual(steps[0].node, inner);
    assert.deepStrictEqual([steps[1].right.kind, steps[1].right.index], ["step", 1]);
});

console.log(`${passed} passed`);
