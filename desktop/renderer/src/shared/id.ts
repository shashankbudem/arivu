import { truncateMiddle } from "./text";

export function randomId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function shortRunId(id: string) {
  return truncateMiddle(id, 18);
}
