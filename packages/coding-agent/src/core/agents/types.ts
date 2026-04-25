/**
 * Subagent / "Task" types — pi's first-class equivalent of Claude Code's
 * `Task` tool. An agent definition is a markdown file with YAML frontmatter
 * declaring a name, description, restricted tool list, optional model, and
 * a body that becomes the child's system prompt.
 */

import type { ThinkingLevel } from "@mariozechner/pi-agent-core";

export interface AgentDefinition {
	/** Filesystem path the definition was loaded from. */
	filePath: string;
	/** Scope: project-local definitions take precedence over user-global. */
	scope: "user" | "project";
	/** Agent name (the identifier the parent uses to invoke this child). */
	name: string;
	/** Short human-readable description, surfaced to the parent in the Task tool's prompt. */
	description: string;
	/**
	 * Whitelisted tool names the child has access to. If omitted, the child
	 * gets the built-in read-only set: read, grep, find, ls.
	 */
	tools?: string[];
	/** Optional model id; if absent, child inherits the parent's current model. */
	model?: string;
	/** Optional thinking level override. */
	thinking?: ThinkingLevel;
	/**
	 * Grants the agent access to the `Task` tool, allowing it to dispatch
	 * other subagents. Recursion is exactly one level deep — the agents this
	 * agent spawns do not inherit `canSpawn`. Default: false.
	 *
	 * Used by the `tech-lead` orchestrator to coordinate a dev-team workflow.
	 */
	canSpawn?: boolean;
	/** The body (everything after the YAML frontmatter) — used as the child's system prompt. */
	systemPrompt: string;
}

export interface AgentRegistry {
	/** Look up an agent definition by name (project takes precedence over user). */
	lookup(name: string): AgentDefinition | undefined;
	/** All registered agent names, sorted alphabetically. */
	list(): string[];
	/** All loaded definitions (project shadows user). */
	all(): AgentDefinition[];
}
