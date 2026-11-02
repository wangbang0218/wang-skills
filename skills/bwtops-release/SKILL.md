---
name: bwtops-release
description: 复用专用浏览器登录态，识别 Git 项目和远端分支，解析 BWTOPS DEV 目标、预检构建配置、提交发布并跟踪结果。用户要求“发布到 BWTOPS 的开发环境”、准备发布或查询本次发布状态时使用。自动提交当前支持 H5-NODEJS 应用的单实例 K8s 构建加发布。
---

# BWTOPS DEV 发布

将 `<skill-directory>` 解析为本文件所在目录，命令使用绝对路径；`--repo` 必须是用户业务项目目录。依赖要求和安装见仓库根 README。用户要求发布即授权对应 DEV 构建发布；唯一候选自动继续，不再询问一次“确认发布”。若只要求调查、预检或编写 Skill，不把它当作新的发布指令；沿用会话中已明确授权的测试范围。

## 工作流程

1. 运行只读完整预检：

   ```bash
   node <skill-directory>/scripts/release.mjs --repo <项目目录>
   ```

2. 认证失效时运行 `node <skill-directory>/scripts/auth.mjs`，请用户在专用浏览器手动登录，保持进程并轮询。成功后重跑预检。默认登录等待 600 秒；`--timeout-seconds` 最多 3600 秒。网络错误、无权限和超时不能当作认证成功。
3. 遇到 `needs_selection`，按下面的表格提出必要的问题。用户明确选择后保留参数重新预检；不能默认取第一个、全选或沿用其他项目的回答。
4. `ready` 后简要告知应用、环境/部署单元、实例、分支、提交和编译器；SCA 摘要若显示 current_branch_not_verified，说明平台仅返回其他分支或未返回扫描结果，不宣称当前代码扫描通过。若用户已授权此次发布，生成一个唯一 `request-id`，用同样参数及返回的 `planHash` 提交：

   ```bash
   node <skill-directory>/scripts/release.mjs --repo <项目目录> <已选择的参数> --execute --plan-hash <planHash> --request-id <唯一ID> --wait 30
   ```

   同一次发布始终使用同一请求 ID。配置变化时重新预检；目标或代码变化且存在新的歧义时再问用户。不能通过反复更新哈希绕过变化检查。
5. 收到 `submitted` 或 `running` 后保存请求 ID，用恢复命令继续直到平台终态：

   ```bash
   node <skill-directory>/scripts/release.mjs --resume <请求ID> --wait 30
   ```

   每次等待最多 45 秒，及时报告阶段变化。会话过期先重新登录再恢复。恢复不执行 POST；不要因等待超时、工具中断或结果不明再发一次发布。
6. `success` 时报告应用/环境/分支、任务标识、产物及构建/发布/启动结果；这不是业务功能回归。`failed` 时报告失败阶段，停止自动重发。`submission_unknown` 或无回执时保留目标锁，只读调查平台记录，不猜测最新记录是自己的任务。具体恢复边界见 [接口与恢复说明](references/release-contract.md)。

## 需要用户选择的节点

| question | 后续参数和处理 |
| --- | --- |
| project / remote / branch | `--repo` / `--remote` / `--branch`；默认业务项目 origin 和当前分支 |
| application | `--app-id`，只能选仓库精确匹配的应用 |
| environment | `--target-key`，展示 DEV 名称、部署单元、ID，不能选 TEST/PROD |
| deployment_type | `--deploy-type`；当前提交仅支持 k8s，server 可只读准备 |
| instances | `--instance-id`；K8s 一次仅一个实例 |
| code_version | 说明本地改动不会进入发布；用户明确选择远端版本后加 `--accept-remote-commit <完整远端哈希>` |
| compiler | `--compiler NODE14/NODE16/NODE18/NODE20/NODE22`；已有合法历史编译器自动复用 |

未提交代码、未推送提交不自动处理；脚本不提交、推送或切换 Git 分支。不从上次构建参数复用分支、产物、操作人和 SCA 数据；这些信息从当前项目与平台重新获取。业务环境需要审批、手工部署或契约不支持时停止并说明，不降级到其他环境或绕过平台校验。

## 登录态和执行边界

- `auth.mjs --check` 无界面验证；`prepare.mjs --repo <目录>` 只解析目标和代码，输出 `prepared`，不等于完整预检的 `ready`。
- 会话与脱敏任务记录保存在本机用户状态目录 `wang-skills/bwtops-release`，不进入仓库。`--state-dir <绝对路径>` 可指定私有目录，登录、预检、提交、恢复必须一致；默认 Chrome，切换到 Chromium 时各步均加 `--browser chromium`。
- 不复制日常 Chrome 会话；不输出 Token、原始用户资料、SCA 明细、请求体或含凭据日志；不导出 HAR。Token 只在内存作为 `X-Token` 使用。
- 不并发使用同一个浏览器 profile；同一应用环境的本机锁在提交前建立，终态后释放。保留结果不明的锁，不能为了继续发布删除它或换状态目录。
- 仅 `/bwton/app/cicd` 可执行一次 POST；其余调用为限定路径 GET。权限由服务器提交时校验，不宣称预检已证明发布权限。
- 当前自动提交支持已核对的 H5-NODEJS + K8s + 单实例 + 无审批 DEV。其他类型/部署方式需要补充真实契约后扩展，不能猜测载荷。
