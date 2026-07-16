/**
 * Pure argv builders and validators for the `ffmpeg` tool. Keeping these free of I/O, approvals,
 * and process spawning (all of which live in the registry) makes each supported operation directly
 * unit-testable without the ffmpeg binary installed.
 *
 * Every plan sets `-nostdin` on ffmpeg and the tool spawns with stdin ignored, so ffmpeg can never
 * block forever on its interactive "overwrite?" prompt; overwrite intent is expressed explicitly
 * with `-y`/`-n` instead.
 */

export type FfmpegOperation = "probe" | "convert" | "extract_audio" | "trim" | "thumbnail" | "custom";

export const FFMPEG_OPERATIONS: readonly FfmpegOperation[] = [
  "probe",
  "convert",
  "extract_audio",
  "trim",
  "thumbnail",
  "custom"
] as const;

export const FFMPEG_DEFAULT_TIMEOUT_MS = 300_000;
export const FFMPEG_MIN_TIMEOUT_MS = 1_000;
export const FFMPEG_MAX_TIMEOUT_MS = 3_600_000;
export const FFMPEG_MAX_OUTPUT_CHARS = 30_000;
export const FFMPEG_MIN_CRF = 0;
export const FFMPEG_MAX_CRF = 63;

/** Operations that read an input media file. `custom` is excluded: the caller supplies raw args. */
export const FFMPEG_OPERATIONS_REQUIRING_INPUT: readonly FfmpegOperation[] = [
  "probe",
  "convert",
  "extract_audio",
  "trim",
  "thumbnail"
] as const;

export type FfmpegBuildParams = {
  /** Resolved, workspace-safe absolute path to the input media (already validated by the caller). */
  input?: string;
  /** Resolved, workspace-safe absolute path to the output file (already validated by the caller). */
  output?: string;
  /** Allow replacing an existing output file (maps to ffmpeg -y vs -n). */
  overwrite?: boolean;
  /** Start timestamp for trim/thumbnail (seconds or HH:MM:SS[.ms]). */
  start?: string;
  /** Absolute end timestamp for trim (seconds or HH:MM:SS[.ms]). Mutually exclusive with duration. */
  end?: string;
  /** Clip length for trim (seconds or HH:MM:SS[.ms]). Mutually exclusive with end. */
  duration?: string;
  videoCodec?: string;
  audioCodec?: string;
  /** Audio bitrate such as 192k. */
  audioBitrate?: string;
  /** Scale filter value such as 1280:720 or -1:720. */
  scale?: string;
  /** Constant rate factor for convert (lower is higher quality). */
  crf?: number;
  /** Raw ffmpeg arguments for the `custom` operation. */
  args?: string[];
};

export type FfmpegPlan = {
  bin: "ffmpeg" | "ffprobe";
  argv: string[];
  /** True when the plan produces the file at `output`, so the caller checkpoints and gates it. */
  writesOutput: boolean;
};

const CODEC_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const BITRATE_PATTERN = /^\d+[kKmM]?$/;
const SCALE_PATTERN = /^-?\d+:-?\d+$/;

/** Accepts plain seconds (12, 12.5) or clock time (1:02, 01:02:03, 00:01:30.5). */
export function isValidMediaTimestamp(value: string): boolean {
  return /^\d+(\.\d+)?$/.test(value) || /^(?:\d+:)?\d{1,2}:\d{1,2}(?:\.\d+)?$/.test(value);
}

export function buildFfmpegPlan(operation: FfmpegOperation, params: FfmpegBuildParams): FfmpegPlan {
  switch (operation) {
    case "probe": {
      const input = requireParam("input", params.input);
      return {
        bin: "ffprobe",
        argv: ["-hide_banner", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", input],
        writesOutput: false
      };
    }
    case "convert": {
      const input = requireParam("input", params.input);
      const output = requireParam("output", params.output);
      const argv = ffmpegGlobals(params.overwrite);
      argv.push("-i", input);
      appendVideoOptions(argv, params);
      appendAudioOptions(argv, params);
      argv.push(output);
      return { bin: "ffmpeg", argv, writesOutput: true };
    }
    case "extract_audio": {
      const input = requireParam("input", params.input);
      const output = requireParam("output", params.output);
      const argv = ffmpegGlobals(params.overwrite);
      argv.push("-i", input, "-vn");
      appendAudioOptions(argv, params);
      argv.push(output);
      return { bin: "ffmpeg", argv, writesOutput: true };
    }
    case "trim": {
      const input = requireParam("input", params.input);
      const output = requireParam("output", params.output);
      const start = params.start ?? "0";
      assertTimestamp("start", start);
      if (params.end !== undefined && params.duration !== undefined) {
        throw new Error("Provide either end or duration for trim, not both.");
      }
      if (params.end === undefined && params.duration === undefined) {
        throw new Error("trim requires end or duration.");
      }
      // -ss/-to/-t after -i are output options: -ss is the start, -to the absolute end timestamp in
      // the source, -t the clip length. Output-side seeking is frame-accurate (input seeking can
      // land on the wrong keyframe), which is what a trim tool should default to.
      const argv = ffmpegGlobals(params.overwrite);
      argv.push("-i", input, "-ss", start);
      if (params.end !== undefined) {
        assertTimestamp("end", params.end);
        argv.push("-to", params.end);
      } else {
        assertTimestamp("duration", params.duration!);
        argv.push("-t", params.duration!);
      }
      argv.push(output);
      return { bin: "ffmpeg", argv, writesOutput: true };
    }
    case "thumbnail": {
      const input = requireParam("input", params.input);
      const output = requireParam("output", params.output);
      const start = params.start ?? "0";
      assertTimestamp("start", start);
      // Input-side seek (before -i) is fast and precise enough for a single still frame.
      const argv = ffmpegGlobals(params.overwrite);
      argv.push("-ss", start, "-i", input, "-frames:v", "1");
      if (params.scale !== undefined) {
        assertMatch("scale", params.scale, SCALE_PATTERN);
        argv.push("-vf", `scale=${params.scale}`);
      }
      argv.push(output);
      return { bin: "ffmpeg", argv, writesOutput: true };
    }
    case "custom": {
      const args = params.args ?? [];
      if (args.length === 0) {
        throw new Error("custom requires a non-empty args array.");
      }
      // -nostdin still applies so a raw invocation that would hit the overwrite prompt aborts
      // instead of hanging. Output paths inside custom args are the caller's responsibility.
      return { bin: "ffmpeg", argv: ["-hide_banner", "-nostdin", ...args], writesOutput: false };
    }
  }
}

function ffmpegGlobals(overwrite: boolean | undefined): string[] {
  return ["-hide_banner", "-nostdin", overwrite ? "-y" : "-n"];
}

function appendVideoOptions(argv: string[], params: FfmpegBuildParams) {
  if (params.videoCodec !== undefined) {
    assertMatch("videoCodec", params.videoCodec, CODEC_PATTERN);
    argv.push("-c:v", params.videoCodec);
  }
  if (params.crf !== undefined) {
    if (!Number.isInteger(params.crf) || params.crf < FFMPEG_MIN_CRF || params.crf > FFMPEG_MAX_CRF) {
      throw new Error(`crf must be an integer from ${FFMPEG_MIN_CRF} to ${FFMPEG_MAX_CRF}.`);
    }
    argv.push("-crf", String(params.crf));
  }
  if (params.scale !== undefined) {
    assertMatch("scale", params.scale, SCALE_PATTERN);
    argv.push("-vf", `scale=${params.scale}`);
  }
}

function appendAudioOptions(argv: string[], params: FfmpegBuildParams) {
  if (params.audioCodec !== undefined) {
    assertMatch("audioCodec", params.audioCodec, CODEC_PATTERN);
    argv.push("-c:a", params.audioCodec);
  }
  if (params.audioBitrate !== undefined) {
    assertMatch("audioBitrate", params.audioBitrate, BITRATE_PATTERN);
    argv.push("-b:a", params.audioBitrate);
  }
}

function requireParam(name: string, value: string | undefined): string {
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is required for this ffmpeg operation.`);
  }
  return value;
}

function assertTimestamp(name: string, value: string) {
  if (!isValidMediaTimestamp(value)) {
    throw new Error(`Invalid ${name} timestamp "${value}"; use seconds (12.5) or HH:MM:SS[.ms].`);
  }
}

function assertMatch(name: string, value: string, pattern: RegExp) {
  if (!pattern.test(value)) {
    throw new Error(`Invalid ${name} value "${value}".`);
  }
}
