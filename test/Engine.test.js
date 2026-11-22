// Run with: node test/Engine.test.js
const assert = require("assert");
const path = require("path");
const { createEngine, experienceFromLevel } = require("../js/Engine.js");
const metadata = require(path.join(__dirname, "../json/metadata.json"));

const engine = createEngine(metadata);
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

function levelsOf(node) {
    return Object.fromEntries(node.enchantments.map(e => [e.namespace, e.level]));
}

test("experience formula matches the wiki", () => {
    assert.strictEqual(experienceFromLevel(0), 0);
    assert.strictEqual(experienceFromLevel(16), 352);
    assert.strictEqual(experienceFromLevel(30), 1395);
    assert.strictEqual(experienceFromLevel(39), 2727);
});

test("single book onto sword costs level x weight", () => {
    const result = engine.solve([["sword", [], 0], ["book", [["sharpness", 5]], 0]]);
    assert.strictEqual(result.cumulative_levels, 5);
    assert.strictEqual(result.prior_work, 1);
    assert.deepStrictEqual(levelsOf(result), { sharpness: 5 });
});

test("non-book sacrifice doubles the cost", () => {
    const left = engine.makeLeaf(["sword", [], 0]);
    const right = engine.makeLeaf(["sword", [["sharpness", 5]], 0]);
    assert.strictEqual(engine.combine(left, right).merge_levels, 10);
});

test("book cannot go in the left slot onto an item", () => {
    const book = engine.makeLeaf(["book", [["sharpness", 5]], 0]);
    const sword = engine.makeLeaf(["sword", [], 0]);
    assert.strictEqual(engine.combine(book, sword), null);
});

test("equal max-level enchantments do not exceed the cap", () => {
    const result = engine.solve([["book", [["sharpness", 5]], 0], ["book", [["sharpness", 5]], 0]]);
    assert.deepStrictEqual(levelsOf(result), { sharpness: 5 });
    assert.strictEqual(result.cumulative_levels, 5);
});

test("equal levels below the cap go up by one", () => {
    const result = engine.solve([["book", [["sharpness", 4]], 0], ["book", [["sharpness", 4]], 0]]);
    assert.deepStrictEqual(levelsOf(result), { sharpness: 5 });
});

test("incompatible enchantment is dropped and costs 1", () => {
    const left = engine.makeLeaf(["sword", [["sharpness", 5]], 0]);
    const right = engine.makeLeaf(["book", [["smite", 5]], 0]);
    const node = engine.combine(left, right);
    assert.deepStrictEqual(levelsOf(node), { sharpness: 5 });
    assert.strictEqual(node.merge_levels, 1);
});

test("order matters: II + II + III reaches IV", () => {
    const result = engine.solve([
        ["book", [["sharpness", 2]], 0],
        ["book", [["sharpness", 2]], 0],
        ["book", [["sharpness", 3]], 0]
    ]);
    assert.deepStrictEqual(levelsOf(result), { sharpness: 4 });
    assert.strictEqual(result.cumulative_levels, 3 + 4 + 1);
});

test("different item types cannot be combined", () => {
    assert.strictEqual(engine.solve([["sword", [], 0], ["pickaxe", [], 0]]), null);
});

test("too expensive merges are rejected", () => {
    const entries = [["sword", [], 5], ["book", [["sharpness", 5], ["unbreaking", 3], ["mending", 1]], 0]];
    assert.strictEqual(engine.solve(entries), null);
});

test("invalid input is rejected", () => {
    assert.throws(() => engine.solve([["sword", [["sharpness", 6]], 0]]));
    assert.throws(() => engine.solve([["sword", [["power", 1]], 0]]));
});

// Independent brute force: every binary merge tree, no memoization or pruning.
function bruteForce(entries) {
    const leaves = entries.map(engine.makeLeaf);
    function all(nodes) {
        if (nodes.length === 1) return nodes;
        const out = [];
        const n = nodes.length;
        for (let mask = 1; mask < (1 << n) - 1; mask++) {
            const left = nodes.filter((_, i) => mask & (1 << i));
            const right = nodes.filter((_, i) => !(mask & (1 << i)));
            for (const l of all(left)) for (const r of all(right)) {
                const c = engine.combine(l, r);
                if (c) out.push(c);
            }
        }
        return out;
    }
    const value = node => node.enchantments.reduce(
        (s, e) => s + e.level * metadata.enchantments[e.namespace].weight, 0);
    let best = null;
    for (const node of all(leaves)) {
        if (!best || value(node) > value(best) ||
            (value(node) === value(best) && node.cumulative_levels < best.cumulative_levels)) best = node;
    }
    return best;
}

test("memoized search matches brute force on random inputs", () => {
    const sword = ["sharpness", "smite", "unbreaking", "mending", "looting", "fire_aspect", "knockback", "sweeping"];
    let seed = 12345;
    const rand = k => (seed = (seed * 1103515245 + 12345) % 2147483648) % k;
    for (let trial = 0; trial < 60; trial++) {
        const count = 2 + rand(4);
        const entries = [["sword", [], rand(3)]];
        for (let i = 1; i < count; i++) {
            const picks = new Set([sword[rand(sword.length)], sword[rand(sword.length)]]);
            const list = [...picks].map(ns => [ns, 1 + rand(metadata.enchantments[ns].max_level)]);
            entries.push(["book", list, rand(2)]);
        }
        const fast = engine.solve(entries);
        const slow = bruteForce(entries);
        assert.strictEqual(fast === null, slow === null, JSON.stringify(entries));
        if (fast) {
            assert.strictEqual(fast.cumulative_levels, slow.cumulative_levels, JSON.stringify(entries));
            assert.deepStrictEqual(levelsOf(fast), levelsOf(slow), JSON.stringify(entries));
        }
    }
});

test("full god sword solves quickly", () => {
    const start = Date.now();
    const result = engine.solve([
        ["sword", [], 0],
        ["book", [["sharpness", 5]], 0],
        ["book", [["unbreaking", 3]], 0],
        ["book", [["mending", 1]], 0],
        ["book", [["looting", 3]], 0],
        ["book", [["fire_aspect", 2]], 0],
        ["book", [["knockback", 2]], 0],
        ["book", [["sweeping", 3]], 0]
    ]);
    assert.ok(result);
    assert.strictEqual(Object.keys(levelsOf(result)).length, 7);
    console.log(`       (${Date.now() - start} ms, ${result.cumulative_levels} levels total)`);
});

test("mace: Density and Breach conflict, Wind Burst does not", () => {
    const left = engine.makeLeaf(["mace", [["density", 5]], 0]);
    const breach = engine.combine(left, engine.makeLeaf(["book", [["breach", 4]], 0]));
    assert.deepStrictEqual(levelsOf(breach), { density: 5 });
    assert.strictEqual(breach.merge_levels, 1);
    const wind = engine.combine(left, engine.makeLeaf(["book", [["wind_burst", 3]], 0]));
    assert.deepStrictEqual(levelsOf(wind), { density: 5, wind_burst: 3 });
    assert.strictEqual(wind.merge_levels, 6);
});

test("spear: Lunge III book costs 3, Sweeping Edge is not allowed", () => {
    const result = engine.solve([["spear", [], 0], ["book", [["lunge", 3]], 0]]);
    assert.strictEqual(result.cumulative_levels, 3);
    assert.throws(() => engine.solve([["spear", [["sweeping", 1]], 0]]));
});

test("progress is reported, increases, and ends at 100%", () => {
    const calls = [];
    engine.solve([
        ["sword", [], 0],
        ["book", [["sharpness", 5]], 0],
        ["book", [["unbreaking", 3]], 0],
        ["book", [["mending", 1]], 0],
        ["book", [["looting", 3]], 0],
        ["book", [["fire_aspect", 2]], 0]
    ], { onProgress: (done, total) => calls.push([done, total]) });
    assert.ok(calls.length > 1);
    const total = calls[0][1];
    assert.strictEqual(total, 3 ** 6 - 2 ** 7 + 1);
    for (let i = 1; i < calls.length; i++) {
        assert.ok(calls[i][0] >= calls[i - 1][0]);
        assert.ok(calls[i][0] <= total);
    }
    assert.deepStrictEqual(calls[calls.length - 1], [total, total]);
});

console.log(`${passed} passed`);
