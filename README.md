# wang-skills

个人维护的可复用 [Agent Skills](https://agentskills.io/) 集合，可安装到 Codex、Claude Code、Cursor 等兼容 Agent。

## 安装

需要本机已安装 Node.js 和 `npx`。

安装指定 Skill：

```bash
npx skills add wangbang0218/wang-skills \
  --skill eolinker-api-doc \
  -g
```

`-g` 表示安装到用户级目录，使 Skill 可跨项目使用。安装过程中可以选择目标 Agent；也可以显式指定，例如：

```bash
npx skills add wangbang0218/wang-skills \
  --skill eolinker-api-doc \
  -g \
  -a codex
```

## 可用 Skills

### `eolinker-api-doc`

从 Eolinker API 文档分享链接中提取适合 AI 阅读的接口信息，包括请求方法、路径、请求参数、响应字段和结构化接口契约。

安装后，将 Eolinker 分享链接交给 Agent，并要求其提取或分析接口文档即可。

## 本地开发

列出仓库内可被发现的 Skills：

```bash
npx skills add . --list
```

从当前工作区安装：

```bash
npx skills add . \
  --skill eolinker-api-doc \
  -g
```

每个 Skill 的源码位于 `skills/<skill-name>/`。
