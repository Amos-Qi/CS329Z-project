/**
 * The skins' Vite plugin (src/skins/README.md). Every skin's CSS goes into index.html between the
 * shared layers, so the first paint is already styled and a skin switch only changes which one
 * applies:
 *
 *   <link rel="preconnect">…         for the default skin's font host
 *   <style data-vcm="base">          styles/base.css
 *   <style data-vcm="skin" data-skin="vaporwave">               skins/vaporwave/skin.css
 *   <style data-vcm="skin" data-skin="<id>" media="not all">    every other skin, switched off
 *   <style data-vcm="motion">        styles/motion.css
 *   <style data-vcm="final">         styles/final.css
 *   <script>                         picks the chosen skin and writes its font <link data-vcm-fonts>
 *   <noscript>                       the default skin's font link, for a page without script
 *
 * One skin applies at a time, so each rule keeps the precedence it had when all of this was one
 * stylesheet. The chooser runs before any font stylesheet, so first paint waits only for the chosen
 * skin's fonts; it writes that link with document.write so it blocks rendering as a link in the HTML
 * would. A build minifies the inline styles. In dev, saving one of these CSS files swaps that
 * <style>'s text in place (the "vcm:css" event, handled in src/skins/index.ts); adding, removing or
 * renaming a skin, or editing a skin.json, reloads the page.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { HtmlTagDescriptor, Plugin } from "vite";
import { DEFAULT_SKIN, SKIN_ID, SKIN_KEY, type SkinMeta } from "./src/skins/settings.ts";

/** The shared layers, in cascade order around the skins. */
const BEFORE = ["base"] as const;
const AFTER = ["motion", "final"] as const;
/** The keys a skin.json may have. */
const META_KEYS = ["label", "order", "fonts"];

/** A skin as found on disk. */
export interface SkinOnDisk extends SkinMeta {
	id: string;
	/** Its skin.css, with relative URLs pointing into its folder (see rebase()). */
	css: string;
}

/**
 * A skin's CSS with its relative `url(…)` and `@import "…"` pointing into its folder
 * (`/src/skins/<id>/…`): inlined into index.html, they would otherwise resolve against the page. The
 * build then bundles those files like any other asset, and dev serves them as they are.
 */
export function rebase(css: string, id: string): string {
	const into = (path: string) =>
		/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(path) ? path : `/src/skins/${id}/${path.replace(/^\.\//, "")}`;
	return css
		.replace(/url\(\s*(['"]?)([^'")\s]+)\1\s*\)/gi, (_, q, path) => `url(${q}${into(path)}${q})`)
		.replace(/@import\s+(['"])([^'"]+)\1/gi, (_, q, path) => `@import ${q}${into(path)}${q}`);
}

/** Text safe inside a <style> or <script> element: nothing in it can close the element early. */
function rawText(text: string): string {
	return text.replace(/<\/(style|script)/gi, "<\\/$1");
}

/** Every skin under `<src>/skins`, in switch order; throws on a malformed one. */
export function readSkins(src: string): SkinOnDisk[] {
	const dir = join(src, "skins");
	const found: SkinOnDisk[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const id = entry.name;
		const where = `src/skins/${id}`;
		const has = ["skin.json", "skin.css"].filter((f) => existsSync(join(dir, id, f)));
		// a folder with neither file is a leftover (e.g. .DS_Store after switching branches), not a skin
		if (!has.length) continue;
		if (has.length < 2) throw new Error(`${where}: a skin has both skin.json and skin.css (see src/skins/README.md)`);
		if (!SKIN_ID.test(id))
			throw new Error(`${where}: a skin's folder name is its id (lowercase letters, digits, dashes)`);
		let meta: Record<string, unknown>;
		try {
			meta = JSON.parse(readFileSync(join(dir, id, "skin.json"), "utf8"));
		} catch (err) {
			throw new Error(`${where}/skin.json: ${(err as Error).message}`);
		}
		const extra = Object.keys(meta).filter((k) => !META_KEYS.includes(k));
		if (extra.length)
			throw new Error(`${where}/skin.json: unknown key ${extra.join(", ")} (it takes ${META_KEYS.join(", ")})`);
		if (typeof meta.label !== "string" || !meta.label.trim())
			throw new Error(`${where}/skin.json: "label" is required`);
		if (meta.order !== undefined && !Number.isFinite(meta.order))
			throw new Error(`${where}/skin.json: "order" is a number`);
		if (meta.fonts !== undefined && !(typeof meta.fonts === "string" && /^https:\/\//.test(meta.fonts)))
			throw new Error(`${where}/skin.json: "fonts" is an https:// stylesheet URL`);
		found.push({
			id,
			label: meta.label,
			order: meta.order as number | undefined,
			fonts: meta.fonts as string | undefined,
			css: rebase(readFileSync(join(dir, id, "skin.css"), "utf8"), id),
		});
	}
	if (!found.some((s) => s.id === DEFAULT_SKIN)) throw new Error(`src/skins/${DEFAULT_SKIN} (DEFAULT_SKIN) is missing`);
	return found.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.label.localeCompare(b.label));
}

/** The script that picks the skin before the first paint (the same choice as initialSkin()). */
function chooser(list: SkinOnDisk[]): string {
	const fonts = Object.fromEntries(list.map((s) => [s.id, s.fonts ?? null]));
	return `(() => {
	const fonts = ${JSON.stringify(fonts).replace(/</g, "\\u003c")};
	const known = (id) => typeof id === "string" && Object.hasOwn(fonts, id);
	let id = new URLSearchParams(location.search).get("skin");
	if (!known(id)) {
		try {
			id = localStorage.getItem(${JSON.stringify(SKIN_KEY)});
		} catch {
			id = null;
		}
	}
	if (!known(id)) id = ${JSON.stringify(DEFAULT_SKIN)};
	document.documentElement.dataset.skin = id;
	for (const s of document.querySelectorAll('style[data-vcm="skin"]')) {
		if (s.dataset.skin === id) s.removeAttribute("media");
		else s.media = "not all";
	}
	const href = fonts[id];
	if (href) {
		const attr = href.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
		document.write('<link rel="stylesheet" data-vcm-fonts href="' + attr + '">');
	}
})();`;
}

/** The <head> tags for these skins (see the header). */
export function headTags(src: string): HtmlTagDescriptor[] {
	const list = readSkins(src);
	const shown = list.find((s) => s.id === DEFAULT_SKIN) as SkinOnDisk;
	const style = (attrs: Record<string, string>, css: string): HtmlTagDescriptor => ({
		tag: "style",
		attrs,
		children: rawText(css),
		injectTo: "head",
	});
	const layer = (name: string) => style({ "data-vcm": name }, readFileSync(join(src, "styles", `${name}.css`), "utf8"));
	const tags: HtmlTagDescriptor[] = [];
	if (shown.fonts) {
		const origin = new URL(shown.fonts).origin;
		tags.push({ tag: "link", attrs: { rel: "preconnect", href: origin }, injectTo: "head" });
		if (origin === "https://fonts.googleapis.com")
			tags.push({
				tag: "link",
				attrs: { rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: true },
				injectTo: "head",
			});
	}
	tags.push(...BEFORE.map(layer));
	for (const s of list)
		tags.push(
			style(
				s === shown
					? { "data-vcm": "skin", "data-skin": s.id }
					: { "data-vcm": "skin", "data-skin": s.id, media: "not all" },
				s.css,
			),
		);
	tags.push(...AFTER.map(layer));
	tags.push({ tag: "script", children: rawText(chooser(list)), injectTo: "head" });
	if (shown.fonts)
		tags.push({
			tag: "noscript",
			children: [{ tag: "link", attrs: { rel: "stylesheet", href: shown.fonts, "data-vcm-fonts": true } }],
			injectTo: "head",
		});
	return tags;
}

/** The plugin: writes the skins into index.html; in dev, swaps edited CSS in place. */
export function skins(): Plugin {
	let src = "";
	return {
		name: "vcm-skins",
		configResolved(config) {
			src = join(config.root, "src");
		},
		transformIndexHtml: { order: "pre", handler: () => headTags(src) },
		configureServer(server) {
			const reload = (file: string) => {
				if (/^skins\/[^/]+\/skin\.(json|css)$/.test(relative(src, file).replaceAll("\\", "/")))
					server.ws.send({ type: "full-reload" });
			};
			server.watcher.on("add", reload);
			server.watcher.on("unlink", reload);
		},
		async handleHotUpdate({ file, server, read }) {
			const rel = relative(src, file).replaceAll("\\", "/");
			const shared = rel.match(/^styles\/(base|motion|final)\.css$/);
			const skin = rel.match(/^skins\/([^/]+)\/skin\.(css|json)$/);
			if (shared) server.ws.send({ type: "custom", event: "vcm:css", data: { layer: shared[1], css: await read() } });
			else if (skin?.[2] === "css" && skin[1])
				server.ws.send({
					type: "custom",
					event: "vcm:css",
					data: { skin: skin[1], css: rebase(await read(), skin[1]) },
				});
			else if (skin) server.ws.send({ type: "full-reload" });
			else return;
			return [];
		},
	};
}
