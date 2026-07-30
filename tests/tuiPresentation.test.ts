import { describe, expect, it } from "vitest";
import {
  editTuiPrompt,
  escapeBlessedTags,
  filterTuiPaletteCommands,
  formatTuiActivityDrawer,
  formatTuiAlignedLine,
  formatTuiContextUsage,
  formatTuiTokenCount,
  formatTuiPromptDraft,
  formatTuiTranscript,
  resolveTuiActivityDrawerWidth,
  summarizeTuiActivityDetail,
  type TuiActivityLine,
  type TuiLogLine
} from "../src/tui/presentation.js";

const now = new Date("2026-07-29T12:00:00.000Z");

describe("TUI presentation", () => {
  it("formats compact context usage", () => {
    expect(formatTuiTokenCount(999)).toBe("999");
    expect(formatTuiTokenCount(9_500)).toBe("9.5K");
    expect(formatTuiTokenCount(53_100)).toBe("53K");
    expect(formatTuiContextUsage(9_500, 500_000)).toBe("9.5K / 500K");
    expect(formatTuiContextUsage(undefined, undefined)).toBe("context —");
  });

  it("escapes untrusted Blessed tags", () => {
    expect(escapeBlessedTags("{red-fg}unsafe{/red-fg}")).toBe("{open}red-fg{close}unsafe{open}/red-fg{close}");
  });

  it("filters command-palette entries by command, title, and shortcut", () => {
    expect(filterTuiPaletteCommands("activity").map((entry) => entry.command)).toEqual(["/activity"]);
    expect(filterTuiPaletteCommands("ctrl+s").map((entry) => entry.command)).toEqual(["/sessions --pick"]);
    expect(filterTuiPaletteCommands("/compact").map((entry) => entry.command)).toEqual(["/compact"]);
  });

  it("merges messages and compact tool activity in sequence order", () => {
    const log: TuiLogLine[] = [
      { kind: "user", text: "Fix {red-fg}this", time: now, sequence: 1 },
      { kind: "assistant", text: "# Done\n**Fixed** the issue.", time: now, sequence: 3 }
    ];
    const activity: TuiActivityLine[] = [
      {
        kind: "result",
        title: "execute_command",
        detail: "npm test completed successfully",
        time: now,
        sequence: 2
      }
    ];

    const output = formatTuiTranscript(log, activity, 100);

    expect(output.indexOf("Fix")).toBeLessThan(output.indexOf("Run"));
    expect(output.indexOf("Run")).toBeLessThan(output.indexOf("Done"));
    expect(output).toContain("{open}red-fg{close}");
    expect(output).toContain("{green-fg}✓{/green-fg} {bold}Run{/bold}");
    expect(output).toContain("{bold}{blue-fg}Done{/blue-fg}{/bold}");
  });

  it("keeps complete details in the activity drawer while summarizing inline rows", () => {
    const detail = `line one ${"x".repeat(220)}\nline two`;
    const activity: TuiActivityLine[] = [{ kind: "call", title: "browser_task", detail, time: now, sequence: 1 }];

    expect(summarizeTuiActivityDetail(detail, 40)).toHaveLength(40);
    expect(summarizeTuiActivityDetail(detail, 40)).toMatch(/…$/);
    expect(formatTuiActivityDrawer(activity)).toContain("line two");
  });

  it("uses an overlay-sized activity drawer at every terminal width", () => {
    expect(resolveTuiActivityDrawerWidth(80)).toBe("92%");
    expect(resolveTuiActivityDrawerWidth(120)).toBe("48%");
    expect(resolveTuiActivityDrawerWidth(180)).toBe("38%");
  });

  it("right-aligns status content without losing the left label", () => {
    const output = formatTuiAlignedLine("left", "right", 20);
    expect(output).toBe("left           right");
  });

  it("edits a Unicode prompt without splitting characters", () => {
    const inserted = editTuiPrompt({ value: "ask 🔵", cursor: 4 }, "new ", {});
    expect(inserted).toMatchObject({ value: "ask new 🔵", cursor: 8, handled: true });

    const deleted = editTuiPrompt(inserted, undefined, { name: "delete" });
    expect(deleted).toMatchObject({ value: "ask new ", cursor: 8, handled: true });
  });

  it("supports terminal editing keys and explicit submission", () => {
    const moved = editTuiPrompt({ value: "one two", cursor: 7 }, undefined, { name: "w", ctrl: true });
    expect(moved).toMatchObject({ value: "one ", cursor: 4, handled: true });

    const submitted = editTuiPrompt(moved, undefined, { name: "enter" });
    expect(submitted).toEqual({ value: "", cursor: 0, handled: true, submitted: "one " });
  });

  it("keeps the prompt cursor visible in long drafts and escapes content", () => {
    const output = formatTuiPromptDraft({ value: `before {unsafe} ${"x".repeat(40)}`, cursor: 56 }, 18, true);
    expect(output).toContain("{bold}{cyan-fg}│{/cyan-fg}{/bold}");
    expect(output).toContain("…");
    expect(output).not.toContain("{unsafe}");
  });
});
