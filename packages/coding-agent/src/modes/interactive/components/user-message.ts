import { Container, Markdown, type MarkdownTheme } from "@mariozechner/pi-tui";
import { getMarkdownTheme, theme } from "../theme/theme.js";
import { RailContainer } from "./rail.js";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * Component that renders a user message.
 *
 * New visual: violet left rail, no background block. Markdown body inherits
 * the default text color so the user's prose reads naturally.
 */
export class UserMessageComponent extends Container {
	private rail: RailContainer;

	constructor(text: string, markdownTheme: MarkdownTheme = getMarkdownTheme()) {
		super();
		this.rail = new RailContainer({ colorFn: (s: string) => theme.fg("accent", s) });
		this.rail.addChild(
			new Markdown(text, 0, 0, markdownTheme, {
				color: (content: string) => theme.fg("userMessageText", content),
			}),
		);
		this.addChild(this.rail);
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length === 0) {
			return lines;
		}

		if (lines.length === 1) {
			// Single-line: emit markers in semantic order on the same line so
			// shell-integration parsers see A → content → B → C.
			lines[0] = OSC133_ZONE_START + lines[0] + OSC133_ZONE_END + OSC133_ZONE_FINAL;
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}
}
