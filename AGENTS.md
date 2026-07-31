# 仓库约定

## 语言

- 总是使用中文进行回复。

## 项目目标

本仓库是通过 `npx skills` 分发的可移植 Agent Skills 的唯一正式源码。

## 仓库结构

- 将可分发的 Skill 放在 `skills/<skill-name>/` 下。
- 将 `skills/` 下的每个目录视为一个独立、完整的 Skill。
- 将面向用户的安装方法和 Skill 清单统一放在根目录 `README.md` 中。
- 不要在 Skill 目录中额外添加 README、变更日志或安装说明。

## Skill 编写规范

- 将 `skills/<skill-name>/` 视为唯一可信源码。`~/.agents/skills/`、`~/.codex/skills/` 等目录是派生的安装副本，不要绕过仓库源码直接修改它们。
- 每个 Skill 必须包含 `SKILL.md`，其 frontmatter 必须包含 `name` 和 `description`。
- Skill 目录名必须与 `name` 一致，并且只使用小写字母、数字和连字符。
- 在 `description` 中同时描述 Skill 的能力和触发场景。
- 保持 `SKILL.md` 简洁并以操作流程为主。将详细资料放入 `references/`，确定性工具放入 `scripts/`，输出资源放入 `assets/`。
- 只添加当前 Skill 实际需要的资源目录。
- 保持路径可移植。相对于 Skill 目录解析配套文件；不要硬编码个人主目录或某个 Agent 专属的安装路径。
- 存在 `agents/openai.yaml` 时，确保其内容与 `SKILL.md` 保持一致。
- 保留脚本文件的可执行权限。

## 文档

- 新增、重命名或移除可分发 Skill 时，同步更新根目录 `README.md`。
- 保持安装示例兼容以下格式：

  ```bash
  npx skills add wangbang0218/wang-skills --skill <skill-name> -g
  ```

## 验证

完成 Skill 修改前：

1. 检查仓库内的 Skill 能否被发现：

   ```bash
   npx skills add . --list
   ```

2. 对每个修改过的脚本运行对应的静态检查。当前 Eolinker 脚本使用：

   ```bash
   node --check skills/eolinker-api-doc/scripts/fetch_eolinker_api.js
   ```

3. 使用可用的 Agent Skills 校验器检查每个修改过的 Skill。
4. 运行：

   ```bash
   git diff --check
   ```

CLI 发现测试和静态检查不能证明真实 API 行为正确。修改涉及提取逻辑、网络请求、解析或输出结构时，运行具有代表性的端到端检查；未执行时必须明确说明。

## 修改边界

- 保留工作区中与当前任务无关的用户修改。
- 将改动严格限制在用户要求的 Skill 和文档范围内。
- 除非用户明确要求，否则不要执行全局安装、提交或推送。
