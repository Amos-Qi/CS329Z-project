/**
 * Test helpers: a pi AgentSession driven by pi's scripted faux provider (no network, no cost).
 * Imported by tests only, as "@vcm/extension/testing".
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type FauxResponseStep,
	type RegisterFauxProviderOptions,
	registerFauxProvider,
} from "@earendil-works/pi-ai/compat";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionFactory,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

export interface FauxSession {
	session: AgentSession;
	dir: string;
	cleanup: () => void;
}

export interface FauxSessionOptions {
	/** Workspace; a fresh temp dir by default (removed by cleanup()). */
	cwd?: string;
	agentDir?: string;
	/** Persist the session JSONL here instead of keeping it in memory. */
	sessionDir?: string;
	/** Faux provider options, e.g. { tokensPerSecond } to make streaming take realistic time. */
	faux?: RegisterFauxProviderOptions;
}

export async function createFauxSession(
	extension: ExtensionFactory,
	responses: FauxResponseStep[],
	options: FauxSessionOptions = {},
): Promise<FauxSession> {
	const dir = options.cwd ?? mkdtempSync(join(tmpdir(), "vcm-test-"));
	const faux = registerFauxProvider(options.faux);
	faux.setResponses(responses);
	const model = faux.getModel();

	const modelRuntime = await ModelRuntime.create({
		authPath: join(options.agentDir ?? join(dir, ".pi"), "auth.json"),
		modelsPath: join(options.agentDir ?? join(dir, ".pi"), "models.json"),
		refreshOnCreate: false,
	});
	modelRuntime.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		api: model.api,
		apiKey: "faux-key",
		models: [
			{
				id: model.id,
				name: model.name,
				api: model.api,
				reasoning: model.reasoning,
				input: model.input,
				cost: model.cost,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
				baseUrl: model.baseUrl,
			},
		],
	});

	const agentDir = options.agentDir ?? join(dir, ".pi");
	const settingsManager = SettingsManager.inMemory();
	const resourceLoader = new DefaultResourceLoader({
		cwd: dir,
		agentDir,
		settingsManager,
		extensionFactories: [{ name: "vcm-modules", factory: extension }],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();

	const { session } = await createAgentSession({
		cwd: dir,
		agentDir,
		modelRuntime,
		model,
		settingsManager,
		resourceLoader,
		sessionManager: options.sessionDir ? SessionManager.create(dir, options.sessionDir) : SessionManager.inMemory(dir),
	});
	await session.bindExtensions({});

	return {
		session,
		dir,
		cleanup: () => {
			session.dispose();
			faux.unregister();
			if (!options.cwd) rmSync(dir, { recursive: true, force: true });
		},
	};
}
