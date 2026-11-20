/**
 * Skins: the panel's look, one folder per skin (skins/README.md says how to add one). Every skin
 * shares the structure (styles/base.css), the module-change motion (styles/motion.css), and reduced
 * motion plus the narrow-screen layout (styles/final.css); a skin brings its tokens and decoration
 * (`<id>/skin.css`) and its web fonts (`<id>/index.ts`). Folders are found on their own, so adding
 * a skin touches no shared file.
 *
 * The page's styles are four <style> elements in cascade order: base, skin, motion, final.
 * Switching skins replaces only the second one's text, so every rule keeps the precedence it had
 * when all of this was one stylesheet. Only the chosen skin's CSS is fetched. The choice comes from
 * `?skin=<id>`, else the remembered one, else DEFAULT_SKIN, and is shown as `data-skin` on <html>.
 */

import { useSyncExternalStore } from "react";
import base from "../styles/base.css?inline";
import final from "../styles/final.css?inline";
import motion from "../styles/motion.css?inline";

/** What a skin's `index.ts` exports as default (its id is the folder's name). */
export interface SkinDef {
	/** Name in the skin picker. */
	label: string;
	/** Place in the picker, lowest first (then by label). */
	order?: number;
	/** Stylesheet URL of the skin's web fonts (e.g. Google Fonts), if it uses any. */
	fonts?: string;
	/** The skin's CSS text: `() => import("./skin.css?inline").then((m) => m.default)`. */
	css: () => Promise<string>;
}

/** A registered skin. */
export interface Skin extends SkinDef {
	id: string;
}

/** The skin shown when none is chosen (or the chosen one no longer exists). */
export const DEFAULT_SKIN = "vaporwave";

/** localStorage key of the chosen skin. */
export const SKIN_KEY = "vcm-skin";

/** How long the first render waits for a skin's font stylesheet before going ahead without it. */
const FONT_WAIT_MS = 1500;

const found = import.meta.glob<SkinDef>("./*/index.ts", { eager: true, import: "default" });

/** Every skin, in picker order. */
export const SKINS: readonly Skin[] = Object.entries(found)
	.map(([path, def]) => ({ ...def, id: path.split("/")[1] as string }))
	.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.label.localeCompare(b.label));

/** The skin with this id, if there is one. */
export function skinById(id: string | null | undefined): Skin | undefined {
	return SKINS.find((s) => s.id === id);
}

/** The skin to start with: `?skin=` (also remembered), else the remembered one, else the default. */
export function initialSkin(): string {
	const asked = new URLSearchParams(location.search).get("skin");
	if (skinById(asked)) {
		remember(asked as string);
		return asked as string;
	}
	let stored: string | null = null;
	try {
		stored = localStorage.getItem(SKIN_KEY);
	} catch {
		// storage unavailable: the default
	}
	return skinById(stored) ? (stored as string) : ((skinById(DEFAULT_SKIN) ?? SKINS[0])?.id ?? DEFAULT_SKIN);
}

function remember(id: string): void {
	try {
		localStorage.setItem(SKIN_KEY, id);
	} catch {
		// private mode: the skin just is not remembered
	}
}

/** A `?skin=` in the address follows a new choice, so a reload does not bring the old skin back. */
function followInUrl(id: string): void {
	const url = new URL(location.href);
	if (!url.searchParams.has("skin") || url.searchParams.get("skin") === id) return;
	url.searchParams.set("skin", id);
	history.replaceState(history.state, "", url);
}

// ---- the page's styles ------------------------------------------------------------------------

type Layer = "base" | "skin" | "motion" | "final";

/** The <style> element of one layer, created on first use in cascade order at the end of <head>. */
function layer(name: Layer): HTMLStyleElement {
	let el = document.head.querySelector<HTMLStyleElement>(`style[data-vcm="${name}"]`);
	if (!el) {
		for (const n of ["base", "skin", "motion", "final"] as const) {
			if (document.head.querySelector(`style[data-vcm="${n}"]`)) continue;
			const s = document.createElement("style");
			s.dataset.vcm = n;
			document.head.append(s);
		}
		el = document.head.querySelector<HTMLStyleElement>(`style[data-vcm="${name}"]`) as HTMLStyleElement;
	}
	return el;
}

/** Points the skin's font link at `href` (or removes it); resolves when that stylesheet is in, or failed. */
function linkFonts(href: string | undefined): Promise<void> {
	const old = document.head.querySelector<HTMLLinkElement>("link[data-vcm-fonts]");
	if (!href) {
		old?.remove();
		return Promise.resolve();
	}
	if (old?.getAttribute("href") === href) return Promise.resolve();
	const link = document.createElement("link");
	link.rel = "stylesheet";
	link.href = href;
	link.dataset.vcmFonts = "";
	const loaded = new Promise<void>((done) => {
		link.addEventListener("load", () => done(), { once: true });
		link.addEventListener("error", () => done(), { once: true });
	});
	// before the style layers, as the font link was in index.html
	const first = document.head.querySelector("style[data-vcm]");
	if (old) old.replaceWith(link);
	else if (first) first.before(link);
	else document.head.append(link);
	return loaded;
}

let shown = "";
let epoch = 0;
let pending = 0;
const readers = new Set<() => void>();

function changed(): void {
	epoch++;
	for (const read of readers) read();
}

/**
 * Shows skin `id` (an unknown id shows the default) and remembers it when `save`. Resolves once its
 * CSS is applied and its font stylesheet is in (or FONT_WAIT_MS passed). Readers re-render at each
 * of those steps and once the fonts themselves have loaded, since each can move what the metro
 * measures.
 */
export async function applySkin(id: string, save = false): Promise<void> {
	const skin = skinById(id) ?? skinById(DEFAULT_SKIN) ?? SKINS[0];
	if (!skin) return;
	const ticket = ++pending;
	const fonts = linkFonts(skin.fonts);
	const css = await skin.css();
	if (ticket !== pending) return; // a later choice won
	layer("base").textContent = base;
	layer("skin").textContent = css;
	layer("motion").textContent = motion;
	layer("final").textContent = final;
	document.documentElement.dataset.skin = skin.id;
	shown = skin.id;
	if (save) {
		remember(skin.id);
		followInUrl(skin.id);
	}
	changed();
	await Promise.race([fonts, new Promise((r) => setTimeout(r, FONT_WAIT_MS))]);
	if (ticket !== pending) return;
	changed();
	document.fonts?.ready.then(() => {
		if (ticket === pending) changed();
	});
}

/** The skin on screen, for the picker. */
export function useSkin(): string {
	return useSyncExternalStore(
		(read) => {
			readers.add(read);
			return () => readers.delete(read);
		},
		() => shown,
		() => shown,
	);
}

/** A number that changes whenever the skin's styles or fonts change (for components that measure). */
export function useSkinEpoch(): number {
	return useSyncExternalStore(
		(read) => {
			readers.add(read);
			return () => readers.delete(read);
		},
		() => epoch,
		() => epoch,
	);
}
