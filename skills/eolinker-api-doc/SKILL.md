---
name: eolinker-api-doc
description: 从免登录、无密码的 Eolinker 项目分享链接提取接口文档，适用于 eolinker.bwton.cn 的 independent 分享页。用户提供接口详情链接，或提供项目接口列表链接和准确的接口路径，并需要查询请求方法、路径、请求参数、响应字段或生成结构化接口说明时使用。
---

# Eolinker 接口文档提取

## 运行前检查

先运行 `node --version`，推荐使用 Node.js 20 或更高版本。如果找不到 `node`，说明当前环境缺少运行时，请用户安装或启用 Node.js 后再继续。复制 Skill 文件不会安装 Node.js，通过 `npx skills add` 安装也需要事先准备好 Node.js 和 `npx`。

脚本仅使用 Node.js 内置模块，无需运行 `npm install` 或 `npm ci`，也无需安装浏览器、Playwright、Python 或 uv。确认当前环境能访问分享链接；如果目标站点仅限内网访问，先连接公司网络或 VPN。

## 提取接口

优先运行随附脚本。将以下命令中的 `<skill-directory>` 替换为本文件所在目录。分享令牌可能包含 `$`，在 Shell 中用单引号包住完整链接。

**接口详情链接**含有 `apiID`，直接运行：

```bash
node "<skill-directory>/scripts/fetch_eolinker_api.js" '<EOLINKER_SHARE_URL>'
```

**项目接口列表链接**缺少 `apiID`，用 `--api-path` 指定文档中的完整接口路径：

```bash
node "<skill-directory>/scripts/fetch_eolinker_api.js" \
  --api-path '/digit/mdr/collection/v1/create' \
  '<EOLINKER_PROJECT_SHARE_URL>'
```

如果同一路径对应多个请求方法，在命令中加上 `--method`：

```bash
node "<skill-directory>/scripts/fetch_eolinker_api.js" \
  --api-path '/digit/mdr/collection/v1/create' \
  --method POST \
  '<EOLINKER_PROJECT_SHARE_URL>'
```

匹配时仅去除 `--api-path` 首尾的空白，再与文档中的 `apiURI` 完整比较。保留斜杠和查询字符串。前缀匹配和模糊搜索结果不能作为命中项。如果路径和方法都相同的候选项仍有多个，列出候选项，请用户提供含目标 `apiID` 的详情链接。

## 使用结果

默认输出包含 Markdown 摘要和规范化 JSON。用摘要查看请求方法、路径、请求参数和响应字段，开发时从 JSON 中读取具体定义。脚本会展开 Eolinker 数据结构引用，列出字段名、类型、是否必填和说明，同时对令牌和 Cookie 值脱敏。只需 JSON 时，加上 `--json-only`。

- 接口定义：`api.method`、`api.path`。
- 接口来源：`source.apiID`、`source.groupID`。按路径查询时还会返回 `source.detailUrl`。
- 请求参数：`request.headers`、`request.query`、`request.pathParams`、`request.body`。
- 响应定义：`responses[].code`、`responses[].type`、`responses[].body`。

按路径查询生成的详情链接省略了 `shareToken`。再次运行脚本时，会通过 `getProjectInfo` 获取新的分享会话。回复用户时不要粘贴原始 `shareToken`、`project_shareToken`、`PHPSESSID` 或密码类字段的值。

## 分享链接与请求流程

当前版本支持免登录、无密码的项目分享链接。详情页和列表页的链接示例如下：

```text
https://eolinker.bwton.cn/independent/#/share/project/api/detail?groupID=...&apiID=...&shareCode=...&shareType=project&shareToken=...&shareID=...
https://eolinker.bwton.cn/independent/#/share/project/api/?groupID=...&shareCode=...&shareType=project&shareToken=...&shareID=...
```

脚本按 Eolinker 前端的顺序请求接口。以下接口均使用 `application/x-www-form-urlencoded` 表单提交，改发 JSON 可能得到误导性的错误信息。

1. 向 `/index.php/apiManagementPro/Share/getProjectInfo` 发送 POST 请求，保存返回的 Cookie 和 `shareToken`。
2. 使用 `--api-path` 时，以 `groupID=-1` 分页请求 `/index.php/apiManagementPro/Share/searchApi`，按上述规则确定唯一接口。
3. 沿用同一组 Cookie，将目标接口的 `apiID` 和实际所属的 `groupID` 通过 POST 提交到 `/index.php/apiManagementPro/Share/getApi`，获取接口详情。

## 故障排查

- **错误码 `200303`**：检查分享链接是否仍可访问、分享参数是否齐全，以及请求是否按表单提交。
- **错误码 `400402`**：分享令牌或 Cookie 校验失败。重新执行完整分享流程，确保各步骤沿用同一组 Cookie。
- **找不到准确路径**：核对文档中的 `apiURI`，特别是开头和结尾的斜杠。
- **分享需要密码**：当前版本仅处理无密码分享。只有在用户提供密码并明确要求扩展 Skill 时，才处理密码保护流程。
- **Eolinker 部署发生变化**：加上 `--raw` 查看脱敏后的原始响应。如果确认响应结构有变，再更新脚本。仅在部署变化导致脚本失效时，才检查浏览器页面或前端打包代码。
