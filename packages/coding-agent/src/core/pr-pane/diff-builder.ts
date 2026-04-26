/**
 * Build a cumulative session diff from the checkpoint manager's snapshots.
 *
 * Walks `<agentDir>/sessions/<sessionId>/snapshots/<seq>/manifest.json`,
 * keeps the *earliest* manifest entry per file (= state at first edit/write
 * during the session), reads the matching pre-image blob, compares to the
 * current on-disk state, and returns structured hunks for rendering.
 *
 * Pure I/O — no dependency on a live `CheckpointManager` instance, so this
 * works on session resume too (where in-memory checkpoint entries are empty
 * but disk snapshots may already exist).
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import * as Diff from "diff";
import type { FileDiff, FileStatus, Hunk, HunkLine, SessionDiff } from "./types.js";

interface ManifestFile {
	relPath: string;
	absPath: string;
	sha: string | null;
	size: number;
	existedBefore: boolean;
}

interface Manifest {
	id: string;
	createdAt: number;
	reason: string;
	files: ManifestFile[];
}

interface EarliestEntry {
	manifestDir: string;
	manifestFile: ManifestFile;
	createdAt: number;
}

function readManifest(manifestPath: string): Manifest | undefined {
	try {
		const raw = readFileSync(manifestPath, "utf-8");
		return JSON.parse(raw) as Manifest;
	} catch {
		return undefined;
	}
}

/** Build a map of absPath → earliest snapshot entry, walking all manifests on disk. */
function collectEarliestEntries(snapshotsDir: string): Map<string, EarliestEntry> {
	const earliest = new Map<string, EarliestEntry>();
	if (!existsSync(snapshotsDir)) return earliest;

	let seqDirs: string[];
	try {
		seqDirs = readdirSync(snapshotsDir);
	} catch {
		return earliest;
	}

	for (const seq of seqDirs) {
		const manifestDir = join(snapshotsDir, seq);
		try {
			if (!statSync(manifestDir).isDirectory()) continue;
		} catch {
			continue;
		}
		const manifest = readManifest(join(manifestDir, "manifest.json"));
		if (!manifest) continue;

		for (const file of manifest.files) {
			const existing = earliest.get(file.absPath);
			if (!existing || manifest.createdAt < existing.createdAt) {
				earliest.set(file.absPath, {
					manifestDir,
					manifestFile: file,
					createdAt: manifest.createdAt,
				});
			}
		}
	}
	return earliest;
}

/** Read pre-image content for a manifest file. Returns "" if it didn't exist before. */
function readPreImage(entry: EarliestEntry): { content: string; skipped: boolean; reason?: string } {
	const f = entry.manifestFile;
	if (!f.existedBefore) {
		return { content: "", skipped: false };
	}
	if (f.sha === null) {
		return { content: "", skipped: true, reason: "file too large to snapshot at session start" };
	}
	const blobPath = join(entry.manifestDir, "files", `${f.sha}.bin`);
	if (!existsSync(blobPath)) {
		return { content: "", skipped: true, reason: "snapshot blob missing on disk" };
	}
	try {
		return { content: readFileSync(blobPath, "utf-8"), skipped: false };
	} catch {
		return { content: "", skipped: true, reason: "snapshot blob unreadable" };
	}
}

/** Read current on-disk file. Returns null if it doesn't exist (= deleted). */
function readCurrent(absPath: string): string | null {
	if (!existsSync(absPath)) return null;
	try {
		return readFileSync(absPath, "utf-8");
	} catch {
		return null;
	}
}

function classifyStatus(existedBefore: boolean, currentExists: boolean): FileStatus {
	if (!existedBefore && currentExists) return "added";
	if (existedBefore && !currentExists) return "deleted";
	return "modified";
}

/** Convert a structuredPatch hunk's raw lines into our HunkLine[] form. */
function buildHunkLines(rawLines: string[], oldStart: number, newStart: number): HunkLine[] {
	const result: HunkLine[] = [];
	let oldLine = oldStart;
	let newLine = newStart;
	for (const raw of rawLines) {
		const marker = raw[0];
		const text = raw.slice(1);
		// `Diff.structuredPatch` adds a special "\ No newline at end of file"
		// marker line — represent it as a context line so the UI shows it but
		// neither line counter advances.
		if (marker === "\\") {
			result.push({ kind: " ", text });
			continue;
		}
		if (marker === "+") {
			result.push({ kind: "+", newLine, text });
			newLine++;
		} else if (marker === "-") {
			result.push({ kind: "-", oldLine, text });
			oldLine++;
		} else {
			result.push({ kind: " ", oldLine, newLine, text });
			oldLine++;
			newLine++;
		}
	}
	return result;
}

function buildHunks(absPath: string, oldContent: string, newContent: string, contextLines: number): Hunk[] {
	if (oldContent === newContent) return [];
	const patch = Diff.structuredPatch("a", "b", oldContent, newContent, "", "", { context: contextLines });
	return patch.hunks.map((h, index) => ({
		id: `${absPath}#${index}`,
		index,
		oldStart: h.oldStart,
		oldLines: h.oldLines,
		newStart: h.newStart,
		newLines: h.newLines,
		lines: buildHunkLines(h.lines, h.oldStart, h.newStart),
	}));
}

export interface BuildSessionDiffOptions {
	/** Lines of unchanged context shown around each change. Default 3. */
	contextLines?: number;
}

/**
 * Compute the cumulative session diff: for every file the agent has touched
 * since session start, return a structured diff of (earliest pre-image →
 * current on-disk state).
 *
 * @param snapshotsDir - Resolved path to the session's snapshots directory,
 *   typically `<agentDir>/sessions/<sessionId>/snapshots`.
 * @param cwd - Working directory used to compute display-relative paths.
 */
export function buildSessionDiff(
	snapshotsDir: string,
	cwd: string,
	options: BuildSessionDiffOptions = {},
): SessionDiff {
	const contextLines = options.contextLines ?? 3;
	const earliest = collectEarliestEntries(snapshotsDir);

	const files: FileDiff[] = [];
	let totalAdditions = 0;
	let totalDeletions = 0;
	let skippedCount = 0;

	const sortedPaths = Array.from(earliest.keys()).sort();
	for (const absPath of sortedPaths) {
		const entry = earliest.get(absPath);
		if (!entry) continue;
		const f = entry.manifestFile;
		const relPath = relative(cwd, absPath) || f.relPath;

		const pre = readPreImage(entry);
		const currentRaw = readCurrent(absPath);

		// File too large or otherwise unsnapshottable — record as skipped.
		if (pre.skipped) {
			skippedCount++;
			files.push({
				relPath,
				absPath,
				status: "skipped",
				hunks: [],
				additions: 0,
				deletions: 0,
				skippedReason: pre.reason,
			});
			continue;
		}

		const oldContent = pre.content;
		const newContent = currentRaw ?? "";
		const status = classifyStatus(f.existedBefore, currentRaw !== null);

		// File ended up identical to session start — drop it from the report.
		if (status === "modified" && oldContent === newContent) {
			continue;
		}

		const hunks = buildHunks(absPath, oldContent, newContent, contextLines);
		let additions = 0;
		let deletions = 0;
		for (const hunk of hunks) {
			for (const line of hunk.lines) {
				if (line.kind === "+") additions++;
				else if (line.kind === "-") deletions++;
			}
		}
		totalAdditions += additions;
		totalDeletions += deletions;

		files.push({
			relPath,
			absPath,
			status,
			hunks,
			additions,
			deletions,
		});
	}

	return {
		files,
		totalAdditions,
		totalDeletions,
		skippedCount,
	};
}
