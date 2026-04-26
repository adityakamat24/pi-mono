/**
 * Phase 1 of the PR pane: a read-only chat insertion that shows the cumulative
 * session diff. Renders one block per touched file with a header row, hunk
 * separators, and intra-line word-level diff highlighting (reusing the
 * existing `renderDiff` infrastructure from `diff.ts`).
 *
 * Future phases turn this into a live, addressable, scrollable side pane with
 * accept/revert/comment actions per hunk.
 */

import { Container, Text } from "@mariozechner/pi-tui";
import * as Diff from "diff";
import type { FileDiff, Hunk, SessionDiff } from "../../../core/pr-pane/types.js";
import { GLYPHS } from "../theme/glyphs.js";
import { theme } from "../theme/theme.js";

const STATUS_BADGE: Record<FileDiff["status"], { text: string; color: "success" | "error" | "warning" | "muted" }> = {
	modified: { text: "M", color: "warning" },
	added: { text: "A", color: "success" },
	deleted: { text: "D", color: "error" },
	skipped: { text: "?", color: "muted" },
	unchanged: { text: "·", color: "muted" },
};

/**
 * Apply word-level intra-line highlighting to a paired removed/added line.
 * Mirrors the algorithm in `components/diff.ts:renderIntraLineDiff` but
 * operates on the HunkLine-level so we can mutate the displayed text only.
 */
function intraLineHighlight(oldText: string, newText: string): { removed: string; added: string } {
	const wordDiff = Diff.diffWords(oldText, newText);
	let removed = "";
	let added = "";
	let firstRemoved = true;
	let firstAdded = true;
	for (const part of wordDiff) {
		if (part.removed) {
			let value = part.value;
			if (firstRemoved) {
				const lead = value.match(/^(\s*)/)?.[1] ?? "";
				removed += lead;
				value = value.slice(lead.length);
				firstRemoved = false;
			}
			if (value) removed += theme.inverse(value);
		} else if (part.added) {
			let value = part.value;
			if (firstAdded) {
				const lead = value.match(/^(\s*)/)?.[1] ?? "";
				added += lead;
				value = value.slice(lead.length);
				firstAdded = false;
			}
			if (value) added += theme.inverse(value);
		} else {
			removed += part.value;
			added += part.value;
		}
	}
	return { removed, added };
}

function formatLineNum(n: number | undefined, width: number): string {
	if (n === undefined) return " ".repeat(width);
	return String(n).padStart(width, " ");
}

function maxLineNumberWidth(file: FileDiff): number {
	let max = 1;
	for (const hunk of file.hunks) {
		const tail = Math.max(hunk.oldStart + hunk.oldLines, hunk.newStart + hunk.newLines);
		max = Math.max(max, String(tail).length);
	}
	return max;
}

function renderHunk(hunk: Hunk, lineNumWidth: number): string[] {
	const lines: string[] = [];
	const tag = theme.fg("accent", `[hunk ${hunk.index}]`);
	const range = theme.fg("dim", `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
	lines.push(`${tag} ${range}`);

	// Walk the hunk and group adjacent -/+ runs so we can do intra-line
	// highlighting when a single removed line is followed by a single added
	// line — same heuristic as the existing renderDiff in `diff.ts`.
	let i = 0;
	while (i < hunk.lines.length) {
		const line = hunk.lines[i];
		if (line.kind === " ") {
			const numCol = `${formatLineNum(line.oldLine, lineNumWidth)}│${formatLineNum(line.newLine, lineNumWidth)}`;
			lines.push(theme.fg("toolDiffContext", `${numCol} ${line.text}`));
			i++;
			continue;
		}
		// Collect a run of removed lines, then a run of added lines.
		const removedRun: typeof hunk.lines = [];
		while (i < hunk.lines.length && hunk.lines[i].kind === "-") {
			removedRun.push(hunk.lines[i]);
			i++;
		}
		const addedRun: typeof hunk.lines = [];
		while (i < hunk.lines.length && hunk.lines[i].kind === "+") {
			addedRun.push(hunk.lines[i]);
			i++;
		}
		if (removedRun.length === 1 && addedRun.length === 1) {
			const r = removedRun[0];
			const a = addedRun[0];
			const { removed, added } = intraLineHighlight(r.text, a.text);
			const rNumCol = `${formatLineNum(r.oldLine, lineNumWidth)}│${" ".repeat(lineNumWidth)}`;
			const aNumCol = `${" ".repeat(lineNumWidth)}│${formatLineNum(a.newLine, lineNumWidth)}`;
			lines.push(theme.fg("toolDiffRemoved", `${rNumCol} -${removed}`));
			lines.push(theme.fg("toolDiffAdded", `${aNumCol} +${added}`));
			continue;
		}
		for (const r of removedRun) {
			const numCol = `${formatLineNum(r.oldLine, lineNumWidth)}│${" ".repeat(lineNumWidth)}`;
			lines.push(theme.fg("toolDiffRemoved", `${numCol} -${r.text}`));
		}
		for (const a of addedRun) {
			const numCol = `${" ".repeat(lineNumWidth)}│${formatLineNum(a.newLine, lineNumWidth)}`;
			lines.push(theme.fg("toolDiffAdded", `${numCol} +${a.text}`));
		}
	}
	return lines;
}

function fileHeaderLine(file: FileDiff): string {
	const badge = STATUS_BADGE[file.status];
	const badgeText = theme.fg(badge.color, theme.bold(badge.text));
	const path = theme.fg("toolTitle", theme.bold(file.relPath));
	const stats =
		file.status === "skipped"
			? theme.fg("muted", `(skipped — ${file.skippedReason ?? "unknown reason"})`)
			: theme.fg("dim", `(+${file.additions} −${file.deletions})`);
	return `${badgeText}  ${path}  ${stats}`;
}

function summaryLine(diff: SessionDiff): string {
	const fileCount = diff.files.filter((f) => f.status !== "skipped").length;
	const filesStr = `${fileCount} file${fileCount === 1 ? "" : "s"} changed`;
	const additions = `${theme.fg("toolDiffAdded", `+${diff.totalAdditions}`)}`;
	const deletions = `${theme.fg("toolDiffRemoved", `−${diff.totalDeletions}`)}`;
	const skippedNote = diff.skippedCount > 0 ? theme.fg("muted", ` · ${diff.skippedCount} skipped`) : "";
	return `${theme.fg("dim", filesStr)} ${additions} ${deletions}${skippedNote}`;
}

export class PrPaneComponent extends Container {
	constructor(diff: SessionDiff) {
		super();
		this.addChild(new Text(""));
		const header =
			diff.files.length === 0
				? theme.fg("dim", "No file changes recorded yet in this session.")
				: `${theme.fg("accent", theme.bold(`${GLYPHS.sectionDivider} Session changes`))}  ${summaryLine(diff)}`;
		this.addChild(new Text(header));
		if (diff.files.length === 0) {
			this.addChild(
				new Text(
					theme.fg(
						"dim",
						"The PR pane shows the cumulative diff of all `edit`/`write` operations the agent has done in this session.",
					),
				),
			);
			this.addChild(new Text(""));
			return;
		}
		this.addChild(new Text(""));

		for (const file of diff.files) {
			this.addChild(new Text(fileHeaderLine(file)));
			if (file.status === "skipped") {
				continue;
			}
			if (file.hunks.length === 0) {
				this.addChild(new Text(theme.fg("dim", "  (no hunks — content unchanged after edits)")));
				continue;
			}
			const lineNumWidth = maxLineNumberWidth(file);
			for (const hunk of file.hunks) {
				for (const rendered of renderHunk(hunk, lineNumWidth)) {
					this.addChild(new Text(rendered));
				}
			}
			this.addChild(new Text(""));
		}
		this.addChild(
			new Text(
				theme.fg(
					"dim",
					"Tip: /revert <path> <hunkIndex> to undo a single hunk (rebuild the diff with /pr afterwards). /undo to roll back the most recent change.",
				),
			),
		);
	}
}
