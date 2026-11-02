# wang-skills

个人维护的可复用 [Agent Skills](https://agentskills.io/) 集合，可安装到 Codex、Claude Code、Cursor 等兼容 Agent。

## 安装

需要本机已安装 Node.js 和 `npx`。

安装指定 Skill，例如先安装项目准备 Skill：

```bash
npx skills add wangbang0218/wang-skills \
  --skill prepare-for-kimi \
  -g
```

`-g` 表示安装到用户级目录，使 Skill 可跨项目使用。安装过程中可以选择目标 Agent；也可以显式指定，例如：

```bash
npx skills add wangbang0218/wang-skills \
  --skill prepare-for-kimi \
  -g \
  -a codex
```

## 可用 Skills

### `prepare-for-kimi`

通过一次只问一个问题的深入访谈细化新项目或现有项目，在用户确认后生成并校验 PRD、架构、可选 UI 规范、模块规格与全链路追踪清单，最终交接给 `implement-with-kimi`。

UI 项目使用已安装的 `baoyu-design` 生成和审批 HTML 设计稿；纯后端项目可将 UI 标记为不适用。该 Skill 只应显式调用，且不会自动启动 reviewer 或进入实现阶段。

安装：

```bash
npx skills add wangbang0218/wang-skills \
  --skill prepare-for-kimi \
  -g
```

### `implement-with-kimi`

让 Codex 按通过校验的 `prepare-for-kimi` 文档包，或已有的架构、PRD 和模块规范，执行严格的测试先行开发。状态 v4 在本地绑定 AC→测试路径、测试哈希、Red/Green/验证证据、run delta 与工作区指纹；`bootstrap`、测试门禁、`rehydrate`、`resume` 和 Hook 恢复都不会调用 reviewer。

每个模块 run 仍需手动固定选择 Kimi K3 1M 或本机 Claude Code 默认模型，但强制外审只有一次最终 `audit`。显式使用 Skill 即涵盖固定 reviewer 对合格工作区文本的只读访问和付费 audit/query 调用；到达 `VERIFIED` 后，`audit` 直接执行，不再等待独立预览授权或 `--execute-reviewer`。`review-preview` 仅用于按需查看 reviewer、初始上下文、权限、重试上限与费用提示，不构成执行门槛。`query` 是直接执行的可选咨询，不改变 milestone、未解决 findings 或 `semantic_review`。失败时不会自动切换 reviewer。

初始 audit 包上限为 700K；规范、authority/`AGENTS.md`、全部 run delta 和映射测试是 mandatory，超限直接阻塞。700K 只限制初始包，Claude 后续自主仓库读取没有 Skill 施加的硬 token 上限。每次 audit/query 最多提交两个 prompt；不启用 Claude `--max-budget-usd`，而是用上下文预算、调用上限、可选预览和事后 usage ledger 控费。Claude 原样记录 provider usage/`modelUsage`/`total_cost_usd`，Kimi 未提供的 token 或美元字段保持 `null`。

运行该 Skill 的 Node 命令统一通过 `volta run node`，使用前需安装并配置 Volta 和 Node.js 18+。

Claude reviewer 会优先使用 Volta 管理的 Claude Code；需要指定其他绝对路径时设置 `CLAUDE_BIN`，Node 镜像中的旧 Claude 副本不会被静默使用。只有最终 audit 或显式 query 会产生强制 reviewer 费用；所有其他阶段都是本地确定性操作。

该 Skill 只应显式调用。它没有 secret scanner；使用前请确保敏感信息没有进入仓库。ignored 文件、二进制或不支持的文本、托管状态文件、不可读路径及越界 symlink 不会交给 reviewer。

安装：

```bash
npx skills add wangbang0218/wang-skills \
  --skill implement-with-kimi \
  -g
```

### `eolinker-api-doc`

从 Eolinker API 详情分享链接提取接口信息，或使用精确 API 路径在项目分享列表中定位接口并获取完整契约，包括请求方法、路径、请求参数和响应字段。

安装后，可以直接将详情分享链接交给 Agent；也可以同时提供项目 API 列表分享链接与目标路径，例如 `/digit/mdr/collection/v1/create`。同一路径存在多个请求方法时，再提供 GET、POST 等方法进行消歧。

### `bwtops-release`

通过专用浏览器手动登录并复用本机认证会话，识别 Git 项目与分支、选择 DEV 环境和实例、校验构建配置、提交构建发布并跟踪到平台终态。用户说“发布到 BWTOPS 的开发环境”时，唯一候选自动继续，多候选或代码差异时询问。当前自动提交支持 H5-NODEJS 应用的单实例 K8s、无审批 DEV；其他目标可只读准备。

安装：

```bash
npx skills add wangbang0218/wang-skills --skill bwtops-release -g
```

需要 Node.js 20+ 和桌面 Google Chrome。安装 Skill 后，将 `<skill-directory>` 替换为实际 Skill 目录，准备本地依赖并登录：

```bash
npm ci --prefix <skill-directory>
node <skill-directory>/scripts/auth.mjs
```

脚本等待用户在新浏览器窗口完成登录（默认 10 分钟），验证成功后自动关闭窗口。日常 Chrome 的登录态不会被复制。后续运行 `node <skill-directory>/scripts/auth.mjs --check` 可无界面检查会话；失效时再次运行登录命令。

完整预检（不提交）：

```bash
node <skill-directory>/scripts/release.mjs --repo <业务项目目录>
```

用户授权发布后，Agent 使用预检返回的 `planHash` 和唯一请求 ID 执行 `--execute --plan-hash <哈希> --request-id <ID> --wait 30`；随后用 `--resume <ID> --wait 30` 继续跟踪。遇到多候选时添加选择参数，运行 `--help` 查看选项。`ready` 只表示预检完成，只有 `success` 表示平台构建、发布与启动均成功。

任务回执保存在同一私有状态目录的 `runs/`。网络中断或提交结果不明时不重发，保留锁并恢复只读查询。服务端权限最终在提交时校验；任务冲突检查限于接口返回的近期记录。平台按分支构建，尚不能保证检出期间分支更新时仍使用预检提交。

保留 `prepare.mjs --repo <目录>` 用于仅解析项目、代码和目标，不读取完整构建配置或提交任务。

没有 Chrome 时，可在 Skill 目录执行 `npx playwright install chromium`，并在运行脚本时加 `--browser chromium`。依赖和浏览器均无需全局 npm 安装。

会话默认保存于本机用户状态目录的 `wang-skills/bwtops-release/browser-profile`；可使用 `--state-dir` 指定独立私有目录。该目录含登录凭据，不要放入仓库或共享目录。脚本不会输出 Token，也不会额外保存 Token 文本文件。

## 本地开发

列出仓库内可被发现的 Skills：

```bash
npx skills add . --list
```

从当前工作区安装：

```bash
npx skills add . \
  --skill prepare-for-kimi \
  -g
```

每个 Skill 的源码位于 `skills/<skill-name>/`。
