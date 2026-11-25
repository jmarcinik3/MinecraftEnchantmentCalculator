# Enchantment Calculator

Finds the cheapest order to combine enchanted books and items on a Minecraft
(Java or Bedrock Edition) anvil. Pick an item, choose the enchantments you want, and it
lists the anvil steps one by one. In Java, Game rules > Mods can add the enchantments of
Fancy Enchantments or Spellbound (data in `json/mods/`).

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
- `js/Logic.js`: UI helpers (automatic books, presets, shareable links).
- `js/App.js` and the modules beside it (`Wanted.js`, `Books.js`, `Ranking.js`,
  `Options.js`, `Results.js`, ...): the page, one module per section.
- `json/metadata.json`: items, enchantments, max levels, anvil weights
  (book multipliers) and conflicts. `json/text/`: every string the page shows.

## Tests

```
node test/Engine.test.js
node test/Logic.test.mjs
python test/Browser.test.py   # drives the page in Chromium (needs Playwright)
```

The engine tests include a brute-force cross-check on random inputs.

## Hosting

Every push to `main` runs the tests in GitHub Actions and, if they pass, deploys the site to
GitHub Pages: https://jmarcinik3.github.io/MinecraftEnchantmentCalculator/
