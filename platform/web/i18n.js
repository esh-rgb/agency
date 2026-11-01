// The interface's language. Texts are written in English in the code and wrapped in t(); a
// language is a dictionary from those English texts to its own, and anything missing stays in
// English. Hebrew also turns the page right to left (styles.css mirrors itself from dir="rtl").
//
// Each person picks a language under Settings (remembered in this browser); until then the
// browser's language decides.

import { he } from "./i18n-he.js";

export const LANGUAGES = {
	en: { name: "English", dir: "ltr", strings: {} },
	he: { name: "עברית", dir: "rtl", strings: he },
};

function stored() {
	try {
		return localStorage.getItem("agency.lang");
	} catch {
		return null;
	}
}

function detect() {
	const saved = stored();
	if (saved && LANGUAGES[saved]) return saved;
	for (const tag of navigator.languages ?? [navigator.language]) {
		const base = String(tag).toLowerCase().split("-")[0];
		if (base === "iw") return "he";
		if (LANGUAGES[base]) return base;
	}
	return "en";
}

export const lang = detect();
const strings = LANGUAGES[lang].strings;

/** The text in the current language. `{name}` placeholders are filled from `vars`. */
export function t(text, vars) {
	const out = strings[text] ?? text;
	return vars ? out.replace(/\{(\w+)\}/g, (match, key) => (key in vars ? String(vars[key]) : match)) : out;
}

/** Picks the text for a count: `one` for 1, `other` for the rest, each run through t(). */
export function plural(count, one, other) {
	return t(count === 1 ? one : other, { count });
}

/** Saves the choice and reloads, so every screen and the page direction change together. */
export function setLanguage(code) {
	try {
		localStorage.setItem("agency.lang", code);
	} catch {}
	location.reload();
}

document.documentElement.lang = lang;
document.documentElement.dir = LANGUAGES[lang].dir;
