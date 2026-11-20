import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = fileURLToPath(new URL("../src/", import.meta.url));
const read = (path: string) => readFileSync(src + path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const SHARED = ["styles/base.css", "styles/motion.css", "styles/final.css"];
const SKIN_IDS = readdirSync(`${src}skins`, { withFileTypes: true })
	.filter((d) => d.isDirectory())
	.map((d) => d.name);

/** Tokens the shared CSS reads without a fallback and does not set itself: every skin defines them. */
function requiredTokens(): string[] {
	const shared = SHARED.map(read).join("\n");
	const set = new Set([...shared.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
	const used = new Set([...shared.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)].map((m) => m[1] as string));
	return [...used].filter((t) => !set.has(t)).sort();
}

describe("skins", () => {
	it("there is at least the default skin", () => {
		expect(SKIN_IDS).toContain("vaporwave");
	});

	it("the shared CSS reads the documented tokens", () => {
		const tokens = requiredTokens();
		expect(tokens).toContain("--bg");
		expect(tokens).toContain("--ring");
		// the shared CSS names no skin's own palette
		expect(tokens.filter((t) => /pink|cyan|purple|neon|glow-(pink|cyan)/.test(t))).toEqual([]);
	});

	for (const id of SKIN_IDS) {
		describe(id, () => {
			it("has index.ts and skin.css", () => {
				expect(existsSync(`${src}skins/${id}/index.ts`)).toBe(true);
				expect(existsSync(`${src}skins/${id}/skin.css`)).toBe(true);
			});

			it("defines every token the shared CSS reads", () => {
				const css = read(`skins/${id}/skin.css`);
				const missing = requiredTokens().filter((t) => !new RegExp(`(^|[;{\\s])${t}\\s*:`, "m").test(css));
				expect(missing).toEqual([]);
			});

			it("keeps the shared keyframe names free", () => {
				const shared = new Set(SHARED.flatMap((f) => [...read(f).matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1])));
				const own = [...read(`skins/${id}/skin.css`).matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]);
				expect(own.filter((k) => shared.has(k))).toEqual([]);
			});
		});
	}
});
