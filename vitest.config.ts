import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["packages/*/test/**/*.test.ts"],
		testTimeout: 30_000,
		// the cache keys a module by its own text, so a glob in it (src/skins/index.ts) would not see a new skin folder
		fsModuleCache: false,
	},
});
