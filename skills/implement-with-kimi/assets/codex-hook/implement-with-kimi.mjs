#!/usr/bin/env node

import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const START = "<!-- implement-with-kimi:managed:start -->";
const END = "<!-- implement-with-kimi:managed:end -->";

let input = "";
for await (const chunk of process.stdin) input += chunk;

try {
  const event = JSON.parse(input || "{}");
  const repoRoot = gitRoot(event.cwd || process.cwd());
  if (!repoRoot) process.exit(0);
  const states = await discoverStates(repoRoot);
  const active = states.filter((item) => item.state.active === true);
  if (active.length === 0) process.exit(0);
  if (active.length > 1) {
    outputContext(`implement-with-kimi 检测到多个活动模块：${active.map((item) => item.relative).join(", ")}。不要猜测当前模块；先解决活动状态冲突。`, true);
    process.exit(0);
  }

  const current = active[0];
  const now = new Date().toISOString();
  current.state.hook = {
    status: "OBSERVED_ACTIVE",
    last_event: event.source ?? "unknown",
    last_triggered_at: now,
    session_id: event.session_id ?? null,
    trigger_count: (current.state.hook?.trigger_count ?? 0) + 1,
  };
  current.state.updated_at = now;
  await updateManagedBlock(current.absolute, current.document, current.state);

  if (event.source === "startup") {
    outputContext(`当前 worktree 存在活动的 implement-with-kimi 运行：spec=${current.state.spec_path}, run_id=${current.state.run_id}, status=${current.state.status}。这是新会话启动，继续任何实施前必须明确执行 resume 或 suspend，不能自动接管。`);
  } else {
    outputContext(`Codex 会话刚经历 ${event.source ?? "恢复"}。当前 implement-with-kimi 模块：spec=${current.state.spec_path}, run_id=${current.state.run_id}, status=${current.state.status}。在修改代码、记录测试证据或宣布完成前，必须先执行 rehydrate。`);
  }
} catch (error) {
  outputContext(`implement-with-kimi Hook 失败：${error.message}。不要继续当前模块实施；先手动运行 rehydrate 或修复状态文件。`, true);
}

function gitRoot(cwd) {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

async function discoverStates(repoRoot) {
  const result = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(result.stderr.trim() || "无法枚举状态文件");
  const states = [];
  for (const relative of result.stdout.split("\0").filter((item) => item.endsWith(".state.md"))) {
    const absolute = path.join(repoRoot, relative);
    const document = await readFile(absolute, "utf8");
    if (!document.includes(START)) continue;
    states.push({ relative, absolute, document, state: parseManagedBlock(document) });
  }
  return states;
}

function parseManagedBlock(document) {
  const start = document.indexOf(START);
  const end = document.indexOf(END);
  if (start < 0 || end <= start) throw new Error("状态文件托管标记损坏");
  const body = document.slice(start + START.length, end).trim();
  const match = body.match(/^```json\s*\n([\s\S]*?)\n```$/);
  if (!match) throw new Error("状态文件托管区不是 JSON");
  const state = JSON.parse(match[1]);
  if (state.tool !== "implement-with-kimi" || ![1, 2].includes(state.state_schema_version)) throw new Error("状态文件版本不受支持");
  return state;
}

async function updateManagedBlock(filePath, document, state) {
  const start = document.indexOf(START);
  const end = document.indexOf(END) + END.length;
  const replacement = `${START}\n\`\`\`json\n${JSON.stringify(state, null, 2)}\n\`\`\`\n${END}`;
  const next = `${document.slice(0, start)}${replacement}${document.slice(end)}`;
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, next, "utf8");
  await rename(temporary, filePath);
}

function outputContext(additionalContext, warning = false) {
  process.stdout.write(
    JSON.stringify({
      continue: true,
      ...(warning ? { systemMessage: additionalContext } : {}),
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext,
      },
    }),
  );
}
