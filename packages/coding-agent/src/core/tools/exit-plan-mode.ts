/**
 * ExitPlanMode tool.
 *
 * The agent calls this once it has finished researching in plan mode and is
 * ready for the user to approve a plan.
 *
 * Note: the body of `execute()` here is a no-op fallback. The real behavior is
 * implemented in the mode gate (`core/mode/tool-mode-gate.ts`), which intercepts
 * any call to a tool with this name and routes through the host's plan-approval
 * dialog. We keep a real implementation for completeness so the tool registry
 * does not blow up if the gate is somehow bypassed (e.g., in a unit test that
 * runs the raw tool).
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Text } from "@mariozechner/pi-tui";
import { type Static, Type } from "typebox";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.js";
import { EXIT_PLAN_MODE_TOOL_NAME } from "./exit-plan-mode-name.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

export { EXIT_PLAN_MODE_TOOL_NAME };

const exitPlanModeSchema = Type.Object({
	plan: Type.String({
		description:
			"The plan in markdown. Use a numbered list of concrete steps. The user will see this verbatim and approve or reject it.",
	}),
});

export type ExitPlanModeInput = Static<typeof exitPlanModeSchema>;

export interface ExitPlanModeDetails {
	approved?: boolean;
	nextMode?: "normal" | "auto-edits";
	feedback?: string;
}

const PROMPT_SNIPPET =
	"ExitPlanMode(plan: string): present a numbered markdown plan and request approval to leave plan mode. Use this tool when you have finished planning the implementation steps of a task that requires writing code.";

const PROMPT_GUIDELINES = [
	"Only call ExitPlanMode when the task requires writing code. For research tasks where you are gathering information, searching files, reading files, or trying to understand the codebase, do NOT use ExitPlanMode — answer in chat instead.",
	"Before calling ExitPlanMode, do enough research with the read-only tools (read, grep, find, ls) that the plan is concrete and grounded in actual code paths.",
	"The plan should be a numbered list of concrete steps describing what files would change and what the changes would do. The user sees the plan verbatim and approves or rejects it.",
	"If the user rejects the plan, the rejection message contains their feedback. Incorporate it and call ExitPlanMode again with a revised plan.",
];

export interface ExitPlanModeToolOptions {
	/**
	 * Optional fallback handler. Used when the tool runs outside the mode gate
	 * (for example in a raw unit test). The interactive runtime intercepts the
	 * call before this is reached.
	 */
	onCall?: (input: ExitPlanModeInput) => void | Promise<void>;
}

export function createExitPlanModeToolDefinition(
	options?: ExitPlanModeToolOptions,
): ToolDefinition<typeof exitPlanModeSchema, ExitPlanModeDetails> {
	return {
		name: EXIT_PLAN_MODE_TOOL_NAME,
		label: "Exit plan mode",
		description:
			"Use this tool when you are in plan mode and have finished presenting your plan and are ready to code. This will prompt the user to exit plan mode. IMPORTANT: Only use this tool when the task requires planning the implementation steps of a task that requires writing code. For research tasks where you're gathering information, searching files, reading files or in general trying to understand the codebase - do NOT use this tool.",
		promptSnippet: PROMPT_SNIPPET,
		promptGuidelines: PROMPT_GUIDELINES,
		parameters: exitPlanModeSchema,
		async execute(_toolCallId, params) {
			await options?.onCall?.(params);
			return {
				content: [
					{
						type: "text" as const,
						text:
							"ExitPlanMode was invoked outside of an interactive session, so the plan cannot be approved here. The plan was:\n\n" +
							params.plan,
					},
				],
				details: { approved: false },
			};
		},
		renderCall(args, theme) {
			const planPreview = typeof args?.plan === "string" ? args.plan.split("\n")[0] : "";
			const headline = `${theme.fg("toolTitle", theme.bold("ExitPlanMode"))} ${theme.fg(
				"accent",
				planPreview ? planPreview.slice(0, 80) : "(plan attached)",
			)}`;
			return new Text(headline);
		},
		renderResult(result, _options: ToolRenderResultOptions, theme) {
			const details = result.details;
			if (details?.approved) {
				return new Text(theme.fg("success", `Plan approved → switched to ${details.nextMode ?? "normal"}`));
			}
			if (details?.feedback) {
				return new Text(theme.fg("warning", `Plan rejected: ${details.feedback}`));
			}
			return new Text(theme.fg("warning", "Plan was not approved."));
		},
	};
}

export function createExitPlanModeTool(options?: ExitPlanModeToolOptions): AgentTool<typeof exitPlanModeSchema> {
	return wrapToolDefinition(createExitPlanModeToolDefinition(options));
}
