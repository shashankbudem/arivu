type OutputError = Error & { code?: string };

type ErrorEmitter = {
  on(event: "error", listener: (error: OutputError) => void): unknown;
};

/**
 * Electron can outlive the terminal or Playwright process that launched it. In
 * that case stdout/stderr writes emit EPIPE; without an error listener Node turns
 * a harmless diagnostic write into an uncaught-exception dialog that blocks the
 * main event loop and every running agent task.
 */
export function installOutputPipeGuard(
  stream: ErrorEmitter | null | undefined,
  onUnexpectedError: (error: OutputError) => void = (error) => {
    setImmediate(() => {
      throw error;
    });
  }
): void {
  stream?.on("error", (error) => {
    if (error.code === "EPIPE") {
      return;
    }
    onUnexpectedError(error);
  });
}

export function installProcessOutputPipeGuards(): void {
  installOutputPipeGuard(process.stdout);
  installOutputPipeGuard(process.stderr);
}
