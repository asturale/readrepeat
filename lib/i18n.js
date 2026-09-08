import fs from 'fs';
import path from 'path';

const localesDir = path.join(import.meta.dirname, '..', 'locales');
const dictionaries = {};
for (const file of fs.readdirSync(localesDir).filter((f) => f.endsWith('.json'))) {
    const locale = path.basename(file, '.json');
    dictionaries[locale] = JSON.parse(fs.readFileSync(path.join(localesDir, file), 'utf8'));
}

export const SUPPORTED_LOCALES = Object.keys(dictionaries);
const DEFAULT_LOCALE = 'nl';

// Accept-Language: "nl-NL,nl;q=0.9,en-US;q=0.8,en;q=0.7" -- take each
// language tag in preference order, compare only the primary subtag.
export function detectLocale(acceptLanguageHeader) {
    if (!acceptLanguageHeader) return DEFAULT_LOCALE;
    const tags = acceptLanguageHeader
        .split(',')
        .map((part) => part.split(';')[0].trim().toLowerCase().slice(0, 2));
    for (const tag of tags) {
        if (SUPPORTED_LOCALES.includes(tag)) return tag;
    }
    return DEFAULT_LOCALE;
}

export function translator(locale) {
    const dict = dictionaries[locale] || dictionaries[DEFAULT_LOCALE];
    const fallback = dictionaries[DEFAULT_LOCALE];
    return (key, vars) => {
        let str = dict[key] ?? fallback[key] ?? key;
        if (vars) {
            for (const [k, v] of Object.entries(vars)) {
                str = str.replaceAll(`{${k}}`, v);
            }
        }
        return str;
    };
}

export function dateLocale(locale) {
    return locale === 'en' ? 'en-GB' : 'nl-NL';
}
