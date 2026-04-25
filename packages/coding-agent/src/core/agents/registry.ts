/**
 * Loads agent definitions from `~/.pi/agents/*.md` (user-scope) and
 * `<cwd>/.pi/agents/*.md` (project-scope). Project scope wins on name
 * conflict.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import { parseFrontmatter } from "../../utils/frontmatter.js";
import type { AgentDefinition, AgentRegistry } from "./types.js";

interface AgentFrontmatter extends Record<string, unknown> {
	name?: string;
	description?: string;
	tools?: string[] | string;
	model?: string;
	thinking?: string;
	canSpawn?: boolean;
}

function listMarkdownFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	try {
		return readdirSync(dir)
			.filter((entry) => extname(entry).toLowerCase() === ".md")
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

function asThinking(value: unknown): ThinkingLevel | undefined {
	if (typeof value !== "string") return undefined;
	const v = value.trim().toLowerCase();
	if (v === "off" || v === "minimal" || v === "low" || v === "medium" || v === "high" || v === "xhigh") {
		return v as ThinkingLevel;
	}
	return undefined;
}

function asToolList(value: unknown): string[] | undefined {
	if (!value) return undefined;
	if (Array.isArray(value)) {
		return value.map((v) => String(v).trim()).filter((v) => v.length > 0);
	}
	if (typeof value === "string") {
		return value
			.split(",")
			.map((v) => v.trim())
			.filter((v) => v.length > 0);
	}
	return undefined;
}

function loadAgentDefinition(filePath: string, scope: "user" | "project"): AgentDefinition | undefined {
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf-8");
	} catch {
		return undefined;
	}
	const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(raw);
	const fallbackName = basename(filePath, extname(filePath));
	const name = (frontmatter.name ?? "").trim() || fallbackName;
	const description = (frontmatter.description ?? "").trim();
	if (!description) return undefined;
	const trimmedBody = body.trim();
	if (!trimmedBody) return undefined;

	return {
		filePath,
		scope,
		name,
		description,
		tools: asToolList(frontmatter.tools),
		model: typeof frontmatter.model === "string" ? frontmatter.model.trim() || undefined : undefined,
		thinking: asThinking(frontmatter.thinking),
		canSpawn: frontmatter.canSpawn === true,
		systemPrompt: trimmedBody,
	};
}

export interface LoadAgentRegistryOptions {
	globalDir?: string;
	projectDir?: string;
}

export function loadAgentRegistry(options: LoadAgentRegistryOptions = {}): AgentRegistry {
	const userDefs: AgentDefinition[] = [];
	const projectDefs: AgentDefinition[] = [];

	if (options.globalDir) {
		for (const path of listMarkdownFiles(options.globalDir)) {
			const def = loadAgentDefinition(path, "user");
			if (def) userDefs.push(def);
		}
	}
	if (options.projectDir) {
		for (const path of listMarkdownFiles(options.projectDir)) {
			const def = loadAgentDefinition(path, "project");
			if (def) projectDefs.push(def);
		}
	}

	// Project shadows user by name.
	const byName = new Map<string, AgentDefinition>();
	for (const def of userDefs) byName.set(def.name, def);
	for (const def of projectDefs) byName.set(def.name, def);

	return {
		lookup(name: string) {
			return byName.get(name);
		},
		list() {
			return Array.from(byName.keys()).sort();
		},
		all() {
			return Array.from(byName.values());
		},
	};
}
