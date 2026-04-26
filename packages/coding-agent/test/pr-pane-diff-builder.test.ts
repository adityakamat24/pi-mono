import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSessionDiff } from "../src/core/pr-pane/diff-builder.js";

interface FakeSnapshot {
	seq: string;
	createdAt: number;
	files: Array<{
		relPath: string;
		absPath: string;
		preImage: string | null; // null = file did not exist before
		preImageTooLarge?: boolean; // simulate sha:null for too-large
	}>;
}

function sha256(s: string): string {
	return createHash("sha256").update(Buffer.from(s, "utf-8")).digest("hex");
}

function writeFakeSnapshot(snapshotsDir: string, snap: FakeSnapshot): void {
	const seqDir = join(snapshotsDir, snap.seq);
	const filesDir = join(seqDir, "files");
	mkdirSync(filesDir, { recursive: true });
	const manifestFiles = snap.files.map((f) => {
		if (f.preImage === null) {
			return { relPath: f.relPath, absPath: f.absPath, sha: null, size: 0, existedBefore: false };
		}
		if (f.preImageTooLarge) {
			return { relPath: f.relPath, absPath: f.absPath, sha: null, size: 999, existedBefore: true };
		}
		const sha = sha256(f.preImage);
		writeFileSync(join(filesDir, `${sha}.bin`), f.preImage, "utf-8");
		return { relPath: f.relPath, absPath: f.absPath, sha, size: f.preImage.length, existedBefore: true };
	});
	writeFileSync(
		join(seqDir, "manifest.json"),
		JSON.stringify(
			{ id: snap.seq, createdAt: snap.createdAt, reason: `seq ${snap.seq}`, files: manifestFiles },
			null,
			2,
		),
	);
}

describe("buildSessionDiff", () => {
	let tempDir: string;
	let cwd: string;
	let snapshotsDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-pr-pane-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "project");
		snapshotsDir = join(tempDir, "snapshots");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(snapshotsDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("returns an empty diff when no snapshots exist", () => {
		const result = buildSessionDiff(snapshotsDir, cwd);
		expect(result.files).toEqual([]);
		expect(result.totalAdditions).toBe(0);
		expect(result.totalDeletions).toBe(0);
	});

	it("reports a modified file with one hunk", () => {
		const absPath = join(cwd, "foo.ts");
		writeFakeSnapshot(snapshotsDir, {
			seq: "1",
			createdAt: 100,
			files: [{ relPath: "foo.ts", absPath, preImage: "line one\nline two\nline three\n" }],
		});
		writeFileSync(absPath, "line one\nLINE TWO\nline three\n", "utf-8");

		const result = buildSessionDiff(snapshotsDir, cwd);
		expect(result.files).toHaveLength(1);
		const file = result.files[0];
		expect(file.relPath).toBe("foo.ts");
		expect(file.status).toBe("modified");
		expect(file.hunks.length).toBeGreaterThan(0);
		expect(file.additions).toBe(1);
		expect(file.deletions).toBe(1);
		expect(result.totalAdditions).toBe(1);
		expect(result.totalDeletions).toBe(1);
	});

	it("classifies a newly-created file as added", () => {
		const absPath = join(cwd, "new-file.ts");
		writeFakeSnapshot(snapshotsDir, {
			seq: "1",
			createdAt: 100,
			files: [{ relPath: "new-file.ts", absPath, preImage: null }],
		});
		writeFileSync(absPath, "alpha\nbeta\n", "utf-8");

		const result = buildSessionDiff(snapshotsDir, cwd);
		expect(result.files).toHaveLength(1);
		expect(result.files[0].status).toBe("added");
		expect(result.files[0].additions).toBe(2);
		expect(result.files[0].deletions).toBe(0);
	});

	it("classifies a removed-from-disk file as deleted", () => {
		const absPath = join(cwd, "gone.ts");
		writeFakeSnapshot(snapshotsDir, {
			seq: "1",
			createdAt: 100,
			files: [{ relPath: "gone.ts", absPath, preImage: "kept\nremoved\n" }],
		});
		// Don't write to disk — simulating the file was deleted during the session.

		const result = buildSessionDiff(snapshotsDir, cwd);
		expect(result.files).toHaveLength(1);
		expect(result.files[0].status).toBe("deleted");
		expect(result.files[0].additions).toBe(0);
		expect(result.files[0].deletions).toBe(2);
	});

	it("uses the EARLIEST snapshot per file when multiple exist", () => {
		const absPath = join(cwd, "edited-twice.ts");
		writeFakeSnapshot(snapshotsDir, {
			seq: "2",
			createdAt: 200,
			files: [{ relPath: "edited-twice.ts", absPath, preImage: "intermediate\n" }],
		});
		writeFakeSnapshot(snapshotsDir, {
			seq: "1",
			createdAt: 100,
			files: [{ relPath: "edited-twice.ts", absPath, preImage: "original\n" }],
		});
		writeFileSync(absPath, "final\n", "utf-8");

		const result = buildSessionDiff(snapshotsDir, cwd);
		expect(result.files).toHaveLength(1);
		const file = result.files[0];
		// Diff should be original → final (1 add, 1 remove), not intermediate → final.
		expect(file.additions).toBe(1);
		expect(file.deletions).toBe(1);
		const allText = file.hunks.flatMap((h) => h.lines).map((l) => l.text);
		expect(allText).toContain("original");
		expect(allText).toContain("final");
		expect(allText).not.toContain("intermediate");
	});

	it("filters out files that ended up identical to the session-start state", () => {
		const absPath = join(cwd, "round-tripped.ts");
		writeFakeSnapshot(snapshotsDir, {
			seq: "1",
			createdAt: 100,
			files: [{ relPath: "round-tripped.ts", absPath, preImage: "same content\n" }],
		});
		writeFileSync(absPath, "same content\n", "utf-8");

		const result = buildSessionDiff(snapshotsDir, cwd);
		expect(result.files).toEqual([]);
	});

	it("marks too-large files as skipped instead of producing a diff", () => {
		const absPath = join(cwd, "huge.ts");
		writeFakeSnapshot(snapshotsDir, {
			seq: "1",
			createdAt: 100,
			files: [{ relPath: "huge.ts", absPath, preImage: "irrelevant", preImageTooLarge: true }],
		});
		writeFileSync(absPath, "anything", "utf-8");

		const result = buildSessionDiff(snapshotsDir, cwd);
		expect(result.files).toHaveLength(1);
		expect(result.files[0].status).toBe("skipped");
		expect(result.skippedCount).toBe(1);
	});

	it("aggregates totals across multiple files", () => {
		const a = join(cwd, "a.ts");
		const b = join(cwd, "b.ts");
		writeFakeSnapshot(snapshotsDir, {
			seq: "1",
			createdAt: 100,
			files: [
				{ relPath: "a.ts", absPath: a, preImage: "old-a-1\nold-a-2\n" },
				{ relPath: "b.ts", absPath: b, preImage: null },
			],
		});
		writeFileSync(a, "new-a-1\nnew-a-2\n", "utf-8");
		writeFileSync(b, "fresh-b\n", "utf-8");

		const result = buildSessionDiff(snapshotsDir, cwd);
		expect(result.files).toHaveLength(2);
		expect(result.totalAdditions).toBeGreaterThanOrEqual(3);
		expect(result.totalDeletions).toBeGreaterThanOrEqual(2);
	});

	it("assigns each hunk a stable id of <absPath>#<index>", () => {
		const absPath = join(cwd, "c.ts");
		writeFakeSnapshot(snapshotsDir, {
			seq: "1",
			createdAt: 100,
			files: [
				{
					relPath: "c.ts",
					absPath,
					preImage: "line a\nline b\nline c\n\n\n\n\n\nline d\nline e\n",
				},
			],
		});
		writeFileSync(absPath, "LINE A\nline b\nline c\n\n\n\n\n\nline d\nLINE E\n", "utf-8");

		const result = buildSessionDiff(snapshotsDir, cwd);
		const file = result.files[0];
		expect(file.hunks.length).toBeGreaterThanOrEqual(2);
		for (const hunk of file.hunks) {
			expect(hunk.id).toBe(`${absPath}#${hunk.index}`);
		}
	});
});
