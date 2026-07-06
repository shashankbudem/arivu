export type AppKeyboardShortcut =
  | "focus_composer"
  | "new_chat"
  | "search_chat"
  | "settings"
  | "refresh_state"
  | "toggle_browser"
  | "show_tools"
  | "show_skills";

export type AppKeyboardShortcutEvent = {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
};

export function resolveAppKeyboardShortcut(event: AppKeyboardShortcutEvent): AppKeyboardShortcut | null {
  if ((!event.metaKey && !event.ctrlKey) || event.altKey) {
    return null;
  }

  const key = event.key.toLowerCase();
  const shifted = Boolean(event.shiftKey);

  if (!shifted) {
    if (key === "k") {
      return "focus_composer";
    }
    if (key === "n") {
      return "new_chat";
    }
    if (key === "f") {
      return "search_chat";
    }
    if (key === ",") {
      return "settings";
    }
    if (key === "r") {
      return "refresh_state";
    }
    return null;
  }

  if (key === "b") {
    return "toggle_browser";
  }
  if (key === "t") {
    return "show_tools";
  }
  if (key === "s") {
    return "show_skills";
  }

  return null;
}
