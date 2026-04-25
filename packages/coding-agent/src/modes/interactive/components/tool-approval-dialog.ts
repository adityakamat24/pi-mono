/**
 * Dialog asking the user to approve / deny a single tool call.
 * Used by interactive mode when the session is in auto-edits mode and a bash
 * call needs explicit approval.
 */

import { Container, type SelectItem, SelectList, type SelectListLayoutOptions, Text } from "@mariozechner/pi-tui";
import type { ToolApprovalRequest, ToolApprovalResult } from "../../../core/mode/types.js";
import { getSelectListTheme, theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";

const LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 24,
	maxPrimaryColumnWidth: 48,
};

type Choice = "allow-once" | "allow-session" | "deny";

const CHOICES: SelectItem[] = [
	{ value: "allow-once", label: "Approve once", description: "Run this tool call only" },
	{
		value: "allow-session",
		label: "Approve & don't ask again this session",
		description: "Auto-approve future calls to this tool",
	},
	{ value: "deny", label: "Reject", description: "Tool call is denied; agent gets an error" },
];

function summarizeArgs(toolName: string, args: unknown): string {
	if (toolName === "bash" && typeof args === "object" && args !== null) {
		const cmd = (args as { command?: unknown }).command;
		if (typeof cmd === "string") return cmd;
	}
	try {
		return JSON.stringify(args, null, 2).slice(0, 600);
	} catch {
		return String(args);
	}
}

export class ToolApprovalDialogComponent extends Container {
	private selectList: SelectList;

	constructor(request: ToolApprovalRequest, onResolve: (result: ToolApprovalResult) => void) {
		super();
		this.addChild(new DynamicBorder());
		this.addChild(
			new Text(
				`${theme.fg("warning", `Approve tool call: ${theme.bold(request.toolName)}`)} (mode: ${request.mode})`,
			),
		);
		const summary = summarizeArgs(request.toolName, request.args);
		for (const line of summary.split("\n")) {
			this.addChild(new Text(theme.fg("toolOutput", line)));
		}
		this.selectList = new SelectList(CHOICES, CHOICES.length, getSelectListTheme(), LAYOUT);
		this.selectList.onSelect = (item) => {
			const value = item.value as Choice;
			if (value === "allow-once") onResolve({ outcome: "allow-once" });
			else if (value === "allow-session") onResolve({ outcome: "allow-session" });
			else onResolve({ outcome: "deny", reason: "User rejected the tool call" });
		};
		this.selectList.onCancel = () => onResolve({ outcome: "deny", reason: "User cancelled the approval prompt" });
		this.addChild(this.selectList);
		this.addChild(new DynamicBorder());
	}

	getSelectList(): SelectList {
		return this.selectList;
	}
}
