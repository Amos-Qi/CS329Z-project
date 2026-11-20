import type { SkinDef } from "../index.ts";

/** Neon pink/cyan/purple on a midnight grid, VHS scanlines and a synthwave hero (the first skin). */
export default {
	label: "Vaporwave",
	order: 0,
	fonts:
		"https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@400;500;600;700&family=Space+Mono:wght@400;700&display=swap",
	css: () => import("./skin.css?inline").then((m) => m.default),
} satisfies SkinDef;
