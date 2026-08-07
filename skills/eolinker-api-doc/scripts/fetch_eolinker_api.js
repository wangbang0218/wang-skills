#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const { URL, URLSearchParams } = require("node:url");

const SUCCESS_CODE = "000000";
const SEARCH_PAGE_SIZE = 50;
const MAX_SEARCH_PAGES = 1000;
const CANDIDATE_DISPLAY_LIMIT = 10;

const METHODS = ["POST", "GET", "PUT", "DELETE", "HEAD", "OPTIONS", "PATCH"];
const PROTOCOLS = ["HTTP", "HTTPS", "WS", "WSS", "TCP", "UDP", "RPC"];
const API_STATUSES = ["已发布", "维护", "废弃", "待定", "开发", "测试", "对接", "异常", "设计", "已完成"];
const REQUEST_BODY_TYPES = ["Form-data", "Raw", "JSON", "XML", "Binary"];
const RESPONSE_BODY_TYPES = ["JSON", "XML", "Raw", "Binary"];
const JSON_OUTER_TYPES = ["Object", "Array"];
const PARAM_TYPES = {
  "0": "string",
  "1": "file",
  "2": "json",
  "3": "int",
  "4": "float",
  "5": "double",
  "6": "date",
  "7": "datetime",
  "8": "boolean",
  "9": "byte",
  "10": "short",
  "11": "long",
  "12": "array",
  "13": "object",
  "14": "number",
  "15": "null",
  "16": "xml",
  "17": "enum",
  "18": "message",
  char: "char",
};

const SENSITIVE_KEY_PARTS = ["token", "cookie", "session", "password", "secret"];

class EolinkerError extends Error {
  constructor(message) {
    super(message);
    this.name = "EolinkerError";
  }
}

class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  store(setCookieHeaders) {
    const headers = Array.isArray(setCookieHeaders)
      ? setCookieHeaders
      : setCookieHeaders
        ? [setCookieHeaders]
        : [];
    for (const header of headers) {
      const pair = String(header).split(";", 1)[0];
      const index = pair.indexOf("=");
      if (index <= 0) continue;
      this.cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
    }
  }

  header() {
    return Array.from(this.cookies.entries())
      .map(([key, value]) => `${key}=${value}`)
      .join("; ");
  }
}

function usage() {
  return `usage: fetch_eolinker_api.js [--json-only | --markdown-only] [--raw] [--api-path API_PATH [--method METHOD]] [--output OUTPUT] url

Fetch AI-readable API information from an Eolinker share URL.

positional arguments:
  url              Eolinker share URL. Quote it to protect '$' characters in shareToken.

options:
  -h, --help       Show this help message and exit.
  --json-only      Print only normalized JSON.
  --markdown-only  Print only the Markdown summary.
  --raw            Include redacted raw Eolinker responses in the JSON.
  --api-path PATH  Find an exact API path from a project share list URL.
  --method METHOD  Disambiguate an API path by HTTP method.
  --output OUTPUT  Write output to this file instead of stdout.
`;
}

function parseArgs(argv) {
  const args = {
    jsonOnly: false,
    markdownOnly: false,
    raw: false,
    apiPath: null,
    method: null,
    output: null,
    url: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") {
      process.stdout.write(usage());
      process.exit(0);
    }
    if (arg === "--json-only") {
      args.jsonOnly = true;
      continue;
    }
    if (arg === "--markdown-only") {
      args.markdownOnly = true;
      continue;
    }
    if (arg === "--raw") {
      args.raw = true;
      continue;
    }
    if (arg === "--api-path") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new EolinkerError("--api-path requires a path.");
      args.apiPath = value.trim();
      index += 1;
      continue;
    }
    if (arg === "--method") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new EolinkerError("--method requires an HTTP method.");
      args.method = value.toUpperCase();
      index += 1;
      continue;
    }
    if (arg === "--output") {
      const value = argv[index + 1];
      if (!value) throw new EolinkerError("--output requires a path.");
      args.output = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new EolinkerError(`Unknown option: ${arg}`);
    }
    if (args.url) {
      throw new EolinkerError("Only one URL argument is supported.");
    }
    args.url = arg;
  }

  if (args.jsonOnly && args.markdownOnly) {
    throw new EolinkerError("--json-only and --markdown-only are mutually exclusive.");
  }
  if (args.apiPath === "") {
    throw new EolinkerError("--api-path requires a non-empty path.");
  }
  if (args.method && !args.apiPath) {
    throw new EolinkerError("--method requires --api-path.");
  }
  if (args.method && !METHODS.includes(args.method)) {
    throw new EolinkerError(`Unsupported --method ${args.method}. Expected one of: ${METHODS.join(", ")}.`);
  }
  if (!args.url) {
    throw new EolinkerError("Missing Eolinker share URL.\n\n" + usage().trimEnd());
  }
  return args;
}

function isSensitiveKey(key) {
  const lower = String(key).toLowerCase();
  return SENSITIVE_KEY_PARTS.some((part) => lower.includes(part));
}

function redactData(value) {
  if (Array.isArray(value)) return value.map((item) => redactData(item));
  if (value && typeof value === "object") {
    const redacted = {};
    for (const [key, item] of Object.entries(value)) {
      redacted[key] = isSensitiveKey(key) ? "<redacted>" : redactData(item);
    }
    return redacted;
  }
  return value;
}

function collectUrlParams(rawUrl) {
  const url = new URL(rawUrl);
  const params = new Map();

  function addEntries(searchParams) {
    for (const [key, value] of searchParams.entries()) {
      if (!params.has(key)) params.set(key, []);
      params.get(key).push(value);
    }
  }

  addEntries(url.searchParams);
  if (url.hash) {
    const fragment = url.hash.slice(1);
    const queryIndex = fragment.indexOf("?");
    if (queryIndex >= 0) {
      addEntries(new URLSearchParams(fragment.slice(queryIndex + 1)));
    } else if (fragment.includes("=")) {
      addEntries(new URLSearchParams(fragment));
    }
  }
  return params;
}

function valueAt(params, key, defaultValue = null) {
  const values = params.get(key);
  if (!values || values.length === 0) return defaultValue;
  return values[values.length - 1];
}

function redactSearch(search) {
  const params = new URLSearchParams(search || "");
  const redacted = new URLSearchParams();
  for (const [key, value] of params.entries()) {
    redacted.append(key, isSensitiveKey(key) ? "<redacted>" : value);
  }
  return redacted.toString();
}

function redactUrl(rawUrl) {
  const url = new URL(rawUrl);
  url.search = redactSearch(url.search);
  if (url.hash) {
    const fragment = url.hash.slice(1);
    const queryIndex = fragment.indexOf("?");
    if (queryIndex >= 0) {
      const path = fragment.slice(0, queryIndex);
      url.hash = path + "?" + redactSearch(fragment.slice(queryIndex + 1));
    }
  }
  return url.toString();
}

function parseShareUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch (error) {
    throw new EolinkerError("URL must include scheme and host, for example https://eolinker.bwton.cn/...");
  }

  const params = collectUrlParams(rawUrl);
  const shareCode = valueAt(params, "shareCode");
  const apiID = valueAt(params, "apiID");
  if (!shareCode) {
    throw new EolinkerError("Missing required shareCode in the Eolinker URL.");
  }

  let prefix = "";
  if (url.pathname.includes("/independent/")) {
    prefix = url.pathname.split("/independent/")[0];
  }
  const baseUrl = `${url.protocol}//${url.host}${prefix.replace(/\/$/, "")}`.replace(/\/$/, "");

  return {
    originalUrl: rawUrl,
    redactedUrl: redactUrl(rawUrl),
    baseUrl,
    referer: `${baseUrl}/independent/`,
    shareCode,
    apiID,
    shareID: valueAt(params, "shareID"),
    groupID: valueAt(params, "groupID", "-1") || "-1",
    shareType: valueAt(params, "shareType", "project") || "project",
    projectHashKey: valueAt(params, "projectHashKey"),
    origin: valueAt(params, "origin"),
    fallbackShareToken: valueAt(params, "shareToken"),
  };
}

function buildDetailUrl(parsed, target, shareID) {
  const url = new URL(parsed.referer);
  const params = new URLSearchParams({
    groupID: String(target.groupID),
    apiID: String(target.apiID),
    shareCode: parsed.shareCode,
    shareType: parsed.shareType,
  });
  if (shareID) params.set("shareID", String(shareID));
  if (parsed.origin) params.set("origin", parsed.origin);
  const projectHashKey = target.projectHashKey || parsed.projectHashKey;
  if (projectHashKey) params.set("projectHashKey", projectHashKey);
  url.hash = `/share/project/api/detail?${params}`;
  return url.toString();
}

function requestText(targetUrl, options, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(targetUrl);
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.request(
      url,
      {
        method: options.method,
        headers: options.headers,
        timeout: options.timeout || 30000,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(new EolinkerError(`HTTP ${response.statusCode} while calling ${options.operate}; response body omitted (${Buffer.byteLength(text)} bytes).`));
            return;
          }
          resolve({
            body: text,
            setCookie: response.headers["set-cookie"] || [],
          });
        });
      },
    );

    request.on("timeout", () => {
      request.destroy(new EolinkerError(`Timeout while calling ${options.operate}.`));
    });
    request.on("error", (error) => reject(error));
    request.end(body);
  });
}

async function postForm(cookieJar, parsed, operate, data) {
  const endpoint = `${parsed.baseUrl}/index.php/apiManagementPro/Share/${operate}`;
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(data)) {
    form.append(key, value == null ? "" : String(value));
  }
  const body = form.toString();
  const originUrl = new URL(parsed.baseUrl);
  const cookieHeader = cookieJar.header();
  const headers = {
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    "Content-Length": Buffer.byteLength(body),
    Origin: `${originUrl.protocol}//${originUrl.host}`,
    Referer: parsed.referer,
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36",
    "X-Requested-With": "XMLHttpRequest",
  };
  if (cookieHeader) headers.Cookie = cookieHeader;

  let response;
  try {
    response = await requestText(endpoint, { method: "POST", headers, timeout: 30000, operate }, body);
  } catch (error) {
    if (error instanceof EolinkerError) throw error;
    throw new EolinkerError(`Network error while calling ${operate}: ${error.message}`);
  }
  cookieJar.store(response.setCookie);

  let payload;
  try {
    payload = JSON.parse(response.body);
  } catch (error) {
    throw new EolinkerError(`Non-JSON response from ${operate}; response body omitted (${Buffer.byteLength(response.body)} bytes).`);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new EolinkerError(`Unexpected response from ${operate}: ${typeof payload}`);
  }
  return payload;
}

function requireSuccess(operation, payload) {
  const code = String(payload.statusCode || "");
  if (code === SUCCESS_CODE) return;
  const hints = {
    200303: "Share unavailable, missing parameters, or request body was not form-urlencoded.",
    400402: "Share token/cookie validation failed; rerun the full share flow with one cookie jar.",
  };
  const visible = redactData(payload);
  delete visible.apiInfo;
  throw new EolinkerError(`${operation} failed with statusCode ${code}. ${hints[code] || "Eolinker returned a non-success status."} Response: ${JSON.stringify(visible)}`);
}

function parseItemCount(value) {
  const text = typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
  if (!/^\d+$/.test(text)) {
    throw new EolinkerError(`searchApi returned invalid itemNum: ${JSON.stringify(value)}.`);
  }
  const count = Number(text);
  if (!Number.isInteger(count) || count < 0) {
    throw new EolinkerError(`searchApi returned invalid itemNum: ${JSON.stringify(value)}.`);
  }
  return count;
}

function normalizeSearchCandidate(item, page, index) {
  if (!isPlainObject(item)) {
    throw new EolinkerError(`searchApi page ${page} apiList[${index}] is not an object.`);
  }
  if (item.apiID === undefined || item.apiID === null || String(item.apiID) === "") {
    throw new EolinkerError(`searchApi page ${page} apiList[${index}] is missing apiID.`);
  }
  if (typeof item.apiURI !== "string") {
    throw new EolinkerError(`searchApi page ${page} apiList[${index}] is missing apiURI.`);
  }
  if (item.groupID === undefined || item.groupID === null || String(item.groupID) === "") {
    throw new EolinkerError(`searchApi page ${page} apiList[${index}] is missing groupID.`);
  }
  const methodText = typeof item.apiRequestType === "string" || typeof item.apiRequestType === "number"
    ? String(item.apiRequestType).trim()
    : "";
  if (!/^\d+$/.test(methodText)) {
    throw new EolinkerError(`searchApi page ${page} apiList[${index}] has invalid apiRequestType.`);
  }
  const methodIndex = Number(methodText);
  const method = Number.isInteger(methodIndex) ? METHODS[methodIndex] : null;
  if (!method) throw new EolinkerError(`searchApi page ${page} apiList[${index}] has invalid apiRequestType.`);
  return {
    apiID: String(item.apiID),
    apiName: String(item.apiName || ""),
    apiURI: item.apiURI,
    groupID: String(item.groupID),
    groupName: String(item.groupName || ""),
    method,
    projectHashKey: item.projectHashKey ? String(item.projectHashKey) : null,
  };
}

function candidateListText(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return "";
  const lines = candidates.slice(0, CANDIDATE_DISPLAY_LIMIT).map((candidate) => {
    const name = candidate.apiName.replace(/\s+/g, " ").trim() || "-";
    const group = candidate.groupName.replace(/\s+/g, " ").trim() || "-";
    return `- ${candidate.method} ${candidate.apiURI} | ${name} | apiID=${candidate.apiID} groupID=${candidate.groupID} group=${group}`;
  });
  if (candidates.length > CANDIDATE_DISPLAY_LIMIT) {
    lines.push(`- ... ${candidates.length - CANDIDATE_DISPLAY_LIMIT} more candidate(s)`);
  }
  return `\nCandidates:\n${lines.join("\n")}`;
}

async function searchApiCandidates(cookieJar, parsed, session, apiPath) {
  const candidates = [];
  const rawPages = [];
  const seenPageSignatures = new Set();
  const seenCandidateKeys = new Set();
  let expectedTotal = null;

  for (let page = 1; page <= MAX_SEARCH_PAGES; page += 1) {
    const payload = await postForm(cookieJar, parsed, "searchApi", {
      shareCode: parsed.shareCode,
      shareID: session.shareID,
      groupID: "-1",
      shareToken: session.shareToken,
      shareType: parsed.shareType,
      tips: apiPath,
      keyword: apiPath,
      orderBy: 3,
      asc: 0,
      pageSize: SEARCH_PAGE_SIZE,
      page,
    });
    requireSuccess("searchApi", payload);
    if (!Array.isArray(payload.apiList)) {
      throw new EolinkerError(`searchApi page ${page} did not include an apiList array.`);
    }

    const itemNum = parseItemCount(payload.itemNum);
    if (expectedTotal === null) expectedTotal = itemNum;
    if (itemNum !== expectedTotal) {
      throw new EolinkerError(`searchApi itemNum changed from ${expectedTotal} to ${itemNum} on page ${page}.`);
    }

    const pageCandidates = payload.apiList.map((item, index) => normalizeSearchCandidate(item, page, index));
    const signature = pageCandidates.map((candidate) => `${candidate.apiID}:${candidate.groupID}`).join("|");
    if (pageCandidates.length > 0 && seenPageSignatures.has(signature)) {
      throw new EolinkerError(`searchApi repeated page data on page ${page}; pagination did not advance.`);
    }
    seenPageSignatures.add(signature);
    for (const candidate of pageCandidates) {
      const key = `${candidate.apiID}:${candidate.groupID}`;
      if (seenCandidateKeys.has(key)) {
        throw new EolinkerError(`searchApi repeated apiID ${candidate.apiID} on page ${page}; pagination did not advance.`);
      }
      seenCandidateKeys.add(key);
    }

    if (candidates.length + pageCandidates.length > expectedTotal) {
      throw new EolinkerError(`searchApi returned more entries than itemNum ${expectedTotal}.`);
    }
    candidates.push(...pageCandidates);
    rawPages.push(payload);

    if (candidates.length === expectedTotal) {
      return { candidates, rawPages };
    }
    if (pageCandidates.length === 0) {
      throw new EolinkerError(`searchApi returned an empty page ${page} before all ${expectedTotal} entries were received.`);
    }
  }

  throw new EolinkerError(`searchApi exceeded ${MAX_SEARCH_PAGES} pages before all results were received.`);
}

async function resolveTargetByPath(cookieJar, parsed, session, apiPath, method) {
  const { candidates, rawPages } = await searchApiCandidates(cookieJar, parsed, session, apiPath);
  const exactPathMatches = candidates.filter((candidate) => candidate.apiURI === apiPath);
  if (exactPathMatches.length === 0) {
    throw new EolinkerError(`No exact API match for path "${apiPath}".${candidateListText(candidates)}`);
  }

  let matches = exactPathMatches;
  if (method) {
    matches = exactPathMatches.filter((candidate) => candidate.method === method);
    if (matches.length === 0) {
      throw new EolinkerError(`No API matches path "${apiPath}" and method ${method}.${candidateListText(exactPathMatches)}`);
    }
  } else if (matches.length > 1) {
    throw new EolinkerError(`Multiple APIs match path "${apiPath}". Pass --method to disambiguate.${candidateListText(matches)}`);
  }

  if (matches.length > 1) {
    throw new EolinkerError(`Multiple APIs match path "${apiPath}" and method ${method}.${candidateListText(matches)}`);
  }

  const target = matches[0];
  if (parsed.apiID && String(parsed.apiID) !== target.apiID) {
    throw new EolinkerError(`Resolved apiID ${target.apiID} does not match apiID ${parsed.apiID} from the URL.`);
  }
  return { target, rawPages };
}

function enumLookup(values, index, defaultValue = "") {
  const numeric = Number.parseInt(index, 10);
  if (Number.isInteger(numeric) && numeric >= 0 && numeric < values.length) return values[numeric];
  return defaultValue;
}

function paramTypeLabel(value, dataStructures) {
  const key = String(value == null ? "0" : value);
  if (Object.prototype.hasOwnProperty.call(PARAM_TYPES, key)) return PARAM_TYPES[key];
  if (dataStructures && typeof dataStructures === "object") {
    const structure = dataStructures[key];
    if (structure && typeof structure === "object") {
      return `structure:${structure.structureName || structure.name || key}`;
    }
  }
  return key;
}

function isRequired(value) {
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "required"].includes(String(value).toLowerCase());
}

function firstPresent(item, keys, defaultValue = "") {
  for (const key of keys) {
    const value = item[key];
    if (value !== undefined && value !== null && value !== "") return String(value);
  }
  return defaultValue;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function usableUpdateData(value) {
  return isPlainObject(value) ? value : {};
}

function mergeParamPatch(param, patch) {
  if (!isPlainObject(patch)) return;
  for (const [key, value] of Object.entries(patch)) {
    if (
      (key === "childList" || key === "paramValueList")
      && Array.isArray(value)
      && value.length === 0
      && Array.isArray(param[key])
      && param[key].length > 0
    ) {
      continue;
    }
    param[key] = deepClone(value);
  }
}

function applyParamUpdates(param, updates) {
  if (!isPlainObject(param)) return param;
  if (param.paramID && isPlainObject(updates[param.paramID])) {
    mergeParamPatch(param, updates[param.paramID]);
  }
  if (Array.isArray(param.childList)) {
    param.childList = param.childList.map((child) => applyParamUpdates(child, updates));
  }
  return param;
}

function expandStructureItem(item, dataStructures, seenStructureIDs) {
  if (!item.structureID || !isPlainObject(dataStructures)) return null;
  const structureID = String(item.structureID);
  const structure = dataStructures[structureID];
  if (!isPlainObject(structure) || !Array.isArray(structure.structureData)) return null;
  if (seenStructureIDs.has(structureID)) {
    return [{
      paramKey: "",
      paramName: structure.structureName || `structure:${structureID}`,
      paramType: structureID,
      paramNotNull: item.paramNotNull ?? item.required ?? "0",
      paramNote: "Circular data structure reference skipped.",
      childList: [],
    }];
  }

  const nextSeen = new Set(seenStructureIDs);
  nextSeen.add(structureID);
  const updates = usableUpdateData(item.updateData);
  return structure.structureData
    .map((param) => applyParamUpdates(deepClone(param), updates))
    .map((param) => expandNestedStructures(param, dataStructures, nextSeen));
}

function expandNestedStructures(param, dataStructures, seenStructureIDs) {
  if (!isPlainObject(param)) return param;
  const expandedChildren = expandStructureItem(param, dataStructures, seenStructureIDs);
  if (expandedChildren) {
    param.childList = expandedChildren;
    if (param.paramType === undefined || param.paramType === null || param.paramType === "") {
      param.paramType = param.structureID;
    }
  } else if (Array.isArray(param.childList)) {
    param.childList = param.childList.map((child) => expandNestedStructures(child, dataStructures, seenStructureIDs));
  }
  return param;
}

function normalizeParamList(items, dataStructures, seenStructureIDs = new Set()) {
  if (!Array.isArray(items)) return [];
  const result = [];
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const expandedStructure = expandStructureItem(item, dataStructures, seenStructureIDs);
    if (expandedStructure) {
      result.push(...normalizeParamList(expandedStructure, dataStructures, seenStructureIDs));
      continue;
    }
    const description = firstPresent(item, ["paramName", "description", "paramNote", "note", "valueDescription"]);
    const node = {
      key: firstPresent(item, ["paramKey", "key", "headerName", "headerKey", "name"]),
      type: paramTypeLabel(item.paramType ?? "0", dataStructures),
      required: isRequired(item.paramNotNull ?? item.required ?? false),
      description,
      example: firstPresent(item, ["paramValue", "example", "value"]),
      children: normalizeParamList(item.childList || item.children || [], dataStructures, seenStructureIDs),
    };
    if (!node.key && item.structureID) {
      const structure = dataStructures?.[String(item.structureID)];
      node.type = paramTypeLabel(item.structureID, dataStructures);
      node.description = node.description || structure?.structureName || "";
    }
    if (item.paramLimit !== undefined && item.paramLimit !== null && item.paramLimit !== "") node.limit = item.paramLimit;
    if (item.paramMock !== undefined && item.paramMock !== null && item.paramMock !== "") node.mock = item.paramMock;
    if (Array.isArray(item.paramValueList) && item.paramValueList.length > 0) node.enum = redactData(item.paramValueList);
    result.push(node);
  }
  return result;
}

function normalizeResponseBody(response, dataStructures) {
  const responseType = enumLookup(RESPONSE_BODY_TYPES, response.responseType, "JSON");
  const body = {
    code: String(response.responseCode || ""),
    name: String(response.responseName || ""),
    type: responseType,
    body: [],
  };
  if (responseType === "Raw" || responseType === "Binary") {
    body[responseType === "Binary" ? "binary" : "raw"] = response[responseType === "Binary" ? "binary" : "raw"] || "";
  } else {
    body.outer = enumLookup(JSON_OUTER_TYPES, response.paramJsonType, "Object");
    body.body = normalizeParamList(response.paramList, dataStructures);
  }
  return body;
}

function normalize(parsed, projectInfo, apiPayload, options) {
  const { includeRaw, target, detailUrl, rawSearchPages } = options;
  const apiInfo = apiPayload.apiInfo;
  if (!apiInfo || typeof apiInfo !== "object" || Array.isArray(apiInfo)) {
    throw new EolinkerError("getApi response did not include apiInfo.");
  }
  const baseInfo = apiInfo.baseInfo && typeof apiInfo.baseInfo === "object" ? apiInfo.baseInfo : {};
  const dataStructures = apiInfo.dataStructureList && typeof apiInfo.dataStructureList === "object" ? apiInfo.dataStructureList : {};

  const normalized = {
    source: {
      url: parsed.redactedUrl,
      host: parsed.baseUrl,
      shareCode: parsed.shareCode,
      shareID: projectInfo.shareID || parsed.shareID,
      apiID: target.apiID,
      groupID: baseInfo.groupID || target.groupID,
      shareType: parsed.shareType,
    },
    project: {
      name: projectInfo.projectName || "",
      updatedAt: projectInfo.projectUpdateTime || "",
      viewSetting: projectInfo.viewSetting || {},
    },
    api: {
      name: baseInfo.apiName || "",
      method: enumLookup(METHODS, baseInfo.apiRequestType, ""),
      path: baseInfo.apiURI || "",
      protocol: enumLookup(PROTOCOLS, baseInfo.apiProtocol, ""),
      status: enumLookup(API_STATUSES, baseInfo.apiStatus, ""),
      requestBodyType: enumLookup(REQUEST_BODY_TYPES, baseInfo.apiRequestParamType, ""),
      requestBodyOuter: enumLookup(JSON_OUTER_TYPES, baseInfo.apiRequestParamJsonType, "Object"),
      apiType: apiInfo.apiType || "",
      groupPath: baseInfo.groupPath || "",
      updatedAt: baseInfo.apiUpdateTime || "",
    },
    request: {
      headers: normalizeParamList(apiInfo.headerInfo, dataStructures),
      query: normalizeParamList(apiInfo.urlParam, dataStructures),
      pathParams: normalizeParamList(apiInfo.restfulParam, dataStructures),
      body: normalizeParamList(apiInfo.requestInfo, dataStructures),
      raw: baseInfo.apiRequestRaw || "",
      binary: baseInfo.apiRequestBinary || "",
    },
    responses: Array.isArray(apiInfo.resultInfo)
      ? apiInfo.resultInfo.filter((item) => item && typeof item === "object").map((item) => normalizeResponseBody(item, dataStructures))
      : [],
  };
  if (detailUrl) normalized.source.detailUrl = detailUrl;
  if (includeRaw) {
    const raw = { projectInfo, api: apiPayload };
    if (rawSearchPages) raw.search = rawSearchPages;
    normalized.raw = redactData(raw);
  }
  return normalized;
}

function formatParamLines(params, indent = 0) {
  const lines = [];
  const prefix = "  ".repeat(indent);
  for (const item of params) {
    const key = item.key || "(anonymous)";
    const type = item.type || "unknown";
    const required = item.required ? "必填" : "可选";
    const tailParts = [item.description].filter(Boolean);
    const tail = tailParts.length ? ` - ${tailParts.join("；")}` : "";
    lines.push(`${prefix}- ${key} ${type} ${required}${tail}`);
    if (Array.isArray(item.children) && item.children.length > 0) {
      lines.push(...formatParamLines(item.children, indent + 1));
    }
  }
  return lines;
}

function markdownSummary(data) {
  const { source, project, api, request, responses } = data;
  const lines = [
    `## ${api.name || "Eolinker API"}`,
    "",
    `Project: ${project.name || "-"}`,
    `Endpoint: ${api.method || "-"} ${api.path || "-"}`,
    `Protocol: ${api.protocol || "-"}`,
    `Status: ${api.status || "-"}`,
    `Request body: ${`${api.requestBodyType || "-"} ${api.requestBodyOuter || ""}`.trim()}`,
  ];
  if (source.detailUrl) lines.push(`Detail: ${source.detailUrl}`);

  for (const [heading, params] of [
    ["Headers", request.headers || []],
    ["Query Params", request.query || []],
    ["Path Params", request.pathParams || []],
    ["Body Params", request.body || []],
  ]) {
    if (params.length > 0) {
      lines.push("", `### ${heading}`, ...formatParamLines(params));
    }
  }

  if (responses.length > 0) {
    lines.push("", "### Responses");
    for (const response of responses) {
      lines.push("", `#### ${`${response.code || "-"} ${response.name || ""}`.trim()}`, `Type: ${response.type || "-"}`);
      if (Array.isArray(response.body) && response.body.length > 0) {
        lines.push(...formatParamLines(response.body));
      } else if (response.raw) {
        lines.push("Raw response body is documented in normalized JSON.");
      } else if (response.binary) {
        lines.push("Binary response body is documented in normalized JSON.");
      }
    }
  }
  return lines.join("\n").trim() + "\n";
}

async function openShareSession(parsed) {
  const cookieJar = new CookieJar();
  const projectInfo = await postForm(cookieJar, parsed, "getProjectInfo", {
    shareCode: parsed.shareCode,
    shareType: parsed.shareType,
  });
  requireSuccess("getProjectInfo", projectInfo);

  if (!["0", "False", "false", ""].includes(String(projectInfo.isLocked ?? "0"))) {
    throw new EolinkerError("This share is locked/password-protected; v1 only supports unlocked share links.");
  }

  const shareToken = projectInfo.shareToken || parsed.fallbackShareToken;
  const shareID = projectInfo.shareID || parsed.shareID;
  if (!shareToken || !shareID) {
    throw new EolinkerError("getProjectInfo did not return shareToken/shareID and the URL did not provide a usable fallback.");
  }

  return { cookieJar, projectInfo, shareToken, shareID };
}

async function fetchApi(parsed, args) {
  const session = await openShareSession(parsed);
  let target = {
    apiID: String(parsed.apiID),
    groupID: String(parsed.groupID),
    method: null,
    projectHashKey: parsed.projectHashKey,
  };
  let rawSearchPages = null;
  let detailUrl = null;

  if (args.apiPath) {
    const resolved = await resolveTargetByPath(
      session.cookieJar,
      parsed,
      session,
      args.apiPath,
      args.method,
    );
    target = resolved.target;
    rawSearchPages = resolved.rawPages;
    detailUrl = buildDetailUrl(parsed, target, session.shareID);
  }

  const apiRequest = {
    shareCode: parsed.shareCode,
    apiID: target.apiID,
    shareID: session.shareID,
    groupID: target.groupID,
    shareToken: session.shareToken,
    shareType: parsed.shareType,
  };
  const projectHashKey = target.projectHashKey || parsed.projectHashKey;
  if (projectHashKey) apiRequest.projectHashKey = projectHashKey;

  const apiPayload = await postForm(session.cookieJar, parsed, "getApi", apiRequest);
  requireSuccess("getApi", apiPayload);
  const normalized = normalize(parsed, session.projectInfo, apiPayload, {
    includeRaw: args.raw,
    target,
    detailUrl,
    rawSearchPages,
  });

  if (args.apiPath && normalized.api.path !== args.apiPath) {
    throw new EolinkerError(`getApi returned path "${normalized.api.path}" after resolving "${args.apiPath}".`);
  }
  if (args.apiPath && normalized.api.method !== target.method) {
    throw new EolinkerError(`getApi returned method ${normalized.api.method || "-"} after resolving ${target.method}.`);
  }
  return normalized;
}

function renderOutput(data, args) {
  const markdown = markdownSummary(data);
  const jsonText = JSON.stringify(data, null, 2);
  if (args.jsonOnly) return jsonText + "\n";
  if (args.markdownOnly) return markdown;
  return `${markdown}\n\`\`\`json\n${jsonText}\n\`\`\`\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const parsed = parseShareUrl(args.url);
  if (!args.apiPath && !parsed.apiID) {
    throw new EolinkerError("Missing apiID in the Eolinker URL. Pass --api-path to search a project share.");
  }
  const data = await fetchApi(parsed, args);
  const output = renderOutput(data, args);
  if (args.output) {
    fs.writeFileSync(args.output, output, "utf8");
  } else {
    process.stdout.write(output);
  }
}

main().catch((error) => {
  if (error instanceof EolinkerError) {
    process.stderr.write(`error: ${error.message}\n`);
  } else {
    process.stderr.write(`error: ${error.stack || error.message}\n`);
  }
  process.exit(1);
});
