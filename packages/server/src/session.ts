import { join } from "node:path";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionFactory,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Config } from "./config.ts";

export interface SessionArgs {
	taskId: string;
	variant?: string;
	workspace: string;
	/** Isolated pi agent dir for this run, so ~/.pi extensions and settings never leak into study runs. */
	agentDir: string;
	sessionDir: string;
	extension: ExtensionFactory;
}

export type SessionFactory = (args: SessionArgs) => Promise<{ session: AgentSession; model: string }>;

/** Creates a real pi session against the configured provider (OpenRouter by default). */
export function piSessionFactory(config: Config): SessionFactory {
	return async ({ workspace, agentDir, sessionDir, extension }) => {
		const modelRuntime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
		});
		const model = modelRuntime.getModel(config.provider, config.model);
		if (!model) {
			throw new Error(
				`Model ${config.provider}/${config.model} is not in pi's catalog. Set VCM_PROVIDER / VCM_MODEL in .env.`,
			);
		}
		const settingsManager = SettingsManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd: workspace,
			agentDir,
			settingsManager,
			extensionFactories: [{ name: "vcm-modules", factory: extension }],
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: workspace,
			agentDir,
			modelRuntime,
			model,
			thinkingLevel: config.thinkingLevel,
			settingsManager,
			resourceLoader,
			sessionManager: SessionManager.create(workspace, sessionDir),
		});
		await session.bindExtensions({});
		return { session, model: `${config.provider}/${config.model}` };
	};
}
