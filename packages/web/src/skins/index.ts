/**
 * Skins: the panel's look, one folder per skin (skins/README.md says how to add one). Every skin
 * shares the structure (styles/base.css), the module-change motion (styles/motion.css), and reduced
 * motion plus the narrow-screen layout (styles/final.css); a skin brings its tokens and decoration
 * (`<id>/skin.css`) and its name and web fonts (`<id>/skin.json`). Folders are found on their own, so
 * adding a skin touches no shared file.
 *
 * The build writes all of it into index.html as <style> elements in cascade order: base, every skin
 * (all but the chosen one carry media="not all"), motion, final (vite-skins.ts). An inline script
 * there picks the skin before the first paint; applySkin() switches by moving that media attribute,
 * so every rule keeps the precedence it had when all of this was one stylesheet. The choice comes
 * from `?skin=<id>` (remembered, then dropped from the address), else the remembered one, else
 * DEFAULT_SKIN, and is shown as `data-skin` on <html>.
 */

import { useSyncExternalStore } from "react";
import { DEFAULT_SKIN, SKIN_KEY, type SkinMeta } from "./settings.ts";

export { DEFAULT_SKIN, SKIN_KEY, type SkinMeta } from "./settings.ts";

/** A registered skin. */
export interface Skin extends SkinMeta {
	id: string;
}

/** How long the first render waits for a skin's font stylesheet before going ahead without it. */
const FONT_WAIT_MS = 1500;

const found = import.meta.glob<SkinMeta>("./*/skin.json", { eager: true, import: "default" });

/** Every skin, in switch order (the order of their <style> elements). */
export const SKINS: readonly Skin[] = Object.entries(found)
	.map(([path, meta]) => ({ ...meta, id: path.split("/")[1] as string }))
	.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.label.localeCompare(b.label));

/** The skin with this id, if there is one. */
export function skinById(id: string | null | undefined): Skin | undefined {
	return SKINS.find((s) => s.id === id);
}

/**
 * The skin to start with, the same choice index.html's script made: `?skin=` (remembered, then
 * dropped from the address, so it never rides along into history entries the app pushes), else the
 * remembered one, else the default.
 */
export function initialSkin(): string {
	const url = new URL(location.href);
	const asked = url.searchParams.get("skin");
	if (asked !== null) {
		url.searchParams.delete("skin");
		history.replaceState(history.state, "", url);
		if (skinById(asked)) {
			remember(asked);
			return asked;
		}
	}
	let stored: string | null = null;
	try {
		stored = localStorage.getItem(SKIN_KEY);
	} catch {
		// storage unavailable: the default
	}
	return skinById(stored) ? (stored as string) : DEFAULT_SKIN;
}

function remember(id: string): void {
	try {
		localStorage.setItem(SKIN_KEY, id);
	} catch {
		// private mode: the skin just is not remembered
	}
}

/** Resolves when this font stylesheet is in (or failed). */
function loaded(link: HTMLLinkElement): Promise<void> {
	if (link.sheet) return Promise.resolve();
	return new Promise<void>((done) => {
		link.addEventListener("load", () => done(), { once: true });
		link.addEventListener("error", () => done(), { once: true });
	});
}

/** Points the skin's font link at `href` (or removes it); resolves when that stylesheet is in, or failed. */
function linkFonts(href: string | undefined): Promise<void> {
	const old = document.head.querySelector<HTMLLinkElement>("link[data-vcm-fonts]");
	if (old && old.getAttribute("href") === href) return loaded(old);
	if (!href) {
		old?.remove();
		return Promise.resolve();
	}
	const link = document.createElement("link");
	link.rel = "stylesheet";
	link.href = href;
	link.dataset.vcmFonts = "";
	if (old) old.replaceWith(link);
	else document.head.append(link);
	return loaded(link);
}

let shown = "";
let epoch = 0;
let ticket = 0;
const readers = new Set<() => void>();

function changed(): void {
	epoch++;
	for (const read of readers) read();
}

/**
 * Shows skin `id` (an unknown id shows the default) and remembers it when `save`. The styles switch
 * at once; the promise resolves when the skin's font stylesheet is in (or FONT_WAIT_MS passed).
 * Readers re-render at the switch, then, and once the fonts themselves have loaded, since each can
 * move what the metro measures.
 */
export function applySkin(id: string, save = false): Promise<void> {
	const skin = skinById(id) ?? skinById(DEFAULT_SKIN);
	const layers = [...document.head.querySelectorAll<HTMLStyleElement>('style[data-vcm="skin"]')];
	const own = layers.find((s) => s.dataset.skin === skin?.id);
	if (!skin || !own) {
		console.error(`Skin "${id}" is not in this page (index.html is written by vite-skins.ts)`);
		return Promise.resolve();
	}
	for (const s of layers) {
		if (s === own) s.removeAttribute("media");
		else s.media = "not all";
	}
	document.documentElement.dataset.skin = skin.id;
	const moved = shown !== skin.id;
	shown = skin.id;
	if (save) remember(skin.id);
	const mine = ++ticket;
	const fonts = linkFonts(skin.fonts);
	if (moved) changed();
	return Promise.race([fonts, new Promise((r) => setTimeout(r, FONT_WAIT_MS))]).then(() => {
		if (mine !== ticket) return;
		changed();
		document.fonts?.ready.then(() => {
			if (mine === ticket) changed();
		});
	});
}

/** The skin on screen, for the switch. */
export function useSkin(): string {
	return useSyncExternalStore(subscribe, () => shown);
}

/** A number that changes whenever the skin's styles or fonts change (for components that measure). */
export function useSkinEpoch(): number {
	return useSyncExternalStore(subscribe, () => epoch);
}

function subscribe(read: () => void): () => void {
	readers.add(read);
	return () => readers.delete(read);
}

// dev: a saved CSS file swaps its <style> in place (vite-skins.ts sends the new text)
if (import.meta.hot) {
	import.meta.hot.on("vcm:css", (u: { layer?: string; skin?: string; css: string }) => {
		const el = document.head.querySelector<HTMLStyleElement>(
			u.skin ? `style[data-vcm="skin"][data-skin="${u.skin}"]` : `style[data-vcm="${u.layer}"]`,
		);
		if (!el) return;
		el.textContent = u.css;
		changed();
	});
}
