/**
 * Pure-function helpers for reverting a single hunk from a file's current
 * state back to the original session-start state for that hunk's range.
 *
 * The PR pane's revert action surfaces this through a slash command, but the
 * core logic is intentionally side-effect-free so it can be tested in
 * isolation: given the current content, the original content, and a hunk,
 * produce the file's content with that one hunk's worth of changes undone
 * while leaving every other hunk's changes intact.
 */

import type { Hunk } from "./types.js";

export interface RevertHunkResult {
	/** New content for the file after applying the revert. */
	content: string;
	/** Number of lines we replaced in the current file (post-revert range size — old lines that came back). */
	linesReplaced: number;
	/** Number of lines we wrote in their place (= the hunk's new-side range). */
	linesRemoved: number;
}

/**
 * Split a string into its lines, preserving the trailing-newline distinction
 * that unified diffs care about. Returns an array where the last element is
 * `""` iff the input ended in `\n`.
 */
function splitLinesPreservingTail(text: string): string[] {
	if (text === "") return [""];
	return text.split("\n");
}

function joinLinesPreservingTail(lines: string[]): string {
	return lines.join("\n");
}

/**
 * Replace the hunk's range in `currentContent` with the corresponding range
 * from `originalContent`. The hunk's `oldStart`/`oldLines` and
 * `newStart`/`newLines` are 1-indexed line numbers as produced by
 * `Diff.structuredPatch`.
 *
 * Errors when the hunk's ranges fall outside the actual files (defensive —
 * shouldn't happen if the hunk was just freshly built from these contents).
 */
export function revertHunk(currentContent: string, originalContent: string, hunk: Hunk): RevertHunkResult {
	const currentLines = splitLinesPreservingTail(currentContent);
	const originalLines = splitLinesPreservingTail(originalContent);

	const newStart0 = hunk.newStart - 1;
	const newEnd0 = newStart0 + hunk.newLines;
	const oldStart0 = hunk.oldStart - 1;
	const oldEnd0 = oldStart0 + hunk.oldLines;

	if (newStart0 < 0 || newEnd0 > currentLines.length) {
		throw new Error(
			`Hunk new-range out of bounds: newStart=${hunk.newStart} newLines=${hunk.newLines} but file has ${currentLines.length} lines.`,
		);
	}
	if (oldStart0 < 0 || oldEnd0 > originalLines.length) {
		throw new Error(
			`Hunk old-range out of bounds: oldStart=${hunk.oldStart} oldLines=${hunk.oldLines} but original has ${originalLines.length} lines.`,
		);
	}

	const before = currentLines.slice(0, newStart0);
	const after = currentLines.slice(newEnd0);
	const replacement = originalLines.slice(oldStart0, oldEnd0);

	const next = [...before, ...replacement, ...after];
	return {
		content: joinLinesPreservingTail(next),
		linesReplaced: replacement.length,
		linesRemoved: hunk.newLines,
	};
}
