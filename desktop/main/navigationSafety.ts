import path from "node:path";
import { fileURLToPath } from "node:url";

type TrustedNavigationOptions = {
  devUrl?: string;
  rendererIndex: string;
};

export function isTrustedAppNavigationUrl(rawUrl: string, options: TrustedNavigationOptions): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  if (options.devUrl) {
    try {
      return url.origin === new URL(options.devUrl).origin;
    } catch {
      return false;
    }
  }

  if (url.protocol !== "file:") {
    return false;
  }

  try {
    return path.resolve(fileURLToPath(url)) === path.resolve(options.rendererIndex);
  } catch {
    return false;
  }
}

export function isExternalHttpUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
