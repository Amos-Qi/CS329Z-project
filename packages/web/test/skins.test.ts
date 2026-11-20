import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_SKIN, SKINS } from "../src/skins/index.ts";
import { headTags, readSkins, rebase } from "../vite-skins.ts";

const src = fileURLToPath(new URL("../src/", import.meta.url));
const read = (path: string) => readFileSync(src + path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const SHARED = ["styles/base.css", "styles/motion.css", "styles/final.css"];
/** Skin folders (one with neither file is a leftover the build skips too). */
const SKIN_IDS = readdirSync(`${src}skins`, { withFileTypes: true })
	.filter((d) => d.isDirectory() && ["skin.json", "skin.css"].some((f) => existsSync(`${src}skins/${d.name}/${f}`)))
	.map((d) => d.name)
	.sort();
/** Custom properties the page sets from script (always read with a fallback). */
const SET_BY_SCRIPT = new Set(["--i", "--now-h", "--harness-h"]);

/** Every .ts/.tsx file under src outside skins/. */
function sources(dir = src): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
		const path = `${dir}${d.name}`;
		if (d.isDirectory()) return d.name === "skins" ? [] : sources(`${path}/`);
		return /\.tsx?$/.test(d.name) ? [path] : [];
	});
}

/**
 * Tokens the shared CSS and the components read without a fallback and do not set themselves: every
 * skin defines them.
 */
function requiredTokens(): string[] {
	const text = [...SHARED.map(read), ...sources().map((f) => readFileSync(f, "utf8"))].join("\n");
	const shared = SHARED.map(read).join("\n");
	const set = new Set([...shared.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
	const used = new Set([...text.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)].map((m) => m[1] as string));
	return [...used].filter((t) => !set.has(t) && !SET_BY_SCRIPT.has(t)).sort();
}

/** The declarations of a skin's first top-level rule for `selector` (tokens live in flat blocks). */
function block(css: string, selector: string): string {
	const at = css.indexOf(`\n${selector} {`);
	const start = at < 0 && css.startsWith(`${selector} {`) ? 0 : at;
	if (start < 0) return "";
	const open = css.indexOf("{", start);
	return css.slice(open + 1, css.indexOf("\n}", open));
}

const defines = (decls: string, token: string) => new RegExp(`(^|[;{\\s])${token}\\s*:`, "m").test(decls);

describe("skins", () => {
	it("the default skin exists, and the registry has every folder", () => {
		expect(SKIN_IDS).toContain(DEFAULT_SKIN);
		expect(SKINS.map((s) => s.id).sort()).toEqual(SKIN_IDS);
	});

	it("the shared CSS and components read the documented tokens, and no skin's own palette", () => {
		const tokens = requiredTokens();
		for (const t of ["--bg", "--ring", "--on-ok", "--ease"]) expect(tokens).toContain(t);
		expect(tokens.filter((t) => /pink|cyan|purple|neon|^--glow-|^--grad|^--grid|^--scan/.test(t))).toEqual([]);
	});

	it("index.html gets the layers in cascade order, the default skin applying and the others off", () => {
		const tags = headTags(src);
		const styles = tags.filter((t) => t.tag === "style").map((t) => t.attrs ?? {});
		const order = styles.map((a) => (a["data-vcm"] === "skin" ? `skin:${a["data-skin"]}` : a["data-vcm"]));
		expect(order).toEqual(["base", ...readSkins(src).map((s) => `skin:${s.id}`), "motion", "final"]);
		for (const a of styles.filter((x) => x["data-vcm"] === "skin"))
			expect(a.media).toBe(a["data-skin"] === DEFAULT_SKIN ? undefined : "not all");
		expect(tags.map((t) => t.tag).slice(-2)).toEqual(["script", "noscript"]);
		// the chooser comes before any font stylesheet, so first paint waits only for the chosen skin's fonts
		expect(tags.filter((t) => t.tag === "link" && t.attrs?.rel === "stylesheet")).toEqual([]);
	});

	describe("the build's checks (on a scratch skins folder)", () => {
		function scratch(skins: Record<string, Record<string, string>>): string {
			const dir = mkdtempSync(join(tmpdir(), "vcm-skins-"));
			mkdirSync(join(dir, "styles"));
			for (const f of ["base", "motion", "final"]) writeFileSync(join(dir, "styles", `${f}.css`), `/* ${f} */`);
			for (const [id, files] of Object.entries(skins)) {
				mkdirSync(join(dir, "skins", id), { recursive: true });
				for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, "skins", id, name), text);
			}
			return dir;
		}
		const ok = { "skin.json": '{ "label": "V" }', "skin.css": ":root { --bg: #000; }" };

		it("nothing in a skin's CSS can close its <style> early", () => {
			const dir = scratch({
				[DEFAULT_SKIN]: { ...ok, "skin.css": '/* lives in a <style>…</style> */ a { content: "</STYLE>"; }' },
			});
			const css = headTags(dir).find((t) => t.attrs?.["data-skin"] === DEFAULT_SKIN)?.children as string;
			expect(css).not.toMatch(/<\/style/i);
			expect(css).toContain("<\\/STYLE>");
		});

		it("a skin's relative url() and @import point into its folder", () => {
			expect(
				rebase(`a { b: url(./n.png), url("i/x.svg"), url(/abs.png), url(data:x), url(#f); } @import "m.css";`, "paper"),
			).toBe(
				`a { b: url(/src/skins/paper/n.png), url("/src/skins/paper/i/x.svg"), url(/abs.png), url(data:x), url(#f); } @import "/src/skins/paper/m.css";`,
			);
		});

		it("rejects a malformed skin and skips a leftover folder", () => {
			expect(() =>
				readSkins(scratch({ [DEFAULT_SKIN]: { ...ok, "skin.json": '{ "label": "V", "font": "x" }' } })),
			).toThrow(/unknown key font/);
			expect(() => readSkins(scratch({ [DEFAULT_SKIN]: ok, Paper: ok }))).toThrow(/folder name is its id/);
			expect(() => readSkins(scratch({ [DEFAULT_SKIN]: ok, paper: { "skin.css": "" } }))).toThrow(/both skin.json/);
			expect(readSkins(scratch({ [DEFAULT_SKIN]: ok, gone: { ".DS_Store": "" } })).map((s) => s.id)).toEqual([
				DEFAULT_SKIN,
			]);
			expect(() => readSkins(scratch({ paper: ok }))).toThrow(/DEFAULT_SKIN/);
		});
	});

	for (const id of SKIN_IDS) {
		describe(id, () => {
			it("has a valid skin.json and a skin.css (the build reads both)", () => {
				const skin = readSkins(src).find((s) => s.id === id);
				expect(skin?.label).toBeTruthy();
				expect(skin?.css.length).toBeGreaterThan(0);
			});

			it("defines every token on :root and sets both colour schemes", () => {
				const css = read(`skins/${id}/skin.css`);
				const root = block(css, ":root");
				expect(requiredTokens().filter((t) => !defines(root, t))).toEqual([]);
				expect(root).toMatch(/color-scheme:\s*dark/);
				expect(block(css, '[data-theme="light"]')).toMatch(/color-scheme:\s*light/);
			});

			it("keeps the shared keyframe names free", () => {
				const shared = new Set(SHARED.flatMap((f) => [...read(f).matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1])));
				const own = [...read(`skins/${id}/skin.css`).matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]);
				expect(own.filter((k) => shared.has(k))).toEqual([]);
			});
		});
	}
});
