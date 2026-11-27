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
// - `names`: { items: {ns: name}, enchantments: {ns: name}, descriptions: {ns: text} }.
//
// Every language has the same entries as English (a test checks they match).

// Each language's name in its own language. Add a language here and as a JSON file.
// Keyed by the game's own locale codes (json/text/<code>.json, as the Minecraft Wiki lists them); `localeOf` turns one into the BCP 47 tag
// Intl and <html lang> take (en_us -> en-US, bar -> bar).
export const LANGUAGES = {
    af_za: "Afrikaans",
    ar_sa: "العربية",
    ast_es: "Asturianu",
    az_az: "Azərbaycanca",
    ba_ru: "Башҡортса",
    bar: "Boarisch",
    be_by: "Беларуская",
    be_latn: "Biełaruskaja",
    bg_bg: "Български",
    br_fr: "Brezhoneg",
    brb: "Brabants",
    bs_ba: "Bosanski",
    ca_es: "Català",
    cbk_zam: "Chavacano",
    cs_cz: "Čeština",
    cv_cu: "Чӑвашла",
    cy_gb: "Cymraeg",
    da_dk: "Dansk",
    de_at: "Deutsch (Österreich)",
    de_ch: "Deutsch (Schweiz)",
    de_de: "Deutsch",
    el_gr: "Ελληνικά",
    en_au: "English (Australia)",
    en_ca: "English (Canada)",
    en_gb: "English (UK)",
    en_nz: "English (New Zealand)",
    en_pt: "Pirate Speak",
    en_ud: "ɥsᴉlɓuƎ",
    en_us: "English",
    enp: "Anglish",
    enws: "Shakespearean English",
    eo_uy: "Esperanto",
    es_ar: "Español (Argentina)",
    es_cl: "Español (Chile)",
    es_ec: "Español (Ecuador)",
    es_es: "Español",
    es_mx: "Español (México)",
    es_uy: "Español (Uruguay)",
    es_ve: "Español (Venezuela)",
    esan: "Andaluz",
    et_ee: "Eesti",
    eu_es: "Euskara",
    fa_ir: "فارسی",
    fi_fi: "Suomi",
    fil_ph: "Filipino",
    fo_fo: "Føroyskt",
    fr_ca: "Français (Canada)",
    fr_ch: "Français (Suisse)",
    fr_fr: "Français",
    fra_de: "Fráisk",
    fur_it: "Furlan",
    fy_nl: "Frysk",
    ga_ie: "Gaeilge",
    gd_gb: "Gàidhlig",
    gl_es: "Galego",
    go_fr: "Gallo",
    got_de: "𐌲𐌿𐍄𐌹𐍃𐌺",
    hal_ua: "Галицка",
    haw_us: "ʻŌlelo Hawaiʻi",
    he_il: "עברית",
    hi_in: "हिन्दी",
    hn_no: "Høgnorsk",
    hr_hr: "Hrvatski",
    hu_hu: "Magyar",
    hy_am: "Հայերեն",
    id_id: "Bahasa Indonesia",
    ig_ng: "Igbo",
    io_en: "Ido",
    is_is: "Íslenska",
    isv: "Medžuslovjansky",
    it_it: "Italiano",
    ja_jp: "日本語",
    jbo_en: "la .lojban.",
    jv_id: "Basa Jawa",
    ka_ge: "ქართული",
    kk_kz: "Қазақша",
    kn_in: "ಕನ್ನಡ",
    ko_kr: "한국어",
    ksh: "Kölsch",
    kw_gb: "Kernewek",
    ky_kg: "Кыргызча",
    la_la: "Latina",
    lb_lu: "Lëtzebuergesch",
    li_li: "Limburgs",
    lmo: "Lombard",
    lo_la: "ລາວ",
    lol_us: "LOLCAT",
    lt_lt: "Lietuvių",
    lv_lv: "Latviešu",
    lzh: "文言",
    mk_mk: "Македонски",
    mn_mn: "Монгол",
    ms_my: "Bahasa Melayu",
    mt_mt: "Malti",
    nah: "Nāhuatl",
    nds_de: "Plattdüütsch",
    nl_be: "Nederlands (België)",
    nl_nl: "Nederlands",
    nn_no: "Norsk nynorsk",
    no_no: "Norsk bokmål",
    oc_fr: "Occitan",
    ovd: "Övdalską",
    pl_pl: "Polski",
    pls: "Ngiiwa",
    pt_br: "Português (Brasil)",
    pt_pt: "Português (Portugal)",
    qcb_es: "Caboverdiano",
    qid: "Bahasa Indonesia Jadul",
    qya_aa: "Quenya",
    ro_ro: "Română",
    rpr: "Русскій дореформенный",
    ru_ru: "Русский",
    ry_ua: "Русиньскый",
    sah_sah: "Сахалыы",
    se_no: "Davvisámegiella",
    sk_sk: "Slovenčina",
    sl_si: "Slovenščina",
    so_so: "Af-Soomaali",
    sq_al: "Shqip",
    sr_cs: "Srpski",
    sr_sp: "Српски",
    sv_se: "Svenska",
    sxu: "Säggs'sch",
    szl: "Ślōnskŏ",
    ta_in: "தமிழ்",
    th_th: "ไทย",
    tl_ph: "Tagalog",
    tlh_aa: "tlhIngan Hol",
    tok: "toki pona",
    tr_tr: "Türkçe",
    tt_ru: "Татарча",
    tzo_mx: "Batsʼi kʼop",
    uk_ua: "Українська",
    uz_uz: "Oʻzbekcha",
    val_es: "Valencià",
    vec_it: "Vèneto",
    vi_vn: "Tiếng Việt",
    vp_vl: "Viossa",
    vro: "Võro",
    yi_de: "ייִדיש",
    yo_ng: "Yorùbá",
    zh_cn: "简体中文",
    zh_hk: "繁體中文（香港）",
    zh_tw: "繁體中文（台灣）",
    zlm_arab: "بهاس ملايو"
};
// How sure each translation is, which the picker shows as the code's colour: 3 high (the game's own names and a well-known language), 2 moderate, 1 poor (needs a native speaker).
export const CONFIDENCE = {
    af_za: 2, ar_sa: 2, ast_es: 2, az_az: 2, ba_ru: 1, bar: 2, be_by: 2, be_latn: 1, bg_bg: 2, br_fr: 1, brb: 1, bs_ba: 2,
    ca_es: 3, cbk_zam: 1, cs_cz: 3, cv_cu: 1, cy_gb: 2, da_dk: 3, de_at: 3, de_ch: 3, de_de: 3, el_gr: 3, en_au: 3, en_ca: 3,
    en_gb: 3, en_nz: 3, en_pt: 2, en_ud: 2, en_us: 3, enp: 2, enws: 2, eo_uy: 2, es_ar: 3, es_cl: 3, es_ec: 3, es_es: 3,
    es_mx: 3, es_uy: 3, es_ve: 3, esan: 1, et_ee: 2, eu_es: 2, fa_ir: 2, fi_fi: 3, fil_ph: 2, fo_fo: 1, fr_ca: 3, fr_ch: 3,
    fr_fr: 3, fra_de: 1, fur_it: 1, fy_nl: 2, ga_ie: 2, gd_gb: 1, gl_es: 2, go_fr: 1, got_de: 1, hal_ua: 1, haw_us: 1, he_il: 2,
    hi_in: 2, hn_no: 1, hr_hr: 2, hu_hu: 3, hy_am: 2, id_id: 3, ig_ng: 1, io_en: 1, is_is: 2, isv: 1, it_it: 3, ja_jp: 3,
    jbo_en: 1, jv_id: 1, ka_ge: 2, kk_kz: 2, kn_in: 1, ko_kr: 3, ksh: 1, kw_gb: 1, ky_kg: 1, la_la: 2, lb_lu: 2, li_li: 1,
    lmo: 1, lo_la: 1, lol_us: 2, lt_lt: 2, lv_lv: 2, lzh: 1, mk_mk: 2, mn_mn: 2, ms_my: 2, mt_mt: 2, nah: 1, nds_de: 1,
    nl_be: 3, nl_nl: 3, nn_no: 2, no_no: 3, oc_fr: 1, ovd: 1, pl_pl: 3, pls: 1, pt_br: 3, pt_pt: 3, qcb_es: 1, qid: 1,
    qya_aa: 1, ro_ro: 3, rpr: 1, ru_ru: 3, ry_ua: 1, sah_sah: 1, se_no: 1, sk_sk: 2, sl_si: 2, so_so: 1, sq_al: 2, sr_cs: 2,
    sr_sp: 2, sv_se: 3, sxu: 1, szl: 1, ta_in: 1, th_th: 3, tl_ph: 2, tlh_aa: 1, tok: 1, tr_tr: 3, tt_ru: 1, tzo_mx: 1,
    uk_ua: 3, uz_uz: 2, val_es: 2, vec_it: 1, vi_vn: 3, vp_vl: 1, vro: 1, yi_de: 1, yo_ng: 1, zh_cn: 3, zh_hk: 3, zh_tw: 3,
    zlm_arab: 1
};
// Codes Intl does not take (or has no rules for), and the locale used for their numbers, lists and plurals instead.
const INTL_LOCALES = { cbk_zam: "cbk", enws: "en-GB", esan: "es-ES", sah_sah: "sah" };
export const DEFAULT_LANGUAGE = "en_us";
export const localeOf = code => INTL_LOCALES[code] || code.split("_").map((part, i) => (i === 0 ? part : part.toUpperCase())).join("-");

const TEXT_FOLDER = "json/text/";
const TEXT_VERSION = ""; // deploy sets this to "?v=<commit>" (.github/stamp-version.sh)

const PLACEHOLDER = /\{([a-z_]+)\}/g;

// The text in use. Templates are functions taking an object of values, e.g.
// TEXT.wanted.replaces({ name: "Smite" }). Loading another language swaps the contents
// in place, so modules holding TEXT see the change.
export const TEXT = {};

// Turns a language's JSON into TEXT's shape: templates become functions.
export function compileText(data, language) {
    const plural_rules = new Intl.PluralRules(localeOf(language));
    const lists = new Intl.ListFormat(localeOf(language), { type: "conjunction" });
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
    const chosen = LANGUAGES[language] ? language : DEFAULT_LANGUAGE;
    const response = await fetch(TEXT_FOLDER + chosen + ".json" + TEXT_VERSION);
    if (!response.ok) throw new Error("Couldn't load the " + chosen + " text: " + response.status);
    setText(await response.json(), chosen);
    return chosen;
}
