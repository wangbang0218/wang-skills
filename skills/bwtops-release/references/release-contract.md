# 接口、状态和恢复

核对来源：2026-11-02 的真实 DEV 发布请求和当前平台前端表单。字段是已观察契约，不表示平台所有应用类型均兼容。出现 `unsupported_*` 或未知响应时停止，先重新核对平台。

## 调用顺序

| 方法、路径 | 用途 |
| --- | --- |
| GET `/bwton/app/list` | 分页按 Git 仓库定位应用，再以 app_id 读取当前构建参数 |
| GET `/bwton/app/env?app_id=…&optype=getEnv` | 仅选 DEV，保留 target_key、scope_id |
| GET `/bwton/app/instance` | 按目标读取实例；普通分页结果的 targetList/envList 提供 auth_state |
| GET `/bwton/app/applog?app_id=…&log_type=cicdparam` | 只复用本应用合法编译器版本，不整包复用历史参数 |
| GET `/bwton/user/info` | 当前操作人 user_id；响应可能包含 Token，不输出原文 |
| GET `/bwton/oapi/sca?proline_name=…&app_name=…&branch=…` | 请求本次分支的风险数据，服务端可能回退历史扫描；保留原结果，不发起扫描或改写结论 |
| GET `/bwton/app/applog?app_id=…&env_id=…&log_type=all&limit_size=200` | 检查近期进行中任务，并关联发布回执 |
| POST `/bwton/app/cicd` | 唯一写操作；固定 cicdType=cicd、exeMode=order、need_buildid=1 |
| GET `/bwton/app/applog/jenkins?applog_id=…&cursor=0` | 查询关联的构建状态 |
| GET `/bwton/logs/info?logs_id=…&option=runtime&index=0` | 查询对应发布和启动结果，不输出原始日志 |

请求仅发送 X-Token，不复制 Cookie，不跟随重定向。HTTP 200 仍需校验业务 code；1001/1002 表示需要登录。

## 构建载荷

分支来自当前 Git/用户选择，提交哈希用 `git ls-remote` 实时读取。应用字段从当前详情读取，实例完整对象从当前目标查询取得，操作人从当前用户接口取得；这些原始对象只存在于内存。packageId 留空，等待本次新构建产物，curInstList 中的历史 package_id 仅保留平台实例字段。请求采用正常“构建+发布”流程，保留页面使用的 passPackage=true/optype=publish，不复用旧 build_id/batch/release_id。

SCA 接口现场即使传入当前分支，也返回另一个分支的历史扫描结果。脚本与页面一样向服务端提交当前查询到的风险列表，不伪造通过、不清空风险或使用旧 cicdparam 中的列表。预检摘要展示 requestedBranch、returnedBranches 和 coverage；分支相同也不代表扫描覆盖当前提交。不把发布成功解释成安全扫描通过。

预检哈希覆盖组装后的请求和公开摘要；执行时重新查询并比较。提交前再次核对 Git 状态。平台实际按分支检出，接口未验证支持绑定 commit SHA，因此仍存在提交前检查与 Jenkins 检出之间分支更新的窗口。expectedRemoteCommit 是期望值，不是假称实际产物已验证的完整哈希。

环境 `manual_deploy_enabled` 为真时页面仅允许构建，脚本阻塞构建加发布；auth_state 必须明确为 N。没有证据表明存在独立完整发布权限预检接口，提交时由平台裁决。

## 防重复和结果判定

- 本机私有 `runs/<request-id>.json` 先记提交意图，再发 POST，然后保存回执。记录仅含脱敏摘要、哈希、回执和结果，不保存请求体/Token。
- 相同请求 ID 永不再次提交；同一应用环境由独占文件锁保护。超时、异常、5xx、业务异常或缺失回执均不自动重发。网络错误不能证明请求未被服务器接受。
- 近期记录的数量受服务端限制（现场返回 100 条）；这是有限的冲突检查，不是全量审计。独占锁只覆盖同一状态目录，不能阻止其他用户、电脑或网页并发发布；当前未验证服务端幂等键。
- 只使用 app_id/env_id/build_id/batch 共同匹配记录，并检查日志 ID；禁止选“最新一条”。Jenkins success 且 finished 后，仍需发布记录 success、runtime success、publish_status success、startup_status normal 才报成功。
- 未知状态继续只读查询；构建失败、取消、超时或发布/启动失败报告失败。轮询时间到达只退出本地等待，不取消任务。

## 恢复

有回执时 `--resume <请求ID>` 自动从原任务继续。认证过期先登录，再沿用同一 state-dir 恢复。

没有回执时，恢复命令返回原摘要和结果不明状态。通过平台只读记录核对应用、环境、分支、实例、操作人和时间范围；仅靠时间或最新记录不足以绑定任务。当前未实现自动认领无回执任务或解除未知锁的命令；保留锁并向用户报告，需要人工核实原任务后处理。不要自动删除锁、改请求 ID 重试或重发 POST。

退出码：0 表示 ready/submitted/running/success；2 表示选择或登录；1 表示阻塞、失败或结果不明。退出码 0 不等于发布成功，应检查 JSON status。
