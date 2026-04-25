/**
 * Dialog shown when the agent calls ExitPlanMode. Displays the proposed plan
 * (markdown) and asks the user to approve it (and choose the next mode) or
 * reject it with feedback.
 */

import {
	Container,
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
	maxPrimaryColumnWidth: 56,
};

type Choice = "approve-normal" | "approve-auto-edits" | "reject";

const CHOICES: SelectItem[] = [
	{
		value: "approve-normal",
		label: "Yes, proceed with no prompts",
		description: "Switch to Normal mode (pi default — every tool runs automatically)",
	},
	{
		value: "approve-auto-edits",
		label: "Yes, but ask before bash",
		description: "Switch to Auto-Accept Edits — edits/writes auto-run, bash prompts for approval",
	},
	{
		value: "reject",
		label: "No, keep planning",
		description: "Stay in plan mode and revise the plan",
	},
];

export class PlanApprovalDialogComponent extends Container {
	private selectList: SelectList;

	constructor(request: PlanApprovalRequest, onResolve: (result: PlanApprovalResult) => void) {
		super();
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
		this.addChild(new Markdown(request.plan, 1, 0, getMarkdownTheme()));
		this.selectList = new SelectList(CHOICES, CHOICES.length, getSelectListTheme(), LAYOUT);
		this.selectList.onSelect = (item) => {
			const value = item.value as Choice;
			if (value === "approve-normal") {
				onResolve({ outcome: "approve", nextMode: "normal" satisfies Exclude<SessionMode, "plan"> });
			} else if (value === "approve-auto-edits") {
				onResolve({ outcome: "approve", nextMode: "auto-edits" satisfies Exclude<SessionMode, "plan"> });
			} else {
				onResolve({
					outcome: "reject",
					feedback:
						"User rejected the plan. Revise based on what you read and call ExitPlanMode again with an updated plan.",
				});
			}
		};
		this.selectList.onCancel = () => {
			onResolve({
				outcome: "reject",
				feedback: "User cancelled the approval prompt without choosing. Stay in plan mode.",
			});
		};
		this.addChild(this.selectList);
		this.addChild(new DynamicBorder());
	}

	getSelectList(): SelectList {
		return this.selectList;
	}
}
