// @page-agent/core and @page-agent/llms import chalk for colored console logging
// (e.g. `chalk.blue.bold("Observing...")` on every step). chalk v5 has no browser build
// and does lazy color-support detection that references Node's `process` at each call,
// which throws in a browser-injected IIFE. This shim is aliased in place of `chalk` for
// the browser bundle entries only (see desktop.tsup.config.ts) and turns every color/style
// call into a plain identity passthrough.
function identity(...args: unknown[]): string {
  return args.map(String).join(" ");
}

const chalkShim: unknown = new Proxy(identity, {
  get: () => chalkShim,
  apply: (_target, _thisArg, args: unknown[]) => identity(...args)
});

export default chalkShim;
