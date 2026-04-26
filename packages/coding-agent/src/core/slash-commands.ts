import { APP_NAME } from "../config.js";
import type { SourceInfo } from "./source-info.js";

export type SlashCommandSource = "extension" | "prompt" | "skill";

export interface SlashCommandInfo {
	name: string;
	description?: string;
	source: SlashCommandSource;
	sourceInfo: SourceInfo;
}

export interface BuiltinSlashCommand {
	name: string;
	description: string;
}

export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	{ name: "settings", description: "Open settings menu" },
	{ name: "model", description: "Select model (opens selector UI)" },
	{ name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling" },
	{ name: "export", description: "Export session (HTML default, or specify path: .html/.jsonl)" },
	{ name: "import", description: "Import and resume a session from a JSONL file" },
	{ name: "share", description: "Share session as a secret GitHub gist" },
	{ name: "copy", description: "Copy last agent message to clipboard" },
	{ name: "name", description: "Set session display name" },
	{ name: "session", description: "Show session info and stats" },
	{ name: "changelog", description: "Show changelog entries" },
	{ name: "hotkeys", description: "Show all keyboard shortcuts" },
	{ name: "agents", description: "List loaded subagent definitions (~/.pi/agents and .pi/agents)" },
	{ name: "teams", description: "Toggle agent teams (canSpawn orchestration): /teams on | off | status" },
	{ name: "undo", description: "Restore files to their state before the last edit/write (does not cover bash)" },
	{ name: "checkpoints", description: "List auto-checkpoints created during this session" },
	{ name: "jobs", description: "List background shell jobs spawned via BashSpawn" },
	{ name: "job", description: "Show recent output for a background job: /job <id>" },
	{ name: "kill", description: "Terminate a background job: /kill <id> [--force]" },
	{ name: "memory", description: "List loaded memory files (~/.pi/memory and .pi/memory)" },
	{ name: "pr", description: "Show cumulative session diff — every edit/write since session start" },
	{ name: "revert", description: "Revert a single hunk: /revert <relPath> <hunkIndex> (find indexes via /pr)" },
	{ name: "plan", description: "Enter plan mode (research with read-only tools, then approve a plan)" },
	{ name: "mode", description: "Set input mode: /mode normal | auto-edits | manual | plan" },
	{ name: "fork", description: "Create a new fork from a previous user message" },
	{ name: "clone", description: "Duplicate the current session at the current position" },
	{ name: "tree", description: "Navigate session tree (switch branches)" },
	{ name: "login", description: "Configure provider authentication" },
	{ name: "logout", description: "Remove provider authentication" },
	{ name: "new", description: "Start a new session" },
	{ name: "compact", description: "Manually compact the session context" },
	{ name: "resume", description: "Resume a different session" },
	{ name: "reload", description: "Reload keybindings, extensions, skills, prompts, and themes" },
	{ name: "quit", description: `Quit ${APP_NAME}` },
	{ name: "exit", description: `Exit ${APP_NAME} and return to the terminal` },
];
