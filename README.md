# Flexbar AI Dashboard

![Flexbar AI Dashboard screenshot](assets/Flexbar-7C3502BA2010-screenshot-2026-05-14T06-12-46-108Z.jpg)

Flexbar AI Dashboard is a FlexDesigner v1 plugin that shows local Codex activity on Flexbar keys: session status, upcoming scheduled tasks, token usage, plan usage windows, skill shortcuts, and the state of your ChatGPT dots.

It is built for development workflows that use Codex. You can see which sessions are running, which tool Codex just used, recent token consumption, and remaining plan quota without switching back to the terminal or the ChatGPT app.

## Codex Data

- Sessions and current activity: reads from `codex app-server` first, then falls back to JSONL logs under `$CODEX_HOME/sessions`.
- Token usage: parses `token_count` events from Codex session JSONL files.
- Plan usage: reads rate limits from `codex app-server` when available; otherwise uses the OAuth token in `$CODEX_HOME/auth.json` to query the ChatGPT usage endpoint.
- Skill shortcuts: reads `SKILL.md` files from `$CODEX_HOME/skills` and `$CODEX_HOME/plugins/cache`.
- Scheduled tasks: reads the `automations` table that the ChatGPT desktop app keeps in `$CODEX_HOME/sqlite/*.db`, read-only (see [Scheduled tasks](#scheduled-tasks--定时任务)).
- ChatGPT Dots: asks chatgpt.com for your dots' status with read-only GET requests and the `auth.json` token, through the system proxy, and falls back to the ChatGPT app's local cache in `$CODEX_HOME/.codex-global-state.json`; with **Local cache only** on the settings page it reads only that cache (see [ChatGPT Dots](#chatgpt-dots--chatgpt-dots-按键)).

The default `CODEX_HOME` is `~/.codex`. Override it with the `CODEX_HOME` environment variable, or on the settings page (see [Settings Page](#settings-page)).

插件读取本地 Codex 数据；它自己发出的网络请求只有两类：在 `codex app-server` 未提供套餐额度时用 `auth.json` 中的 OAuth 令牌向 ChatGPT 查询用量，以及 ChatGPT Dots 按键的只读状态请求（走系统代理，可在设置页改为只读本地缓存，见 [ChatGPT Dots](#chatgpt-dots--chatgpt-dots-按键)）。读取的数据包括：会话与当前活动（优先读取 `codex app-server`，否则读取 `$CODEX_HOME/sessions` 下的 JSONL 日志）、`token_count` 事件中的令牌用量、套餐额度（`codex app-server`，或用 `$CODEX_HOME/auth.json` 中的 OAuth 令牌查询 ChatGPT 用量接口）、`$CODEX_HOME/skills` 和 `$CODEX_HOME/plugins/cache` 中的技能，ChatGPT 桌面应用在 `$CODEX_HOME/sqlite/*.db` 中保存的定时任务（只读），以及 ChatGPT Dots 的本地缓存 `$CODEX_HOME/.codex-global-state.json`（只读）。`CODEX_HOME` 默认为 `~/.codex`，可通过同名环境变量或设置页覆盖。

## Flexbar Keys

- **AI Session**: shows a recent active Codex session. The key can be configured by session title mode.
  - **Tap to cycle / 点击切换**: each tap moves the key one step: its session → all sessions → scheduled tasks → back to its session. Leaving the session view counts that session as viewed. / 每次点击切换一步：单会话 → 会话总览 → 定时任务 → 返回单会话；离开单会话视图时该会话记为已查看。
  - **All sessions / 会话总览** (first tap): an overview of the Codex sessions — one title per row with a colored dot: **orange** waiting for approval (listed for up to 6 hours), **blue** running (listed until it goes 30 minutes without activity, so a session killed mid tool call drops off), **green** done (finished in the last 30 minutes, or finished while you were away and not yet viewed). Approvals come first, then running, then finished sessions, each newest first; when they do not fit, the key ends with "+N", drawn blue if it hides a running or waiting session. When you tap on to the scheduled tasks, the finished sessions it showed count as viewed; those behind "+N" stay unread. / 第一次点击显示会话总览：每行一个会话标题和一个圆点，**橙色**=等待批准，**蓝色**=进行中，**绿色**=已完成；切换到定时任务时，总览中显示过的已完成会话记为已查看，"+N" 中隐藏的仍为未读。
  - **Scheduled tasks / 定时任务** (second tap): see [Scheduled tasks](#scheduled-tasks--定时任务). A third tap returns to the session. / 第二次点击显示定时任务，第三次点击返回单会话视图。
  - Codex progress per session is read from each thread's rollout file (`$CODEX_HOME/sessions/**`) written in the last 6 hours (at most 16 changed files are read per refresh, newest first; unchanged ones come from a cache), since `codex app-server` reports threads opened in the ChatGPT app as `notLoaded`. Rollouts written recently that `thread/list` left out (such as an old thread resumed today) are listed too.
  - Trade-off: a session counts as running only while it keeps writing. A single tool call that runs silently for more than 30 minutes (or an approval request without the escalation flag) reads as not running until it writes again; that is what keeps a killed session from staying blue. / 取舍：会话需持续写入才算进行中，极少数超过 30 分钟无输出的单次调用会暂时显示为未在运行，以避免已中断的会话一直显示为蓝色。
- **Token Usage**: shows observed local token usage. Supports summary mode and recent chart mode.
- **Plan Usage**: shows remaining Codex plan / rate-limit windows and each window’s next reset date and time in the computer’s local time zone. Missing reset times show “—”; an elapsed reset shows “Reset pending” until fresh usage arrives. / 套餐用量显示各周期剩余额度及下次重置日期和时间（本机时区）；缺失时间显示“—”，到期后等待新数据时显示“等待刷新”。
  - Each bar is labelled by its window's actual length as Codex reports it (e.g. `windowDurationMins` 10080 → **Weekly / 每周**, 300 → **5h / 5小时**), so a plan with only a weekly limit shows "Weekly". When a source does not give the length, the label stays neutral: **Usage / 用量**. The percentage is what remains in that window. / 每个进度条按额度窗口的实际时长命名（如每周、5小时），未知时显示中性的「用量」；百分比为该窗口剩余额度。
- **Reset Timer**: counts down to the next reset of each Codex plan-usage window.
- **New Codex Session**: opens a new thread in the ChatGPT desktop app (see below).
- **AI Skill**: lets you select a Codex skill. Pressing the key pastes `Use the <skill> skill.` into the current input target.
- **ChatGPT Dots**: shows the state of your ChatGPT dots and opens Dots in the ChatGPT app (see [ChatGPT Dots](#chatgpt-dots--chatgpt-dots-按键)).
- **OpenAI icons / OpenAI 图标**: the key library, the keys and their config pages carry the OpenAI mark, so Codex / ChatGPT data is recognizable at a glance. In the key library each key is the white mark on a dark tile with a badge: blue list = AI Session, purple # = Token Usage, green bars = Plan Usage, blue clock = Reset Timer, green + = New Codex Session, yellow star = AI Skill, pink dots = ChatGPT Dots. On the keys a small white mark sits left of the header label, in the same top-left spot on the Reset Timer, and left of the session title; on the all-sessions and scheduled-tasks views it leads the first row (or the "no sessions / tasks" message), and on New Codex Session the mark with its green + badge replaces the green circle. Where it would squeeze or touch the content it is left out: Reset Timer rings on a narrow key, a long token total, a session title under about 218px, all-sessions and scheduled-tasks grids that would lose a slot (a 240px key; the default 520px has room). A New Codex Session key under about 137px keeps the green circle, with the small mark left of its header. FlexDesigner draws the AI Skill key from its icon: until a skill is chosen it shows the OpenAI skill icon, also on keys placed with the old star; an icon you picked yourself stays. / 按键库、按键及其配置页都带有 OpenAI 标志，一眼可知显示的是 Codex / ChatGPT 数据。按键库中每个按键是深色底上的白色标志加角标：蓝色列表=AI 会话，紫色 #=令牌用量，绿色柱状=套餐用量，蓝色时钟=重置倒计时，绿色 +=新建 Codex 会话，黄色星形=AI 技能，粉色三点=ChatGPT Dots。按键上的白色小标志位于标题左侧（重置倒计时在同一左上角位置）和会话标题左侧；会话总览和定时任务视图中位于第一行（或「没有会话 / 任务」提示）左侧；新建 Codex 会话用带绿色 + 角标的标志代替原来的绿色圆形。标志会挤占或碰到内容时省略：按键较窄、会碰到重置倒计时圆环时，令牌总数很长时，会话按键窄于约 218 像素时，以及会话总览和定时任务视图会因此少显示条目时（240 像素按键；默认 520 像素有足够空间）。新建 Codex 会话按键窄于约 137 像素时保留绿色圆形，小标志位于标题左侧。AI 技能按键由 FlexDesigner 按其图标绘制：选择技能前显示 OpenAI 技能图标，旧版放置的星形图标也会替换；自行选择的图标保持不变。

The plugin includes English and Chinese UI strings and follows the host language where possible.

### New Codex Session / 新建 Codex 会话

Pressing the key opens `codex://threads/new?mode=<codex|work|chat>[&path=<project folder>][&prompt=<text>]` with the system URL handler (`open` on macOS, PowerShell `Start-Process` on Windows). The `codex://` scheme is registered by the **ChatGPT desktop app** (bundle id `com.openai.codex`), which must be installed; otherwise a "Could not open the ChatGPT app" notification appears.

- **Mode**: Codex, Work or Chat surface of the app.
- **Project folder**: optional absolute path; the list offers recent Codex session folders. Empty means the app's current project. The first time a folder is opened this way, ChatGPT shows its one-time "trust this folder" dialog.
- **Starting prompt**: optional; it is only prefilled in the composer. Nothing is sent until you press send in the app.

按下按键会通过 `codex://threads/new` 深链接在 ChatGPT 桌面应用中新建会话（需已安装 ChatGPT 桌面应用）。项目目录可选，首次使用某个目录时 ChatGPT 会弹出一次信任确认；起始提示词只会预填到输入框，不会自动发送。

### ChatGPT Dots / ChatGPT Dots 按键

The **ChatGPT Dots** key shows the state of your dots in the ChatGPT desktop app and opens Dots when pressed.

- **What it shows**: the state that matters most across your available dots (status `active`; paused ones count too), in this order:
  - **orange Safety pause**: a dot was paused out of precaution;
  - **green Update**: a dot's room has something you have not read (unless that room is muted); `Update ×2` for two such dots;
  - **blue Working**: one of the dot's recent activity entries is in progress (a paused dot may still run delegated tasks, so paused dots are checked too);
  - **gray Paused** (pause bars), **gray Idle**;
  - **gray No dot** (none yet: pressing the key starts the app's setup) or **Not available** (the backend says this account has no Dots).

  With one dot the second line names it (turn off **Show the dot's name** on the key's config page to see its last check-in instead); with several it counts them. Keys narrower than about 137px show only the light and the state.
- **Degraded**: a hollow light means the data is not a fresh answer from chatgpt.com, and the second line says why and how old it is: `Offline · Cache 5m`, `Sign-in expired · Cache 2h`, `Rate limited · 3m ago`, `Blocked` (an answer that is not JSON, such as a Cloudflare challenge). An answer older than 10 minutes is hollow too.
- **Pressing**: opens `codex://dots` with `/usr/bin/open` (PowerShell `Start-Process` on Windows). It must be exactly that: the app ignores the link with a trailing slash or a query. The app shows its window, goes to Dots and opens your primary dot, or its setup when you have none. If the link cannot be opened, `https://chatgpt.com/dots` opens in the browser. Presses within 1.5 s count once; the status is read again 20 s and 90 s later.
- **Network** (status source **Network + cache**, the default):
  - Two read-only `GET` requests and nothing else: `https://chatgpt.com/backend-api/tbo?limit=25&include_room_preview=true` (your dots) and `https://chatgpt.com/backend-api/tbo/<id>/activity?limit=5` (one dot per round, taking turns). A fixed allowlist in `src/collectors/chatgptDots.js` refuses any other method, host or path, and `test/dotsSafety.test.js` checks that the Dots code never names a state-changing call (pause, resume, reboot, messages, read receipts).
  - Signed in with the ChatGPT login in `$CODEX_HOME/auth.json`, the token the app and the CLI share (headers `Authorization` and `ChatGPT-Account-Id`). **The plugin never refreshes the token**: a refresh rotates the refresh token and could sign the app or the CLI out. An expired token (by its `exp`) is not sent at all; the key shows the cache until the app refreshes it.
  - Through the proxy in `HTTPS_PROXY`, else the macOS system proxy (`scutil --proxy`, read at most once a minute), else directly. When the proxy cannot be reached or refuses the tunnel, the request goes direct once; a tunnel the proxy accepted and then dropped is not retried directly. Node's built-in proxy support (`https.Agent` with `proxyEnv`) does the tunnelling.
  - About every 150 s (±10%, up to 300 s with many dots), one round at a time, at most 60 requests an hour. Network errors back off up to 15 minutes, `429` waits for `Retry-After`, a `401` before the token's expiry waits 30 minutes (or until the token changes). Nothing is sent while no Dots key is loaded or every Flexbar is unplugged.
- **Local cache**: `$CODEX_HOME/.codex-global-state.json`, the app's own copy of your primary dot and its recent activity (its `.bak` when the file cannot be parsed). It is used until the first answer arrives, when a request fails and the app's data is newer than the key's last answer (otherwise the key keeps that answer: `Offline · 3m ago`), and in **Local cache only** mode (global settings page), which sends no request at all. The app updates it while it is in the foreground, so it can be old: the key always says `Cache <age>`, where the age is the newest Dots timestamp in the file (when the app picked or refreshed the dot, or the dot last changed), not the file's modification time, which changes with every unrelated setting; `Cache` alone when there is none. The cache holds only the primary dot and no unread information, so it never shows **Update**: in **Local cache only** mode the key cannot tell that a dot has something new.
- **Privacy**: the logs record only the route (`system-proxy`, `env-proxy`, `direct`, `direct-fallback`), HTTP statuses, error categories, the number of dots and the shown state, once per change; never the token, the account id, dot ids, names or message previews. The key's config page shows only the state, its source and its time.
- **Limitations**: the endpoints and the cache file are undocumented and may change with an app update. "Update" is approximate (the room's latest item may be your own message). Approval requests, failed tasks and scheduled runs are not shown yet.

**ChatGPT Dots** 按键显示 ChatGPT 桌面应用中 dot 的状态，按下打开 Dots。按键在所有可用 dot（status 为 active，已暂停的也算）中按优先级显示最需要关注的状态：**橙色**=安全暂停；**绿色**=有新进展（dot 的房间里有未读内容，静音的房间除外，多个 dot 时显示「×n」）；**蓝色**=工作中（dot 最近的 activity 中有进行中的任务；已暂停的 dot 仍可能在运行委派任务，所以也会检查）；**灰色**=已暂停（暂停图形）、空闲、没有 dot（按下进入应用的创建流程）或 Dots 不可用（后端返回该账号没有 Dots）。只有一个 dot 时第二行显示它的名称（可在按键配置页关闭 **Show the dot's name**，改为显示签到时间），有多个时显示数量；窄于约 137 像素的按键只显示状态灯和状态。空心状态灯表示数据不是 chatgpt.com 的最新结果，第二行写明原因和数据时间，如「离线 · 缓存 5分钟」「登录过期 · 缓存 2小时」「限流 · 3分钟前」「网络被拦截」（返回的不是 JSON，例如 Cloudflare 验证页）；超过 10 分钟的结果也显示为空心。

按下时用 `/usr/bin/open` 打开 `codex://dots`（Windows 上用 PowerShell `Start-Process`）。链接必须一字不差，带尾斜杠或参数都会被应用忽略。应用会显示窗口、进入 Dots 并打开 primary dot，没有 dot 时进入创建流程；无法打开时改为在浏览器中打开 `https://chatgpt.com/dots`。1.5 秒内的重复按下只算一次，按下后 20 秒和 90 秒各刷新一次状态。

联网（全局设置页的状态来源为默认的 **Network + cache** 时）：只发两种只读 `GET` 请求：`https://chatgpt.com/backend-api/tbo?limit=25&include_room_preview=true`（dot 列表）和 `https://chatgpt.com/backend-api/tbo/<id>/activity?limit=5`（每轮一个 dot，轮流）。`src/collectors/chatgptDots.js` 中写死的白名单拒绝其他任何方法、主机和路径，`test/dotsSafety.test.js` 检查 Dots 代码中不出现任何会改变状态的调用（暂停、恢复、重启、发消息、标记已读）。请求使用 `$CODEX_HOME/auth.json` 中的 ChatGPT 登录，即应用和 CLI 共用的令牌（请求头为 `Authorization` 和 `ChatGPT-Account-Id`）。**插件绝不刷新令牌**：刷新会轮换 refresh token，可能让应用或 CLI 掉线；令牌按 `exp` 已过期时不发请求，按键改为显示缓存，直到应用刷新令牌。请求优先走 `HTTPS_PROXY` 指定的代理，其次是 macOS 系统代理（`scutil --proxy`，最多每分钟读取一次），都没有时直连；代理连不上或拒绝建立隧道时，该请求直连重试一次；代理已接受隧道、之后才断开的，不改走直连。隧道由 Node 内置的代理支持（`https.Agent` 的 `proxyEnv`）完成。约每 150 秒一轮（±10%，dot 多时最长 300 秒），同一时间只有一轮，每小时最多 60 次请求；网络错误时指数退避，最长 15 分钟；`429` 按 `Retry-After` 等待；令牌未过期却返回 `401` 时等待 30 分钟（或直到令牌变化）。没有 Dots 按键或所有 Flexbar 都断开时不发请求。

本地缓存是 `$CODEX_HOME/.codex-global-state.json`，即应用自己保存的 primary dot 及其最近 activity（文件无法解析时读 `.bak`）。在第一次结果返回前、请求失败且应用的数据比按键上一次的结果更新时（否则按键继续显示上一次的结果，如「离线 · 3分钟前」），以及在全局设置页选择 **Local cache only** 时使用；**Local cache only** 完全不联网。应用只在前台时更新这个文件，数据可能较旧，所以按键始终标注「缓存 <时长>」：时长取文件里最新的 Dots 时间戳（应用选中或刷新 dot 的时间，或 dot 最后变化的时间），而不是文件的修改时间，因为任何无关设置变化都会重写文件；没有时间戳时只标「缓存」。缓存里只有 primary dot，也没有未读信息，所以永远不会显示「有新进展」：**Local cache only** 模式下按键无法发现 dot 的新进展。日志只在变化时记录路由类型（`system-proxy`、`env-proxy`、`direct`、`direct-fallback`）、HTTP 状态码、错误类别、dot 数量和显示的状态，绝不记录令牌、账号 ID、dot ID、名称或消息预览；按键配置页只显示状态、数据来源和时间。限制：这些接口和缓存文件都未公开，应用更新后可能变化；「有新进展」是近似判断（房间里最新的一条可能是你自己发的消息）；暂不显示待审批、失败任务和定时运行。

### Scheduled tasks / 定时任务

The second tap on an **AI Session** key lists the Codex scheduled tasks ("Automations") of the ChatGPT desktop app:

- **Which tasks**: at most 6, soonest first, in two columns of 3 (tasks 1–3 on the left, 4–6 on the right; up to 3 tasks use one full-width column). Running tasks come first, then due ones, then active ones by next run, then active ones without a next run, then paused and other ones, most recently changed first. Deleted or archived tasks are not listed. A key too narrow for two columns (under about 225 px) lists 3 rows; when there are more tasks, the third row is "+N", drawn blue if it hides a running or due task.
- **Each row**: a colored dot, the task name and, on the right, its next run or state:
  - **green** scheduled, with the next run in local 24-hour time: `in 25m` (under an hour), `14:30` (today), `Tmrw 09:00`, `Tue 09:00` (within the next 6 days), `10/12 09:00` (later, month/day). On a narrow key a label that does not fit loses its clock time (`Tmrw`, `Tue`, `10/12`, `25m`) so the task name keeps its room;
  - **blue** running (`Running`: the app's latest run of the task is still in progress, started or updated within the last 2 hours), followed by the next run when the task will run again (`Running · Tmrw 09:00`; with less room `Running · Tmrw`, then `Running`), or due (`Due`: the next run time has passed and the app has not run it yet);
  - **gray** no next run (`No next run`, `—` on a narrow key: the task is active but the app has set no next run, e.g. a one-off task that has run), paused (`Paused`), or another state the app reports, shown as the app names it (in English) and cut to fit.
- **Colors**: green means "scheduled" here but "done" on the all-sessions view one tap earlier; blue means running (or due) on both.
- **Data source**: the `automations` table that the ChatGPT desktop app writes to a SQLite database in `$CODEX_HOME/sqlite/` (the most recently changed `*.db` file with that table; `codex-dev.db` in current builds). It is opened read-only, and only again when the file changes, through Node's built-in `node:sqlite`, which FlexDesigner's plugin runtime (Electron 38, Node 22) includes. Only names, states, schedules and timestamps are read (of the runs, only those started in the last 24 hours), never prompts, project folders or account ids; the logs record only how many tasks there are.
- **Limitations**: the database is the app's own, undocumented local format and may change with an app update. When it cannot be read (or there is no such database, or the runtime lacks `node:sqlite`) the key shows **Scheduled tasks unavailable**; after a failed read it keeps showing the tasks it read last. Right after an AI Session key is added the tasks may not be read yet: the key shows its loading look for a moment and reads them at once. Paused tasks have no next run, so they show `Paused` instead of a time.

第二次点击 **AI 会话** 按键时显示 ChatGPT 桌面应用中的 Codex 定时任务：最多 6 个，最先运行的在前，分两列、每列 3 个（第 1–3 个在左列，第 4–6 个在右列；不超过 3 个时只用一整列）。运行中的排最前，其次是待运行的、按下次运行时间排列的已启用任务、没有下次运行时间的已启用任务，最后是已暂停或其他状态的任务（最近修改的在前）；已删除或已归档的任务不显示。按键太窄、放不下两列时（约 225 像素以下）只显示 3 行，任务更多时第 3 行显示「+N」，其中隐藏了运行中或待运行的任务时为蓝色。每行包括圆点、任务名称和右侧的下次运行时间或状态：**绿色**=已排定（本地 24 小时制：`25分钟后`、`14:30`（今天）、`明天 09:00`、`周二 09:00`（6 天内）、`10/12 09:00`（更晚，月/日）；按键较窄放不下时省略具体时刻，显示 `明天`、`周二`、`10/12`、`25分钟`，把空间留给任务名称）；**蓝色**=运行中（应用最近一次运行仍在进行，且在 2 小时内开始或更新；任务之后还会运行时附上下次运行时间，如 `运行中 · 明天 09:00`，空间不足时依次简化为 `运行中 · 明天`、`运行中`）或待运行（已过运行时间，应用尚未运行）；**灰色**=无下次运行（`无下次运行`，窄按键上为 `—`：任务已启用但应用未设置下次运行时间，例如已运行过的一次性任务）、已暂停或其他状态（其他状态按应用的英文原名显示，放不下时截断）。注意：绿色在这里表示「已排定」，而在前一步的会话总览中表示「已完成」；蓝色在两处都表示进行中（或待运行）。数据来自 ChatGPT 桌面应用写入 `$CODEX_HOME/sqlite/*.db` 的 `automations` 表，通过 FlexDesigner 插件运行时自带的 `node:sqlite` 以只读方式读取，只读取名称、状态、计划和时间（运行记录只读取最近 24 小时内开始的），不读取提示词、项目目录或账号信息，日志中只记录任务数量。该数据库是应用未公开的本地格式，应用更新后可能变化；无法读取时（或没有该数据库、运行时缺少 `node:sqlite`）按键显示 **无法读取定时任务**，读取失败时继续显示上次读取到的任务。刚添加 AI 会话按键时定时任务可能尚未读取，按键会短暂显示加载状态并立即读取。已暂停的任务没有下次运行时间，显示「已暂停」。

## References

This plugin does not fork upstream code. It adapts behavior and data formats from these projects and docs, and copies one asset, the OpenAI mark:

- [ENIAC-Tech/flexdesigner-sdk](https://github.com/ENIAC-Tech/flexdesigner-sdk): FlexDesigner plugin SDK, `plugin.draw`, lifecycle events, and config page communication.
- [openai/codex](https://github.com/openai/codex): Codex CLI local session behavior, app-server behavior, and token event shape.
- [Simple Icons](https://github.com/simple-icons/simple-icons) `icons/openai.svg` as of `simple-icons@15.22.0`: the vector path of the OpenAI mark on the keys, the key-library icons and the config pages (`src/dashboard/openaiLogo.js`). Simple Icons removed the icon in 16.0.0 for want of OpenAI's permission, so no CC0 licence is claimed for it; its use is subject to [OpenAI's brand guidelines](https://openai.com/brand).

"OpenAI" and the OpenAI logo are trademarks of OpenAI, used here only to identify the data source; their use is subject to OpenAI's brand guidelines. This project is not affiliated with or endorsed by OpenAI. / 「OpenAI」及 OpenAI 标志是 OpenAI 的商标，此处仅用于标明数据来源，其使用受 OpenAI 品牌规范约束；本项目与 OpenAI 无关联，也未获其认可。

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
npm run icons    # re-render the 8 OpenAI icons in manifest.json (after changing src/dashboard/openaiLogo.js; see below for the config pages)
```

`npm run icons` (`scripts/generate-icons.cjs --write`) replaces only the `icon` values of `keyLibrary.style` and of each key; every other byte of `manifest.json` stays. Without `--write` (`node scripts/generate-icons.cjs`) it only reports whether the icons are current; `test/openaiLogo.test.js` fails while they are not. The 8 config pages in `ui/*.vue` embed the same logo path and badge colours inline (a page cannot import `src/`), so after changing `src/dashboard/openaiLogo.js` update them by hand too; `test/keyConfigPages.test.js` checks that they match. / `npm run icons` 只替换 `manifest.json` 中插件和各按键的 `icon` 值；不加 `--write` 时只报告图标是否为最新，图标过期时 `test/openaiLogo.test.js` 会失败。`ui/*.vue` 中的 8 个配置页内联了相同的标志路径和角标颜色（配置页无法引用 `src/`），修改 `src/dashboard/openaiLogo.js` 后也需手动更新它们，`test/keyConfigPages.test.js` 会检查是否一致。

If `npm` is not available in the current shell, run the underlying commands directly:

```bash
node --test test/*.test.js
node node_modules/rollup/dist/bin/rollup -c
```

Maintenance map:

- Collector changes: update `test/collectors.test.js`.
- Dashboard view model changes: update `test/dashboardViewModel.test.js`.
- Canvas renderer changes: update `test/dashboardRender.test.js` (also covers where the OpenAI mark is drawn).
- OpenAI mark, key-library icons and `scripts/generate-icons.cjs`: `test/openaiLogo.test.js`; the AI Skill key's default icon: `test/skillKey.test.js`.
- AI Session tap cycle and session overview: `test/sessionOverview.test.js` (runs `src/plugin.js` against a fake FlexDesigner host).
- Scheduled tasks: `test/codexAutomations.test.js` (collector) and `test/automationOverview.test.js` (view model, next-run labels, renderer, snapshot). The tests that build a SQLite database need `node:sqlite` (Node.js 22.13+, or 22.5+ with `--experimental-sqlite`); on older versions they are skipped.
- ChatGPT Dots: `test/dotsView.test.js` (states and their priority), `test/dotsRender.test.js`, `test/chatgptDots.test.js` (allowlist, headers, error categories), `test/dotsPoller.test.js` (schedule, budget, backoff), `test/dotsLocalCache.test.js`, `test/dotsAuth.test.js`, `test/systemProxy.test.js`, `test/httpsGetJson.test.js`, `test/dotsAction.test.js`, `test/dotsKey.test.js`, `test/dotsKeyIntegration.test.js` (runs `src/plugin.js` against a fake FlexDesigner host) and `test/dotsSafety.test.js` (read-only guards).
- Flexbar config page changes: update `test/keyConfigPages.test.js`.
- Settings page, Codex status and path override changes: update `test/globalConfigPage.test.js`, `test/setupStatus.test.js` and `test/pathOverrides.test.js`.

## Privacy / 隐私

Nothing pushed to this repository may contain tokens, API keys, OAuth credentials, personal emails, local usernames or personal paths, device serial numbers, or real session data; commits use the GitHub noreply email. The full rules are in [CLAUDE.md](CLAUDE.md#privacy-rules--隐私规则).

推送到本仓库的内容不得包含 Token、API Key、OAuth 凭据、个人邮箱、本机用户名或个人路径、设备序列号或真实会话数据；提交使用 GitHub noreply 邮箱。完整规则见 [CLAUDE.md](CLAUDE.md#privacy-rules--隐私规则)。

```bash
npm run hooks:install   # once per clone: the pre-push hook blocks pushes with findings
npm run check:privacy   # tracked files + unpushed commits; also --staged, --tracked, --range <revs>
```

`scripts/check-privacy.cjs` also reads a local denylist of your own identifiers from `.git/info/privacy-denylist` (one literal per line; it lives inside `.git`, so it is never committed, and its terms are never printed). CI runs the same scan on every push and pull request (`.github/workflows/privacy.yml`). Checked false positives go into `.privacy-allowlist` with a justification, or get a `privacy-allow` comment on the line.

## Settings Page

The plugin's global config page lists the local Codex data the keys rely on: the Codex home, its `auth.json` (used for plan usage and the Dots status) and its `sessions` directory. **Refresh** checks them again. The plugin installs nothing and never writes to Codex data; reading the scheduled tasks may leave SQLite's usual `-shm` / `-wal` sidecar files next to the ChatGPT app's database.

The **Path overrides** section supports an optional override for `CODEX_HOME`. Click **Apply path overrides** to save it into the plugin `config.json` through FlexDesigner (`$fd.setConfig`) after backend validation. On plugin startup the backend reads `config.json` from the plugin directory before resolving Codex paths, so the override survives restarts even before the settings UI opens. The Codex home must be an existing directory. Leave the field blank to keep auto-detection from the current environment; its placeholder shows the resolved default path.

**ChatGPT Dots status** picks where the ChatGPT Dots key reads its status, for the whole plugin: **Network + cache** (the default: read-only requests to chatgpt.com, see [ChatGPT Dots](#chatgpt-dots--chatgpt-dots-按键)) or **Local cache only** (no network; only the ChatGPT app's local cache, which cannot show **Update**). The choice is saved as soon as you pick it.

设置页列出按键依赖的本地 Codex 数据：Codex 主目录、其中的 `auth.json`（用于套餐用量和 Dots 状态）和 `sessions` 目录，**Refresh** 会重新检查。插件不安装任何内容，也不写入 Codex 数据；读取定时任务时，SQLite 可能会在 ChatGPT 应用的数据库旁留下常见的 `-shm` / `-wal` 辅助文件。**Path overrides** 中可选择覆盖 `CODEX_HOME`：点击 **Apply path overrides**，经后端校验后通过 FlexDesigner 保存到插件目录的 `config.json`，重启后依然生效。该路径必须是已存在的目录；留空则按当前环境自动检测，输入框的占位符显示检测到的默认路径。**ChatGPT Dots status** 设置 ChatGPT Dots 按键的状态来源，对整个插件生效：**Network + cache**（默认，向 chatgpt.com 发只读请求，见 [ChatGPT Dots](#chatgpt-dots--chatgpt-dots-按键)）或 **Local cache only**（不联网，只读 ChatGPT 应用的本地缓存，无法显示「有新进展」）。选择后立即保存。

### Upgrading from a version with Claude Code support / 从支持 Claude Code 的旧版本升级

Earlier versions could also show Claude Code and installed a bridge for it with **One-click install**. This version neither reads nor manages that bridge, and the settings it saved for it (Claude path overrides, the statusLine option) are ignored when the config loads. If you installed the bridge, remove what it left behind by hand; nothing else uses it. Until you do, Claude Code keeps running the old recorder on every hook event and status line refresh, and `claude-events.jsonl` keeps growing:

- In `~/.claude/settings.json`, delete every hook handler under `hooks` whose `command` or `args` contains `flexbar-ai-dashboard` (and a hook group or event that has no handler left), and delete `statusLine` if its `command` contains `flexbar-ai-dashboard`. Keep every other entry.
- Delete the folder `~/.flexbar-ai-dashboard` (the recorder script and `claude-events.jsonl`). If you had set a custom bridge events file, delete that file too.

On Windows these paths are under `%USERPROFILE%`.

**AI Skill** keys that used Claude Code keep the skill name they had. Their config page marks it as not found in your Codex skills; pick a Codex skill for them again.

旧版本还能显示 Claude Code，并可通过 **One-click install** 为其安装桥接。本版本既不读取也不管理该桥接，旧版本为它保存的设置（Claude 路径覆盖、statusLine 选项）在加载配置时会被忽略。如果曾安装过桥接，请手动清理残留，其他功能都不会用到它们。清理之前，Claude Code 会在每次 hook 事件和状态栏刷新时继续运行旧的记录脚本，`claude-events.jsonl` 会持续变大：

- 在 `~/.claude/settings.json` 中，删除 `hooks` 下 `command` 或 `args` 含有 `flexbar-ai-dashboard` 的每个 hook 处理器（以及因此不再有处理器的 hook 分组或事件）；若 `statusLine` 的 `command` 含有 `flexbar-ai-dashboard`，也删除 `statusLine`。其他条目保持不变。
- 删除文件夹 `~/.flexbar-ai-dashboard`（记录脚本和 `claude-events.jsonl`）。若曾自定义桥接事件文件路径，也一并删除该文件。

Windows 上这些路径位于 `%USERPROFILE%` 下。

曾使用 Claude Code 的 **AI Skill** 按键会保留原来的技能名，其配置页会标注该技能不在 Codex 技能列表中；请为这些按键重新选择一个 Codex 技能。

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
  collectors/      Codex sessions, usage, skills, scheduled tasks (ChatGPT app
                   SQLite, read-only), ChatGPT Dots status (read-only requests,
                   app cache, poller) and settings-page status
  dashboard/       view models, rendering, OpenAI mark and icons, AI Session tap
                   cycle, ChatGPT Dots key, and config event parsing
  net/             proxy route (HTTPS_PROXY, macOS system proxy) and the one
                   HTTPS GET helper used by the Dots status
  prototype/       CLI snapshots and debug formatting

com.aspen.flexbar-ai-dashboard.plugin/
  manifest.json    FlexDesigner plugin manifest
  ui/              global config page and key config pages
  backend/         Rollup build output

scripts/           doctor.cjs preflight, flexcli.cjs FlexCLI wrapper, native-canvas.cjs
                   (FLEX_TARGET binaries), pack-release.cjs (release assets),
                   generate-icons.cjs (key-library icons)
test/              Node test runner tests
```

## Notes

- The plugin reads local Codex data and does not upload session logs. The network requests it sends itself are the plan-usage query to ChatGPT with the `auth.json` token, when `codex app-server` does not report the rate limits (see [Codex Data](#codex-data)), and, while a ChatGPT Dots key is loaded, the read-only Dots status requests (see [ChatGPT Dots](#chatgpt-dots--chatgpt-dots-按键)); **Local cache only** on the settings page turns the latter off.
- The ChatGPT app's scheduled-task database is only ever opened read-only.
- The Codex OAuth token is used locally only for reading plan usage and the Dots status, and is never refreshed by the plugin. Tests cover that the token is not exposed.
