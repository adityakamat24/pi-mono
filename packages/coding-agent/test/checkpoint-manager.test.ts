import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CheckpointManager } from "../src/core/checkpoint/manager.js";

describe("CheckpointManager (file-snapshot, no git)", () => {
	let projectDir: string;
	let agentDir: string;
	let originalAgentDir: string | undefined;

	beforeEach(() => {
		const root = join(tmpdir(), `pi-cp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		projectDir = join(root, "project");
		agentDir = join(root, "agent");
		mkdirSync(projectDir, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		originalAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
	});

	afterEach(() => {
		if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		rmSync(join(projectDir, ".."), { recursive: true, force: true });
	});

	it("snapshots and restores existing files", async () => {
		const file = join(projectDir, "a.txt");
		writeFileSync(file, "before");

		const mgr = new CheckpointManager(projectDir, "session-1");
		const entry = await mgr.create("edit a.txt", [file]);
		expect(entry).toBeDefined();
		expect(entry?.files).toEqual([file]);

		writeFileSync(file, "after");
		expect(readFileSync(file, "utf-8")).toBe("after");

		const result = await mgr.undo();
		expect(result.ok).toBe(true);
		expect(readFileSync(file, "utf-8")).toBe("before");
		expect(mgr.list()).toHaveLength(0);
	});

	it("deletes files that did not exist pre-mutation", async () => {
		const file = join(projectDir, "new.txt");
		const mgr = new CheckpointManager(projectDir, "session-2");

		const entry = await mgr.create("write new.txt", [file]);
		expect(entry).toBeDefined();

		writeFileSync(file, "freshly written");
		expect(existsSync(file)).toBe(true);

		const result = await mgr.undo();
		expect(result.ok).toBe(true);
		expect(existsSync(file)).toBe(false);
	});

	it("never creates files inside the user's project tree", async () => {
		const file = join(projectDir, "x.txt");
		writeFileSync(file, "v1");

		const mgr = new CheckpointManager(projectDir, "session-3");
		await mgr.create("edit x.txt", [file]);

		// Project tree should contain only the original file we created.
		const projectFiles = require("node:fs").readdirSync(projectDir);
		expect(projectFiles).toEqual(["x.txt"]);
	});

	it("stores snapshots under the agent dir, not the project dir", async () => {
		const file = join(projectDir, "y.txt");
		writeFileSync(file, "v1");

		const mgr = new CheckpointManager(projectDir, "session-4");
		await mgr.create("edit y.txt", [file]);

		const snapshotDir = join(agentDir, "sessions", "session-4", "snapshots", "1");
		expect(existsSync(snapshotDir)).toBe(true);
		expect(existsSync(join(snapshotDir, "manifest.json"))).toBe(true);
	});

	it("supports multiple checkpoints and restores by id", async () => {
		const file = join(projectDir, "z.txt");
		writeFileSync(file, "v1");

		const mgr = new CheckpointManager(projectDir, "session-5");
		const cp1 = await mgr.create("edit z.txt", [file]);
		writeFileSync(file, "v2");
		const cp2 = await mgr.create("edit z.txt", [file]);
		writeFileSync(file, "v3");

		expect(mgr.list()).toHaveLength(2);

		// Undo specific checkpoint (cp1) — restores v1.
		const r1 = await mgr.undo(cp1?.id);
		expect(r1.ok).toBe(true);
		expect(readFileSync(file, "utf-8")).toBe("v1");

		// cp2 should still be there.
		expect(mgr.list()).toHaveLength(1);
		expect(mgr.list()[0].id).toBe(cp2?.id);
	});

	it("returns ok=false when no checkpoints exist", async () => {
		const mgr = new CheckpointManager(projectDir, "session-6");
		const result = await mgr.undo();
		expect(result.ok).toBe(false);
		expect(result.message).toMatch(/no checkpoints/i);
	});

	it("dedupes identical content via content-addressed blobs", async () => {
		const a = join(projectDir, "a.txt");
		const b = join(projectDir, "b.txt");
		writeFileSync(a, "shared");
		writeFileSync(b, "shared");

		const mgr = new CheckpointManager(projectDir, "session-7");
		await mgr.create("edit both", [a, b]);

		const blobsDir = join(agentDir, "sessions", "session-7", "snapshots", "1", "files");
		const blobs = require("node:fs").readdirSync(blobsDir);
		expect(blobs).toHaveLength(1); // both files share one blob
	});
});
