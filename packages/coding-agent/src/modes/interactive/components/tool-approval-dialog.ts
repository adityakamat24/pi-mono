/**
 * Dialog asking the user to approve / deny a single tool call.
 *
 * Two render states:
 * 1. "select" — user picks: approve once, approve & don't ask again, or reject.
 * 2. "feedback" — after picking reject, user types feedback that's sent back to
 *    the model as a deny-with-feedback result. Empty submit falls back to a
 *    plain deny; Esc returns to the select state.
 *
 * Used by interactive mode whenever a tool call needs explicit approval —
 * either because of the current session mode (auto-edits gates bash; manual
 * gates everything that mutates) or because the tool name is in the
 * settings.permissions.askTools list.
 */

import {
	type Component,
	Container,
	Input,
	type SelectItem,
	SelectList,
	type SelectListLayoutOptions,
	Text,
} from "@mariozechner/pi-tui";
import type { ToolApprovalRequest, ToolApprovalResult } from "../../../core/mode/types.js";
import { getSelectListTheme, theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";

const LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 24,
	maxPrimaryColumnWidth: 56,
};

type Choice = "allow-once" | "allow-session" | "deny";

const CHOICES: SelectItem[] = [
	{ value: "allow-once", label: "Approve once", description: "Run this tool call only" },
	{
		value: "allow-session",
		label: "Approve & don't ask again this session",
		description: "Auto-approve future calls to this tool",
	},
	{
		value: "deny",
		label: "Reject and tell the agent what to do differently",
		description: "Decline this call and send feedback back to the model",
	},
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

	constructor(
		private readonly request: ToolApprovalRequest,
		private readonly onResolve: (result: ToolApprovalResult) => void,
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
			if (value === "allow-once") this.onResolve({ outcome: "allow-once" });
			else if (value === "allow-session") this.onResolve({ outcome: "allow-session" });
			else this._renderFeedbackState();
		};
		list.onCancel = () => this.onResolve({ outcome: "deny", reason: "User cancelled the approval prompt" });
		return list;
	}

	private _renderSelectState(): void {
		this.clear();
		this.addChild(new DynamicBorder());
		this.addChild(
			new Text(
				`${theme.fg("warning", `Approve tool call: ${theme.bold(this.request.toolName)}`)} (mode: ${this.request.mode})`,
			),
		);
		const summary = summarizeArgs(this.request.toolName, this.request.args);
		for (const line of summary.split("\n")) {
			this.addChild(new Text(theme.fg("toolOutput", line)));
		}
		this.addChild(this.selectList);
		this.addChild(new DynamicBorder());
		this.onFocusChange?.(this.selectList);
	}

	private _renderFeedbackState(): void {
		this.clear();
		this.addChild(new DynamicBorder());
		this.addChild(
			new Text(
				theme.fg("warning", theme.bold(`Reject ${this.request.toolName} — what should the agent do instead?`)),
			),
		);
		this.addChild(
			new Text(theme.fg("dim", "Type feedback below and press Enter to send. Press Esc to go back to the choices.")),
		);
		const input = new Input();
		input.onSubmit = (value: string) => {
			const trimmed = value.trim();
			if (trimmed.length > 0) {
				this.onResolve({ outcome: "deny-with-feedback", feedback: trimmed });
			} else {
				this.onResolve({ outcome: "deny", reason: "User rejected the tool call" });
			}
		};
		input.onEscape = () => {
			this._renderSelectState();
		};
		this.addChild(input);
		this.addChild(new DynamicBorder());
		this.onFocusChange?.(input);
	}
}
