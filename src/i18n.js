// Translations of the copypaste plugin, in the language Filestash itself picked for the page:
// the same rule as Filestash's public/assets/locales/index.js (navigator.language, among the
// languages Filestash ships, English otherwise).
//
// Each language is locales/<lang>.json in the plugin zip, keyed like en.json. A value is a
// string, or for a message with a {{count}}, an object keyed by Intl.PluralRules category
// ("zero", "one", "two", "few", "many", "other"; "other" is always there). A key missing in a
// language falls back to English. Placeholders are {{name}}.

export const LANGUAGES = [
    "az", "be", "bg", "ca", "cs", "da", "de", "el", "es", "et",
    "eu", "fi", "fr", "gl", "hr", "hu", "id", "is", "it", "ja",
    "ka", "ko", "lt", "lv", "mn", "nb", "nl", "no", "pl", "pt",
    "ro", "ru", "sk", "sl", "sr", "sv", "th", "tr", "uk", "vi",
    "zh",
];
export const REGIONAL = ["zh-TW", "fr-CA"];

export function pickLanguage(language = "") {
    if (REGIONAL.includes(language)) return language;
    const base = language.split("-")[0];
    return LANGUAGES.includes(base) ? base : "en";
}

const state = { lang: "en", en: {}, dict: {}, plural: new Intl.PluralRules("en") };

async function fetchLocale(lang) {
    const res = await fetch(new URL(`./locales/${lang}.json?v=__V__`, import.meta.url)); // __V__: set by build.py
    if (!res.ok) throw new Error(`locales/${lang}.json: HTTP ${res.status}`);
    return res.json();
}

// Never throws: with nothing loaded, t() returns the keys.
export async function load(language = globalThis.navigator?.language, fetchJSON = fetchLocale) {
    state.lang = pickLanguage(language);
    state.plural = new Intl.PluralRules(state.lang === "en" ? "en" : state.lang);
    const [en, dict] = await Promise.all([
        fetchJSON("en").catch((err) => { console.error("[copypaste]", err); return {}; }),
        state.lang === "en" ? {} : fetchJSON(state.lang).catch((err) => { console.error("[copypaste]", err); return {}; }),
    ]);
    state.en = en;
    state.dict = dict;
    return state.lang;
}

export function t(key, vars = {}) {
    let value = state.dict[key] ?? state.en[key] ?? key;
    if (typeof value === "object") {
        const english = state.en[key] || {};
        value = value[state.plural.select(vars.count ?? 0)] ?? value.other ?? english.other ?? key;
    }
    return value.replace(/\{\{(\w+)\}\}/g, (match, name) => (name in vars ? String(vars[name]) : match));
}
