/**
 * Pure argv builders and validators for the `computer_screenshot` tool. Keeping these free of I/O,
 * approvals, and process spawning (all of which live in the registry) makes the capture plan
 * directly unit-testable without macOS screen-capture binaries or a real display.
 *
 * Capture executes through `screencapture`, which ships with macOS. This is the read half of
 * computer use: it observes the machine's screen but injects no input. Input actions belong behind
 * the same `computer_control` capability and a destructive-action guard, and are not built yet.
 */

export const SCREENCAPTURE_BIN = "screencapture";

export const COMPUTER_CAPTURE_DEFAULT_TIMEOUT_MS = 20_000;
export const COMPUTER_CAPTURE_MIN_TIMEOUT_MS = 1_000;
export const COMPUTER_CAPTURE_MAX_TIMEOUT_MS = 120_000;

/** `screencapture -D` is 1-based. Beyond a handful of displays the argument is almost certainly a typo. */
export const MIN_DISPLAY_ID = 1;
export const MAX_DISPLAY_ID = 16;

/**
 * A capture smaller than this is not a screen. Used to reject degenerate regions before spawning,
 * since `screencapture` answers a 0x0 rectangle with an empty file rather than an error.
 */
export const MIN_REGION_EDGE_PX = 1;

export type ComputerScreenshotRegion = { x: number; y: number; width: number; height: number };

export type ComputerScreenshotParams = {
  /** Absolute PNG destination, already resolved by the caller. */
  output: string;
  /** 1-based display index. Ignored when `region` is set, which is global-coordinate based. */
  display?: number;
  region?: ComputerScreenshotRegion;
  /** The pointer is excluded by default so repeat captures of the same screen are byte-comparable. */
  includeCursor?: boolean;
};

export type ComputerScreenshotPlan = {
  bin: typeof SCREENCAPTURE_BIN;
  argv: string[];
  /** Human-readable capture target for the approval prompt and the audit scope. */
  target: string;
};

/**
 * macOS gates screen capture behind a TCC permission that cannot be granted, or reliably queried,
 * from a child process. Worse, a denied capture still exits 0 and still writes a valid PNG — it
 * just contains the desktop picture with every window missing. There is no exit code, stderr
 * string, or file-size threshold that separates that from a legitimately empty desktop, so the
 * tool states the requirement instead of pretending to detect it.
 */
export const SCREEN_RECORDING_PERMISSION_HINT =
  "If the capture shows only the desktop picture with no application windows, macOS Screen Recording " +
  "permission has not been granted. Grant it in System Settings > Privacy & Security > Screen & System " +
  "Audio Recording for the app running Arivu, then re-run. macOS denies this silently: the capture " +
  "still succeeds and still writes a PNG, so a permission failure cannot be detected from the exit code.";

export function buildComputerScreenshotPlan(params: ComputerScreenshotParams): ComputerScreenshotPlan {
  if (!params.output.trim()) {
    throw new Error("output is required for a screen capture.");
  }
  // `-x` suppresses the shutter sound. Deliberately not offered: the sound is the one signal a
  // person physically at the machine gets that their screen was captured, and a governed harness
  // should not be able to read the screen silently.
  const argv = ["-t", "png"];

  if (params.region) {
    const region = assertValidRegion(params.region);
    if (params.display !== undefined) {
      throw new Error("Pass either display or region, not both; region coordinates are global across displays.");
    }
    argv.push("-R", `${region.x},${region.y},${region.width},${region.height}`);
  } else if (params.display !== undefined) {
    argv.push("-D", String(assertValidDisplay(params.display)));
  } else {
    // No -D and no -R captures every attached display into one image, which silently widens the
    // capture past what the approval prompt described. Default to the main display instead.
    argv.push("-D", String(MIN_DISPLAY_ID));
  }

  if (params.includeCursor) {
    argv.push("-C");
  }

  argv.push(params.output);
  return { bin: SCREENCAPTURE_BIN, argv, target: describeCaptureTarget(params) };
}

export function assertValidDisplay(display: number): number {
  if (!Number.isInteger(display) || display < MIN_DISPLAY_ID || display > MAX_DISPLAY_ID) {
    throw new Error(`Invalid display ${display}; expected an integer from ${MIN_DISPLAY_ID} to ${MAX_DISPLAY_ID}.`);
  }
  return display;
}

export function assertValidRegion(region: ComputerScreenshotRegion): ComputerScreenshotRegion {
  for (const [name, value] of Object.entries(region)) {
    if (!Number.isInteger(value)) {
      throw new Error(`Invalid region ${name} ${value}; screen coordinates must be integers.`);
    }
  }
  if (region.width < MIN_REGION_EDGE_PX || region.height < MIN_REGION_EDGE_PX) {
    throw new Error(`Invalid region size ${region.width}x${region.height}; width and height must be at least ${MIN_REGION_EDGE_PX}.`);
  }
  return region;
}

/** The phrase the user sees in the approval prompt, so what they authorize matches what runs. */
export function describeCaptureTarget(params: Pick<ComputerScreenshotParams, "display" | "region">): string {
  if (params.region) {
    const { x, y, width, height } = params.region;
    return `screen region ${width}x${height} at ${x},${y}`;
  }
  return `entire display ${params.display ?? MIN_DISPLAY_ID}`;
}

/**
 * Why this platform cannot capture, or undefined when it can. Returned rather than thrown so the
 * registry can phrase the failure the same way it phrases a missing binary. `dist:win` and
 * `dist:linux` ship, so a macOS-only tool has to answer for itself on the other two.
 */
export function screenCaptureUnsupportedReason(platform: NodeJS.Platform): string | undefined {
  if (platform === "darwin") {
    return undefined;
  }
  return `Screen capture requires macOS; ${SCREENCAPTURE_BIN} is not available on ${platform}.`;
}

/**
 * PNG dimensions straight from the IHDR chunk, which is fixed at bytes 16-23 of every PNG. Reading
 * them back is the only real confirmation that the capture produced an image rather than an empty
 * or truncated file, and it gives the model the coordinate space any later click would use.
 */
export function readPngDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte)) {
    return undefined;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

/**
 * Backing scale of the capture, derived by comparing what was asked for against what landed.
 *
 * `screencapture -R` takes a rectangle in screen *points*, but writes a PNG in physical *pixels*.
 * On a Retina display those differ by the backing scale factor: asking for a 1x1 point region on a
 * 2x display produces a 2x2 pixel image (verified against a built-in 2560x1664 Retina panel). Any
 * coordinate read off the returned image therefore has to be divided by this factor before it means
 * anything to a future click, which is the whole reason it is reported rather than left implicit.
 *
 * Only derivable for a region capture, where the requested size is known. A whole-display capture
 * returns undefined: the display's size in points is not something this tool asked for.
 */
export function captureScaleFactor(requestedEdge: number, actualEdge: number): number | undefined {
  if (requestedEdge <= 0 || actualEdge <= 0) {
    return undefined;
  }
  const scale = actualEdge / requestedEdge;
  // Backing scales are small integers or simple fractions; anything else means the capture was
  // clipped at a screen edge rather than scaled, and reporting a ratio would be misleading.
  const rounded = Math.round(scale * 100) / 100;
  return rounded >= 0.5 && rounded <= 4 ? rounded : undefined;
}

export const CAPTURE_COORDINATE_SPACE_HINT =
  "Region coordinates are in screen points, but the returned PNG is in physical pixels. On a Retina " +
  "display these differ by the backing scale factor, so divide any pixel coordinate read off this " +
  "image by that factor before treating it as a screen position.";

/** Collision-free capture filename. `now` is injected so the name is testable without a clock. */
export function screenshotFileName(now: Date, suffix: string): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return `screen-${stamp}-${suffix}.png`;
}
