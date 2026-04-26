/**
 * PR-pane components.
 *
 * - `PrPaneComponent` — full read-only diff dump used by the `/pr` slash
 *   command. Insertable into chat scrollback.
 * - `LivePrPaneComponent` — compact dashboard variant used by `/pr-watch`
 *   as a right-side overlay. Shows cumulative stats + per-file summaries
 *   only (no hunks; those stay in `/pr`). Designed to fit a ~50%-width
 *   column without truncating the user's chat / editor area.
 *
 * Both expose `setDiff(diff)` so callers can rebuild the rendered children
 * in place when the cumulative session diff changes (Phase 2 bumper trigger,
 * Phase 6 live updates).
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

	let i = 0;
	while (i < hunk.lines.length) {
		const line = hunk.lines[i];
		if (line.kind === " ") {
			const numCol = `${formatLineNum(line.oldLine, lineNumWidth)}│${formatLineNum(line.newLine, lineNumWidth)}`;
			lines.push(theme.fg("toolDiffContext", `${numCol} ${line.text}`));
			i++;
			continue;
		}
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

/**
 * Full PR pane — one block per file with all hunks rendered. Used by `/pr`
 * (chat insertion). Heavy; the live overlay uses LivePrPaneComponent instead.
 */
export class PrPaneComponent extends Container {
	constructor(diff: SessionDiff) {
		super();
		this.setDiff(diff);
	}

	/** Rebuild children for the new diff. */
	setDiff(diff: SessionDiff): void {
		this.clear();
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

/**
 * Compact "live" PR pane for overlay use. Always-visible dashboard with
 * cumulative stats + a per-file summary line. Designed to fit a ~50%-width
 * right-side column without crowding out the chat or editor.
 *
 * Per-hunk content is intentionally NOT shown here — the static `/pr` chat
 * insertion remains the place to inspect specific hunks. This pane is the
 * "are we trending green?" dashboard, not the diff browser.
 */
export class LivePrPaneComponent extends Container {
	constructor(diff: SessionDiff) {
		super();
		this.setDiff(diff);
	}

	/** Rebuild compact dashboard for the new diff. */
	setDiff(diff: SessionDiff): void {
		this.clear();

		// Header row: tall accent banner. `≡ PR pane` left-justified, stats inline.
		this.addChild(new Text(theme.fg("accent", theme.bold(`${GLYPHS.sectionDivider} PR pane`))));
		this.addChild(new Text(summaryLine(diff)));
		this.addChild(new Text(""));

		if (diff.files.length === 0) {
			this.addChild(new Text(theme.fg("dim", "No edits yet this session.")));
			this.addChild(
				new Text(
					theme.fg("dim", "This pane updates live as the agent edits. /pr-watch to toggle. /pr for full hunks."),
				),
			);
			return;
		}

		// One line per file: badge + path + stats.
		for (const file of diff.files) {
			this.addChild(new Text(fileHeaderLine(file)));
		}

		this.addChild(new Text(""));
		this.addChild(
			new Text(
				theme.fg(
					"dim",
					`/pr for full hunks · /revert <path> <hunkIdx> to undo a hunk · /pr-watch to close this pane`,
				),
			),
		);
	}
}
