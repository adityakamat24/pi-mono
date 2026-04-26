/**
 * `Task` tool — pi's first-class equivalent of Claude Code's Task tool.
 *
 * Lets the parent agent delegate a focused piece of work to a named subagent
 * defined at `~/.pi/agents/<name>.md` or `<cwd>/.pi/agents/<name>.md`. The
 * child runs in-process with a restricted toolset and its own context, then
 * returns a concise summary to the parent.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";
import { type Static, Type } from "typebox";
import { TaskExecutionComponent } from "../../modes/interactive/components/task-execution.js";
import { runChildAgent } from "../agents/child-session.js";
import { acquireTaskSlot } from "../agents/concurrency.js";
import type { ChildProgress } from "../agents/streaming-bus.js";
import type { AgentRegistry } from "../agents/types.js";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.js";
import type { ModelRegistry } from "../model-registry.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

export const TASK_TOOL_NAME = "Task";

const taskSchema = Type.Object({
	agent: Type.String({
		description:
			"Name of the subagent to invoke. Must match a definition under ~/.pi/agents or .pi/agents (see /agents to list).",
	}),
	prompt: Type.String({
		description:
			"What the subagent should do. The child only sees this prompt and its own restricted tools — give it everything it needs.",
	}),
});

export type TaskToolInput = Static<typeof taskSchema>;

export interface TaskToolDetails {
	agent?: string;
	durationMs?: number;
	tokens?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
	};
	error?: string;
	/** Live progress snapshot streamed via onUpdate while the child runs. */
	progress?: ChildProgress;
}

export interface TaskToolDeps {
	/** Parent's agent registry — looked up at execute time so reload picks up new definitions. */
	getRegistry: () => AgentRegistry;
	/** Parent's model registry — shared with the child for auth resolution. */
	getModelRegistry: () => ModelRegistry;
	/** Parent's currently selected model — child inherits it when no model override is set. */
	getCurrentModel: () => Model<any> | undefined;
	/**
	 * Build the AgentTool[] the child will see. Caller filters by allowlist.
	 * `canSpawn` controls whether the child receives the Task tool itself
	 * (used by the lead-orchestrator pattern; recursion is one level deep).
	 */
	resolveTools: (allowlist: string[] | undefined, canSpawn: boolean) => AgentTool[];
}

const PROMPT_GUIDELINES = [
	"You MUST call `Task` to dispatch a named subagent whenever the user explicitly asks for it — phrases like 'use the explorer agent', 'use sub-agents', 'use agent teams', 'dispatch the tech-lead', 'use the implementer to build it', or 'spawn an explore agent'. Failing to dispatch when asked is a behavioral bug, not a stylistic choice.",
	'For multi-component builds (a game, an app, a refactor across many files), prefer the `tech-lead` orchestrator subagent if available — it spawns explorer / refactor-planner / implementer / code-reviewer in turn. One `Task(agent: "tech-lead", ...)` call is enough; the orchestrator handles the rest.',
	"Use Task to delegate a focused piece of work — code review, exploration, research — to a named subagent. The child has restricted tools and returns a concise summary.",
	"Pass the child everything it needs in `prompt`; the child does not see your conversation. Include enough context that the child can act standalone.",
	"Do NOT use Task for trivial questions you can answer yourself in one or two tool calls. Subagents add cost and latency — they pay off on multi-step focused work.",
];

export function createTaskToolDefinition(deps: TaskToolDeps): ToolDefinition<typeof taskSchema, TaskToolDetails> {
	return {
		name: TASK_TOOL_NAME,
		label: "Run subagent",
		description:
			"Delegate a focused task (review, exploration, research) to a named subagent. The subagent runs in-process with its own restricted tool set and system prompt, and returns a concise summary. Available agents are defined under ~/.pi/agents/ and .pi/agents/.",
		promptSnippet:
			"Task(agent: string, prompt: string): delegate to a named subagent for focused research/review/exploration.",
		promptGuidelines: PROMPT_GUIDELINES,
		parameters: taskSchema,
		async execute(_toolCallId, params, signal, onUpdate) {
			const registry = deps.getRegistry();
			const def = registry.lookup(params.agent);
			if (!def) {
				const available = registry.list();
				const message =
					available.length > 0
						? `Unknown agent "${params.agent}". Available: ${available.join(", ")}.`
						: `Unknown agent "${params.agent}". No agents defined. Drop a markdown file into ~/.pi/agents/ or .pi/agents/.`;
				return {
					content: [{ type: "text" as const, text: message }],
					details: { error: message },
				};
			}

			const parentModel = deps.getCurrentModel();
			if (!parentModel) {
				const message = "No model selected on the parent. Cannot dispatch subagent.";
				return {
					content: [{ type: "text" as const, text: message }],
					details: { error: message, agent: params.agent },
				};
			}

			// Acquire a concurrency slot before dispatching the child. Multiple
			// parallel `Task` calls (e.g. from a `tech-lead` fan-out) queue here
			// instead of blasting the provider's rate limit.
			let release: (() => void) | undefined;
			try {
				release = await acquireTaskSlot(signal);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text" as const, text: `Subagent dispatch aborted: ${message}` }],
					details: { error: message, agent: params.agent },
				};
			}

			let result: Awaited<ReturnType<typeof runChildAgent>>;
			try {
				result = await runChildAgent({
					def,
					prompt: params.prompt,
					parentModelRegistry: deps.getModelRegistry(),
					parentModel,
					resolveTools: (allowlist) => deps.resolveTools(allowlist, def.canSpawn === true),
					signal,
					onProgress: onUpdate
						? (progress) => {
								onUpdate({
									content: [],
									details: {
										agent: progress.agentName,
										progress,
									},
								});
							}
						: undefined,
				});
			} finally {
				release();
			}

			if (result.error) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Subagent "${params.agent}" failed: ${result.error}`,
						},
					],
					details: {
						agent: params.agent,
						durationMs: result.durationMs,
						tokens: result.tokens,
						error: result.error,
					},
				};
			}

			return {
				content: [
					{
						type: "text" as const,
						text: result.text || `Subagent "${params.agent}" returned no output.`,
					},
				],
				details: {
					agent: params.agent,
					durationMs: result.durationMs,
					tokens: result.tokens,
				},
			};
		},
		renderCall(args, theme, context) {
			const existing = context.lastComponent;
			const text = existing instanceof Text ? existing : new Text("", 0, 0);
			const agentName = typeof args?.agent === "string" ? args.agent : "(unknown)";
			const promptPreview = typeof args?.prompt === "string" ? args.prompt.split("\n")[0].slice(0, 80) : "";
			text.setText(
				`${theme.fg("toolTitle", theme.bold("Task"))} ${theme.fg("accent", agentName)} ${theme.fg("dim", `"${promptPreview}"`)}`,
			);
			return text;
		},
		renderResult(result, _options: ToolRenderResultOptions, _theme, context) {
			const existing = context.lastComponent;
			const comp = existing instanceof TaskExecutionComponent ? existing : new TaskExecutionComponent();
			comp.bindInvalidate(context.invalidate);
			const details = result.details as TaskToolDetails | undefined;

			if (details?.progress) {
				// Live streaming branch — fed by onUpdate().
				comp.setProgress(details.progress);
				return comp;
			}

			if (details?.error) {
				comp.setProgress({
					agentName: details.agent ?? "(unknown)",
					phase: "error",
					tools: [],
					tokens: details.tokens ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
					startedAt: Date.now() - (details.durationMs ?? 0),
					error: details.error,
				});
				return comp;
			}

			// Final result without a streamed progress snapshot — happens for very
			// fast children or when the host doesn't pipe onUpdate. Synthesize a
			// terminal "done" view from the result.
			const first = result.content[0];
			const finalText = first && first.type === "text" ? first.text : "";
			comp.setFinalFromResult(finalText, details?.durationMs, details?.tokens);
			return comp;
		},
	};
}

export function createTaskTool(deps: TaskToolDeps): AgentTool<typeof taskSchema> {
	return wrapToolDefinition(createTaskToolDefinition(deps));
}
