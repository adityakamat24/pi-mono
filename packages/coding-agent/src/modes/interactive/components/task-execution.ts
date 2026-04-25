/**
 * TaskExecutionComponent — custom renderer for the `Task` tool's result body.
 *
 * Renders, inside the Task call's status rail, three regions:
 *   1. The child's tool calls as a nested sub-rail (`▏ ◉ read src/main.ts`)
 *   2. A live tail line: `▏ π Working… 4.2s · ↑1.2k ↓0.3k $0.012`
 *   3. The child's final markdown answer (after phase === "done")
 *
 * State is preserved across renderResult invocations via
 * `context.lastComponent`, so streaming progress updates the same instance
 * instead of recreating UI on every tick.
 */

import { Container, Markdown, type MarkdownTheme, Text } from "@mariozechner/pi-tui";
import type { ChildPhase, ChildProgress } from "../../../core/agents/streaming-bus.js";
import { GLYPHS } from "../theme/glyphs.js";
import { PI_SPINNER_FRAMES } from "../theme/spinner.js";
import { getMarkdownTheme, theme } from "../theme/theme.js";

function formatTokens(n: number): string {
	if (n < 1000) return n.toString();
	if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
	return `${Math.round(n / 1000)}k`;
}

function formatDurationMs(ms: number): string {
	return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Computed lazily so it doesn't run before `initTheme()`. */
function subRail(): string {
	return `${theme.fg("dim", GLYPHS.railSubBar)} `;
}

export class TaskExecutionComponent extends Container {
	private toolList: Container;
	private tail: Text;
	private finalContainer: Container;
	private toolEntries: Map<string, Text> = new Map();
	private markdownTheme: MarkdownTheme;
	private lastProgress: ChildProgress | undefined;
	private invalidateFn: (() => void) | undefined;
	private tickTimer: NodeJS.Timeout | undefined;

	constructor() {
		super();
		this.markdownTheme = getMarkdownTheme();
		this.toolList = new Container();
		this.tail = new Text("", 0, 0);
		this.finalContainer = new Container();
		this.addChild(this.toolList);
		this.addChild(this.tail);
		this.addChild(this.finalContainer);
	}

	/** Wire the `context.invalidate()` callback so the live tail can re-render between progress events. */
	bindInvalidate(invalidate: (() => void) | undefined): void {
		this.invalidateFn = invalidate;
	}

	setProgress(progress: ChildProgress): void {
		this.lastProgress = progress;

		// Sync child tool entries (preserve order, update existing).
		for (const tool of progress.tools) {
			let entry = this.toolEntries.get(tool.id);
			if (!entry) {
				entry = new Text("", 0, 0);
				this.toolEntries.set(tool.id, entry);
				this.toolList.addChild(entry);
			}
			const isRunning = tool.finishedAt === undefined;
			const glyph = isRunning
				? theme.fg("warning", GLYPHS.toolRunning)
				: tool.isError
					? theme.fg("error", GLYPHS.toolError)
					: theme.fg("success", GLYPHS.toolSuccess);
			const duration = tool.finishedAt
				? theme.fg("dim", ` (${formatDurationMs(tool.finishedAt - tool.startedAt)})`)
				: "";
			const argsSummary = tool.argsSummary ? ` ${theme.fg("accent", tool.argsSummary)}` : "";
			entry.setText(`${subRail()}${glyph} ${theme.fg("toolTitle", tool.name)}${argsSummary}${duration}`);
		}

		this.refreshTail();

		if (progress.phase === "done" || progress.phase === "error") {
			this.stopTicker();
			this.renderFinal(progress);
		} else {
			this.ensureTicker();
		}
	}

	/**
	 * Called when only the final result is available (no progress snapshot was
	 * streamed — e.g., test environments or when isPartial=false hits without
	 * any prior partial). Builds a synthetic "done" tail.
	 */
	setFinalFromResult(
		text: string,
		durationMs?: number,
		tokens?: { input: number; output: number; cost: number },
	): void {
		this.stopTicker();
		if (durationMs !== undefined && tokens) {
			const tokenStr = `${formatTokens(tokens.input + tokens.output)} tokens · $${tokens.cost.toFixed(4)}`;
			this.tail.setText(`${subRail()}${theme.fg("dim", `✓ done in ${formatDurationMs(durationMs)} · ${tokenStr}`)}`);
		} else {
			this.tail.setText(`${subRail()}${theme.fg("dim", "✓ done")}`);
		}
		this.finalContainer.clear();
		const trimmed = text.trim();
		if (trimmed) {
			this.finalContainer.addChild(new Text("", 0, 0));
			this.finalContainer.addChild(new Markdown(trimmed, 1, 0, this.markdownTheme));
		}
	}

	dispose(): void {
		this.stopTicker();
	}

	private ensureTicker(): void {
		if (this.tickTimer) return;
		this.tickTimer = setInterval(() => {
			// Refresh tail with current elapsed time. Stop if the parent
			// invalidate callback isn't available (component is detached).
			this.refreshTail();
			this.invalidateFn?.();
		}, 250);
	}

	private stopTicker(): void {
		if (this.tickTimer) {
			clearInterval(this.tickTimer);
			this.tickTimer = undefined;
		}
	}

	private refreshTail(): void {
		const progress = this.lastProgress;
		if (!progress) return;
		if (progress.phase === "done") {
			const elapsed = formatDurationMs(Date.now() - progress.startedAt);
			const t = progress.tokens;
			const tokenStr = `${formatTokens(t.input + t.output)} tokens · $${t.cost.toFixed(4)}`;
			this.tail.setText(`${subRail()}${theme.fg("dim", `✓ done in ${elapsed} · ${tokenStr}`)}`);
			return;
		}
		if (progress.phase === "error") {
			this.tail.setText(`${subRail()}${theme.fg("error", `✕ failed: ${progress.error ?? "unknown"}`)}`);
			return;
		}
		// Live tail: π-pulse spinner + elapsed + token deltas.
		const elapsedMs = Date.now() - progress.startedAt;
		const elapsed = formatDurationMs(elapsedMs);
		const t = progress.tokens;
		const parts: string[] = [elapsed];
		if (t.input) parts.push(`↑${formatTokens(t.input)}`);
		if (t.output) parts.push(`↓${formatTokens(t.output)}`);
		if (t.cost > 0) parts.push(`$${t.cost.toFixed(3)}`);
		const frame = PI_SPINNER_FRAMES[Math.floor(elapsedMs / 110) % PI_SPINNER_FRAMES.length];
		const phaseLabel = labelForPhase(progress.phase);
		this.tail.setText(
			`${subRail()}${theme.fg("accent", frame)} ${theme.fg("dim", `${phaseLabel} ${parts.join(" · ")}`)}`,
		);
	}

	private renderFinal(progress: ChildProgress): void {
		this.finalContainer.clear();
		if (progress.phase === "error") return;
		const text = progress.finalText?.trim();
		if (!text) return;
		this.finalContainer.addChild(new Text("", 0, 0));
		this.finalContainer.addChild(new Markdown(text, 1, 0, this.markdownTheme));
	}
}

function labelForPhase(phase: ChildPhase): string {
	switch (phase) {
		case "starting":
			return "starting…";
		case "tool":
			return "running tools…";
		case "thinking":
			return "thinking…";
		case "responding":
			return "responding…";
		default:
			return "working…";
	}
}
