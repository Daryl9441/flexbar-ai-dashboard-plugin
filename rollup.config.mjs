import commonjs from "@rollup/plugin-commonjs";
import nodeResolve from "@rollup/plugin-node-resolve";
import terser from "@rollup/plugin-terser";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import json from "@rollup/plugin-json";
import nativeCanvas from "./scripts/native-canvas.cjs";

const isWatching = !!process.env.ROLLUP_WATCH;
const projectDir = path.dirname(url.fileURLToPath(import.meta.url));
const flexPlugin = "com.aspen.flexbar-ai-dashboard.plugin";
// FLEX_TARGET picks the @napi-rs/canvas binaries bundled into the plugin backend,
// e.g. "darwin-arm64,darwin-x64", "win32-x64" or "all"; empty means the build host.
// Resolved up front so a typo fails before bundling starts.
const canvasTargets = nativeCanvas.resolveCanvasTargets(process.env.FLEX_TARGET);

function listUiVueFiles(uiDir) {
  if (!fs.existsSync(uiDir)) return [];
  return fs.readdirSync(uiDir)
    .filter((name) => name.endsWith(".vue"))
    .map((name) => path.join(uiDir, name));
}

/** @param {import("rollup").RollupLog} warning */
function suppressKnownRollupWarnings(warning) {
  if (warning.code === "CIRCULAR_DEPENDENCY") {
    const cycle = warning.ids?.join("/") || "";
    if (
      cycle.includes("readable-stream/") ||
      cycle.includes("async/") ||
      cycle.includes("winston/")
    ) {
      return;
    }
  }

  if (
    warning.code === "THIS_IS_UNDEFINED" &&
    warning.id?.includes("@eniac/flexdesigner/dist/transport.js")
  ) {
    return;
  }

  console.warn(warning.message);
}

/**
 * @type {import('rollup').RollupOptions}
 */
const config = {
  input: "src/plugin.js",
  onwarn: suppressKnownRollupWarnings,
  output: {
    file: `${flexPlugin}/backend/plugin.cjs`,
    format: "cjs",
    sourcemap: isWatching,
    sourcemapPathTransform: (relativeSourcePath, sourcemapPath) => {
      return url.pathToFileURL(path.resolve(path.dirname(sourcemapPath), relativeSourcePath)).href;
    },
  },
  plugins: [
    json(),
    {
      name: "watch-externals",
      buildStart: function () {
        this.addWatchFile(`${flexPlugin}/manifest.json`);
        for (const file of listUiVueFiles(path.join(flexPlugin, "ui"))) {
          this.addWatchFile(file);
        }
      },
    },
    nodeResolve({
      browser: false,
      exportConditions: ["node"],
      preferBuiltins: true
    }),
    commonjs(),
    patchFlexdesignerTransportRetry(),
    !isWatching && terser(),
    {
      name: "copy-native-canvas",
      generateBundle() {
        let bundled;
        try {
          bundled = nativeCanvas.bundleNativeCanvas({
            projectDir,
            pluginDir: path.resolve(flexPlugin),
            targets: canvasTargets,
            log: (message) => this.info(message),
          });
        } catch (error) {
          this.error(`Could not bundle the @napi-rs/canvas native binary: ${error.message}`);
        }
        for (const item of bundled) {
          this.info(`bundled ${item.name}@${item.version} for ${item.target} (${item.source})`);
        }
      }
    },
    {
      name: "emit-module-package-file",
      generateBundle() {
        this.emitFile({ fileName: "package.json", source: `{ "type": "module" }`, type: "asset" });
      }
    }
  ],
  external: id => id.endsWith('.node')
};

function patchFlexdesignerTransportRetry() {
  return {
    name: "patch-flexdesigner-transport-retry",
    transform(code, id) {
      const normalizedId = id.split(path.sep).join("/");
      if (!normalizedId.endsWith("/@eniac/flexdesigner/dist/transport.js")) return null;

      const unboundRetry = "setTimeout(this.start, 5000);";
      if (!code.includes(unboundRetry)) return null;

      return {
        code: code.replaceAll(unboundRetry, "setTimeout(() => this.start(), 5000);"),
        map: null,
      };
    },
  };
}

export default config;
