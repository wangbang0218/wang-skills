---
name: eolinker-api-doc
description: Extract AI-readable API information from Eolinker API documentation share links, especially eolinker.bwton.cn independent share URLs such as share/project/api/detail with shareCode, apiID, shareID, groupID, or shareToken. Use when a user provides an Eolinker interface documentation URL and wants Codex to retrieve method, path, request parameters, response fields, or a structured API contract for development.
---

# Eolinker API Doc

## Quick Start

Use the bundled script first. Do not rely on browser rendering or re-discover the frontend bundle unless the script fails because the Eolinker deployment changed.

```bash
node <skill-directory>/scripts/fetch_eolinker_api.js '<EOLINKER_SHARE_URL>'
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

1. Run `scripts/fetch_eolinker_api.js` with the user-provided URL.
2. Use the Markdown summary for quick explanation and the normalized JSON for implementation details.
3. If only machine-readable output is needed, pass `--json-only`.
4. If debugging a changed Eolinker response, pass `--raw`; inspect the redacted raw response and update the script if the wire shape changed.

## Supported Links

Support v1 for unauthenticated project share links, including URLs like:

```text
https://eolinker.bwton.cn/independent/#/share/project/api/detail?groupID=...&apiID=...&shareCode=...&shareType=project&shareToken=...&shareID=...
```

The script emulates the Eolinker frontend flow:

1. POST form data to `/index.php/apiManagementPro/Share/getProjectInfo`.
2. Keep the returned cookies and `shareToken`.
3. POST form data to `/index.php/apiManagementPro/Share/getApi` with the same cookie jar.

Use `application/x-www-form-urlencoded`; JSON request bodies return misleading errors on this deployment.

## Failure Hints

- `200303`: the share is unavailable, the request was sent in the wrong shape, or the required share parameters are missing.
- `400402`: the share token/cookie validation failed; rerun the full `getProjectInfo -> getApi` flow with one cookie jar.
- Locked/password-protected shares are out of scope for v1 unless the user provides the password and explicitly asks to extend the skill.

## Output Guidance

Prefer citing the normalized fields in follow-up development work:

- `api.method` and `api.path`
- `request.headers`, `request.query`, `request.pathParams`, `request.body`
- `responses[].code`, `responses[].type`, `responses[].body`

Do not paste raw `shareToken`, `project_shareToken`, `PHPSESSID`, or password-like values back to the user.
