# Flexbar AI Dashboard

![Flexbar AI Dashboard screenshot](assets/Flexbar-7C3502BA2010-screenshot-2026-05-14T06-12-46-108Z.jpg)

Flexbar AI Dashboard is a FlexDesigner v1 plugin that shows local Codex and Claude Code activity on Flexbar keys: session status, token usage, plan usage windows, and skill shortcuts.

It is built for development workflows that use both Codex and Claude Code. You can see which agent is running, which tool it just used, recent token consumption, and remaining plan quota without switching back to the terminal.

## Supported Tools

### Codex

- Sessions and current activity: reads from `codex app-server` first, then falls back to JSONL logs under `$CODEX_HOME/sessions`.
- Token usage: parses `token_count` events from Codex session JSONL files.
- Plan usage: reads rate limits from `codex app-server` when available; otherwise uses the OAuth token in `$CODEX_HOME/auth.json` to query the ChatGPT usage endpoint.
- Skill shortcuts: reads `SKILL.md` files from `$CODEX_HOME/skills` and `$CODEX_HOME/plugins/cache`.

The default `CODEX_HOME` is `~/.codex`. Override it with the `CODEX_HOME` environment variable if needed.

### Claude Code

- Sessions and token usage: reads Claude Code project JSONL logs. Default locations:
  - `~/.config/claude/projects`
  - `~/.claude/projects`
- Live activity and plan windows: uses plugin-installed Claude hooks and statusLine output written to a local bridge file.
- Skill shortcuts: reads `~/.claude/skills`. If `CLAUDE_CONFIG_DIR` is set, the plugin reads `skills` and `projects` from that config directory.

The default bridge file is `~/.flexbar-ai-dashboard/claude-events.jsonl`. Override it with `FLEXBAR_AI_CLAUDE_EVENTS` if needed.

## Flexbar Keys

- **AI Session**: shows a recent active Codex or Claude Code session. The key can be configured by data source and session title mode.
  - **Tap to list all sessions / 点击查看所有会话**: tapping the key switches it to an overview of the sessions of its data source — one title per row with a colored dot: **orange** waiting for approval (listed for up to 6 hours), **blue** running (listed until it goes 30 minutes without activity, so a session killed mid tool call drops off), **green** done (finished in the last 30 minutes, or finished while you were away and not yet viewed). Approvals come first, then running, then finished sessions, each newest first; when they do not fit, the key ends with "+N", drawn blue if it hides a running or waiting session. Tap again to return; the finished sessions it showed count as viewed, those behind "+N" stay unread. / 点击按键切换为会话总览：每行一个会话标题和一个圆点，**橙色**=等待批准，**蓝色**=进行中，**绿色**=已完成；再次点击返回单会话视图。
  - Codex progress per session is read from each thread's rollout file (`$CODEX_HOME/sessions/**`) written in the last 6 hours, newest first and up to 16 threads, since `codex app-server` reports threads opened in the ChatGPT app as `notLoaded`. Rollouts written recently that `thread/list` left out (such as an old thread resumed today) are listed too.
  - Claude Code progress per session comes from that session's own hook events and transcript: a finished turn (Stop) shows as done, a permission prompt as waiting for approval.
- **Token Usage**: shows observed local token usage. Supports summary mode and recent chart mode.
- **Plan Usage**: shows remaining Codex or Claude Code plan / rate-limit windows.
- **Reset Timer**: counts down to the next plan-usage window reset of the selected provider.
- **New Codex Session**: opens a new thread in the ChatGPT desktop app (see below).
- **AI Skill**: lets you select a Codex or Claude Code skill. Pressing the key pastes `Use the <skill> skill.` into the current input target.

The plugin includes English and Chinese UI strings and follows the host language where possible.

### New Codex Session / 新建 Codex 会话

Pressing the key opens `codex://threads/new?mode=<codex|work|chat>[&path=<project folder>][&prompt=<text>]` with the system URL handler (`open` on macOS, PowerShell `Start-Process` on Windows). The `codex://` scheme is registered by the **ChatGPT desktop app** (bundle id `com.openai.codex`), which must be installed; otherwise a "Could not open the ChatGPT app" notification appears.

- **Mode**: Codex, Work or Chat surface of the app.
- **Project folder**: optional absolute path; the list offers recent Codex session folders. Empty means the app's current project. The first time a folder is opened this way, ChatGPT shows its one-time "trust this folder" dialog.
- **Starting prompt**: optional; it is only prefilled in the composer. Nothing is sent until you press send in the app.

按下按键会通过 `codex://threads/new` 深链接在 ChatGPT 桌面应用中新建会话（需已安装 ChatGPT 桌面应用）。项目目录可选，首次使用某个目录时 ChatGPT 会弹出一次信任确认；起始提示词只会预填到输入框，不会自动发送。

## References

This plugin does not fork upstream code. It adapts behavior and data formats from these projects and docs:

- [ENIAC-Tech/flexdesigner-sdk](https://github.com/ENIAC-Tech/flexdesigner-sdk): FlexDesigner plugin SDK, `plugin.draw`, lifecycle events, and config page communication.
- [openai/codex](https://github.com/openai/codex): Codex CLI local session behavior, app-server behavior, and token event shape.
- [anthropics/claude-code](https://github.com/anthropics/claude-code): Claude Code local config, skills, and project log conventions.
- [Claude Code hooks docs](https://docs.anthropic.com/en/docs/claude-code/hooks): hook configuration structure in `~/.claude/settings.json`.
- [Claude Code statusLine docs](https://docs.anthropic.com/en/docs/claude-code/statusline): statusLine JSON input via stdin and status text via stdout.

## Installation

### From a release

Each GitHub release has one `.flexplugin` per platform, each bundling the matching `@napi-rs/canvas` native binaries (key images cannot be rendered without them). FlexDesigner picks the asset for your machine when installing from the repository link; for a manual import pick it yourself:

| Asset | Contains |
| --- | --- |
| `com.aspen.flexbar-ai-dashboard.darwin.arm64.flexplugin` | macOS arm64 + x64 |
| `com.aspen.flexbar-ai-dashboard.darwin.x64.flexplugin` | macOS arm64 + x64 |
| `com.aspen.flexbar-ai-dashboard.win32.x64.flexplugin` | Windows x64 |
| `com.aspen.flexbar-ai-dashboard.all.flexplugin` | universal: all three |

### Prerequisites (building from source)

- Node.js 20.10 or later (22/24 LTS work too). FlexCLI 1.0.7 imports JSON with import attributes (`with { type: 'json' }`), which needs Node.js 18.20+/20.10+; Node.js 18 is end-of-life, so 20.10 is the minimum (`engines` in `package.json`).
- FlexDesigner 1.3.0 or later
- A Flexbar device
- No global FlexCLI: the npm scripts run `@eniac/flexcli@1.0.7` through `npx` via `scripts/flexcli.cjs`.

FlexCLI 1.0.7 also uses the older `assert { type: 'json' }` syntax, which Node.js 22+ rejects (`SyntaxError: Unexpected identifier 'assert'`). `scripts/flexcli.cjs` patches this at load time, so run FlexCLI through the `npm run plugin:*` scripts (or `node scripts/flexcli.cjs ...`) instead of a global `flexcli`.

### Install Dependencies

```bash
git clone <repo-url>
cd flexbar-ai-dashboard
npm install
```

## macOS local install / 本地安装 (macOS)

The darwin release assets already contain the macOS arm64 and x64 binaries. To run unreleased changes, build and install from source on the Mac (FlexDesigner must be running; FlexCLI talks to it over a local WebSocket):

Release 中的 darwin 资源已包含 macOS arm64 与 x64 的原生二进制。如需运行未发布的代码，请在 Mac 上从源码构建并安装（FlexDesigner 必须处于运行状态，FlexCLI 通过本地 WebSocket 与其通信）：

```bash
npm install
npm run plugin:install  # build -> doctor -> flexcli plugin pack -> flexcli plugin install --force
```

- **Check the result / 确认结果**: the install succeeded only if the output contains `Install command successful`. FlexCLI exits with code 0 even when FlexDesigner rejects the install (`Install command failed`), so do not rely on the exit code. / 输出中出现 `Install command successful` 才表示安装成功；FlexDesigner 拒绝安装时（`Install command failed`）FlexCLI 的退出码仍为 0。
- **Manual import / 手动导入**: `npm run plugin:pack`, then import `com.aspen.flexbar-ai-dashboard.flexplugin` with the **+** button at the top right of the key library. / 执行 `npm run plugin:pack`，再通过按键库右上角的 **+** 导入该文件。
- **config.json**: local settings that FlexDesigner writes into the plugin folder while it is linked for development (e.g. path overrides). `plugin:pack` moves it out of the folder while packing and restores it afterwards, so it never ends up in the `.flexplugin`. / 打包时会临时移走插件目录中的 `config.json`，打包后自动恢复，不会被打进 `.flexplugin`。

### Doctor / 环境自检

`npm run doctor` runs automatically before `plugin:pack`, `plugin:install` and `dev` (they chain `npm run build && npm run doctor` explicitly, so it also runs with pnpm, yarn or `--ignore-scripts`). It checks:

- Node.js >= 20.10 and `manifest.json` (uuid vs. folder name), the built backend, and a stray `config.json`;
- for every target in `FLEX_TARGET` (same syntax as the build, see [Build and Deploy](#build-and-deploy)), that `@napi-rs/canvas-<target>` is bundled with the same version as `@napi-rs/canvas`, built for that OS/CPU, with its binary and every file its `package.json` lists (e.g. `icudtl.dat` for Windows);
- that canvas loads from the plugin folder alone and renders a PNG in the runtime that will execute the plugin: on macOS FlexDesigner's own plugin runtime (`FlexDesigner Helper` with `ELECTRON_RUN_AS_NODE=1`), falling back to this Node.js with a warning when FlexDesigner is not installed; set `FLEX_NODE_RUNTIME=<binary>` to choose another. Only the binary matching that runtime is loaded; binaries for other platforms are checked, never loaded.

自检会检查 Node.js 版本、manifest、构建产物，以及 `FLEX_TARGET` 中每个目标平台的 canvas 原生包是否存在、版本一致且文件完整，并在实际运行插件的运行时（macOS 上为 FlexDesigner 自带的运行时）中加载 canvas。其他平台的二进制只检查、不加载。

```bash
FLEX_TARGET=all npm run doctor   # check a build made with FLEX_TARGET=all
node scripts/doctor.cjs --plugin-dir="$HOME/Library/Application Support/FlexDesigner/data/plugins/com.aspen.flexbar-ai-dashboard"   # an installed copy (read-only)
```

## Development

Make sure FlexDesigner is running, then start the plugin in development mode:

```bash
npm run dev
```

This command:

- builds the backend and runs `npm run doctor`
- unlinks the old `com.aspen.flexbar-ai-dashboard` plugin
- links `com.aspen.flexbar-ai-dashboard.plugin`
- starts Rollup in watch mode
- restarts the plugin after each build
- opens FlexCLI debug output

To inspect one local snapshot from the command line:

```bash
npm run prototype:once
npm run prototype:json
```

## Maintenance

Common checks:

```bash
npm run build
npm test
npm run doctor
npm run plugin:validate
```

If `npm` is not available in the current shell, run the underlying commands directly:

```bash
node --test test/*.test.js
node node_modules/rollup/dist/bin/rollup -c
```

Maintenance map:

- Collector changes: update `test/collectors.test.js`.
- Dashboard view model changes: update `test/dashboardViewModel.test.js`.
- Canvas renderer changes: update `test/dashboardRender.test.js`.
- Flexbar config page changes: update `test/keyConfigPages.test.js`.
- Claude hooks / statusLine setup changes: update `test/claudeBridgeInstall.test.js` and `test/oneClickSetup.test.js`.

## Claude Bridge Setup

Clicking **One-click install** on the global config page will:

- check Codex home, auth, and sessions paths
- install Flexbar-managed Claude hooks into `~/.claude/settings.json`
- write a recorder script to `~/.flexbar-ai-dashboard/`
- install a Flexbar-managed statusLine when the user does not already have one

If the user already has a custom statusLine, the plugin does not overwrite it by default. Use the **Advanced** section to overwrite it.

The **Path overrides** section supports optional overrides for `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, and `FLEXBAR_AI_CLAUDE_EVENTS`. Click **Apply path overrides** to save them into the plugin `config.json` through FlexDesigner (`$fd.setConfig`) after backend validation. On plugin startup the backend reads `config.json` from the plugin directory before resolving Codex or Claude paths, so overrides survive restarts even before the settings UI opens. Codex home must exist, each Claude config root must exist with a `projects` subdirectory, and the Claude bridge path must be a file (existing or creatable under an existing parent directory). Leave a field blank to keep auto-detection from the current environment. Each field placeholder shows the resolved default path.

Clicking **Uninstall config** removes only hooks and statusLine entries managed by this plugin. It does not delete original Codex or Claude Code session data.

## Build and Deploy

Build the backend bundle:

```bash
npm run build
```

Key images are rendered with `@napi-rs/canvas`, whose native binary is platform specific, and `npm install` only installs the one for the Node.js running it. The build copies the binaries selected by `FLEX_TARGET` into `backend/node_modules` (default: the build machine). `FLEX_TARGET` takes a comma-separated list of `darwin-arm64`, `darwin-x64`, `win32-x64` (also `win32-arm64`, `linux-x64`, `linux-arm64`, `linux-arm`, `android-arm64`) and the aliases `darwin` (both Mac binaries), `win32` (Windows x64), `all` (macOS arm64 + x64 and Windows x64) and `host`:

```bash
FLEX_TARGET=all npm run build                 # macOS / Linux shells
FLEX_TARGET=darwin-arm64,win32-x64 npm run plugin:pack
```

```powershell
$env:FLEX_TARGET='all'; npm run build         # Windows PowerShell
Remove-Item Env:FLEX_TARGET                   # back to the default
```

Binaries missing from `node_modules` are fetched with `npm pack` at the exact installed `@napi-rs/canvas` version; `package.json` and the lockfile are untouched. A fetched tarball must match the integrity `package-lock.json` records for it, and only such tarballs are cached, in `node_modules/.cache/flexbar-native-canvas` (re-checked on every use). The build fails if a requested binary cannot be bundled or a package is missing a file its `package.json` lists. Pass the same `FLEX_TARGET` to `npm run doctor`, `plugin:pack` and `plugin:install`; they rebuild with it.

Rebuilds leave unchanged binaries untouched. On Windows, FlexDesigner keeps the loaded `.node` file locked while the plugin runs; if a build has to replace it, the build stops with a message to stop the plugin (or quit FlexDesigner) and build again, and the bundled package stays intact.

Pack the `.flexplugin` artifact (builds and runs the doctor first; writes `com.aspen.flexbar-ai-dashboard.flexplugin` next to the plugin folder):

```bash
npm run plugin:pack
```

Install the packed artifact into the running FlexDesigner (runs `plugin:pack` first; look for `Install command successful`):

```bash
npm run plugin:install
```

Recommended release checklist:

```bash
npm test
npm run plugin:validate
FLEX_TARGET=all npm run plugin:pack
```

Artifacts:

- Plugin directory: `com.aspen.flexbar-ai-dashboard.plugin`
- Backend entry: `com.aspen.flexbar-ai-dashboard.plugin/backend/plugin.cjs`
- Packed file: `com.aspen.flexbar-ai-dashboard.flexplugin`

Releases: pushing a `v*` tag runs `.github/workflows/release.yml`, which calls `npm run release:pack` (`scripts/pack-release.cjs`: one `npm run plugin:pack` per asset with the matching `FLEX_TARGET`), checks the assets with `node scripts/pack-release.cjs --verify dist` (each must bundle exactly its native canvas packages with all their files, and no `config.json`), and uploads the assets listed under [From a release](#from-a-release): the universal `com.aspen.flexbar-ai-dashboard.all.flexplugin` (named to sort first, since GitHub lists assets by name and older FlexDesigner versions take the first one) and the platform ones. FlexDesigner looks for `<uuid>.<os>.<arch>.flexplugin` and may pick either darwin asset on any Mac, so both carry the arm64 and x64 binaries.

## Project Structure

```text
src/
  collectors/      Codex / Claude / skills / setup data collection
  dashboard/       view models, rendering, and config event parsing
  prototype/       CLI snapshots and debug formatting

com.aspen.flexbar-ai-dashboard.plugin/
  manifest.json    FlexDesigner plugin manifest
  ui/              global config page and key config pages
  backend/         Rollup build output

scripts/           doctor.cjs preflight, flexcli.cjs FlexCLI wrapper, native-canvas.cjs
                   (FLEX_TARGET binaries), pack-release.cjs (release assets)
test/              Node test runner tests
```

## Notes

- The plugin reads local Codex / Claude Code data only. It does not upload session logs.
- The Codex OAuth token is used locally only for reading plan usage. Tests cover that the token is not exposed.
- The Claude bridge modifies `~/.claude/settings.json`, but entries managed by this plugin are marked with `flexbar-ai-dashboard`, so uninstall removes only those entries.
- On Windows, the Claude bridge recorder uses PowerShell. On macOS / Linux, it uses a Node script.
