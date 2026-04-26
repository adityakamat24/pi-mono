/**
 * Dialog shown when the agent calls ExitPlanMode.
 *
 * Two render states:
 * 1. "select" — user picks an outcome: approve into one of three modes, or
 *    reject and tell the agent what to revise.
 * 2. "feedback" — after picking reject, user types feedback that's sent back
 *    to the model so it can revise the plan. Empty submit falls back to a
 *    boilerplate rejection; Esc returns to the select state.
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

const LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 28,
	maxPrimaryColumnWidth: 64,
};

type Choice = "approve-normal" | "approve-auto-edits" | "approve-manual" | "reject";

const CHOICES: SelectItem[] = [
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
		value: "reject",
		label: "No, keep planning",
		description: "Stay in plan mode and tell the agent what to revise",
	},
];

export class PlanApprovalDialogComponent extends Container {
	private selectList: SelectList;

	constructor(
		private readonly request: PlanApprovalRequest,
		private readonly onResolve: (result: PlanApprovalResult) => void,
		private readonly onFocusChange?: (focus: Component) => void,
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
		const list = new SelectList(CHOICES, CHOICES.length, getSelectListTheme(), LAYOUT);
		list.onSelect = (item) => {
			const value = item.value as Choice;
			if (value === "approve-normal") {
				this.onResolve({ outcome: "approve", nextMode: "normal" satisfies Exclude<SessionMode, "plan"> });
			} else if (value === "approve-auto-edits") {
				this.onResolve({ outcome: "approve", nextMode: "auto-edits" satisfies Exclude<SessionMode, "plan"> });
			} else if (value === "approve-manual") {
				this.onResolve({ outcome: "approve", nextMode: "manual" satisfies Exclude<SessionMode, "plan"> });
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

	private _renderSelectState(): void {
		this.clear();
		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.fg("accent", theme.bold("Ready to code?"))));
		this.addChild(
			new Text(
				theme.fg(
					"dim",
					"Here is the agent's plan. Approve to exit plan mode, or reject with feedback to keep planning.",
				),
			),
		);
		this.addChild(new Markdown(this.request.plan, 1, 0, getMarkdownTheme()));
		this.addChild(this.selectList);
		this.addChild(new DynamicBorder());
		this.onFocusChange?.(this.selectList);
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
