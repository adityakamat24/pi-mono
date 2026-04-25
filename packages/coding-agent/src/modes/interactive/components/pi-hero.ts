/**
 * Hero π logo shown at startup. Renders a stylized π glyph drawn with
 * Unicode block elements, centered horizontally and colored in the active
 * accent. Pure-static; no animation tick required.
 *
 * Width: ~22 cells. Height: 8 lines. Designed to look balanced at typical
 * terminal widths (≥80 cols).
 */

import type { Component } from "@mariozechner/pi-tui";
import stripAnsi from "strip-ansi";
import { theme } from "../theme/theme.js";

const PI_LINES: ReadonlyArray<string> = [
	"  ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄",
	" █▘                  ▝█",
	"      ██      ██",
	"      ██      ██",
	"      ██      ██",
	"      ██      ██",
	"      ██      ██",
	"     ██        ▀▀",
];

const PI_VISIBLE_WIDTH = Math.max(...PI_LINES.map((l) => l.length));

export class PiHero implements Component {
	private readonly tagline: string;

	constructor(appName: string, version: string) {
		this.tagline = `${appName} · v${version} · violet/lavender`;
	}

	invalidate(): void {
		// Static art; no state to invalidate.
	}

	render(width: number): string[] {
		// Center the art horizontally if there's room; otherwise left-align with a
		// small indent so it doesn't crash into the terminal edge.
		const indent = Math.max(2, Math.floor((width - PI_VISIBLE_WIDTH) / 2));
		const pad = " ".repeat(indent);
		const lines = PI_LINES.map((line, i) => {
			// First two lines (the top bar) bold-bright; legs slightly dimmer for depth.
			if (i < 2) {
				return `${pad}${theme.bold(theme.fg("accent", line))}`;
			}
			return `${pad}${theme.fg("accent", line)}`;
		});

		// Tagline line, dim and centered under the glyph.
		const taglineWidth = stripAnsi(this.tagline).length;
		const taglineIndent = Math.max(2, Math.floor((width - taglineWidth) / 2));
		const taglinePad = " ".repeat(taglineIndent);
		lines.push(`${taglinePad}${theme.fg("dim", this.tagline)}`);
		return lines;
	}
}
