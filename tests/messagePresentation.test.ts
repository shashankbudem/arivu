import { describe, expect, it } from "vitest";
import { formatMessageDateTime, messageDateTimeValue } from "../desktop/renderer/src/format.js";
import { deriveVisibleMessages } from "../desktop/renderer/src/messagePresentation.js";

describe("message presentation", () => {
  it("formats valid timestamps and falls back without depending on the host timezone", () => {
    const value = "2026-07-27T12:34:56.000Z";
    const expected = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(
      new Date(value)
    );
    expect(formatMessageDateTime(value, undefined, { timeZone: "UTC" })).toBe(expected);
    expect(formatMessageDateTime("not-a-date", value, { timeZone: "UTC" })).toBe(expected);
    expect(formatMessageDateTime(undefined)).toBeUndefined();
    expect(messageDateTimeValue(value)).toBe(value);
    expect(messageDateTimeValue("not-a-date")).toBeUndefined();
  });

  it("uses the first duplicate user timestamp and the final merged assistant timestamp", () => {
    const visible = deriveVisibleMessages([
      { role: "user", content: "retry me", createdAt: "2026-07-27T10:00:00.000Z" },
      { role: "user", content: "retry me", createdAt: "2026-07-27T10:01:00.000Z" },
      { role: "assistant", content: "First part", createdAt: "2026-07-27T10:02:00.000Z" },
      { role: "assistant", content: "Second part", createdAt: "2026-07-27T10:03:00.000Z" }
    ]);

    expect(visible).toHaveLength(2);
    expect(visible[0]).toMatchObject({ sourceIndexes: [0, 1], message: { createdAt: "2026-07-27T10:00:00.000Z" } });
    expect(visible[1]).toMatchObject({
      sourceIndexes: [2, 3],
      message: { content: "First part\n\nSecond part", createdAt: "2026-07-27T10:03:00.000Z" }
    });
  });
});
