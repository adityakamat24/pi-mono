/**
 * EnterPlanMode tool.
 *
 * The agent calls this when the user asks for a plan, design, or otherwise
 * asks to "use plan mode" / "plan this out" / similar. The harness then
 * switches into plan mode: only read-only tools auto-run, and the agent
 * eventually must call `ExitPlanMode` with a markdown plan for user approval.
 *
 * The body of `execute()` here is a no-op fallback. The real behavior is
 * implemented in the mode gate (`core/mode/tool-mode-gate.ts`), which
 * intercepts any call to a tool with this name and routes through the host's
 * `onEnterPlanMode()` callback. The fallback exists so the tool registry
 * does not blow up if the gate is somehow bypassed (e.g. in a unit test
 * that runs the raw tool).
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Text } from "@mariozechner/pi-tui";
import { type Static, Type } from "typebox";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.js";
import { ENTER_PLAN_MODE_TOOL_NAME } from "./enter-plan-mode-name.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

export { ENTER_PLAN_MODE_TOOL_NAME };

const enterPlanModeSchema = Type.Object({
	reason: Type.Optional(
		Type.String({
			description: "Optional one-line reason for entering plan mode (shown to the user).",
		}),
	),
});

export type EnterPlanModeInput = Static<typeof enterPlanModeSchema>;

export interface EnterPlanModeDetails {
	switched?: boolean;
	reason?: string;
}

const PROMPT_SNIPPET =
	"EnterPlanMode(reason?: string): switch the session into plan mode. After this call, only read-only tools (read, grep, find, ls) auto-run; the model must research and then call ExitPlanMode with a markdown plan that the user approves.";

const PROMPT_GUIDELINES = [
	"Call EnterPlanMode when the user asks you to plan, design, or otherwise asks to 'use plan mode' / 'plan this out' for a coding task that involves writing code. Examples: 'plan a refactor of X', 'use plan mode to design Y', 'first plan, then implement'.",
	"Once in plan mode, you may only use read-only tools (`read`, `grep`, `find`, `ls`). Research thoroughly using those, then call `ExitPlanMode` exactly once with a numbered markdown plan describing the concrete changes you would make. The user will approve or reject the plan in a dialog.",
	"Do NOT call EnterPlanMode for pure research, explanation, or Q&A tasks (e.g. 'how does X work?', 'where is Y defined?'). Just answer in chat using the read-only tools.",
	"Do NOT call EnterPlanMode if the session is already in plan mode — it's a no-op.",
];

export interface EnterPlanModeToolOptions {
	/**
	 * Optional fallback handler. Used when the tool runs outside the mode gate
	 * (for example in a raw unit test). The interactive runtime intercepts the
	 * call before this is reached.
	 */
	onCall?: (input: EnterPlanModeInput) => void | Promise<void>;
}

export function createEnterPlanModeToolDefinition(
	options?: EnterPlanModeToolOptions,
): ToolDefinition<typeof enterPlanModeSchema, EnterPlanModeDetails> {
	return {
		name: ENTER_PLAN_MODE_TOOL_NAME,
		label: "Enter plan mode",
		description:
			"Switch the session into PLAN MODE. The harness will restrict the tool set to read-only (`read`, `grep`, `find`, `ls`) plus `ExitPlanMode`. Use this when the user explicitly asks to plan, design, or 'use plan mode' for a coding task. After researching the problem, call `ExitPlanMode` with a numbered markdown plan.",
		promptSnippet: PROMPT_SNIPPET,
		promptGuidelines: PROMPT_GUIDELINES,
		parameters: enterPlanModeSchema,
		async execute(_toolCallId, params) {
			await options?.onCall?.(params);
			return {
				content: [
					{
						type: "text" as const,
						text: "EnterPlanMode was invoked outside of an interactive session, so the mode could not be switched.",
					},
				],
				details: { switched: false, reason: params.reason },
			};
		},
		renderCall(args, theme) {
			const reason = typeof args?.reason === "string" ? args.reason : "";
			const headline = reason
				? `${theme.fg("toolTitle", theme.bold("EnterPlanMode"))} ${theme.fg("dim", reason.slice(0, 80))}`
				: theme.fg("toolTitle", theme.bold("EnterPlanMode"));
			return new Text(headline);
		},
		renderResult(result, _options: ToolRenderResultOptions, theme) {
			const details = result.details;
			if (details?.switched) {
				return new Text(theme.fg("accent", "Switched to plan mode — only read-only tools available."));
			}
			return new Text(
				theme.fg("warning", "Mode was not switched (already in plan mode or non-interactive context)."),
			);
		},
	};
}

export function createEnterPlanModeTool(options?: EnterPlanModeToolOptions): AgentTool<typeof enterPlanModeSchema> {
	return wrapToolDefinition(createEnterPlanModeToolDefinition(options));
}
