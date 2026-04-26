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
 *
 * Per-tool argument rendering: instead of dumping raw JSON, the dialog shows
 * domain-aware previews — diff blocks for `edit`, content preview for `write`,
 * the literal command for `bash` / `bash_spawn`, the URL for `web_fetch`, and
 * agent + prompt for `Task`. Anything else falls back to JSON.
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

const MAX_LINE_LENGTH = 120;
const MAX_BASH_LINES = 8;
const MAX_EDIT_BLOCKS = 3;
const MAX_EDIT_LINES_PER_BLOCK = 6;
const MAX_WRITE_LINES = 12;
const MAX_TASK_PROMPT_LINES = 4;
const MAX_JSON_CHARS = 600;

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

function clip(line: string, max: number = MAX_LINE_LENGTH): string {
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

interface EditPair {
	oldText: string;
	newText: string;
}

function extractEdits(args: Record<string, unknown>): EditPair[] {
	const arr = args.edits;
	if (Array.isArray(arr)) {
		return arr
			.map((e) => {
				if (typeof e !== "object" || e === null) return null;
				const r = e as Record<string, unknown>;
				const oldText = asString(r.oldText) ?? asString(r.old_string);
				const newText = asString(r.newText) ?? asString(r.new_string);
				if (oldText === undefined || newText === undefined) return null;
				return { oldText, newText };
			})
			.filter((e): e is EditPair => e !== null);
	}
	const legacyOld = asString(args.oldText) ?? asString(args.old_string);
	const legacyNew = asString(args.newText) ?? asString(args.new_string);
	if (legacyOld !== undefined && legacyNew !== undefined) {
		return [{ oldText: legacyOld, newText: legacyNew }];
	}
	return [];
}

/**
 * Render a tool's args as a list of pre-coloured display lines.
 *
 * The dialog adds one Text component per returned line, so this function
 * controls all formatting and colour.
 */
function summarizeArgsRich(toolName: string, rawArgs: unknown): string[] {
	const args: Record<string, unknown> =
		typeof rawArgs === "object" && rawArgs !== null ? (rawArgs as Record<string, unknown>) : {};

	switch (toolName) {
		case "bash":
		case "bash_spawn": {
			const cmd = asString(args.command) ?? "";
			const desc = asString(args.description);
			const lines: string[] = [];
			if (desc) lines.push(theme.fg("dim", clip(desc)));
			const cmdLines = cmd.split("\n");
			const shown = cmdLines.slice(0, MAX_BASH_LINES);
			for (let i = 0; i < shown.length; i++) {
				const prefix = i === 0 ? theme.fg("accent", "$ ") : "  ";
				lines.push(prefix + theme.fg("toolOutput", clip(shown[i])));
			}
			if (cmdLines.length > MAX_BASH_LINES) {
				lines.push(theme.fg("dim", `  … and ${cmdLines.length - MAX_BASH_LINES} more line(s)`));
			}
			return lines;
		}

		case "edit": {
			const path = asString(args.path) ?? asString(args.file_path) ?? "";
			const edits = extractEdits(args);
			const lines: string[] = [];
			if (path) lines.push(theme.fg("accent", theme.bold(path)));
			if (edits.length === 0) {
				lines.push(theme.fg("dim", "(no edits found in args)"));
				return lines;
			}
			const shown = edits.slice(0, MAX_EDIT_BLOCKS);
			for (let i = 0; i < shown.length; i++) {
				if (i > 0) lines.push("");
				if (edits.length > 1) {
					lines.push(theme.fg("dim", `edit ${i + 1} of ${edits.length}:`));
				}
				const oldLines = shown[i].oldText.split("\n");
				const newLines = shown[i].newText.split("\n");
				const oldShown = oldLines.slice(0, MAX_EDIT_LINES_PER_BLOCK);
				const newShown = newLines.slice(0, MAX_EDIT_LINES_PER_BLOCK);
				for (const line of oldShown) {
					lines.push(theme.fg("toolDiffRemoved", clip(`- ${line}`)));
				}
				if (oldLines.length > MAX_EDIT_LINES_PER_BLOCK) {
					lines.push(theme.fg("dim", `  … (${oldLines.length - MAX_EDIT_LINES_PER_BLOCK} more old lines)`));
				}
				for (const line of newShown) {
					lines.push(theme.fg("toolDiffAdded", clip(`+ ${line}`)));
				}
				if (newLines.length > MAX_EDIT_LINES_PER_BLOCK) {
					lines.push(theme.fg("dim", `  … (${newLines.length - MAX_EDIT_LINES_PER_BLOCK} more new lines)`));
				}
			}
			if (edits.length > MAX_EDIT_BLOCKS) {
				lines.push("");
				lines.push(theme.fg("dim", `… and ${edits.length - MAX_EDIT_BLOCKS} more edit block(s)`));
			}
			return lines;
		}

		case "write": {
			const path = asString(args.path) ?? asString(args.file_path) ?? "";
			const content = asString(args.content) ?? "";
			const lines: string[] = [];
			if (path) lines.push(theme.fg("accent", theme.bold(path)));
			lines.push(theme.fg("dim", `${content.length} bytes, ${content.split("\n").length} line(s) — full overwrite`));
			const contentLines = content.split("\n");
			const shown = contentLines.slice(0, MAX_WRITE_LINES);
			for (const line of shown) {
				lines.push(theme.fg("toolDiffAdded", clip(`+ ${line}`)));
			}
			if (contentLines.length > MAX_WRITE_LINES) {
				lines.push(theme.fg("dim", `  … and ${contentLines.length - MAX_WRITE_LINES} more line(s)`));
			}
			return lines;
		}

		case "web_fetch": {
			const url = asString(args.url) ?? "";
			const lines: string[] = [];
			if (url) lines.push(`${theme.fg("accent", "GET ")}${theme.fg("toolTitle", clip(url))}`);
			const rest: Record<string, unknown> = { ...args };
			delete rest.url;
			const restKeys = Object.keys(rest);
			if (restKeys.length > 0) {
				try {
					lines.push(theme.fg("dim", clip(JSON.stringify(rest))));
				} catch {
					/* ignore */
				}
			}
			return lines;
		}

		case "Task": {
			const agent = asString(args.agent) ?? "";
			const prompt = asString(args.prompt) ?? "";
			const lines: string[] = [];
			if (agent) {
				lines.push(`${theme.fg("dim", "agent:")} ${theme.fg("toolTitle", theme.bold(agent))}`);
			}
			if (prompt) {
				const promptLines = prompt.split("\n");
				const shown = promptLines.slice(0, MAX_TASK_PROMPT_LINES);
				for (let i = 0; i < shown.length; i++) {
					const prefix = i === 0 ? theme.fg("dim", "prompt: ") : "        ";
					lines.push(prefix + theme.fg("toolOutput", clip(shown[i])));
				}
				if (promptLines.length > MAX_TASK_PROMPT_LINES) {
					lines.push(theme.fg("dim", `        … and ${promptLines.length - MAX_TASK_PROMPT_LINES} more line(s)`));
				}
			}
			return lines;
		}

		default: {
			try {
				const json = JSON.stringify(rawArgs, null, 2);
				const truncated = json.length > MAX_JSON_CHARS ? `${json.slice(0, MAX_JSON_CHARS)}…` : json;
				return truncated.split("\n").map((line) => theme.fg("toolOutput", clip(line)));
			} catch {
				return [theme.fg("toolOutput", clip(String(rawArgs)))];
			}
		}
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
		const lines = summarizeArgsRich(this.request.toolName, this.request.args);
		for (const line of lines) {
			this.addChild(new Text(line));
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
