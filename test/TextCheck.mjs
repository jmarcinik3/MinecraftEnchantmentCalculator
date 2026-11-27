// Checks language files in json/text against English: the same entries, the same kind of each (text, template, plural), the same
// {placeholders}, every plural form the language's Intl.PluralRules gives a whole number from 0 to 1000, and every item and enchantment named.
// Usage: node test/TextCheck.mjs de_de fr_fr ...   (no codes: every file in json/text). Exits 1 on any error.
// Values identical to English are listed as warnings (fine for names that are the same, worth a look otherwise).
import { readFileSync, readdirSync } from "fs";

const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const english = read("../json/text/en_us.json");
const meta = read("../json/metadata.json");
const PLACEHOLDER = /\{([a-z_]+)\}/g;
const placeholders = text => [...new Set([...String(text).matchAll(PLACEHOLDER)].map(match => match[1]))].sort().join(",");
const isPlural = value => value && typeof value === "object" && "plural" in value;

// The BCP 47 tag the page would hand Intl for a file name: de_de -> de-DE, bar -> bar, zh_hk -> zh-HK.
// Text.js's own exceptions (codes Intl does not take), read from its source since Node loads js/*.js as CommonJS.
const INTL_LOCALES = JSON.parse(/const INTL_LOCALES = (\{[^}]*\})/.exec(readFileSync(new URL("../js/Text.js", import.meta.url), "utf8"))[1].replace(/(\w+):/g, '"$1":'));
export const bcp47 = code => INTL_LOCALES[code] || code.split("_").map((part, i) => (i === 0 ? part : part.toUpperCase())).join("-");

export function checkLanguage(code, text) {
    const errors = [], warnings = [];
    let categories;
    // The forms the page can meet: the counts it shows are whole numbers, well under 1000 (Spanish's "many" is for millions, so it is not needed).
    try { const rules = new Intl.PluralRules(bcp47(code)); categories = [...new Set(Array.from({ length: 1001 }, (_, n) => rules.select(n)))]; } catch { categories = ["one", "other"]; }
    const walk = (en, other, path) => {
        for (const [key, value] of Object.entries(en)) {
            const here = path + key;
            if (!(key in other)) { errors.push("missing " + here); continue; }
            const mine = other[key];
            if (path === "" && key === "names") continue; // checked below
            if (isPlural(value)) {
                if (!isPlural(mine)) { errors.push("not a plural " + here); continue; }
                if (mine.plural !== value.plural) errors.push(`plural of ${here} counts "${mine.plural}", English "${value.plural}"`);
                const want = placeholders(value.other);
                for (const form of new Set([...categories, "other"])) {
                    if (typeof mine[form] !== "string") errors.push(`plural ${here} lacks the "${form}" form`);
                    else if (placeholders(mine[form]).split(",").some(p => p && !want.split(",").concat(value.plural).includes(p))) errors.push(`plural ${here}.${form} has a placeholder English lacks`);
                }
                for (const form of Object.keys(mine)) if (form !== "plural" && !["zero", "one", "two", "few", "many", "other"].includes(form)) errors.push(`plural ${here} has an unknown form "${form}"`);
            } else if (typeof value === "string") {
                if (typeof mine !== "string") { errors.push("not text " + here); continue; }
                if (placeholders(mine) !== placeholders(value)) errors.push(`placeholders differ at ${here}: {${placeholders(mine)}} vs English {${placeholders(value)}}`);
                if (!mine.trim() && value.trim()) errors.push("empty " + here);
                if (mine === value && /[a-z]{3}/i.test(value)) warnings.push("same as English: " + here);
            } else if (value && typeof value === "object") {
                if (!mine || typeof mine !== "object" || isPlural(mine)) { errors.push("not a group " + here); continue; }
                walk(value, mine, here + ".");
            }
        }
        for (const key of Object.keys(other)) if (!(key in en)) errors.push("extra " + path + key);
    };
    walk(english, text, "");
    const names = text.names || {};
    const want = { items: meta.items, enchantments: Object.keys(meta.enchantments), descriptions: Object.keys(meta.enchantments) };
    for (const [group, keys] of Object.entries(want)) {
        const have = names[group] || {};
        for (const key of keys) if (typeof have[key] !== "string" || !have[key].trim()) errors.push(`names.${group}.${key} missing`);
        for (const key of Object.keys(have)) if (!keys.includes(key)) errors.push(`names.${group}.${key} is not an item/enchantment the app knows`);
    }
    for (const key of Object.keys(names)) if (!(key in want)) errors.push("extra names." + key);
    return { errors, warnings, categories };
}

const folder = new URL("../json/text/", import.meta.url);
const codes = process.argv.slice(2).length ? process.argv.slice(2) : readdirSync(folder).filter(f => f.endsWith(".json")).map(f => f.slice(0, -5));
let failed = 0;
for (const code of codes) {
    let text;
    try { text = JSON.parse(readFileSync(new URL(code + ".json", folder), "utf8")); }
    catch (error) { console.log(`${code}: cannot read (${error.message})`); failed++; continue; }
    const { errors, warnings, categories } = checkLanguage(code, text);
    console.log(`${code}: ${errors.length ? errors.length + " errors" : "ok"}, ${warnings.length} same as English (plural forms: ${categories.join(" ")})`);
    for (const error of errors) console.log("  ERROR " + error);
    if (process.env.WARN) for (const warning of warnings) console.log("  warn  " + warning);
    if (errors.length) failed++;
}
process.exit(failed ? 1 : 0);
