/**
 * Input modes for an interactive coding session.
 *
 * - "normal": all tools auto-execute (pi's historical default — no friction).
 * - "auto-edits": file-mutating tools auto-execute, but `bash` requires approval.
 * - "manual": every tool that mutates state or runs a command prompts. Only the
 *   pure-read tools (`read`, `grep`, `find`, `ls`) auto-run. Mirrors Claude
 *   Code's "default" permission mode — every edit, write, bash, web_fetch, or
 *   subagent dispatch asks first.
 * - "plan": only read-only tools and the `ExitPlanMode` tool are registered. The
 *   model researches, then must call `ExitPlanMode` with a markdown plan; the
 *   user approves and the session switches back to a non-plan mode.
 */
export type SessionMode = "normal" | "auto-edits" | "manual" | "plan";

export const SESSION_MODES: ReadonlyArray<SessionMode> = ["normal", "auto-edits", "manual", "plan"];

export const DEFAULT_SESSION_MODE: SessionMode = "normal";

/** Order used by cycleMode(): normal -> auto-edits -> manual -> plan -> normal. */
export const MODE_CYCLE_ORDER: ReadonlyArray<SessionMode> = ["normal", "auto-edits", "manual", "plan"];

/** Human-readable label shown in the footer badge. */
export function modeLabel(mode: SessionMode): string {
	switch (mode) {
		case "normal":
			return "NORMAL";
		case "auto-edits":
			return "AUTO-ACCEPT EDITS";
		case "manual":
			return "MANUAL APPROVAL";
		case "plan":
			return "PLAN MODE";
	}
}

/** Short hint shown next to the footer badge. */
export function modeHint(mode: SessionMode): string {
	switch (mode) {
		case "normal":
			return "";
		case "auto-edits":
			return "bash will prompt";
		case "manual":
			return "every tool prompts";
		case "plan":
			return "read-only • call ExitPlanMode when ready";
	}
}

/** Request emitted when a tool needs explicit user approval before running. */
export interface ToolApprovalRequest {
	toolCallId: string;
	toolName: string;
	args: unknown;
	mode: SessionMode;
}

export type ToolApprovalOutcome =
	/** Approve once for this single tool call. */
	| { outcome: "allow-once" }
	/** Approve and don't ask again for this tool name during the rest of the session. */
	| { outcome: "allow-session" }
	/** Reject. The tool returns an error result to the model. */
	| { outcome: "deny"; reason?: string }
	/** Reject with feedback the model should incorporate before retrying. */
	| { outcome: "deny-with-feedback"; feedback: string };

export type ToolApprovalResult = ToolApprovalOutcome;

/** Request emitted when the model invokes ExitPlanMode. */
export interface PlanApprovalRequest {
	toolCallId: string;
	plan: string;
}

export type PlanApprovalResult =
	/**
	 * User approved and chose the next mode to switch into. If `editedPlan` is
	 * set, the user revised the plan via an external editor before approving;
	 * the gate should persist and inject the edited version, not the model's
	 * original.
	 */
	| { outcome: "approve"; nextMode: Exclude<SessionMode, "plan">; editedPlan?: string }
	/** User rejected; the model should revise the plan based on feedback. */
	| { outcome: "reject"; feedback: string };

/** customType used for the persisted `plan_approved` custom message. */
export const PLAN_APPROVED_CUSTOM_TYPE = "plan_approved";

/** customType used for the per-mode-change marker entry. */
export const MODE_CHANGE_CUSTOM_TYPE = "mode_change";

/** Payload of a MODE_CHANGE_CUSTOM_TYPE entry. */
export interface ModeChangeData {
	mode: SessionMode;
}

/** Payload of a PLAN_APPROVED_CUSTOM_TYPE custom message's `details`. */
export interface PlanApprovedDetails {
	approvedAt: string;
	nextMode: Exclude<SessionMode, "plan">;
}
