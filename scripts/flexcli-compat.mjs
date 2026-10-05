// Preloaded by scripts/flexcli.cjs (via NODE_OPTIONS=--import=...) on Node.js 22+.
// Rewrites FlexCLI's `import ... assert { type: 'json' }` to `with { type: 'json' }`.
// Only modules under @eniac/flexcli are touched; everything else loads unchanged.
import * as nodeModule from "node:module";
import { isMainThread } from "node:worker_threads";
import compat from "./flexcli.cjs";

const { isFlexcliModuleUrl, rewriteImportAssertions } = compat;

function patch(url, result) {
  if (!isFlexcliModuleUrl(url) || result.format !== "module" || result.source == null) return result;
  const source = typeof result.source === "string" ? result.source : Buffer.from(result.source).toString("utf8");
  return { ...result, source: rewriteImportAssertions(source) };
}

export async function load(url, context, nextLoad) {
  return patch(url, await nextLoad(url, context));
}

if (isMainThread) {
  if (typeof nodeModule.registerHooks === "function") {
    nodeModule.registerHooks({ load: (url, context, nextLoad) => patch(url, nextLoad(url, context)) });
  } else {
    nodeModule.register(import.meta.url);
  }
}
