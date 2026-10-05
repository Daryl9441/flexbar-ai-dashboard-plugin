# Project instructions for AI agents

FlexDesigner plugin that shows Codex and Claude Code activity on Flexbar keys. README.md covers features, setup and
release packaging.

## Commands

- `npm run build`: bundle the backend with Rollup.
- `node --test test/*.test.js` (`npm test`): unit tests.
- `npm run doctor`: preflight for building, packing and installing locally.
- `npm run check:privacy`: privacy scan of tracked files and unpushed commits (see below).

## Privacy rules / 隐私规则

Nothing pushed to GitHub may contain private information. This includes, but is not limited to:

- tokens, API keys, OAuth credentials and their files (e.g. the contents of `~/.codex/auth.json`, Claude credentials),
  private keys, `Authorization: Bearer` values;
- personal email addresses: commits must be authored and committed with the GitHub noreply address
  (`<id>+<login>@users.noreply.github.com`), check with `git config user.email`;
- local usernames and personal absolute paths (`/Users/<name>/...`, `/home/<name>/...`, `C:\Users\<name>\...`);
- device serial numbers (Flexbar or others);
- real session titles, prompts, logs or screenshots from the user's machine.

Use placeholders instead: `/Users/me`, `C:\Users\me`, `001100AA0001` (Flexbar serial), `example.com` addresses, made-up
session titles. In tests, assemble fake secrets at runtime (e.g. `"gh" + "p_" + "A".repeat(36)`) so the source never
contains a match.

Before every commit and push run `npm run check:privacy`, and keep the pre-push hook installed (`npm run hooks:install`,
which sets `core.hooksPath` to `.githooks`); the hook blocks any push with findings. CI (`.github/workflows/privacy.yml`)
runs the same scan on every push and pull request. A checked false positive gets `privacy-allow` on its line or a
justified entry in `.privacy-allowlist`; never allowlist a real identifier. Personal identifiers the patterns cannot
know go into the local denylist `.git/info/privacy-denylist` (one literal per line, never committed or printed).

If private data ever reaches GitHub: rewrite the history (`git filter-repo`, or an interactive rebase for recent
commits), then `git push --force-with-lease`; rotate any leaked credential. GitHub may keep unreachable commits (and
forks / cached pull request refs) until garbage collection, so ask GitHub Support to purge them when it matters.

推送到 GitHub 的任何内容都不得包含隐私信息，包括但不限于：

- Token、API Key、OAuth 凭据及其文件（如 `~/.codex/auth.json` 的内容、Claude 凭据）、私钥、`Authorization: Bearer` 的值；
- 个人邮箱：提交的作者和提交者邮箱必须是 GitHub noreply 地址（`<id>+<login>@users.noreply.github.com`），可用
  `git config user.email` 确认；
- 本机用户名和个人绝对路径（`/Users/<name>/...`、`/home/<name>/...`、`C:\Users\<name>\...`）；
- 设备序列号（Flexbar 或其他设备）；
- 用户本机的真实会话标题、提示词、日志或截图。

请改用占位符：`/Users/me`、`C:\Users\me`、`001100AA0001`（Flexbar 序列号）、`example.com` 邮箱、虚构的会话标题。测试中的假密钥在运行时拼接
（如 `"gh" + "p_" + "A".repeat(36)`），源码本身不出现匹配项。

每次提交和推送前运行 `npm run check:privacy`，并保持 pre-push 钩子已安装（`npm run hooks:install`，即把 `core.hooksPath` 设为
`.githooks`），有发现时钩子会阻止推送；CI（`.github/workflows/privacy.yml`）对每次推送和 PR 运行同样的检查。确认是误报时，在该行加
`privacy-allow` 注释，或在 `.privacy-allowlist` 中添加带理由的条目；不得把真实身份信息加入白名单。规则无法识别的个人标识写入本地黑名单
`.git/info/privacy-denylist`（每行一个字面量，不提交、不输出）。

如果隐私数据已经推送到 GitHub：用 `git filter-repo`（近期提交也可用交互式 rebase）重写历史，再 `git push --force-with-lease`，并吊销泄露的凭据。
GitHub 可能在垃圾回收前保留不可达的提交（以及 fork 和 PR 缓存引用），必要时联系 GitHub Support 清除。
