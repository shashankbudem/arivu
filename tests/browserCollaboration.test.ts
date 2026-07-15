import { describe, expect, it } from "vitest";
import {
  applyBrowserDesignPatchScript,
  browserAutofillScript,
  discardBrowserDesignPatchScript,
  installBrowserAnnotationScript,
  normalizeBrowserDesignPatch
} from "../desktop/main/browserCollaboration.js";

describe("browser collaboration scripts", () => {
  it("emits syntactically valid annotation scripts for every mode", () => {
    for (const mode of ["browse", "element", "region"] as const) {
      expect(() => new Function(installBrowserAnnotationScript(mode))).not.toThrow();
    }
  });

  it("emits syntactically valid design and autofill scripts", () => {
    expect(() => new Function(applyBrowserDesignPatchScript("#submit", { color: "#112233", padding: "8px" }))).not.toThrow();
    expect(() => new Function(discardBrowserDesignPatchScript("#submit"))).not.toThrow();
    expect(
      () =>
        new Function(
          browserAutofillScript({ fullName: "A User", email: "a@example.com" }, { username: "a@example.com", password: "secret" })
        )
    ).not.toThrow();
  });

  it("accepts only supported, bounded design properties", () => {
    expect(
      normalizeBrowserDesignPatch({
        color: "  #112233  ",
        padding: "12px",
        position: "fixed",
        width: "x".repeat(121),
        gap: 12
      })
    ).toEqual({ color: "#112233", padding: "12px" });
  });
});
