# Enchantment Calculator

Finds the cheapest order to combine enchanted books and items on a Minecraft
(Java Edition) anvil. Pick an item, choose the enchantments you want, and it
lists the anvil steps one by one.

## Running it

It's a static site with no build step. Serve the folder over HTTP (browsers
block Web Workers on `file://`):

```
python -m http.server 8080
```

Then open http://localhost:8080.

## How it works

- `js/Engine.js`: the search. It tries every way to split the items into
  left/right groups, memoized on the subset of items, and keeps the cheapest
  result per (prior work, resulting enchantments). Follows Java anvil rules:
  book vs. item multipliers, prior-work penalty `2^n - 1`, level caps,
  incompatible enchantments dropped for 1 level, and the 39-level limit.
- `js/Calculator.js`: Web Worker wrapper so the page stays responsive.
- `js/Logic.js`: UI helpers (automatic books, "Max all", shareable links).
- `js/App.js`: rendering and state.
- `json/metadata.json`: items, enchantments, max levels, anvil weights
  (book multipliers) and conflicts.

## Tests

```
node test/Engine.test.js
node test/Logic.test.mjs
```

The engine tests include a brute-force cross-check on random inputs.
