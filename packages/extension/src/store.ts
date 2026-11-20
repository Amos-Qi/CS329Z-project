import type {
	Attempt,
	AttemptStatus,
	Author,
	FileChange,
	ModuleEdit,
	ModuleId,
	ModuleSpec,
	ModuleVersion,
	PlanVersion,
	TraceEventBody,
	ValidationResult,
} from "@vcm/protocol";

export interface PlannedModuleInput {
	id?: string;
	title: string;
	label?: string;
	purpose: string;
	instructions: string;
	inputs?: string[];
	outputs?: string[];
	dependsOn?: string[];
	validation?: string[];
	skills?: string[];
}

const SPEC_KEYS: (keyof ModuleSpec)[] = [
	"title",
	"label",
	"purpose",
	"instructions",
	"skills",
	"inputs",
	"outputs",
	"dependsOn",
	"validation",
];

function sameSpec(a: ModuleSpec, b: ModuleSpec): boolean {
	return SPEC_KEYS.every((key) => JSON.stringify(a[key]) === JSON.stringify(b[key]));
}

/**
 * Authoritative module state for one run. Every mutation is emitted as a trace event, so the
 * trace can always be replayed into the same state with reduceTrace().
 */
export class ModuleStore {
	private versions = new Map<ModuleId, ModuleVersion[]>();
	private plans: PlanVersion[] = [];
	/** What the agent last proposed for each module in plan_modules (before the overseer's edits). */
	private proposals = new Map<ModuleId, ModuleSpec>();
	private attempts = new Map<string, Attempt>();
	private attemptOrder: string[] = [];
	private nextModule = 1;
	activeAttemptId: string | null = null;
	private emit: (event: TraceEventBody) => void;

	constructor(emit: (event: TraceEventBody) => void) {
		this.emit = emit;
	}

	get planVersion(): number {
		return this.plans.at(-1)?.version ?? 0;
	}

	get currentPlan(): PlanVersion | undefined {
		return this.plans.at(-1);
	}

	latest(moduleId: ModuleId): ModuleVersion | undefined {
		return this.versions.get(moduleId)?.at(-1);
	}

	hasModule(moduleId: ModuleId): boolean {
		return this.versions.has(moduleId);
	}

	attempt(attemptId: string): Attempt | undefined {
		return this.attempts.get(attemptId);
	}

	get activeAttempt(): Attempt | undefined {
		return this.activeAttemptId ? this.attempts.get(this.activeAttemptId) : undefined;
	}

	/** Attempts that started after the given one, in order (for conservative invalidation). */
	attemptsAfter(attemptId: string): Attempt[] {
		const index = this.attemptOrder.indexOf(attemptId);
		if (index < 0) return [];
		return this.attemptOrder.slice(index + 1).flatMap((id) => this.attempts.get(id) ?? []);
	}

	/** First module in plan order whose latest live attempt has not completed. */
	nextUnfinishedModule(): ModuleId | undefined {
		return this.currentPlan?.moduleOrder.find((moduleId) => {
			const live = this.attemptOrder
				.map((id) => this.attempts.get(id))
				.filter((a) => a?.moduleId === moduleId && a.status !== "invalidated" && a.status !== "abandoned");
			return live.at(-1)?.status !== "completed";
		});
	}

	/** Creates a plan version; new or changed modules get new versions. */
	plan(modules: PlannedModuleInput[], rationale: string | undefined, author: Author): PlanVersion {
		const now = Date.now();
		const ids = modules.map((m) => (m.id && this.versions.has(m.id) ? m.id : `M${this.nextModule++}`));
		const byTitle = new Map(modules.map((m, i) => [m.title.trim().toLowerCase(), ids[i]]));
		const resolveDep = (dep: string): string | undefined =>
			this.versions.has(dep) || ids.includes(dep) ? dep : byTitle.get(dep.trim().toLowerCase());

		const changed: ModuleVersion[] = [];
		modules.forEach((input, i) => {
			const moduleId = ids[i] as string;
			const spec: ModuleSpec = {
				title: input.title,
				label: input.label?.trim() || undefined,
				purpose: input.purpose,
				instructions: input.instructions,
				skills: input.skills ?? [],
				inputs: input.inputs ?? [],
				outputs: input.outputs ?? [],
				dependsOn: (input.dependsOn ?? []).map(resolveDep).filter((d): d is string => !!d && d !== moduleId),
				validation: input.validation ?? [],
			};
			const previous = this.latest(moduleId);
			const proposed = this.proposals.get(moduleId);
			this.proposals.set(moduleId, { ...spec });
			if (previous && proposed) {
				// a field the agent repeats unchanged from its own last proposal keeps the current value, so a
				// re-plan never silently undoes the overseer's "Change Mk"
				const fields = spec as unknown as Record<string, unknown>;
				for (const key of SPEC_KEYS) {
					if (JSON.stringify(spec[key]) === JSON.stringify(proposed[key])) fields[key] = previous[key];
				}
			}
			if (previous && sameSpec(previous, spec)) return;
			const version: ModuleVersion = {
				...spec,
				moduleId,
				version: (previous?.version ?? 0) + 1,
				author,
				reason: previous ? rationale : undefined,
				createdAt: now,
			};
			this.versions.set(moduleId, [...(this.versions.get(moduleId) ?? []), version]);
			changed.push(version);
		});

		const plan: PlanVersion = { version: this.planVersion + 1, moduleOrder: ids, author, rationale, createdAt: now };
		this.plans.push(plan);
		this.emit({ type: "plan_version", plan, modules: changed });
		return plan;
	}

	/** Re-issues an earlier plan's module order as a new plan version (used when rewinding past a re-plan). */
	restorePlan(version: number, reason: string): PlanVersion | undefined {
		const earlier = this.plans.find((p) => p.version === version);
		if (!earlier || version === this.planVersion) return undefined;
		const plan: PlanVersion = {
			version: this.planVersion + 1,
			moduleOrder: [...earlier.moduleOrder],
			author: "user",
			rationale: reason,
			createdAt: Date.now(),
		};
		this.plans.push(plan);
		this.emit({ type: "plan_version", plan, modules: [] });
		return plan;
	}

	/**
	 * Rewinding to `asOf` (a checkpoint's time): every module of the current plan whose definition the
	 * agent changed after that time gets a new version with the definition it had then (a later edit by
	 * the overseer is kept). Returns the versions created.
	 */
	restoreVersions(asOf: number, reason: string): ModuleVersion[] {
		const created: ModuleVersion[] = [];
		for (const moduleId of this.currentPlan?.moduleOrder ?? []) {
			const versions = this.versions.get(moduleId) ?? [];
			const latest = versions.at(-1);
			const then = versions.filter((v) => v.createdAt <= asOf).at(-1);
			if (!latest || !then || latest === then || latest.author !== "agent" || sameSpec(then, latest)) continue;
			const spec = Object.fromEntries(SPEC_KEYS.map((key) => [key, then[key]])) as unknown as ModuleSpec;
			const next: ModuleVersion = {
				...spec,
				moduleId,
				version: latest.version + 1,
				author: then.author,
				reason,
				createdAt: Date.now(),
			};
			versions.push(next);
			this.emit({ type: "module_version", module: next });
			created.push(next);
		}
		return created;
	}

	/** Whether applying `edit` would create a new version (it changes the module's definition). */
	changes(edit: ModuleEdit): boolean {
		const previous = this.latest(edit.moduleId);
		if (!previous) return false;
		const changes = Object.fromEntries(Object.entries(edit.changes).filter(([, v]) => v !== undefined));
		return !sameSpec(previous, { ...previous, ...changes });
	}

	/** Applies user edits as new module versions. Returns the versions created. */
	applyEdits(edits: ModuleEdit[]): ModuleVersion[] {
		const created: ModuleVersion[] = [];
		for (const edit of edits) {
			const previous = this.latest(edit.moduleId);
			if (!previous) continue;
			const next: ModuleVersion = {
				...previous,
				...Object.fromEntries(Object.entries(edit.changes).filter(([, v]) => v !== undefined)),
				version: previous.version + 1,
				author: "user",
				reason: edit.note,
				createdAt: Date.now(),
			};
			if (sameSpec(previous, next)) continue;
			this.versions.get(edit.moduleId)?.push(next);
			this.emit({ type: "module_version", module: next });
			created.push(next);
		}
		return created;
	}

	startAttempt(moduleId: ModuleId, startEntryId: string | null | undefined, startCheckpoint?: string): Attempt {
		const version = this.latest(moduleId);
		if (!version) throw new Error(`Unknown module ${moduleId}`);
		const n = this.attemptOrder.filter((id) => this.attempts.get(id)?.moduleId === moduleId).length + 1;
		const attempt: Attempt = {
			attemptId: `${moduleId}.${n}`,
			moduleId,
			moduleVersion: version.version,
			n,
			status: "running",
			startedAt: Date.now(),
			startEntryId,
			startCheckpoint,
		};
		this.attempts.set(attempt.attemptId, attempt);
		this.attemptOrder.push(attempt.attemptId);
		this.activeAttemptId = attempt.attemptId;
		this.emit({ type: "attempt_started", attempt });
		return attempt;
	}

	endAttempt(
		attemptId: string,
		result: {
			status: AttemptStatus;
			summary?: string;
			outputs?: string[];
			validation?: ValidationResult[];
			endCheckpoint?: string;
			fileChanges?: FileChange[];
		},
	): void {
		const attempt = this.attempts.get(attemptId);
		if (!attempt) return;
		Object.assign(attempt, { ...result, endedAt: Date.now() });
		if (this.activeAttemptId === attemptId) this.activeAttemptId = null;
		this.emit({ type: "attempt_ended", attemptId, ...result });
	}

	invalidate(attemptIds: string[], reason: string): void {
		if (attemptIds.length === 0) return;
		for (const id of attemptIds) {
			const attempt = this.attempts.get(id);
			if (attempt) attempt.status = "invalidated";
			if (this.activeAttemptId === id) this.activeAttemptId = null;
		}
		this.emit({ type: "attempts_invalidated", attemptIds, reason });
	}
}

export function formatModule(version: ModuleVersion): string {
	const list = (items: string[]) => (items.length ? items.map((i) => `  - ${i}`).join("\n") : "  (none)");
	return [
		`${version.moduleId}: ${version.title}  [instructions v${version.version}${version.author === "user" ? ", edited by the overseer" : ""}]`,
		`Purpose: ${version.purpose}`,
		`Instructions:\n${version.instructions}`,
		`Inputs:\n${list(version.inputs)}`,
		`Outputs:\n${list(version.outputs)}`,
		`Depends on: ${version.dependsOn.length ? version.dependsOn.join(", ") : "(none)"}`,
		`Validation criteria:\n${list(version.validation)}`,
		version.author === "user" && version.reason ? `Overseer note: ${version.reason}` : undefined,
	]
		.filter(Boolean)
		.join("\n");
}
