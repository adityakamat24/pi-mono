import { describe, expect, it } from "vitest";
import { needsApproval } from "../../../src/core/mode/tool-mode-gate.js";
import {
	DEFAULT_SESSION_MODE,
	MODE_CHANGE_CUSTOM_TYPE,
	MODE_CYCLE_ORDER,
	type SessionMode,
} from "../../../src/core/mode/types.js";
import { EXIT_PLAN_MODE_TOOL_NAME } from "../../../src/core/tools/exit-plan-mode.js";
import { createHarness } from "../harness.js";

describe("session mode", () => {
	it("starts in normal mode by default", async () => {
		const h = await createHarness();
		try {
			expect(h.session.getMode()).toBe(DEFAULT_SESSION_MODE);
		} finally {
			h.cleanup();
		}
	});

	it("cycles modes in normal -> auto-edits -> manual -> plan -> normal order", async () => {
		const h = await createHarness();
		try {
			expect(MODE_CYCLE_ORDER).toEqual(["normal", "auto-edits", "manual", "plan"]);
			expect(h.session.cycleMode()).toBe(MODE_CYCLE_ORDER[1]);
			expect(h.session.cycleMode()).toBe(MODE_CYCLE_ORDER[2]);
			expect(h.session.cycleMode()).toBe(MODE_CYCLE_ORDER[3]);
			expect(h.session.cycleMode()).toBe(MODE_CYCLE_ORDER[0]);
		} finally {
			h.cleanup();
		}
	});

	it("setMode is a no-op when mode already matches", async () => {
		const h = await createHarness();
		try {
			h.session.setMode("normal");
			const before = h.eventsOfType("mode_change").length;
			h.session.setMode("normal");
			const after = h.eventsOfType("mode_change").length;
			expect(after).toBe(before);
		} finally {
			h.cleanup();
		}
	});

	it("emits mode_change when changing mode", async () => {
		const h = await createHarness();
		try {
			h.session.setMode("plan");
			h.session.setMode("auto-edits");
			const events = h.eventsOfType("mode_change");
			expect(events.map((e) => e.mode)).toEqual(["plan", "auto-edits"]);
			expect(events[0].previous).toBe("normal");
			expect(events[1].previous).toBe("plan");
		} finally {
			h.cleanup();
		}
	});

	it("registers ExitPlanMode tool while in plan mode and removes it on exit", async () => {
		const h = await createHarness();
		try {
			expect(h.session.getToolDefinition(EXIT_PLAN_MODE_TOOL_NAME)).toBeUndefined();

			h.session.setMode("plan");
			expect(h.session.getToolDefinition(EXIT_PLAN_MODE_TOOL_NAME)).toBeDefined();
			// Active tool list should include ExitPlanMode
			expect(h.session.getActiveToolNames()).toContain(EXIT_PLAN_MODE_TOOL_NAME);

			h.session.setMode("normal");
			expect(h.session.getToolDefinition(EXIT_PLAN_MODE_TOOL_NAME)).toBeUndefined();
			expect(h.session.getActiveToolNames()).not.toContain(EXIT_PLAN_MODE_TOOL_NAME);
		} finally {
			h.cleanup();
		}
	});

	it("persists mode changes as MODE_CHANGE_CUSTOM_TYPE custom entries", async () => {
		const h = await createHarness();
		try {
			h.session.setMode("plan");
			h.session.setMode("auto-edits");
			const entries = h.sessionManager
				.getEntries()
				.filter((e) => e.type === "custom" && e.customType === MODE_CHANGE_CUSTOM_TYPE);
			expect(entries.length).toBe(2);
			const modes = entries.map((e) => (e.type === "custom" ? (e.data as { mode: SessionMode }).mode : null));
			expect(modes).toEqual(["plan", "auto-edits"]);
		} finally {
			h.cleanup();
		}
	});

	it("plan-mode preamble appears in the system prompt while in plan mode", async () => {
		const h = await createHarness();
		try {
			expect(h.session.agent.state.systemPrompt).not.toContain("PLAN MODE");
			h.session.setMode("plan");
			expect(h.session.agent.state.systemPrompt).toContain("PLAN MODE");
			h.session.setMode("normal");
			expect(h.session.agent.state.systemPrompt).not.toContain("PLAN MODE");
		} finally {
			h.cleanup();
		}
	});
});

describe("needsApproval gate predicate", () => {
	it("normal mode: nothing needs approval", () => {
		expect(needsApproval("normal", "bash")).toBe(false);
		expect(needsApproval("normal", "edit")).toBe(false);
		expect(needsApproval("normal", "read")).toBe(false);
	});

	it("plan mode: tool registry restricts; gate doesn't prompt", () => {
		expect(needsApproval("plan", "read")).toBe(false);
		expect(needsApproval("plan", "ExitPlanMode")).toBe(false);
		// edit/write/bash never reach the gate in plan mode (not registered),
		// but the predicate still returns false.
		expect(needsApproval("plan", "bash")).toBe(false);
	});

	it("auto-edits mode: only bash requires approval", () => {
		expect(needsApproval("auto-edits", "bash")).toBe(true);
		expect(needsApproval("auto-edits", "edit")).toBe(false);
		expect(needsApproval("auto-edits", "write")).toBe(false);
		expect(needsApproval("auto-edits", "read")).toBe(false);
	});

	it("manual mode: everything except read-only tools requires approval", () => {
		// Read-only tools auto-run.
		expect(needsApproval("manual", "read")).toBe(false);
		expect(needsApproval("manual", "grep")).toBe(false);
		expect(needsApproval("manual", "find")).toBe(false);
		expect(needsApproval("manual", "ls")).toBe(false);
		// Mutating + command-running + extension tools all prompt.
		expect(needsApproval("manual", "edit")).toBe(true);
		expect(needsApproval("manual", "write")).toBe(true);
		expect(needsApproval("manual", "bash")).toBe(true);
		expect(needsApproval("manual", "web_fetch")).toBe(true);
		expect(needsApproval("manual", "Task")).toBe(true);
		expect(needsApproval("manual", "some-extension-tool")).toBe(true);
	});

	it("ExitPlanMode is never gated by approval", () => {
		expect(needsApproval("auto-edits", "ExitPlanMode")).toBe(false);
		expect(needsApproval("normal", "ExitPlanMode")).toBe(false);
		expect(needsApproval("plan", "ExitPlanMode")).toBe(false);
		expect(needsApproval("manual", "ExitPlanMode")).toBe(false);
	});
});
