import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const chalkShimPath = path.resolve(dirname, "desktop/main/browserBundleShims/chalkShim.ts");

// page-agent's core/llms packages import chalk for colored console logging, but chalk v5
// has no browser build and references Node's `process` at each call site. These two
// browser-targeted bundles alias it away; see chalkShim.ts for why.
function aliasChalkForBrowser(options: { alias?: Record<string, string> }) {
  options.alias = { ...options.alias, chalk: chalkShimPath };
}

export default defineConfig([
  {
    entry: ["desktop/main/main.ts"],
    format: ["esm"],
    platform: "node",
    external: ["electron"],
    // Bundle the runtime dependencies (tsup externalizes package.json dependencies by default)
    // so the packaged app runs from dist-desktop alone and electron-builder can drop
    // node_modules from the asar entirely. All five are pure JS with no native modules.
    // execa's bundled cross-spawn dependency is CommonJS and still performs a runtime
    // require("child_process"), so expose Node's ESM-safe require bridge to the bundle.
    noExternal: [/^execa(\/|$)/, /^zod(\/|$)/, /^chalk(\/|$)/, /^@inquirer\/prompts(\/|$)/, /^@modelcontextprotocol\/sdk(\/|$)/],
    banner: {
      js: 'import { createRequire as __arivuCreateRequire } from "node:module"; const require = __arivuCreateRequire(import.meta.url);'
    },
    outDir: "dist-desktop/main",
    sourcemap: true,
    clean: true
  },
  {
    entry: ["desktop/main/preload.ts"],
    format: ["cjs"],
    platform: "node",
    external: ["electron"],
    outDir: "dist-desktop/preload",
    sourcemap: true,
    clean: true,
    outExtension() {
      return { js: ".cjs" };
    }
  },
  {
    entry: { "page-agent": "desktop/main/pageAgentBundle/entry.ts" },
    format: ["iife"],
    platform: "browser",
    noExternal: [/.*/],
    outDir: "dist-desktop/pageAgentBundle",
    sourcemap: false,
    minify: true,
    dts: false,
    clean: true,
    esbuildOptions: aliasChalkForBrowser,
    outExtension() {
      return { js: ".iife.js" };
    }
  },
  {
    entry: { "page-controller": "desktop/main/pageControllerBundle/entry.ts" },
    format: ["iife"],
    platform: "browser",
    noExternal: [/.*/],
    outDir: "dist-desktop/pageControllerBundle",
    sourcemap: false,
    minify: true,
    dts: false,
    clean: true,
    esbuildOptions: aliasChalkForBrowser,
    outExtension() {
      return { js: ".iife.js" };
    }
  }
]);
