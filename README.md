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

UI 项目使用已安装的 `baoyu-design` 生成和审批 HTML 设计稿；纯后端项目可将 UI 标记为不适用。该 Skill 只应显式调用，且不会自动启动 Kimi 或进入实现阶段。

安装：

```bash
npx skills add wangbang0218/wang-skills \
  --skill prepare-for-kimi \
  -g
```

### `implement-with-kimi`

让 Codex 按通过校验的 `prepare-for-kimi` 文档包，或已有的架构、PRD 和模块规范，执行严格的测试先行开发，并把 Kimi K3 1M 用作首选的只读超长上下文审查器。经每个运行显式授权后，可在 Kimi 登录、额度、订阅或服务可用性失败时调用本机 Claude Code 的默认供应商、模型和认证作为 fallback；不绑定 DeepSeek、Qwen 或具体模型名。支持纯本地输入校验、Codex 上下文压缩后的恢复、模块状态审计、最终完成门禁，以及可选的项目级 Codex Hook。

该 Skill 只应显式调用。它会把仓库内容交给当前获授权的 reviewer，使用前请确保敏感信息没有进入仓库。

安装：

```bash
npx skills add wangbang0218/wang-skills \
  --skill implement-with-kimi \
  -g
```

### `eolinker-api-doc`

从 Eolinker API 详情分享链接提取接口信息，或使用精确 API 路径在项目分享列表中定位接口并获取完整契约，包括请求方法、路径、请求参数和响应字段。

安装后，可以直接将详情分享链接交给 Agent；也可以同时提供项目 API 列表分享链接与目标路径，例如 `/digit/mdr/collection/v1/create`。同一路径存在多个请求方法时，再提供 GET、POST 等方法进行消歧。

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
