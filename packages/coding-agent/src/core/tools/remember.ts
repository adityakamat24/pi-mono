/**
 * Remember tool.
 *
 * Persists a memory as a markdown file under `<agentDir>/memory/` so it
 * loads into the system prompt at the start of future sessions, via the
 * existing `core/memory/loader.ts` infrastructure. Reuses pi's file-based
 * markdown memory rather than introducing a parallel JSON memory blob.
 *
 * The tool runs through the standard mode gate, so it auto-runs in
 * `normal` / `auto-edits`, prompts in `manual`, and is denied in `plan`.
 * That gives a sensible default safety profile without special-casing.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Text } from "@mariozechner/pi-tui";
import { type Static, Type } from "typebox";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.js";
import { REMEMBER_TOOL_NAME } from "./remember-name.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

export { REMEMBER_TOOL_NAME };

const VALID_TYPES = ["user", "feedback", "project", "reference"] as const;
type MemoryType = (typeof VALID_TYPES)[number];

const rememberSchema = Type.Object({
	content: Type.String({
		description:
			"The memory body as markdown. Should be self-contained — a future session reading this file should understand it without conversation context.",
	}),
	name: Type.Optional(
		Type.String({
			description:
				"Short slug used in the filename and frontmatter (alphanumeric + dashes). Auto-derived from the first line of content if omitted.",
		}),
	),
	description: Type.Optional(
		Type.String({
			description:
				"One-line description shown in the /memory selector. Future sessions use this to decide if the memory is relevant — make it specific.",
		}),
	),
	type: Type.Optional(
		Type.String({
			description:
				"What kind of memory this is. Must be one of: 'user' (about the user — role/preferences/knowledge), 'feedback' (collaboration rules — what to do/avoid), 'project' (current work goals/decisions), 'reference' (pointers to external systems like Linear/Slack). Defaults to 'project'.",
		}),
	),
});

export type RememberInput = Static<typeof rememberSchema>;

export interface RememberDetails {
	saved?: boolean;
	path?: string;
	error?: string;
}

const PROMPT_SNIPPET =
	'Remember(content: string, name?: string, description?: string, type?: "user"|"feedback"|"project"|"reference"): persist a memory to <agentDir>/memory/<name>.md so it loads into the system prompt at the start of future sessions.';

const PROMPT_GUIDELINES = [
	"Call Remember when the user says something useful that should persist across sessions: their role, preferences, project conventions, decisions made, or pointers to external systems they use (Linear, Slack channels, dashboards).",
	"Don't remember ephemeral state: in-progress task details, current conversation context, fix recipes that already live in the code or git history. If `git log` or a grep would surface it, don't memoize it.",
	"For 'feedback' or 'project' memories, structure the body as: rule/fact, then a 'Why:' line explaining the reason, then a 'How to apply:' line for when the rule kicks in. The 'why' lets future sessions judge edge cases instead of blindly following the rule.",
	"Convert relative dates in user input to absolute dates before saving (e.g. 'Thursday' → '2026-03-05') so the memory remains interpretable later.",
	"Memories load at session START. The user must restart the session (or run /reload) for newly-saved memories to take effect in the current session — mention this in your response if relevant.",
];

export interface RememberToolOptions {
	/** Resolved agent directory; the tool writes to `<agentDir>/memory/`. */
	agentDir: string;
}

const NON_SLUG_CHAR = /[^a-z0-9_-]+/g;

function slugify(input: string): string {
	const slug = input
		.toLowerCase()
		.trim()
		.replace(/\s+/g, "-")
		.replace(NON_SLUG_CHAR, "")
		.slice(0, 60)
		.replace(/^-+|-+$/g, "");
	return slug || "memory";
}

function uniqueFilePath(dir: string, slug: string): string {
	let candidate = join(dir, `${slug}.md`);
	let i = 2;
	while (existsSync(candidate) && i < 1000) {
		candidate = join(dir, `${slug}-${i}.md`);
		i++;
	}
	return candidate;
}

function normaliseType(raw: string | undefined): MemoryType {
	if (raw && (VALID_TYPES as readonly string[]).includes(raw)) return raw as MemoryType;
	return "project";
}

function buildFrontmatter(name: string, description: string | undefined, type: MemoryType): string {
	const lines: string[] = ["---", `name: ${name}`];
	const trimmedDesc = description?.trim();
	if (trimmedDesc) lines.push(`description: ${trimmedDesc}`);
	lines.push(`type: ${type}`);
	lines.push("---", "");
	return lines.join("\n");
}

export function createRememberToolDefinition(
	options: RememberToolOptions,
): ToolDefinition<typeof rememberSchema, RememberDetails> {
	return {
		name: REMEMBER_TOOL_NAME,
		label: "Remember",
		description:
			"Persist a memory to disk so it loads into the system prompt in future sessions. Stores a markdown file under the user-scope memory directory (<agentDir>/memory/<slug>.md). Use for user preferences, project conventions, decisions, or references to external systems — anything worth remembering across sessions. Memory takes effect on the next session start (or after /reload).",
		promptSnippet: PROMPT_SNIPPET,
		promptGuidelines: PROMPT_GUIDELINES,
		parameters: rememberSchema,
		async execute(_toolCallId, params) {
			const memoryDir = join(options.agentDir, "memory");
			try {
				mkdirSync(memoryDir, { recursive: true });
				const seedSlug = params.name ?? params.content.split("\n")[0] ?? "memory";
				const slug = slugify(seedSlug);
				const path = uniqueFilePath(memoryDir, slug);
				const fmName = (params.name ?? slug).trim() || slug;
				const fmType = normaliseType(params.type);
				const frontmatter = buildFrontmatter(fmName, params.description, fmType);
				const body = `${params.content.trimEnd()}\n`;
				writeFileSync(path, `${frontmatter}\n${body}`, "utf-8");
				return {
					content: [
						{
							type: "text" as const,
							text: `Memory saved to ${path}. Loaded into the system prompt on the next session start, or run \`/reload\` to load now.`,
						},
					],
					details: { saved: true, path },
				};
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				return {
					content: [{ type: "text" as const, text: `Failed to save memory: ${msg}` }],
					details: { saved: false, error: msg },
				};
			}
		},
		renderCall(args, theme) {
			const name = typeof args?.name === "string" ? args.name : "";
			const headline = name
				? `${theme.fg("toolTitle", theme.bold("Remember"))} ${theme.fg("dim", name)}`
				: theme.fg("toolTitle", theme.bold("Remember"));
			return new Text(headline);
		},
		renderResult(result, _options: ToolRenderResultOptions, theme) {
			const details = result.details;
			if (details?.saved) {
				return new Text(theme.fg("success", `Saved to ${details.path}`));
			}
			if (details?.error) {
				return new Text(theme.fg("error", `Failed to save: ${details.error}`));
			}
			return new Text(theme.fg("warning", "Save status unknown."));
		},
	};
}

export function createRememberTool(options: RememberToolOptions): AgentTool<typeof rememberSchema> {
	return wrapToolDefinition(createRememberToolDefinition(options));
}
