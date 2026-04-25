/**
 * Translates a child agent's `AgentEvent` stream into throttled `ChildProgress`
 * snapshots that the Task tool surfaces to its parent UI via `onUpdate`.
 *
 * Why throttle? Token-streaming `message_update` events fire ~30/s and would
 * flood the TUI's render path with noise. We coalesce to ~10Hz max.
 */

import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "@mariozechner/pi-ai";

export type ChildPhase = "starting" | "tool" | "thinking" | "responding" | "done" | "error";

export interface ChildToolCall {
	id: string;
	name: string;
	argsSummary: string;
	startedAt: number;
	finishedAt?: number;
	isError?: boolean;
}

export interface ChildProgress {
	agentName: string;
	phase: ChildPhase;
	/** Tool calls observed so far, in order. */
	tools: ChildToolCall[];
	/** Cumulative usage from completed assistant messages in the child run. */
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
	};
	startedAt: number;
	/** Final assistant text (only when phase === "done"). */
	finalText?: string;
	/** Error message (only when phase === "error"). */
	error?: string;
}

export interface ChildProgressTrackerOptions {
	agentName: string;
	onProgress?: (snapshot: ChildProgress) => void;
	/** Minimum ms between forwarded snapshots. Default 100 (≈10 Hz). */
	throttleMs?: number;
}

/**
 * Subscribes to a child Agent's events and emits ChildProgress snapshots.
 * Call `attach(agent)` once and `detach()` when the run is complete.
 */
export class ChildProgressTracker {
	private readonly snapshot: ChildProgress;
	private readonly onProgress?: (snapshot: ChildProgress) => void;
	private readonly throttleMs: number;
	private lastEmitAt = 0;
	private pendingTimer: NodeJS.Timeout | undefined;

	constructor(options: ChildProgressTrackerOptions) {
		this.onProgress = options.onProgress;
		this.throttleMs = options.throttleMs ?? 100;
		this.snapshot = {
			agentName: options.agentName,
			phase: "starting",
			tools: [],
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
			startedAt: Date.now(),
		};
	}

	current(): ChildProgress {
		return this.snapshot;
	}

	handleEvent(event: AgentEvent): void {
		switch (event.type) {
			case "agent_start":
				this.snapshot.phase = "starting";
				this.scheduleEmit();
				return;
			case "message_start":
				if (event.message.role === "assistant") {
					this.snapshot.phase = "thinking";
					this.scheduleEmit();
				}
				return;
			case "message_update":
				// Token-stream content. Switch to "responding" once we see text content.
				this.snapshot.phase = "responding";
				this.scheduleEmit();
				return;
			case "message_end":
				if (event.message.role === "assistant") {
					const m = event.message as AssistantMessage;
					this.snapshot.tokens.input += m.usage.input;
					this.snapshot.tokens.output += m.usage.output;
					this.snapshot.tokens.cacheRead += m.usage.cacheRead;
					this.snapshot.tokens.cacheWrite += m.usage.cacheWrite;
					this.snapshot.tokens.cost += m.usage.cost.total;
					this.scheduleEmit();
				}
				return;
			case "tool_execution_start": {
				this.snapshot.phase = "tool";
				this.snapshot.tools.push({
					id: event.toolCallId,
					name: event.toolName,
					argsSummary: summarizeArgs(event.args),
					startedAt: Date.now(),
				});
				this.scheduleEmit();
				return;
			}
			case "tool_execution_end": {
				const entry = this.snapshot.tools.find((t) => t.id === event.toolCallId);
				if (entry) {
					entry.finishedAt = Date.now();
					entry.isError = event.isError;
				}
				this.scheduleEmit();
				return;
			}
			case "agent_end": {
				this.snapshot.phase = "done";
				this.flush();
				return;
			}
			default:
				return;
		}
	}

	markError(error: string): void {
		this.snapshot.phase = "error";
		this.snapshot.error = error;
		this.flush();
	}

	markDone(finalText: string | undefined): void {
		this.snapshot.phase = "done";
		this.snapshot.finalText = finalText;
		this.flush();
	}

	dispose(): void {
		if (this.pendingTimer) {
			clearTimeout(this.pendingTimer);
			this.pendingTimer = undefined;
		}
	}

	private scheduleEmit(): void {
		if (!this.onProgress) return;
		const now = Date.now();
		const elapsed = now - this.lastEmitAt;
		if (elapsed >= this.throttleMs) {
			this.flush();
			return;
		}
		// Coalesce: a single trailing-edge timer fires at the throttle boundary.
		if (this.pendingTimer) return;
		this.pendingTimer = setTimeout(() => {
			this.pendingTimer = undefined;
			this.flush();
		}, this.throttleMs - elapsed);
	}

	private flush(): void {
		if (this.pendingTimer) {
			clearTimeout(this.pendingTimer);
			this.pendingTimer = undefined;
		}
		this.lastEmitAt = Date.now();
		this.onProgress?.(this.snapshot);
	}
}

function summarizeArgs(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const obj = args as Record<string, unknown>;
	// Prefer the most identifying field per tool — matches what the parent
	// renders for the same tools elsewhere.
	const candidates = [obj.path, obj.file_path, obj.command, obj.pattern, obj.query, obj.name];
	for (const c of candidates) {
		if (typeof c === "string" && c.trim().length > 0) {
			const s = c.trim();
			return s.length > 60 ? `${s.slice(0, 57)}...` : s;
		}
	}
	return "";
}
