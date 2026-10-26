/**
 * Standalone entry for the stock pi CLI, for debugging the module protocol without the server:
 *
 *   pi -e packages/extension/src/cli.ts
 *
 * Boundaries never pause; the trace is appended to <cwd>/.vcm/trace.jsonl.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createModulesExtension } from "./index.ts";

export default function (pi: ExtensionAPI) {
	const dir = join(process.cwd(), ".vcm");
	const file = join(dir, "trace.jsonl");
	let seq = 0;
	const { factory } = createModulesExtension({
		emit(event) {
			mkdirSync(dir, { recursive: true });
			appendFileSync(file, `${JSON.stringify({ ...event, seq: seq++, t: Date.now() })}\n`);
		},
		async boundary() {
			return { action: "continue" };
		},
	});
	return factory(pi);
}
