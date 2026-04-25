/**
 * BashSpawn tool — runs a shell command in the background and returns a job
 * handle immediately. Pair with `/jobs`, `/job <id>`, and `/kill <id>` for
 * inspection and termination.
 *
 * Use cases the regular `bash` tool can't handle:
 *   - `npm run dev` / `next dev` style watch processes the user wants kept
 *     alive while the conversation continues.
 *   - Long-running tests/builds where the agent should keep working in
 *     parallel and check back later.
 *
 * Security: same shell sandbox as the regular `bash` tool (uses the user's
 * configured shell with the shell-command-prefix). No new attack surface —
 * just no blocking.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Text } from "@mariozechner/pi-tui";
import { type Static, Type } from "typebox";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.js";
import { getSharedJobManager } from "../jobs/manager.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

export const BASH_SPAWN_TOOL_NAME = "bash_spawn";

const bashSpawnSchema = Type.Object({
	command: Type.String({
		description:
			"Shell command to run in the background. Same shell as the regular `bash` tool. The command does NOT block — it returns a job ID immediately. Use /jobs to list, /job <id> to inspect output, /kill <id> to terminate.",
	}),
	purpose: Type.Optional(
		Type.String({
			description:
				'One-line description of what this background process is doing (e.g. "dev server"). Surfaced in /jobs.',
		}),
	),
});

export type BashSpawnToolInput = Static<typeof bashSpawnSchema>;

export interface BashSpawnToolDetails {
	jobId?: string;
	command?: string;
	pid?: number;
	error?: string;
}

export interface BashSpawnToolOptions {
	/** Shell to use. Default: bash on POSIX, cmd /c on Windows. */
	shellPath?: string;
	/** Optional command prefix (matches the regular bash tool's shellCommandPrefix). */
	shellCommandPrefix?: string;
}

const PROMPT_SNIPPET =
	"BashSpawn(command, purpose?): start a background shell command and return a job ID. Use /jobs, /job <id>, /kill <id> from the UI.";

const PROMPT_GUIDELINES = [
	"Use BashSpawn ONLY for long-running processes the user wants kept alive (dev servers, watch tasks). For one-shot commands use the regular `bash` tool.",
	"Always include a `purpose` so the user can identify the job in /jobs.",
	"Do not poll a background job inside the same turn — let it run, continue the conversation, and inspect output later via /job <id> or /kill <id>.",
];

function resolveShell(options: BashSpawnToolOptions): { command: string; argFlag: string } {
	if (options.shellPath) {
		return { command: options.shellPath, argFlag: "-c" };
	}
	if (process.platform === "win32") {
		return { command: process.env.ComSpec ?? "cmd.exe", argFlag: "/c" };
	}
	return { command: "/bin/bash", argFlag: "-c" };
}

export function createBashSpawnToolDefinition(
	cwd: string,
	options: BashSpawnToolOptions = {},
): ToolDefinition<typeof bashSpawnSchema, BashSpawnToolDetails> {
	return {
		name: BASH_SPAWN_TOOL_NAME,
		label: "Spawn background shell",
		description:
			"Start a long-running shell command in the background and return immediately with a job ID. Output is captured to a ring buffer (last ~64KB). Use /jobs to list, /job <id> to inspect, /kill <id> to terminate. Same shell sandbox as the regular `bash` tool.",
		promptSnippet: PROMPT_SNIPPET,
		promptGuidelines: PROMPT_GUIDELINES,
		parameters: bashSpawnSchema,
		async execute(_toolCallId, params) {
			const { command, argFlag } = resolveShell(options);
			const finalCommand = options.shellCommandPrefix
				? `${options.shellCommandPrefix}\n${params.command}`
				: params.command;
			try {
				const jobs = getSharedJobManager();
				const info = jobs.spawn({
					command,
					args: [argFlag, finalCommand],
					cwd,
					env: process.env,
				});
				const purpose = params.purpose?.trim();
				const summary =
					`Started background job ${info.id} (pid ${info.pid ?? "?"})\n` +
					`Command: ${params.command}\n` +
					(purpose ? `Purpose: ${purpose}\n` : "") +
					`Inspect with /job ${info.id} · terminate with /kill ${info.id}.`;
				return {
					content: [{ type: "text" as const, text: summary }],
					details: { jobId: info.id, command: params.command, pid: info.pid },
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text" as const, text: `BashSpawn failed: ${message}` }],
					details: { error: message, command: params.command },
				};
			}
		},
		renderCall(args, theme) {
			const cmd = typeof args?.command === "string" ? args.command : "(unknown)";
			const purpose =
				typeof args?.purpose === "string" && args.purpose ? ` ${theme.fg("dim", `"${args.purpose}"`)}` : "";
			return new Text(`${theme.fg("toolTitle", theme.bold("BashSpawn"))} ${theme.fg("accent", cmd)}${purpose}`);
		},
		renderResult(result, _options: ToolRenderResultOptions, theme) {
			const details = result.details;
			if (details?.error) {
				return new Text(theme.fg("error", `failed: ${details.error}`));
			}
			if (details?.jobId) {
				return new Text(theme.fg("dim", `job ${details.jobId} (pid ${details.pid ?? "?"})`));
			}
			return new Text("");
		},
	};
}

export function createBashSpawnTool(
	cwd: string,
	options: BashSpawnToolOptions = {},
): AgentTool<typeof bashSpawnSchema> {
	return wrapToolDefinition(createBashSpawnToolDefinition(cwd, options));
}
