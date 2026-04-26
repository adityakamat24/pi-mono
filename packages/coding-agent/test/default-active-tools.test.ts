/**
 * Regression test: a fresh session created with defaults must expose the
 * full set of built-in + meta tools to the model, NOT just the original
 * four (read/bash/edit/write).
 *
 * History: a hardcoded list in sdk.ts overrode agent-session.ts's intended
 * default, hiding EnterPlanMode / Remember / Task / grep / find / ls /
 * web_fetch / bash_spawn from the LLM. This test pins the contract so the
 * same drift can't happen again.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";

const EXPECTED_DEFAULT_ACTIVE_TOOLS = [
	"read",
	"bash",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
	"bash_spawn",
	"web_fetch",
	"EnterPlanMode",
	"Remember",
	// Task is conditional on subagent definitions existing — not asserted here
	// because the test fixture doesn't write any. The 3592 test covers the
	// "registered when subagents exist" case.
];

describe("default active tool list", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-default-tools-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	async function createDefaultSession() {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory(tempDir);
		const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
		});
		await session.bindExtensions({});
		return session;
	}

	it("exposes all built-in + meta tools to the model by default", async () => {
		const session = await createDefaultSession();
		try {
			const active = new Set(session.getActiveToolNames());
			for (const expected of EXPECTED_DEFAULT_ACTIVE_TOOLS) {
				expect(
					active.has(expected),
					`expected "${expected}" in default active tool list — got: ${[...active].sort().join(", ")}`,
				).toBe(true);
			}
		} finally {
			session.dispose();
		}
	});

	it("registers all of those tools (getAllTools includes them)", async () => {
		const session = await createDefaultSession();
		try {
			const all = new Set(session.getAllTools().map((t) => t.name));
			for (const expected of EXPECTED_DEFAULT_ACTIVE_TOOLS) {
				expect(
					all.has(expected),
					`expected "${expected}" in registered tool list — got: ${[...all].sort().join(", ")}`,
				).toBe(true);
			}
		} finally {
			session.dispose();
		}
	});

	it("preserves the active tool list across plan→normal mode round-trip", async () => {
		const session = await createDefaultSession();
		try {
			const initialActive = [...session.getActiveToolNames()].sort();
			expect(initialActive.length).toBeGreaterThanOrEqual(EXPECTED_DEFAULT_ACTIVE_TOOLS.length);

			session.setMode("plan");
			const planActive = session.getActiveToolNames();
			// Plan mode strips write tools; should NOT contain bash/edit/write.
			expect(planActive).not.toContain("bash");
			expect(planActive).not.toContain("edit");
			expect(planActive).not.toContain("write");
			// And must include the read-only set + ExitPlanMode.
			expect(planActive).toContain("read");
			expect(planActive).toContain("ExitPlanMode");

			session.setMode("normal");
			const restored = [...session.getActiveToolNames()].sort();
			expect(
				restored,
				`mode round-trip lost tools: ${initialActive.filter((t) => !restored.includes(t)).join(", ")}`,
			).toEqual(initialActive);
		} finally {
			session.dispose();
		}
	});

	it("plan-mode active list contains exactly the read-only set + ExitPlanMode", async () => {
		const session = await createDefaultSession();
		try {
			session.setMode("plan");
			const planActive = new Set(session.getActiveToolNames());
			// Must contain.
			for (const tool of ["read", "grep", "find", "ls", "ExitPlanMode"]) {
				expect(
					planActive.has(tool),
					`plan mode missing "${tool}" — got: ${[...planActive].sort().join(", ")}`,
				).toBe(true);
			}
			// Must NOT contain mutating tools.
			for (const tool of ["bash", "edit", "write", "bash_spawn"]) {
				expect(planActive.has(tool), `plan mode should not include "${tool}"`).toBe(false);
			}
		} finally {
			session.dispose();
		}
	});

	it("registers CamelCase aliases for canonical tools so model-side typos resolve", async () => {
		const session = await createDefaultSession();
		try {
			// agent.state.tools is the LLM-facing tool list including aliases.
			const toolNames = new Set(session.agent.state.tools.map((t) => t.name));
			const expectedAliases: Record<string, string> = {
				Read: "read",
				Bash: "bash",
				Edit: "edit",
				Write: "write",
				Grep: "grep",
				Find: "find",
				Ls: "ls",
				BashSpawn: "bash_spawn",
				WebFetch: "web_fetch",
			};
			for (const [alias, canonical] of Object.entries(expectedAliases)) {
				expect(toolNames.has(alias), `expected alias "${alias}" registered (canonical: ${canonical})`).toBe(true);
				expect(toolNames.has(canonical), `expected canonical "${canonical}" still registered`).toBe(true);
			}
		} finally {
			session.dispose();
		}
	});

	it("alias and canonical share the same execute (gate behavior is identical)", async () => {
		const session = await createDefaultSession();
		try {
			const tools = session.agent.state.tools;
			const editCanonical = tools.find((t) => t.name === "edit");
			const editAlias = tools.find((t) => t.name === "Edit");
			expect(editCanonical, "canonical 'edit' should be in state.tools").toBeDefined();
			expect(editAlias, "alias 'Edit' should be in state.tools").toBeDefined();
			// Same execute closure — gate logic captured against the canonical
			// name, so the alias inherits the right mode-gate behavior.
			expect(editAlias?.execute).toBe(editCanonical?.execute);
		} finally {
			session.dispose();
		}
	});

	it("aliases do NOT leak into the system prompt's tool list (canonical names only)", async () => {
		const session = await createDefaultSession();
		try {
			const sysPrompt = session.agent.state.systemPrompt ?? "";
			// Canonical names appear in the prompt's "Available tools" section.
			expect(sysPrompt).toContain("- edit:");
			expect(sysPrompt).toContain("- bash:");
			// CamelCase aliases must not appear as tool entries — they would
			// confuse the model's choice and bloat the prompt.
			expect(sysPrompt).not.toContain("- Edit:");
			expect(sysPrompt).not.toContain("- Bash:");
			expect(sysPrompt).not.toContain("- BashSpawn:");
			expect(sysPrompt).not.toContain("- WebFetch:");
		} finally {
			session.dispose();
		}
	});
});
