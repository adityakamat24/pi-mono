import { describe, expect, test } from "vitest";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
const BG_RESET = "\x1b[49m";

describe("UserMessageComponent", () => {
	test("emits OSC133 zone markers in semantic order around content (single line)", () => {
		initTheme("dark");

		const component = new UserMessageComponent("hello");
		const lines = component.render(20);

		expect(lines.length).toBeGreaterThan(0);
		const line = lines[0];
		const aIdx = line.indexOf(OSC133_ZONE_START);
		const contentIdx = line.indexOf("hello");
		const bIdx = line.indexOf(OSC133_ZONE_END);
		const cIdx = line.indexOf(OSC133_ZONE_FINAL);

		// Semantic order: A (prompt start) → content → B (prompt end) → C (command end).
		expect(aIdx).toBeGreaterThanOrEqual(0);
		expect(contentIdx).toBeGreaterThan(aIdx);
		expect(bIdx).toBeGreaterThan(contentIdx);
		expect(cIdx).toBeGreaterThan(bIdx);
	});
});

void BG_RESET;
