import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

export type HighlightTheme = "min-light" | "vitesse-black";

let highlighterPromise: Promise<HighlighterCore> | undefined;

/**
 * Fine-grained shiki setup instead of `import("shiki")`: the full bundle ships every grammar
 * and theme (~8 MB of renderer assets, 300 chunks) while chats realistically render the
 * mainstream languages below. Fence aliases (sh, py, yml, dockerfile, ...) resolve through the
 * grammars themselves; anything not listed falls back to the plain-text rendering in
 * highlightCodeHtml. The JavaScript regex engine replaces the oniguruma wasm chunk; `forgiving`
 * skips any grammar rule it cannot compile instead of throwing.
 */
function getHighlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= createHighlighterCore({
    themes: [import("@shikijs/themes/min-light"), import("@shikijs/themes/vitesse-black")],
    langs: [
      import("@shikijs/langs/javascript"),
      import("@shikijs/langs/jsx"),
      import("@shikijs/langs/typescript"),
      import("@shikijs/langs/tsx"),
      import("@shikijs/langs/json"),
      import("@shikijs/langs/jsonc"),
      import("@shikijs/langs/html"),
      import("@shikijs/langs/css"),
      import("@shikijs/langs/scss"),
      import("@shikijs/langs/python"),
      import("@shikijs/langs/shellscript"),
      import("@shikijs/langs/sql"),
      import("@shikijs/langs/yaml"),
      import("@shikijs/langs/toml"),
      import("@shikijs/langs/ini"),
      import("@shikijs/langs/markdown"),
      import("@shikijs/langs/diff"),
      import("@shikijs/langs/go"),
      import("@shikijs/langs/rust"),
      import("@shikijs/langs/java"),
      import("@shikijs/langs/c"),
      import("@shikijs/langs/cpp"),
      import("@shikijs/langs/csharp"),
      import("@shikijs/langs/php"),
      import("@shikijs/langs/ruby"),
      import("@shikijs/langs/swift"),
      import("@shikijs/langs/kotlin"),
      import("@shikijs/langs/xml"),
      import("@shikijs/langs/docker"),
      import("@shikijs/langs/make")
    ],
    engine: createJavaScriptRegexEngine({ forgiving: true })
  });
  return highlighterPromise;
}

export async function highlightCodeHtml(code: string, language: string, theme: HighlightTheme): Promise<string> {
  const highlighter = await getHighlighter();
  try {
    return highlighter.codeToHtml(code, { lang: language, theme });
  } catch {
    // Unknown or unloaded language: render as plain text (built into the core, no grammar).
    return highlighter.codeToHtml(code, { lang: "text", theme });
  }
}
