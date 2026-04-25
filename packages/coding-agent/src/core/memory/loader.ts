/**
 * Persistent memory: markdown files at `~/.pi/memory/*.md` (user-scope) and
 * `.pi/memory/*.md` (project-scope) auto-loaded into the system prompt.
 *
 * Equivalent to Claude Code's memory directory, with:
 *   - Optional YAML frontmatter (`name`, `description`) used by the `/memory`
 *     selector. The body is what reaches the model.
 *   - A `MEMORY.md` file in the directory, if present, becomes the table of
 *     contents prefix.
 *   - Project-scope files are loaded after global ones (project wins on
 *     conflicting names).
 *   - A configurable byte cap so a runaway file can't blow up the system
 *     prompt; oversized files are truncated with a warning.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { parseFrontmatter } from "../../utils/frontmatter.js";

export interface MemoryFile {
	path: string;
	name: string;
	/** Optional human description from frontmatter for `/memory`. */
	description?: string;
	content: string;
	bytes: number;
	truncated: boolean;
}

export interface LoadMemoryOptions {
	/** Global directory (e.g. `~/.pi/memory`). */
	globalDir?: string;
	/** Project directory (e.g. `<cwd>/.pi/memory`). */
	projectDir?: string;
	/** Maximum bytes per file. Files larger than this are truncated with a notice. */
	maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 32 * 1024;
const TOC_FILENAME = "MEMORY.md";

interface FrontmatterFields extends Record<string, unknown> {
	name?: string;
	description?: string;
}

function listMemoryFilesInDir(dir: string): string[] {
	if (!existsSync(dir)) return [];
	try {
		const entries = readdirSync(dir);
		return entries
			.filter((entry) => extname(entry).toLowerCase() === ".md")
			.filter((entry) => entry !== TOC_FILENAME)
			.map((entry) => join(dir, entry))
			.filter((p) => {
				try {
					return statSync(p).isFile();
				} catch {
					return false;
				}
			})
			.sort();
	} catch {
		return [];
	}
}

function readTocFile(dir: string): string | undefined {
	if (!dir) return undefined;
	const tocPath = join(dir, TOC_FILENAME);
	if (!existsSync(tocPath)) return undefined;
	try {
		return readFileSync(tocPath, "utf-8");
	} catch {
		return undefined;
	}
}

function readMemoryFile(path: string, maxBytes: number): MemoryFile | undefined {
	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch {
		return undefined;
	}

	const { frontmatter, body } = parseFrontmatter<FrontmatterFields>(raw);
	const baseName = basename(path, extname(path));
	const name = (frontmatter.name ?? "").trim() || baseName;
	const description = frontmatter.description?.trim() || undefined;

	const bodyBytes = Buffer.byteLength(body, "utf-8");
	let content = body;
	let truncated = false;
	if (bodyBytes > maxBytes) {
		// Truncate at codepoint boundary; UTF-8 safe.
		const buf = Buffer.from(body, "utf-8").subarray(0, maxBytes);
		content = `${buf.toString("utf-8")}\n\n[memory file truncated at ${maxBytes} bytes — full file is ${bodyBytes} bytes]`;
		truncated = true;
	}

	return {
		path,
		name,
		description,
		content,
		bytes: bodyBytes,
		truncated,
	};
}

export function loadMemoryFiles(options: LoadMemoryOptions = {}): MemoryFile[] {
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const seenNames = new Set<string>();
	const result: MemoryFile[] = [];

	// Global first; project entries with the same name override (project wins).
	const orderedDirs: Array<{ dir: string; scope: "global" | "project" }> = [];
	if (options.globalDir) orderedDirs.push({ dir: options.globalDir, scope: "global" });
	if (options.projectDir) orderedDirs.push({ dir: options.projectDir, scope: "project" });

	const collected: Array<{ scope: "global" | "project"; file: MemoryFile }> = [];
	for (const { dir, scope } of orderedDirs) {
		for (const path of listMemoryFilesInDir(dir)) {
			const file = readMemoryFile(path, maxBytes);
			if (file) collected.push({ scope, file });
		}
	}

	// Project shadows global by `name`.
	const projectNames = new Set(collected.filter((c) => c.scope === "project").map((c) => c.file.name));
	for (const { scope, file } of collected) {
		if (scope === "global" && projectNames.has(file.name)) continue;
		if (seenNames.has(file.name)) continue;
		seenNames.add(file.name);
		result.push(file);
	}

	return result;
}

/** Read the MEMORY.md table of contents file (project preferred over global). */
export function loadMemoryToc(options: LoadMemoryOptions = {}): string | undefined {
	return readTocFile(options.projectDir ?? "") ?? readTocFile(options.globalDir ?? "");
}
