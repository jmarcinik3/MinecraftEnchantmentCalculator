// Loads the page's text from json/text/<language>.json: every string the page shows,
// and the item and enchantment names. Edit the wording there; this file only reads it.
//
// In the JSON:
// - Plain strings are used as they are.
// - `{name}` in a string is filled in by the page (e.g. "Replaces {name}"). Keep the
//   `{...}` parts and change the words around them. A list fills in as "A, B and C",
//   joined the way the language does it.
// - Text that depends on a number is an object: "plural" names the value it depends
//   on, then one string per plural form of the language ("one", "other", and for some
//   languages "few", "many"...), e.g.
//     { "plural": "count", "one": "{count} level", "other": "{count} levels" }
// - `help` entries are tooltips (shown on hover). `label` entries ending in `_label`
//   are read aloud by screen readers but not shown.
// - `names`: { items: {ns: name}, enchantments: {ns: name} }.
//
// Every language has the same entries as English (a test checks they match).

// Each language's name in its own language. Add a language here and as a JSON file.
export const LANGUAGES = { en: "English", es: "Español" };

const TEXT_FOLDER = "json/text/";
const TEXT_VERSION = ""; // deploy sets this to "?v=<commit>" (.github/stamp-version.sh)

const PLACEHOLDER = /\{([a-z_]+)\}/g;

// The text in use. Templates are functions taking an object of values, e.g.
// TEXT.wanted.replaces({ name: "Smite" }). Loading another language swaps the contents
// in place, so modules holding TEXT see the change.
export const TEXT = {};

// Turns a language's JSON into TEXT's shape: templates become functions.
export function compileText(data, language) {
    const plural_rules = new Intl.PluralRules(language);
    const lists = new Intl.ListFormat(language, { type: "conjunction" });
    const fill = (template, values = {}) => template.replace(PLACEHOLDER, (match, key) => {
        const value = values[key];
        if (value == null) return match;
        return Array.isArray(value) ? lists.format(value.map(String)) : String(value);
    });
    const build = (value, key) => {
        if (key === "names") return value;
        if (typeof value === "string") return value.search(PLACEHOLDER) >= 0 ? values => fill(value, values) : value;
        if (value && typeof value === "object" && "plural" in value) {
            return values => fill(value[plural_rules.select(Number(values[value.plural]))] ?? value.other, values);
        }
        if (value && typeof value === "object") {
            return Object.fromEntries(Object.entries(value).map(([name, inner]) => [name, build(inner, name)]));
        }
        return value;
    };
    return build(data, "");
}

// Puts `data` (a language's JSON) in TEXT.
export function setText(data, language) {
    const compiled = compileText(data, language);
    for (const key of Object.keys(TEXT)) delete TEXT[key];
    Object.assign(TEXT, compiled);
}

// Loads a language (English if there is no such language) and returns its code.
export async function loadLanguage(language) {
    const chosen = LANGUAGES[language] ? language : "en";
    const response = await fetch(TEXT_FOLDER + chosen + ".json" + TEXT_VERSION);
    if (!response.ok) throw new Error("Couldn't load the " + chosen + " text: " + response.status);
    setText(await response.json(), chosen);
    return chosen;
}
