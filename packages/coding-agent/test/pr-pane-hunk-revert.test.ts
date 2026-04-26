import * as Diff from "diff";
import { describe, expect, it } from "vitest";
import { revertHunk } from "../src/core/pr-pane/hunk-revert.js";
import type { Hunk } from "../src/core/pr-pane/types.js";

function buildHunks(absPath: string, oldContent: string, newContent: string): Hunk[] {
	const patch = Diff.structuredPatch("a", "b", oldContent, newContent, "", "", { context: 3 });
	return patch.hunks.map((h, index) => ({
		id: `${absPath}#${index}`,
		index,
		oldStart: h.oldStart,
		oldLines: h.oldLines,
		newStart: h.newStart,
		newLines: h.newLines,
		// NOTE: lines representation isn't needed for the revert algorithm —
		// it operates purely on the (oldStart, oldLines, newStart, newLines)
		// quadruple plus the original file's content. Pass an empty array.
		lines: [],
	}));
}

describe("revertHunk", () => {
	it("reverts a single-line modification", () => {
		const original = "alpha\nbravo\ncharlie\n";
		const current = "alpha\nBRAVO\ncharlie\n";
		const hunks = buildHunks("/x.txt", original, current);
		expect(hunks).toHaveLength(1);
		const result = revertHunk(current, original, hunks[0]);
		expect(result.content).toBe(original);
	});

	it("reverts a multi-line insertion", () => {
		const original = "head\nfoot\n";
		const current = "head\ninserted-1\ninserted-2\nfoot\n";
		const hunks = buildHunks("/x.txt", original, current);
		expect(hunks).toHaveLength(1);
		const result = revertHunk(current, original, hunks[0]);
		expect(result.content).toBe(original);
	});

	it("reverts a multi-line deletion", () => {
		const original = "alpha\nbeta\ngamma\ndelta\n";
		const current = "alpha\ndelta\n";
		const hunks = buildHunks("/x.txt", original, current);
		expect(hunks).toHaveLength(1);
		const result = revertHunk(current, original, hunks[0]);
		expect(result.content).toBe(original);
	});

	it("only reverts ONE hunk when there are multiple", () => {
		const original = "a\nb\nc\n\n\n\n\n\nx\ny\nz\n";
		const current = "A\nb\nc\n\n\n\n\n\nx\ny\nZ\n";
		const hunks = buildHunks("/x.txt", original, current);
		expect(hunks.length).toBeGreaterThanOrEqual(2);
		const reverted0 = revertHunk(current, original, hunks[0]);
		// First hunk reverted (a came back), but Z is still uppercase from second hunk.
		expect(reverted0.content).toContain("a\n");
		expect(reverted0.content).toContain("Z\n");
		expect(reverted0.content).not.toContain("A\n");

		const reverted1 = revertHunk(current, original, hunks[1]);
		// Second hunk reverted (z came back), but A from first hunk untouched.
		expect(reverted1.content).toContain("A\n");
		expect(reverted1.content).toContain("z\n");
		expect(reverted1.content).not.toContain("Z\n");
	});

	it("reverting all hunks in order yields the original content", () => {
		const original = "a\nb\nc\n\n\n\n\n\nx\ny\nz\n";
		const current = "A\nb\nc\n\n\n\n\n\nx\ny\nZ\n";
		const hunks = buildHunks("/x.txt", original, current);

		// Apply hunks in REVERSE order so earlier line numbers stay valid as
		// later hunks are reverted (matches how the PR pane's CLI command will
		// behave when the user runs /revert multiple times — each revert
		// rebuilds the diff afresh, but reversing here matches single-pass
		// application).
		let working = current;
		for (let i = hunks.length - 1; i >= 0; i--) {
			working = revertHunk(working, original, hunks[i]).content;
		}
		expect(working).toBe(original);
	});

	it("reverts a created file (newly-added → empty)", () => {
		const original = "";
		const current = "fresh-1\nfresh-2\n";
		const hunks = buildHunks("/x.txt", original, current);
		expect(hunks).toHaveLength(1);
		const result = revertHunk(current, original, hunks[0]);
		expect(result.content).toBe(original);
	});

	it("throws on out-of-bounds new-range", () => {
		const fakeHunk: Hunk = {
			id: "/x.txt#0",
			index: 0,
			oldStart: 1,
			oldLines: 0,
			newStart: 100,
			newLines: 5,
			lines: [],
		};
		expect(() => revertHunk("only one line\n", "", fakeHunk)).toThrow(/out of bounds/);
	});
});
