// Checks the translations and the i18n module, offline.
//   node test/locales.mjs
// Every language Filestash ships has a file; each file has exactly the keys of en.json, the same
// placeholders, and every plural form its language uses for whole numbers.
import fs from "node:fs";
import path from "node:path";
import { LANGUAGES, REGIONAL, pickLanguage, load, t } from "../src/i18n.js";

const dir = path.join(path.dirname(new URL(import.meta.url).pathname), "../src/locales");
let failures = 0;
const check = (ok, label, extra = "") => {
    if (!ok || process.env.VERBOSE) console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
    if (!ok) failures += 1;
};
const read = (lang) => JSON.parse(fs.readFileSync(path.join(dir, `${lang}.json`), "utf8"));
const placeholders = (s) => [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort().join(",");

// the plural categories a language selects for whole numbers
const integerCategories = (lang) => {
    const rules = new Intl.PluralRules(lang);
    const seen = new Set();
    for (let n = 0; n <= 10000; n++) seen.add(rules.select(n));
    return seen;
};

const en = read("en");
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
for (const lang of [...LANGUAGES, ...REGIONAL]) check(files.includes(lang), `${lang}.json exists`);
for (const lang of files) check(lang === "en" || LANGUAGES.includes(lang) || REGIONAL.includes(lang), `${lang}.json is a Filestash language`);

let checked = 0;
for (const lang of files) {
    const d = read(lang);
    const keys = Object.keys(d);
    check(JSON.stringify(keys) === JSON.stringify(Object.keys(en)), `${lang}: same keys as en, same order`,
        JSON.stringify({ missing: Object.keys(en).filter((k) => !(k in d)), extra: keys.filter((k) => !(k in en)) }));
    const needed = integerCategories(lang);
    for (const [key, source] of Object.entries(en)) {
        const value = d[key];
        if (value === undefined) continue;
        const want = placeholders(typeof source === "string" ? source : source.other);
        if (typeof source === "string") {
            check(typeof value === "string" && value.trim() !== "", `${lang}.${key}: a non-empty string`);
            if (typeof value === "string") check(placeholders(value) === want, `${lang}.${key}: placeholders`, `${placeholders(value)} != ${want}`);
            continue;
        }
        check(value && typeof value === "object", `${lang}.${key}: plural forms`);
        if (!value || typeof value !== "object") continue;
        const forms = Object.keys(value);
        const missing = [...needed, "other"].filter((c) => !forms.includes(c));
        check(missing.length === 0, `${lang}.${key}: plural forms for ${[...needed].join("/")}`, `missing ${missing.join(",")}`);
        const unknown = forms.filter((c) => !["zero", "one", "two", "few", "many", "other"].includes(c));
        check(unknown.length === 0, `${lang}.${key}: known plural categories`, unknown.join(","));
        for (const [form, s] of Object.entries(value)) {
            check(typeof s === "string" && s.trim() !== "", `${lang}.${key}.${form}: a non-empty string`);
            if (typeof s === "string") check(placeholders(s) === want, `${lang}.${key}.${form}: placeholders`, `${placeholders(s)} != ${want}`);
        }
        checked += 1;
    }
}

// the language choice is Filestash's
for (const [input, want] of [["es-ES", "es"], ["es", "es"], ["zh-TW", "zh-TW"], ["zh-CN", "zh"], ["fr-CA", "fr-CA"], ["fr-FR", "fr"],
    ["pt-BR", "pt"], ["nb-NO", "nb"], ["en-US", "en"], ["xx-YY", "en"], ["", "en"], [undefined, "en"]]) {
    check(pickLanguage(input) === want, `pickLanguage(${JSON.stringify(input)}) = ${want}`, pickLanguage(input));
}

// t(): plural selection, placeholders, fallbacks
const fake = (dicts) => async (lang) => {
    if (!dicts[lang]) throw new Error("404");
    return dicts[lang];
};
await load("ru-RU", fake({ en, ru: read("ru") }));
const ru = read("ru").MOVED_ITEMS;
check(t("MOVED_ITEMS", { count: 1 }) === ru.one.replace("{{count}}", "1"), "ru: 1 → one");
check(t("MOVED_ITEMS", { count: 3 }) === ru.few.replace("{{count}}", "3"), "ru: 3 → few");
check(t("MOVED_ITEMS", { count: 5 }) === ru.many.replace("{{count}}", "5"), "ru: 5 → many");
check(t("MOVED_ITEMS", { count: 21 }) === ru.one.replace("{{count}}", "21"), "ru: 21 → one");
await load("es-ES", fake({ en, es: { COPY: "Copiar" } }));
check(t("COPY") === "Copiar" && t("CUT") === "Cut", "a key missing in a language falls back to English");
check(t("NO_SUCH_KEY") === "NO_SUCH_KEY", "an unknown key comes back as itself");
check(t("COPY_DONE", { count: 2, size: "3 MB" }) === "Copy finished: 2 files (3 MB)", "placeholders filled", t("COPY_DONE", { count: 2, size: "3 MB" }));
check(t("COPY_DONE", { count: 1 }) === "Copy finished: 1 file ({{size}})", "a placeholder without a value is left as it is");
const consoleError = console.error;
console.error = () => {}; // load() reports the two failed fetches
await load("de-DE", fake({}));
console.error = consoleError;
check(t("COPY") === "COPY", "nothing loadable: keys, no exception");

console.log(`${files.length} languages, ${checked} plural messages checked`);
console.log(failures === 0 ? "ALL PASSED" : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
