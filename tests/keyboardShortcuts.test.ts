import { describe, expect, it } from "vitest";
import { resolveAppKeyboardShortcut, type AppKeyboardShortcutEvent } from "../desktop/renderer/src/keyboardShortcuts.js";

function shortcutEvent(key: string, options: Partial<AppKeyboardShortcutEvent> = {}): AppKeyboardShortcutEvent {
  return { key, ...options };
}

describe("desktop keyboard shortcuts", () => {
  it("requires a command or control modifier", () => {
    expect(resolveAppKeyboardShortcut(shortcutEvent("k"))).toBeNull();
    expect(resolveAppKeyboardShortcut(shortcutEvent("k", { altKey: true, metaKey: true }))).toBeNull();
  });

  it("maps common unshifted shortcuts", () => {
    expect(resolveAppKeyboardShortcut(shortcutEvent("k", { metaKey: true }))).toBe("focus_composer");
    expect(resolveAppKeyboardShortcut(shortcutEvent("n", { ctrlKey: true }))).toBe("new_chat");
    expect(resolveAppKeyboardShortcut(shortcutEvent("f", { metaKey: true }))).toBe("search_chat");
    expect(resolveAppKeyboardShortcut(shortcutEvent(",", { metaKey: true }))).toBe("settings");
    expect(resolveAppKeyboardShortcut(shortcutEvent("r", { ctrlKey: true }))).toBe("refresh_state");
  });

  it("maps shifted app-surface shortcuts", () => {
    expect(resolveAppKeyboardShortcut(shortcutEvent("B", { metaKey: true, shiftKey: true }))).toBe("toggle_browser");
    expect(resolveAppKeyboardShortcut(shortcutEvent("T", { ctrlKey: true, shiftKey: true }))).toBe("show_tools");
    expect(resolveAppKeyboardShortcut(shortcutEvent("S", { metaKey: true, shiftKey: true }))).toBe("show_skills");
  });

  it("ignores unsupported combinations", () => {
    expect(resolveAppKeyboardShortcut(shortcutEvent("b", { metaKey: true }))).toBeNull();
    expect(resolveAppKeyboardShortcut(shortcutEvent("r", { metaKey: true, shiftKey: true }))).toBeNull();
  });
});
