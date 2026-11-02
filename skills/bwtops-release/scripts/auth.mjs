#!/usr/bin/env node
import { mkdir, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const ORIGIN = 'https://bwtops.bwton.cn';
export const LIST_URL = `${ORIGIN}/bwton/app/list?current_page=1&page_size=10&app_type=&app_flag=&state=1&app_name=&prolineid=&git_url=&owner_id=`;

// A fresh HTTP context deliberately shares neither browser cookies nor storage.
export async function verifyToken(token, request, url = LIST_URL) {
  if (typeof token !== 'string' || !token.trim()) return { status: 'auth_required' };
  const client = await request.newContext();
  try {
    const response = await client.get(url, {
      headers: { 'X-Token': token }, timeout: 15000, maxRedirects: 0,
    });
    const httpStatus = response.status();
    if (httpStatus === 401) return { status: 'auth_required', httpStatus };
    if (httpStatus !== 200) return { status: 'http_error', httpStatus };
    let body;
    try { body = await response.json(); }
    catch { return { status: 'invalid_response', httpStatus }; }
    const code = body?.code;
    if (code === 1001 || code === 1002) return { status: 'auth_required', httpStatus, code };
    if (code !== 200) return { status: 'api_error', httpStatus, code: typeof code === 'number' ? code : null };
    if (!Array.isArray(body?.data?.app_list) || !Number.isInteger(body.data.total) || body.data.total < 0) {
      return { status: 'invalid_response', httpStatus, code };
    }
    return { status: 'authenticated', httpStatus, code, total: body.data.total, count: body.data.app_list.length };
  } catch {
    // Playwright errors may include headers: never print raw exceptions.
    return { status: 'network_error' };
  } finally {
    await client.dispose();
  }
}

export function defaultStateDir(env = process.env) {
  const base = env.XDG_STATE_HOME || (process.platform === 'win32'
    ? env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local')
    : path.join(homedir(), '.local', 'state'));
  return path.join(base, 'wang-skills', 'bwtops-release');
}

const report = (value) => console.log(JSON.stringify(value));
const hint = (message) => console.error(message);

// Internal consumer receives the token in memory only; CLI never exposes it.
export async function main(args = process.argv.slice(2), onAuthenticated) {
  const { values } = parseArgs({ args, options: {
    check: { type: 'boolean', default: false },
    'state-dir': { type: 'string' },
    browser: { type: 'string', default: 'chrome' },
    'timeout-seconds': { type: 'string', default: '600' },
    help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) {
    console.log('用法: node scripts/auth.mjs [--check] [--state-dir <专用目录>] [--browser chrome|chromium] [--timeout-seconds 600]\n默认打开专用浏览器供用户登录；--check 无界面验证已有会话，失效时退出。Token 不输出。');
    return 0;
  }
  const seconds = Number(values['timeout-seconds']);
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 3600 || !['chrome', 'chromium'].includes(values.browser)) {
    report({ status: 'invalid_arguments' }); return 1;
  }
  let playwright;
  try { playwright = await import('playwright'); }
  catch { hint('缺少 Playwright。请按根 README 中的说明在 Skill 目录执行 npm ci。'); return 1; }
  // The state root is dedicated to this skill; never use an everyday Chrome profile.
  const stateDir = path.resolve(values['state-dir'] || defaultStateDir());
  const profileDir = path.join(stateDir, 'browser-profile');
  if (process.platform !== 'win32') process.umask(0o077);
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    await chmod(stateDir, 0o700);
    await chmod(profileDir, 0o700);
  }
  let context;
  try {
    context = await playwright.chromium.launchPersistentContext(profileDir, {
      channel: values.browser === 'chrome' ? 'chrome' : undefined,
      headless: values.check,
      timeout: 30000,
    });
  } catch {
    report({ status: 'browser_start_failed' });
    hint('检查所选浏览器是否已安装、图形会话/沙箱是否可用，以及该专用资料目录是否正被另一进程占用。不要改用日常 Chrome 资料目录。');
    return 1;
  }
  let interrupted = false;
  const stop = () => { interrupted = true; void context.close().catch(() => {}); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const page = context.pages()[0] || await context.newPage();
    try { await page.goto(`${ORIGIN}/#/app/list`, { waitUntil: 'domcontentloaded', timeout: 30000 }); }
    catch { report({ status: 'navigation_failed' }); return 1; }
    if (!values.check) hint('请在新打开的专用浏览器中手动登录 BWTOPS；脚本会自动验证，成功后关闭浏览器并保存会话。');
    const deadline = Date.now() + seconds * 1000;
    let previousToken;
    let sawToken = false;
    do {
      if (interrupted || context.pages().length === 0) {
        report({ status: 'cancelled' }); return 1;
      }
      let token;
      for (const candidate of context.pages()) {
        if (new URL(candidate.url()).origin !== ORIGIN) continue;
        try { token = await candidate.evaluate(() => localStorage.getItem('token')); }
        catch { continue; } // Login redirects may destroy the page execution context.
        if (token) break;
      }
      if (token && token !== previousToken) {
        previousToken = token;
        sawToken = true;
        const result = await verifyToken(token, playwright.request);
        if (result.status === 'authenticated') {
          if (onAuthenticated) {
            const output = await onAuthenticated(token, playwright.request);
            report(output);
            return ['prepared', 'ready', 'submitted', 'running', 'success'].includes(output.status) ? 0 : output.status === 'needs_selection' ? 2 : 1;
          }
          report({ ...result, source: 'dedicated_browser', stateDir }); return 0;
        }
        if (result.status !== 'auth_required' || values.check) { report(result); return result.status === 'auth_required' ? 2 : 1; }
        hint('已有 Token 已失效，请在专用浏览器完成重新登录；不会重复验证同一个无效 Token。');
      }
      if (values.check) { report({ status: 'auth_required' }); return 2; }
      await new Promise(resolve => setTimeout(resolve, 1000));
    } while (Date.now() < deadline);
    report({ status: 'login_timeout', tokenObserved: sawToken }); return 2;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await context.close().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code; }).catch(() => {
    report({ status: 'unexpected_error' }); process.exitCode = 1;
  });
}
