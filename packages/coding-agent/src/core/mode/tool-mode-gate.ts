/**
 * Wraps a list of AgentTools so that, depending on the current session mode,
 * `execute()` first awaits user approval before invoking the underlying tool.
 *
 * The mode gate is the single primitive that turns "auto-accept-edits" mode
 * into a real thing and lets the `ExitPlanMode` tool intercept plan approval.
 *
 * Plan-mode write restriction is NOT enforced here — that is enforced by the
 * tool registry only registering read-only tools while the session is in plan
 * mode. This file only handles approval-gated execution.
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { EXIT_PLAN_MODE_TOOL_NAME } from "../tools/exit-plan-mode-name.js";
import type {
	PlanApprovalRequest,
	PlanApprovalResult,
	SessionMode,
	ToolApprovalRequest,
	ToolApprovalResult,
} from "./types.js";

export interface ModeGateContext {
	/** Read the current mode at execution time (not capture time). */
	getMode(): SessionMode;
	/** Ask the host (interactive/print/rpc) for a tool-approval decision. */
	requestApproval(request: ToolApprovalRequest): Promise<ToolApprovalResult>;
	/** Ask the host for a plan-approval decision (ExitPlanMode tool). */
	requestPlanApproval(request: PlanApprovalRequest): Promise<PlanApprovalResult>;
	/** Persist the approved plan as a custom message and switch the session mode. */
	onPlanApproved(plan: string, nextMode: Exclude<SessionMode, "plan">): void;
	/** Record a session-scoped allowlist hit so we don't ask again for this tool name. */
	rememberAllow(toolName: string): void;
	/** Has this tool name been allow-listed for the rest of this session? */
	isAllowed(toolName: string): boolean;
	/**
	 * Tool names that should always require approval (from
	 * `settings.permissions.askTools`). Returns an empty set when unset.
	 */
	getAskTools(): ReadonlySet<string>;
}

/**
 * Decide whether a given tool needs an approval prompt in the given mode.
 *
 * Pure, exported for unit tests.
 */
export function needsApproval(mode: SessionMode, toolName: string): boolean {
	if (toolName === EXIT_PLAN_MODE_TOOL_NAME) {
		// ExitPlanMode has its own dedicated approval path (plan_approval_request).
		// It does NOT go through the tool approval prompt.
		return false;
	}
	switch (mode) {
		case "normal":
			return false;
		case "plan":
			// In plan mode, write tools aren't even registered, so anything that
			// reaches execute() is a read-only tool and runs without a prompt.
			return false;
		case "auto-edits":
			// Only bash prompts in auto-edits mode; edit/write/read auto-run.
			return toolName === "bash";
		case "manual":
			// Manual mode: gate every tool that mutates state or runs commands.
			// Pure-read tools (read/grep/find/ls) auto-run; everything else —
			// edit, write, bash, web_fetch, Task, extension tools — prompts.
			return toolName !== "read" && toolName !== "grep" && toolName !== "find" && toolName !== "ls";
	}
}

function denyResult(toolName: string, reason: string): AgentToolResult<unknown> {
	return {
		content: [
			{
				type: "text" as const,
				text: `Tool \`${toolName}\` was not executed: ${reason}`,
			},
		],
		details: { rejected: true, reason },
	};
}

/**
 * Wrap a single AgentTool so its execute() consults the mode gate first.
 * Used by ExitPlanMode wiring as well as the mass-wrap below.
 */
export function wrapToolWithModeGate<T extends AgentTool>(tool: T, ctx: ModeGateContext): T {
	const original = tool.execute;
	const wrapped: AgentTool["execute"] = async (toolCallId, params, signal, onUpdate) => {
		// ExitPlanMode is intercepted here regardless of mode: when called, it
		// publishes the plan and awaits user approval. The original execute()
		// is never invoked — the host owns the side effect (mode change,
		// plan persistence) via onPlanApproved().
		if (tool.name === EXIT_PLAN_MODE_TOOL_NAME) {
			const plan = typeof (params as { plan?: unknown })?.plan === "string" ? (params as { plan: string }).plan : "";
			const decision = await ctx.requestPlanApproval({ toolCallId, plan });
			if (decision.outcome === "approve") {
				ctx.onPlanApproved(plan, decision.nextMode);
				return {
					content: [
						{
							type: "text" as const,
							text:
								`Plan approved by user. Mode switched to "${decision.nextMode}". ` +
								`Proceed with the plan above using the now-available write tools.`,
						},
					],
					details: { approved: true, nextMode: decision.nextMode },
				};
			}
			return {
				content: [
					{
						type: "text" as const,
						text:
							"Plan was rejected. Stay in plan mode and revise the plan based on this feedback before calling ExitPlanMode again:\n\n" +
							decision.feedback,
					},
				],
				details: { approved: false, feedback: decision.feedback },
			};
		}

		const mode = ctx.getMode();
		const askTools = ctx.getAskTools();
		const askListedHit = askTools.has(tool.name);
		const needsByMode = needsApproval(mode, tool.name);
		if ((needsByMode || askListedHit) && !ctx.isAllowed(tool.name)) {
			const decision = await ctx.requestApproval({
				toolCallId,
				toolName: tool.name,
				args: params,
				mode,
			});
			if (decision.outcome === "deny") {
				return denyResult(tool.name, decision.reason ?? "user denied execution");
			}
			if (decision.outcome === "deny-with-feedback") {
				return denyResult(tool.name, decision.feedback);
			}
			if (decision.outcome === "allow-session") {
				ctx.rememberAllow(tool.name);
			}
		}
		return original(toolCallId, params, signal, onUpdate);
	};
	return { ...tool, execute: wrapped } as T;
}

/** Wrap every tool in `tools` with the same mode gate. */
export function wrapToolsWithModeGate(tools: AgentTool[], ctx: ModeGateContext): AgentTool[] {
	return tools.map((tool) => wrapToolWithModeGate(tool, ctx));
}
