import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { installOutputPipeGuard } from "../desktop/main/outputPipeGuard.js";

describe("installOutputPipeGuard", () => {
  it("swallows EPIPE when the launcher's output pipe has closed", () => {
    const stream = new EventEmitter();
    const unexpected = vi.fn();
    installOutputPipeGuard(stream, unexpected);

    stream.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));

    expect(unexpected).not.toHaveBeenCalled();
  });

  it("does not hide unrelated stream failures", () => {
    const stream = new EventEmitter();
    const unexpected = vi.fn();
    installOutputPipeGuard(stream, unexpected);
    const error = Object.assign(new Error("permission denied"), { code: "EACCES" });

    stream.emit("error", error);

    expect(unexpected).toHaveBeenCalledWith(error);
  });
});
