import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApprovalManager } from "../src/permissions/ApprovalManager.js";
import { buildFfmpegPlan, isValidMediaTimestamp } from "../src/tools/ffmpeg.js";
import { createToolRegistry } from "../src/tools/registry.js";

const IN = "/ws/input.mp4";
const OUT = "/ws/output.mp4";

describe("buildFfmpegPlan", () => {
  it("builds a probe plan with ffprobe and no output", () => {
    const plan = buildFfmpegPlan("probe", { input: IN });
    expect(plan.bin).toBe("ffprobe");
    expect(plan.writesOutput).toBe(false);
    expect(plan.argv).toEqual(["-hide_banner", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", IN]);
  });

  it("builds a convert plan with codecs, scale, and crf", () => {
    const plan = buildFfmpegPlan("convert", {
      input: IN,
      output: OUT,
      videoCodec: "libx264",
      crf: 23,
      scale: "1280:720",
      audioCodec: "aac",
      audioBitrate: "192k"
    });
    expect(plan.bin).toBe("ffmpeg");
    expect(plan.writesOutput).toBe(true);
    expect(plan.argv.slice(0, 5)).toEqual(["-hide_banner", "-nostdin", "-n", "-i", IN]);
    expect(plan.argv).toEqual(
      expect.arrayContaining(["-c:v", "libx264", "-crf", "23", "-vf", "scale=1280:720", "-c:a", "aac", "-b:a", "192k"])
    );
    expect(plan.argv.at(-1)).toBe(OUT);
  });

  it("uses -y instead of -n when overwrite is allowed", () => {
    const plan = buildFfmpegPlan("convert", { input: IN, output: OUT, overwrite: true });
    expect(plan.argv).toContain("-y");
    expect(plan.argv).not.toContain("-n");
  });

  it("builds an extract_audio plan that drops video", () => {
    const plan = buildFfmpegPlan("extract_audio", { input: IN, output: "/ws/out.mp3", audioBitrate: "256k" });
    expect(plan.argv).toEqual(expect.arrayContaining(["-vn", "-b:a", "256k"]));
    expect(plan.argv.at(-1)).toBe("/ws/out.mp3");
  });

  it("builds a trim plan with a duration", () => {
    const plan = buildFfmpegPlan("trim", { input: IN, output: OUT, start: "5", duration: "10" });
    expect(plan.argv).toEqual(expect.arrayContaining(["-i", IN, "-ss", "5", "-t", "10"]));
    expect(plan.argv).not.toContain("-to");
  });

  it("builds a trim plan with an absolute end timestamp", () => {
    const plan = buildFfmpegPlan("trim", { input: IN, output: OUT, start: "00:00:05", end: "00:00:20" });
    expect(plan.argv).toEqual(expect.arrayContaining(["-ss", "00:00:05", "-to", "00:00:20"]));
    expect(plan.argv).not.toContain("-t");
  });

  it("builds a thumbnail plan capturing a single frame", () => {
    const plan = buildFfmpegPlan("thumbnail", { input: IN, output: "/ws/thumb.png", start: "2", scale: "-1:480" });
    expect(plan.argv).toEqual([
      "-hide_banner",
      "-nostdin",
      "-n",
      "-ss",
      "2",
      "-i",
      IN,
      "-frames:v",
      "1",
      "-vf",
      "scale=-1:480",
      "/ws/thumb.png"
    ]);
  });

  it("passes raw args through for custom while keeping -nostdin", () => {
    const plan = buildFfmpegPlan("custom", { args: ["-i", IN, "-af", "loudnorm", OUT] });
    expect(plan.argv).toEqual(["-hide_banner", "-nostdin", "-i", IN, "-af", "loudnorm", OUT]);
    expect(plan.writesOutput).toBe(false);
  });

  it("requires input and output where the operation needs them", () => {
    expect(() => buildFfmpegPlan("probe", {})).toThrow(/input is required/);
    expect(() => buildFfmpegPlan("convert", { input: IN })).toThrow(/output is required/);
  });

  it("rejects a trim with both end and duration, or neither", () => {
    expect(() => buildFfmpegPlan("trim", { input: IN, output: OUT, end: "10", duration: "5" })).toThrow(/not both/);
    expect(() => buildFfmpegPlan("trim", { input: IN, output: OUT })).toThrow(/requires end or duration/);
  });

  it("rejects malformed timestamps, scale, codec, and crf values", () => {
    expect(() => buildFfmpegPlan("trim", { input: IN, output: OUT, start: "abc", duration: "5" })).toThrow(/Invalid start timestamp/);
    expect(() => buildFfmpegPlan("convert", { input: IN, output: OUT, scale: "huge" })).toThrow(/Invalid scale/);
    expect(() => buildFfmpegPlan("convert", { input: IN, output: OUT, videoCodec: "lib x264" })).toThrow(/Invalid videoCodec/);
    expect(() => buildFfmpegPlan("convert", { input: IN, output: OUT, crf: 99 })).toThrow(/crf must be/);
  });

  it("rejects a custom operation with no args", () => {
    expect(() => buildFfmpegPlan("custom", { args: [] })).toThrow(/non-empty args/);
  });
});

describe("isValidMediaTimestamp", () => {
  it("accepts seconds and clock formats", () => {
    for (const value of ["0", "12", "12.5", "1:02", "01:02:03", "00:01:30.5"]) {
      expect(isValidMediaTimestamp(value)).toBe(true);
    }
  });

  it("rejects non-time values", () => {
    for (const value of ["abc", "-5", "1:2:3:4", "12s"]) {
      expect(isValidMediaTimestamp(value)).toBe(false);
    }
  });
});

describe("ffmpeg tool registration and guards", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "arivu-ffmpeg-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function registry() {
    return createToolRegistry({
      workspaceRoot: tempDir,
      approvals: new ApprovalManager("trusted", async () => true)
    });
  }

  it("registers the ffmpeg tool", () => {
    expect(registry().schemas.map((schema) => schema.name)).toContain("ffmpeg");
  });

  it("reports a missing input file before spawning anything", async () => {
    await expect(registry().execute("ffmpeg", { operation: "probe", input: "missing.mp4" })).resolves.toMatch(/Input not found/);
  });

  it("keeps input and output inside the workspace", async () => {
    await expect(registry().execute("ffmpeg", { operation: "probe", input: "../escape.mp4" })).resolves.toMatch(/escapes workspace/);
  });

  it("refuses to overwrite an existing output unless overwrite is set", async () => {
    await writeFile(path.join(tempDir, "in.mp4"), "x", "utf8");
    await writeFile(path.join(tempDir, "out.mp4"), "y", "utf8");
    await expect(registry().execute("ffmpeg", { operation: "convert", input: "in.mp4", output: "out.mp4" })).resolves.toMatch(
      /already exists/
    );
  });

  it("surfaces per-operation validation errors from the tool", async () => {
    await writeFile(path.join(tempDir, "in.mp4"), "x", "utf8");
    await expect(registry().execute("ffmpeg", { operation: "trim", input: "in.mp4", output: "out.mp4" })).resolves.toMatch(
      /requires end or duration/
    );
  });
});
