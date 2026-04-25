/**
 * Splash banner shown at the top of an interactive session (unless quiet
 * startup is set). Width-aware: stretches to fill the terminal while keeping
 * the content left-aligned with breathing room.
 *
 * Visual:
 *
 *   ╭─────────────────────────────────────────────╮
 *   │  π  pi · v{version}                          │
 *   ╰─────────────────────────────────────────────╯
 *
 * The corners and border use `borderAccent`; the content is
 * `accent`-colored with a `dim` version tag.
 */

import type { Component } from "@mariozechner/pi-tui";
import stripAnsi from "strip-ansi";
import { theme } from "../theme/theme.js";

export class SplashBanner implements Component {
	private readonly content: string;

	constructor(appName: string, version: string, tagline?: string) {
		const head = `${theme.bold(theme.fg("accent", `π  ${appName}`))}${theme.fg("dim", ` · v${version}`)}`;
		this.content = tagline ? `${head}\n${theme.fg("dim", tagline)}` : head;
	}

	invalidate(): void {
		// Stateless component: nothing to invalidate.
	}

	render(width: number): string[] {
		const minInner = 30;
		const innerWidth = Math.max(minInner, Math.min(width - 2, 72));
		const lines = this.content.split("\n");
		const horizontal = "─".repeat(innerWidth);
		const top = theme.fg("borderAccent", `╭${horizontal}╮`);
		const bottom = theme.fg("borderAccent", `╰${horizontal}╯`);
		const left = theme.fg("borderAccent", "│ ");
		const right = theme.fg("borderAccent", " │");

		const result: string[] = [top];
		for (const line of lines) {
			const visible = stripAnsi(line);
			const padding = Math.max(0, innerWidth - 2 - visible.length);
			result.push(`${left}${line}${" ".repeat(padding)}${right}`);
		}
		result.push(bottom);
		return result;
	}
}
