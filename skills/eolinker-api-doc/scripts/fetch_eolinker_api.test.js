"use strict";

const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = path.join(__dirname, "fetch_eolinker_api.js");
const TARGET_PATH = "/digit/mdr/collection/v1/create";

function makeCandidate({
  apiID = 17941,
  apiName = "Create collection",
  apiURI = TARGET_PATH,
  groupID = 2962,
  apiRequestType = 0,
} = {}) {
  return {
    apiID,
    apiName,
    apiURI,
    groupID,
    groupName: "Collections",
    apiRequestType,
    apiType: "http",
  };
}

function makeApiPayload({
  apiName = "Create collection",
  apiURI = TARGET_PATH,
  groupID = 2962,
  apiRequestType = 0,
} = {}) {
  return {
    statusCode: "000000",
    apiInfo: {
      apiType: "http",
      baseInfo: {
        apiName,
        apiURI,
        apiRequestType,
        apiProtocol: 0,
        apiStatus: 0,
        apiRequestParamType: 2,
        apiRequestParamJsonType: 0,
        groupID,
        groupPath: `-1,${groupID}`,
      },
      headerInfo: [],
      urlParam: [],
      restfulParam: [],
      requestInfo: [],
      resultInfo: [],
      dataStructureList: {},
    },
  };
}

function sendMockResponse(response, config) {
  const {
    payload,
    rawBody = null,
    statusCode = 200,
    headers = {},
  } = config;
  response.writeHead(statusCode, {
    "Content-Type": rawBody === null ? "application/json" : "text/plain",
    Connection: "close",
    ...headers,
  });
  response.end(rawBody === null ? JSON.stringify(payload) : rawBody);
}

async function createMockEolinker({
  projectInfo = {},
  searchPages = [[]],
  itemNum = searchPages.reduce((total, page) => total + page.length, 0),
  apiPayloads = {},
  onRequest = null,
} = {}) {
  const requests = [];
  const serverErrors = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      try {
        const operation = new URL(request.url, "http://localhost").pathname.split("/").pop();
        const params = Object.fromEntries(new URLSearchParams(body));
        const record = {
          operation,
          params,
          cookie: request.headers.cookie || "",
          contentType: request.headers["content-type"] || "",
        };
        requests.push(record);

        const customResponse = onRequest ? onRequest(record) : null;
        if (customResponse) {
          sendMockResponse(response, customResponse);
          return;
        }

        if (operation === "getProjectInfo") {
          sendMockResponse(response, {
            payload: {
              statusCode: "000000",
              projectName: "Mock project",
              projectUpdateTime: "2026-08-07 00:00:00",
              isLocked: 0,
              shareID: 192,
              shareToken: "server-secret-token",
              viewSetting: { apiView: 1 },
              ...projectInfo,
            },
            headers: { "Set-Cookie": "PHPSESSID=test-session; Path=/; HttpOnly" },
          });
          return;
        }

        if (operation === "searchApi") {
          const page = Number.parseInt(params.page, 10);
          sendMockResponse(response, {
            payload: {
              statusCode: "000000",
              apiList: searchPages[page - 1] || [],
              itemNum,
            },
          });
          return;
        }

        if (operation === "getApi") {
          sendMockResponse(response, { payload: apiPayloads[String(params.apiID)] || makeApiPayload() });
          return;
        }

        sendMockResponse(response, { payload: { statusCode: "100006", operation } });
      } catch (error) {
        serverErrors.push(error);
        response.writeHead(500, { "Content-Type": "text/plain" });
        response.end(error.stack || error.message);
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    serverErrors,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function makeShareUrl(baseUrl, { apiID = null, groupID = 2961, shareToken = "url-secret-token" } = {}) {
  const params = new URLSearchParams({
    groupID: String(groupID),
    shareCode: "Qa9Ywc",
    shareType: "project",
    shareToken,
    shareID: "192",
    origin: "platform",
  });
  if (apiID !== null) params.set("apiID", String(apiID));
  const route = apiID === null ? "" : "detail";
  return `${baseUrl}/independent/#/share/project/api/${route}?${params}`;
}

async function runCli(args) {
  return execFileAsync(process.execPath, [SCRIPT_PATH, ...args], {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
    timeout: 5000,
  });
}

async function runCliFailure(args) {
  let failure = null;
  try {
    await runCli(args);
  } catch (error) {
    failure = error;
  }
  assert.ok(failure, "expected CLI command to fail");
  assert.notEqual(failure.code, 0);
  return failure;
}

test("keeps the existing detail URL flow without searching", async () => {
  const mock = await createMockEolinker({
    apiPayloads: { 17941: makeApiPayload() },
  });
  try {
    const { stdout } = await runCli(["--json-only", makeShareUrl(mock.baseUrl, { apiID: 17941 })]);
    const data = JSON.parse(stdout);

    assert.deepEqual(mock.requests.map((item) => item.operation), ["getProjectInfo", "getApi"]);
    assert.equal(data.api.path, TARGET_PATH);
    assert.equal(data.api.method, "POST");
    assert.equal(String(data.source.apiID), "17941");
    assert.equal(String(data.source.groupID), "2962");
    assert.equal(data.source.detailUrl, undefined);
    assert.doesNotMatch(stdout, /server-secret-token|url-secret-token/);
    assert.deepEqual(mock.serverErrors, []);
  } finally {
    await mock.close();
  }
});

test("searches every page, resolves the real group, and emits a token-free detail URL", async () => {
  const firstPage = Array.from({ length: 50 }, (_, index) => makeCandidate({
    apiID: 10000 + index,
    apiURI: `/digit/mdr/other/${index}`,
  }));
  const mock = await createMockEolinker({
    searchPages: [firstPage, [makeCandidate()]],
    itemNum: 51,
    apiPayloads: { 17941: makeApiPayload() },
  });
  try {
    const { stdout } = await runCli([
      "--json-only",
      "--raw",
      "--api-path",
      TARGET_PATH,
      makeShareUrl(mock.baseUrl),
    ]);
    const data = JSON.parse(stdout);
    const searchRequests = mock.requests.filter((item) => item.operation === "searchApi");
    const detailRequest = mock.requests.find((item) => item.operation === "getApi");

    assert.deepEqual(mock.requests.map((item) => item.operation), [
      "getProjectInfo",
      "searchApi",
      "searchApi",
      "getApi",
    ]);
    assert.deepEqual(searchRequests.map((item) => item.params.page), ["1", "2"]);
    assert.ok(searchRequests.every((item) => item.params.groupID === "-1"));
    assert.ok(searchRequests.every((item) => item.params.keyword === TARGET_PATH));
    assert.ok(searchRequests.every((item) => item.params.tips === TARGET_PATH));
    assert.ok(searchRequests.every((item) => item.params.pageSize === "50"));
    assert.ok(searchRequests.every((item) => item.cookie.includes("PHPSESSID=test-session")));
    assert.equal(detailRequest.params.apiID, "17941");
    assert.equal(detailRequest.params.groupID, "2962");
    assert.equal(detailRequest.params.shareToken, "server-secret-token");
    assert.equal(String(data.source.apiID), "17941");
    assert.equal(String(data.source.groupID), "2962");
    assert.match(data.source.detailUrl, /\/share\/project\/api\/detail\?/);
    assert.match(data.source.detailUrl, /apiID=17941/);
    assert.match(data.source.detailUrl, /groupID=2962/);
    assert.doesNotMatch(data.source.detailUrl, /shareToken/i);
    assert.equal(data.raw.projectInfo.shareToken, "<redacted>");
    assert.equal(data.raw.search.length, 2);
    assert.doesNotMatch(stdout, /server-secret-token|url-secret-token/);
    assert.deepEqual(mock.serverErrors, []);
  } finally {
    await mock.close();
  }
});

test("requires --method for the same path with different methods and then disambiguates", async () => {
  const postCandidate = makeCandidate({ apiID: 17941, apiRequestType: 0 });
  const getCandidate = makeCandidate({ apiID: 17942, apiName: "Get collection", apiRequestType: 1 });
  const mock = await createMockEolinker({
    searchPages: [[postCandidate, getCandidate]],
    itemNum: 2,
    apiPayloads: {
      17941: makeApiPayload({ apiRequestType: 0 }),
      17942: makeApiPayload({ apiName: "Get collection", apiRequestType: 1 }),
    },
  });
  try {
    const failure = await runCliFailure(["--api-path", TARGET_PATH, makeShareUrl(mock.baseUrl)]);
    assert.match(failure.stderr, /Multiple APIs match path/);
    assert.match(failure.stderr, /--method/);

    const { stdout } = await runCli([
      "--json-only",
      "--api-path",
      TARGET_PATH,
      "--method",
      "post",
      makeShareUrl(mock.baseUrl),
    ]);
    const data = JSON.parse(stdout);
    assert.equal(data.api.method, "POST");
    assert.equal(String(data.source.apiID), "17941");
    assert.deepEqual(mock.serverErrors, []);
  } finally {
    await mock.close();
  }
});

test("rejects duplicate APIs with the same exact path and method", async () => {
  const mock = await createMockEolinker({
    searchPages: [[makeCandidate({ apiID: 17941 }), makeCandidate({ apiID: 17943 })]],
    itemNum: 2,
  });
  try {
    const failure = await runCliFailure([
      "--api-path",
      TARGET_PATH,
      "--method",
      "POST",
      makeShareUrl(mock.baseUrl),
    ]);
    assert.match(failure.stderr, /Multiple APIs match path/);
    assert.match(failure.stderr, /method POST/);
    assert.doesNotMatch(failure.stderr, /server-secret-token|url-secret-token/);
    assert.equal(mock.requests.some((item) => item.operation === "getApi"), false);
  } finally {
    await mock.close();
  }
});

test("continues after an early match so later-page conflicts are detected", async () => {
  const firstPage = [makeCandidate({ apiID: 17941, apiRequestType: 0 })];
  firstPage.push(...Array.from({ length: 49 }, (_, index) => makeCandidate({
    apiID: 11000 + index,
    apiURI: `/digit/mdr/unrelated/${index}`,
  })));
  const mock = await createMockEolinker({
    searchPages: [firstPage, [makeCandidate({ apiID: 17942, apiRequestType: 1 })]],
    itemNum: 51,
  });
  try {
    const failure = await runCliFailure(["--api-path", TARGET_PATH, makeShareUrl(mock.baseUrl)]);
    assert.match(failure.stderr, /Multiple APIs match path/);
    assert.deepEqual(
      mock.requests.filter((item) => item.operation === "searchApi").map((item) => item.params.page),
      ["1", "2"],
    );
    assert.equal(mock.requests.some((item) => item.operation === "getApi"), false);
  } finally {
    await mock.close();
  }
});

test("uses strict path matching and reports non-exact search candidates", async () => {
  const mock = await createMockEolinker({
    searchPages: [[makeCandidate({ apiURI: `${TARGET_PATH}/` })]],
    itemNum: 1,
  });
  try {
    const failure = await runCliFailure(["--api-path", `  ${TARGET_PATH}  `, makeShareUrl(mock.baseUrl)]);
    assert.match(failure.stderr, /No exact API match for path/);
    assert.match(failure.stderr, new RegExp(`${TARGET_PATH.replaceAll("/", "\\/")}\\/`));
    assert.equal(mock.requests.some((item) => item.operation === "getApi"), false);
  } finally {
    await mock.close();
  }
});

test("cross-checks a URL apiID against the path resolution", async () => {
  const mock = await createMockEolinker({
    searchPages: [[makeCandidate({ apiID: 17941 })]],
    itemNum: 1,
  });
  try {
    const failure = await runCliFailure([
      "--api-path",
      TARGET_PATH,
      makeShareUrl(mock.baseUrl, { apiID: 999 }),
    ]);
    assert.match(failure.stderr, /Resolved apiID 17941 does not match apiID 999 from the URL/);
    assert.equal(mock.requests.some((item) => item.operation === "getApi"), false);
  } finally {
    await mock.close();
  }
});

test("rejects malformed search response structures", async (t) => {
  for (const scenario of [
    {
      name: "missing apiList",
      payload: { statusCode: "000000", itemNum: 0 },
      expected: /apiList array/,
    },
    {
      name: "invalid itemNum",
      payload: { statusCode: "000000", apiList: [], itemNum: null },
      expected: /invalid itemNum/,
    },
    {
      name: "empty page before itemNum",
      payload: { statusCode: "000000", apiList: [], itemNum: 1 },
      expected: /empty page 1/,
    },
  ]) {
    await t.test(scenario.name, async () => {
      const mock = await createMockEolinker({
        onRequest(record) {
          if (record.operation === "searchApi") return { payload: scenario.payload };
          return null;
        },
      });
      try {
        const failure = await runCliFailure(["--api-path", TARGET_PATH, makeShareUrl(mock.baseUrl)]);
        assert.match(failure.stderr, scenario.expected);
        assert.doesNotMatch(failure.stderr, /server-secret-token|url-secret-token/);
        assert.equal(mock.requests.some((item) => item.operation === "getApi"), false);
      } finally {
        await mock.close();
      }
    });
  }
});

test("verifies the final detail path and method against the selected search result", async (t) => {
  for (const scenario of [
    {
      name: "path mismatch",
      apiPayload: makeApiPayload({ apiURI: "/digit/mdr/collection/v1/other" }),
      expected: /getApi returned path/,
    },
    {
      name: "method mismatch",
      apiPayload: makeApiPayload({ apiRequestType: 1 }),
      expected: /getApi returned method GET after resolving POST/,
    },
  ]) {
    await t.test(scenario.name, async () => {
      const mock = await createMockEolinker({
        searchPages: [[makeCandidate()]],
        itemNum: 1,
        apiPayloads: { 17941: scenario.apiPayload },
      });
      try {
        const failure = await runCliFailure(["--api-path", TARGET_PATH, makeShareUrl(mock.baseUrl)]);
        assert.match(failure.stderr, scenario.expected);
        assert.doesNotMatch(failure.stderr, /server-secret-token|url-secret-token/);
      } finally {
        await mock.close();
      }
    });
  }
});

test("does not echo untrusted HTTP or non-JSON response bodies", async (t) => {
  for (const scenario of [
    { name: "HTTP error", statusCode: 502, expected: /HTTP 502 while calling searchApi/ },
    { name: "non-JSON response", statusCode: 200, expected: /Non-JSON response from searchApi/ },
  ]) {
    await t.test(scenario.name, async () => {
      const mock = await createMockEolinker({
        onRequest(record) {
          if (record.operation !== "searchApi") return null;
          return {
            statusCode: scenario.statusCode,
            rawBody: "debug shareToken=server-secret-token cookie=test-session url-secret-token",
          };
        },
      });
      try {
        const failure = await runCliFailure(["--api-path", TARGET_PATH, makeShareUrl(mock.baseUrl)]);
        assert.match(failure.stderr, scenario.expected);
        assert.doesNotMatch(failure.stderr, /server-secret-token|url-secret-token|test-session/);
      } finally {
        await mock.close();
      }
    });
  }
});

test("validates path-mode option combinations before making a request", async () => {
  const missingPath = await runCliFailure([
    "--method",
    "POST",
    "https://example.invalid/independent/#/share/project/api/detail?shareCode=test&apiID=1",
  ]);
  assert.match(missingPath.stderr, /--method requires --api-path/);

  const invalidMethod = await runCliFailure([
    "--api-path",
    TARGET_PATH,
    "--method",
    "TRACE",
    "https://example.invalid/independent/#/share/project/api/?shareCode=test",
  ]);
  assert.match(invalidMethod.stderr, /Unsupported --method TRACE/);

  const missingApiID = await runCliFailure([
    "https://example.invalid/independent/#/share/project/api/?shareCode=test",
  ]);
  assert.match(missingApiID.stderr, /Missing apiID.*--api-path/);
});
