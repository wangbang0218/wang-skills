---
name: eolinker-api-doc
description: Find and extract AI-readable API information from unauthenticated Eolinker project share links, especially eolinker.bwton.cn independent links. Use when a user provides either an API detail share URL or an exact API path plus a project API-list share URL and wants the method, path, request parameters, response fields, or a structured API contract for development.
---

# Eolinker API Doc

## Quick Start

Use the bundled script first. Do not rely on browser rendering or re-discover the frontend bundle unless the script fails because the Eolinker deployment changed.

```bash
node <skill-directory>/scripts/fetch_eolinker_api.js '<EOLINKER_SHARE_URL>'
```

For a project API-list share URL without `apiID`, provide the exact documented path:

```bash
node <skill-directory>/scripts/fetch_eolinker_api.js \
  --api-path '/digit/mdr/collection/v1/create' \
  '<EOLINKER_PROJECT_SHARE_URL>'
```

If the same path has multiple request methods, disambiguate it explicitly:

```bash
node <skill-directory>/scripts/fetch_eolinker_api.js \
  --api-path '/digit/mdr/collection/v1/create' \
  --method POST \
  '<EOLINKER_PROJECT_SHARE_URL>'
```

Resolve `<skill-directory>` from this `SKILL.md` file's directory. Do not assume a specific agent or global skills installation path.
Quote the URL with single quotes when running from a shell because Eolinker share tokens may contain `$`.
The script uses only Node.js core modules; do not run `npm install`, and do not require Python or uv to use this skill.

The default output is designed for AI use:

- a concise Markdown summary with method, path, request fields, and response fields
- a normalized JSON block that preserves the interface structure
- sensitive token/cookie values redacted
- Eolinker data-structure references expanded into fields with name, type, required status, and description

## Workflow

1. Run `scripts/fetch_eolinker_api.js` with a detail URL, or add `--api-path` for a project API-list URL.
2. Use the Markdown summary for quick explanation and the normalized JSON for implementation details.
3. If only machine-readable output is needed, pass `--json-only`.
4. If debugging a changed Eolinker response, pass `--raw`; inspect the redacted raw response and update the script if the wire shape changed.

## Supported Links

Support v1 for unlocked, unauthenticated project share links, including detail URLs and project API-list URLs:

```text
https://eolinker.bwton.cn/independent/#/share/project/api/detail?groupID=...&apiID=...&shareCode=...&shareType=project&shareToken=...&shareID=...
https://eolinker.bwton.cn/independent/#/share/project/api/?groupID=...&shareCode=...&shareType=project&shareToken=...&shareID=...
```

The script emulates the Eolinker frontend flow:

1. POST form data to `/index.php/apiManagementPro/Share/getProjectInfo`.
2. Keep the returned cookies and `shareToken`.
3. For `--api-path`, page through `/index.php/apiManagementPro/Share/searchApi` with `groupID=-1`, then require one exact `apiURI` match. Use `--method` only when needed to distinguish methods.
4. POST form data to `/index.php/apiManagementPro/Share/getApi` with the resolved `apiID`, its real `groupID`, and the same cookie jar.

Only trim surrounding whitespace from `--api-path`. Do not treat trailing slashes, query strings, prefixes, or fuzzy search results as exact matches. If more than one exact path and method remains, report the candidates instead of choosing one.

Use `application/x-www-form-urlencoded`; JSON request bodies return misleading errors on this deployment.

## Failure Hints

- `200303`: the share is unavailable, the request was sent in the wrong shape, or the required share parameters are missing.
- `400402`: the share token/cookie validation failed; rerun the full share flow with one cookie jar.
- No exact path match: check the documented `apiURI`, including its leading and trailing slashes.
- Multiple exact matches: add `--method`; if duplicates remain, use a detail URL containing the intended `apiID`.
- Locked/password-protected shares are out of scope for v1 unless the user provides the password and explicitly asks to extend the skill.

## Output Guidance

Prefer citing the normalized fields in follow-up development work:

- `api.method` and `api.path`
- `source.apiID`, `source.groupID`, and path-mode `source.detailUrl`
- `request.headers`, `request.query`, `request.pathParams`, `request.body`
- `responses[].code`, `responses[].type`, `responses[].body`

The path-mode detail URL intentionally omits `shareToken`; the script obtains a fresh share session through `getProjectInfo`. Do not paste raw `shareToken`, `project_shareToken`, `PHPSESSID`, or password-like values back to the user.
