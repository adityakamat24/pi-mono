/**
 * Cumulative token + cost totals for a session.
 *
 * Footer and the working indicator both read these on every render frame.
 * Computing them by iterating session entries every frame is O(N) per frame
 * with N growing without bound; for long sessions this becomes the dominant
 * render cost. Instead we maintain incremental totals here, updated once per
 * assistant message.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ReadonlySessionManager } from "./session-manager.js";

export interface UsageTotalsSnapshot {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export class UsageTotals {
	private input = 0;
	private output = 0;
	private cacheRead = 0;
	private cacheWrite = 0;
	private cost = 0;

	/** Reset and rebuild from a session manager's full entry list (used on session load). */
	rebuildFrom(sessionManager: ReadonlySessionManager): void {
		this.input = 0;
		this.output = 0;
		this.cacheRead = 0;
		this.cacheWrite = 0;
		this.cost = 0;
		for (const entry of sessionManager.getEntries()) {
			if (entry.type === "message" && entry.message.role === "assistant") {
				const msg = entry.message as AssistantMessage;
				this.input += msg.usage.input;
				this.output += msg.usage.output;
				this.cacheRead += msg.usage.cacheRead;
				this.cacheWrite += msg.usage.cacheWrite;
				this.cost += msg.usage.cost.total;
			}
		}
	}

	/** Add an assistant message's usage to the running totals. */
	addAssistantMessage(message: AgentMessage): void {
		if (message.role !== "assistant") return;
		const msg = message as AssistantMessage;
		this.input += msg.usage.input;
		this.output += msg.usage.output;
		this.cacheRead += msg.usage.cacheRead;
		this.cacheWrite += msg.usage.cacheWrite;
		this.cost += msg.usage.cost.total;
	}

	snapshot(): UsageTotalsSnapshot {
		return {
			input: this.input,
			output: this.output,
			cacheRead: this.cacheRead,
			cacheWrite: this.cacheWrite,
			cost: this.cost,
		};
	}

	/** Reset to zero (used after compaction summarizes prior totals into a new baseline). */
	reset(): void {
		this.input = 0;
		this.output = 0;
		this.cacheRead = 0;
		this.cacheWrite = 0;
		this.cost = 0;
	}
}
