/**
 * In-process subagent runner. Builds a fresh `Agent` with a restricted tool
 * set and a custom system prompt, runs a single user prompt, and returns the
 * final assistant text + token usage.
 *
 * Crash-isolated: any error in the child becomes a structured failure result
 * to the parent (never propagates).
 *
 * Cheap to dispatch: no separate process, no separate auth, no double system
 * prompt — auth and the model registry are shared with the parent.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Agent, type AgentEvent } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, Model } from "@mariozechner/pi-ai";
import { convertToLlm } from "../messages.js";
import type { ModelRegistry } from "../model-registry.js";
import { type ChildProgress, ChildProgressTracker } from "./streaming-bus.js";
import type { AgentDefinition } from "./types.js";

export interface RunChildAgentOptions {
	def: AgentDefinition;
	prompt: string;
	parentModelRegistry: ModelRegistry;
	/** Inherited model when the child def doesn't specify one. */
	parentModel: Model<any>;
	/** Tool factory: given the child's allowlist, build an AgentTool[] available in-process. */
	resolveTools: (allowlist: string[] | undefined) => AgentTool[];
	signal?: AbortSignal;
	/** Stream child events to the parent so the TUI can render progress. */
	onEvent?: (event: AgentEvent) => void;
	/**
	 * Throttled high-level progress snapshots derived from child events.
	 * Preferred channel for the Task tool's UI updates.
	 */
	onProgress?: (snapshot: ChildProgress) => void;
}

export interface ChildAgentResult {
	text: string;
	error: string | undefined;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
	};
	durationMs: number;
}

function joinAssistantText(message: AssistantMessage): string {
	const parts: string[] = [];
	for (const block of message.content) {
		if (block.type === "text") parts.push(block.text);
	}
	return parts.join("\n").trim();
}

const DEFAULT_CHILD_SYSTEM_PREFIX = `You are a focused subagent invoked by a parent coding agent. Stay narrowly on the user's task. When you are done, return a concise final answer in plain markdown — the parent will surface it back to its session.

`;

export async function runChildAgent(options: RunChildAgentOptions): Promise<ChildAgentResult> {
	const startedAt = Date.now();
	const { def, prompt, parentModelRegistry, parentModel } = options;

	// Resolve the child's model. Defaults to inheriting the parent's.
	let model: Model<any> = parentModel;
	if (def.model) {
		const found = parentModelRegistry.getAvailable().find((m) => m.id === def.model);
		if (!found) {
			return {
				text: "",
				error: `Subagent "${def.name}" requested model "${def.model}", which is not available. Available models: ${parentModelRegistry
					.getAvailable()
					.map((m) => m.id)
					.slice(0, 10)
					.join(", ")}`,
				tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
				durationMs: Date.now() - startedAt,
			};
		}
		model = found;
	}

	const tools = options.resolveTools(def.tools);
	const systemPrompt = `${DEFAULT_CHILD_SYSTEM_PREFIX}${def.systemPrompt}`;

	const agent = new Agent({
		convertToLlm,
		getApiKey: async (_provider: string) => {
			const auth = await parentModelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok) return undefined;
			return auth.apiKey ?? undefined;
		},
		initialState: {
			model,
			systemPrompt,
			tools,
			messages: [],
		},
	});

	if (options.onEvent) {
		agent.subscribe(options.onEvent);
	}

	const tracker = new ChildProgressTracker({
		agentName: def.name,
		onProgress: options.onProgress,
	});
	agent.subscribe((event) => tracker.handleEvent(event));

	try {
		await agent.prompt(prompt);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		tracker.markError(message);
		tracker.dispose();
		return {
			text: "",
			error: message,
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
			durationMs: Date.now() - startedAt,
		};
	}

	if (options.signal?.aborted) {
		tracker.markError("Subagent aborted");
		tracker.dispose();
		return {
			text: "",
			error: "Subagent aborted",
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
			durationMs: Date.now() - startedAt,
		};
	}

	// Aggregate assistant text + cumulative usage from this run.
	let text = "";
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let cost = 0;
	for (const message of agent.state.messages) {
		if (message.role === "assistant") {
			const m = message as AssistantMessage;
			input += m.usage.input;
			output += m.usage.output;
			cacheRead += m.usage.cacheRead;
			cacheWrite += m.usage.cacheWrite;
			cost += m.usage.cost.total;
			const t = joinAssistantText(m);
			if (t) text = t;
		}
	}

	tracker.markDone(text);
	tracker.dispose();
	return {
		text,
		error: undefined,
		tokens: { input, output, cacheRead, cacheWrite, cost },
		durationMs: Date.now() - startedAt,
	};
}
