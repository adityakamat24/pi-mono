/**
 * Dialog shown when the agent calls ExitPlanMode.
 *
 * Render states:
 * 1. "select" — user picks an outcome: approve into one of three modes,
 *    revise the plan first, or reject and tell the agent what to revise.
 * 2. "feedback" — after picking reject, user types feedback that's sent
 *    back to the model so it can revise the plan. Empty submit falls back
 *    to a boilerplate rejection; Esc returns to the select state.
 * 3. "mode-picker" — after revising the plan in an external editor, user
 *    picks which non-plan mode to switch into. The edited plan is what
 *    gets persisted + re-injected as context (not the model's original).
 *
 * The "revise" flow uses the host-provided `onEditPlan` callback, which
 * the interactive-mode wires to spawn $VISUAL/$EDITOR with the plan
 * pre-populated in a temp file. This keeps editor logic (TUI pause/start,
 * spawnSync, file handling) out of the dialog.
 */

import {
	type Component,
	Container,
	Input,
	Markdown,
	type SelectItem,
	SelectList,
	type SelectListLayoutOptions,
	Text,
} from "@mariozechner/pi-tui";
import type { PlanApprovalRequest, PlanApprovalResult, SessionMode } from "../../../core/mode/types.js";
import { getMarkdownTheme, getSelectListTheme, theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";

const SELECT_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 28,
	maxPrimaryColumnWidth: 64,
};

type SelectChoice = "approve-normal" | "approve-auto-edits" | "approve-manual" | "revise-plan" | "reject";

const SELECT_CHOICES: SelectItem[] = [
	{
		value: "approve-normal",
		label: "Yes, proceed with no prompts",
		description: "Switch to Normal mode (every tool runs automatically)",
	},
	{
		value: "approve-auto-edits",
		label: "Yes, but ask before bash",
		description: "Switch to Auto-Accept Edits — edits/writes auto-run, bash prompts",
	},
	{
		value: "approve-manual",
		label: "Yes, manually approve every tool",
		description: "Switch to Manual mode — every tool call asks for approval",
	},
	{
		value: "revise-plan",
		label: "Yes, but let me revise the plan first",
		description: "Open the plan in $VISUAL/$EDITOR, then pick a mode to switch into",
	},
	{
		value: "reject",
		label: "No, keep planning",
		description: "Stay in plan mode and tell the agent what to revise",
	},
];

type ModeChoice = "normal" | "auto-edits" | "manual";

const MODE_CHOICES: SelectItem[] = [
	{
		value: "normal",
		label: "Normal mode — no prompts",
		description: "Every tool runs automatically. Lowest friction.",
	},
	{
		value: "auto-edits",
		label: "Auto-Accept Edits — bash prompts",
		description: "Edits/writes auto-run, bash prompts.",
	},
	{
		value: "manual",
		label: "Manual approval — every tool prompts",
		description: "Each tool call asks for explicit approval.",
	},
];

/** Open the plan in an external editor and return the (possibly edited) result. */
export type EditPlanCallback = (currentPlan: string) => Promise<string | null>;

export class PlanApprovalDialogComponent extends Container {
	private selectList: SelectList;
	private editedPlan: string | undefined;

	constructor(
		private readonly request: PlanApprovalRequest,
		private readonly onResolve: (result: PlanApprovalResult) => void,
		private readonly onFocusChange?: (focus: Component) => void,
		private readonly onEditPlan?: EditPlanCallback,
		private readonly onStatus?: (message: string) => void,
	) {
		super();
		this.selectList = this._buildSelectList();
		this._renderSelectState();
	}

	/** Initial focus target — used by the host's showSelector(). */
	getSelectList(): SelectList {
		return this.selectList;
	}

	private _buildSelectList(): SelectList {
		const list = new SelectList(SELECT_CHOICES, SELECT_CHOICES.length, getSelectListTheme(), SELECT_LAYOUT);
		list.onSelect = (item) => {
			const value = item.value as SelectChoice;
			if (value === "approve-normal") {
				this.onResolve({ outcome: "approve", nextMode: "normal" satisfies Exclude<SessionMode, "plan"> });
			} else if (value === "approve-auto-edits") {
				this.onResolve({ outcome: "approve", nextMode: "auto-edits" satisfies Exclude<SessionMode, "plan"> });
			} else if (value === "approve-manual") {
				this.onResolve({ outcome: "approve", nextMode: "manual" satisfies Exclude<SessionMode, "plan"> });
			} else if (value === "revise-plan") {
				void this._handleRevise();
			} else {
				this._renderFeedbackState();
			}
		};
		list.onCancel = () => {
			this.onResolve({
				outcome: "reject",
				feedback: "User cancelled the approval prompt without choosing. Stay in plan mode.",
			});
		};
		return list;
	}

	private async _handleRevise(): Promise<void> {
		if (!this.onEditPlan) {
			this.onStatus?.("No external editor configured. Set $VISUAL or $EDITOR to revise plans.");
			return;
		}
		const seed = this.editedPlan ?? this.request.plan;
		const result = await this.onEditPlan(seed);
		if (result === null || result === undefined) {
			// Cancelled or editor failed — stay in select state with the dialog re-shown.
			this._renderSelectState();
			return;
		}
		this.editedPlan = result;
		this._renderModePickerState();
	}

	private _renderSelectState(): void {
		this.clear();
		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.fg("accent", theme.bold("Ready to code?"))));
		this.addChild(
			new Text(
				theme.fg(
					"dim",
					"Here is the agent's plan. Approve to exit plan mode, revise to edit it first, or reject with feedback to keep planning.",
				),
			),
		);
		const planForDisplay = this.editedPlan ?? this.request.plan;
		this.addChild(new Markdown(planForDisplay, 1, 0, getMarkdownTheme()));
		this.addChild(this.selectList);
		this.addChild(new DynamicBorder());
		this.onFocusChange?.(this.selectList);
	}

	private _renderModePickerState(): void {
		this.clear();
		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.fg("accent", theme.bold("Plan revised — pick a mode to continue"))));
		this.addChild(
			new Text(
				theme.fg(
					"dim",
					"Your edited plan will be re-injected to the agent as authoritative context. Choose how strict the harness should be from here.",
				),
			),
		);
		this.addChild(new Markdown(this.editedPlan ?? this.request.plan, 1, 0, getMarkdownTheme()));
		const list = new SelectList(MODE_CHOICES, MODE_CHOICES.length, getSelectListTheme(), SELECT_LAYOUT);
		list.onSelect = (item) => {
			const nextMode = item.value as ModeChoice;
			this.onResolve({
				outcome: "approve",
				nextMode,
				editedPlan: this.editedPlan,
			});
		};
		list.onCancel = () => {
			// Esc on mode-picker drops back to the original choices, keeping the
			// edited plan available so a second "Revise" doesn't lose work.
			this._renderSelectState();
		};
		this.addChild(list);
		this.addChild(new DynamicBorder());
		this.onFocusChange?.(list);
	}

	private _renderFeedbackState(): void {
		this.clear();
		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.fg("warning", theme.bold("Tell the agent what to revise"))));
		this.addChild(
			new Text(theme.fg("dim", "Type feedback below and press Enter to send. Press Esc to go back to the choices.")),
		);
		const input = new Input();
		input.onSubmit = (value: string) => {
			const trimmed = value.trim();
			this.onResolve({
				outcome: "reject",
				feedback:
					trimmed.length > 0
						? `User rejected the plan with feedback: ${trimmed}`
						: "User rejected the plan without specific feedback. Re-read the request, identify what's likely off about the plan, and revise.",
			});
		};
		input.onEscape = () => {
			this._renderSelectState();
		};
		this.addChild(input);
		this.addChild(new DynamicBorder());
		this.onFocusChange?.(input);
	}
}
