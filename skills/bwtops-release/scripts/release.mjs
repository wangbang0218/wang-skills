#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { main as authenticate, defaultStateDir } from './auth.mjs';
import { inspectProject, PreparationError } from './project.mjs';
import { prepare, readOnlyApi } from './prepare-core.mjs';
import { buildRelease, submit, track } from './release-core.mjs';

import { save, unlock, submitOnce } from './run-store.mjs';

const emit = x => console.log(JSON.stringify(x));
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9-]{7,79}$/;
const reason = e => e instanceof PreparationError ? e.reason : 'operation_failed';
export async function main(args = process.argv.slice(2)) {
  const { values: v } = parseArgs({ args, options: {
    repo: { type: 'string', default: process.cwd() }, remote: { type: 'string' }, branch: { type: 'string' },
    'app-id': { type: 'string' }, 'target-key': { type: 'string' }, 'deploy-type': { type: 'string' },
    'instance-id': { type: 'string', multiple: true }, 'accept-remote-commit': { type: 'string' },
    compiler: { type: 'string' }, execute: { type: 'boolean' }, 'plan-hash': { type: 'string' },
    'request-id': { type: 'string' }, resume: { type: 'string' }, wait: { type: 'string', default: '0' },
    'state-dir': { type: 'string' }, browser: { type: 'string', default: 'chrome' }, help: { type: 'boolean', short: 'h' },
  } });
  if (v.help) {
    console.log('DEV H5-NODEJS/K8s 构建发布。默认只读预检，选择参数与 prepare.mjs 一致。\n预检: release.mjs --repo <项目> [--compiler NODE22]\n提交: 同样参数 + --execute --plan-hash <预检哈希> --request-id <唯一请求ID> [--wait 45]\n跟踪: release.mjs --resume <请求ID> [--wait 45]\n--wait 0..45 秒；超时只暂停本地跟踪，不取消平台任务。恢复命令只读，绝不重发 POST。'); return 0;
  }
  const seconds = Number(v.wait);
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 45 || (v.resume && v.execute)) throw new PreparationError('invalid_arguments');
  if ((v.resume && !idPattern.test(v.resume)) || (v.execute && (!idPattern.test(v['request-id'] || '') || !/^[a-f0-9]{64}$/.test(v['plan-hash'] || '')))) throw new PreparationError('request_id_and_plan_hash_required');
  const stateDir = path.resolve(v['state-dir'] || defaultStateDir());
  const runsDir = path.join(stateDir, 'runs');
  const authArgs = ['--check', '--state-dir', stateDir, '--browser', v.browser];
  const projectOptions = { repo: path.resolve(v.repo), remote: v.remote, branch: v.branch };
  const options = { appId: v['app-id'], targetKey: v['target-key'], deployType: v['deploy-type'], instanceIds: v['instance-id'], acceptRemoteCommit: v['accept-remote-commit'], compiler: v.compiler };
  let project;
  if (!v.resume) { project = await inspectProject(projectOptions); if (project.status !== 'project_resolved') { emit(project); return project.status === 'needs_selection' ? 2 : 1; } }
  return authenticate(authArgs, async (token, request) => {
    let api, run, file;
    try {
      api = await readOnlyApi(token, request);
      if (v.resume) {
        file = path.join(runsDir, `${v.resume}.json`);
        try { run = JSON.parse(await readFile(file, 'utf8')); } catch { throw new PreparationError('run_not_found_or_invalid'); }
        if (run.requestId !== v.resume) throw new PreparationError('run_identity_mismatch');
        if (!run.receipt) return { status: run.status, reason: 'no_receipt_do_not_resubmit', requestId: run.requestId, summary: run.summary };
      } else {
        const plan = await prepare(project, api, options);
        if (plan.status !== 'prepared') return plan;
        const ready = await buildRelease(plan, api, options);
        if (ready.status !== 'ready') return ready;
        if (!v.execute) return { status: 'ready', readOnly: true, summary: ready.summary, planHash: ready.planHash };
        if (v['plan-hash'] !== ready.planHash) return { status: 'blocked', reason: 'plan_changed_repeat_preflight', summary: ready.summary };
        const current = await inspectProject(projectOptions);
        if (current.status !== 'project_resolved' || current.remoteCommit !== project.remoteCommit || current.branch !== project.branch
          || current.repository !== project.repository || current.localCommit !== project.localCommit || current.worktreeDirty !== project.worktreeDirty) {
          return { status: 'blocked', reason: 'code_changed_before_submission' };
        }
        file = path.join(runsDir, `${v['request-id']}.json`);
        // Keep a recovery identifier even when persistence fails after POST.
        run = { requestId: v['request-id'] };
        run = await submitOnce(runsDir, v['request-id'], ready, () => submit(token, request, ready.payload));
        if (run.status !== 'submitted') return { status: run.status, reason: run.reason, requestId: run.requestId, summary: run.summary };
        console.error(JSON.stringify({ status: 'submitted', requestId: run.requestId, receipt: run.receipt }));
      }
      const deadline = Date.now() + seconds * 1000;
      let result;
      do {
        result = await track(api, run.receipt);
        run.status = result.status; run.result = result; await save(file, run);
        if (['success', 'failed'].includes(result.status)) { await unlock(runsDir, run); break; }
        if (Date.now() + 5000 >= deadline) break;
        await new Promise(resolve => setTimeout(resolve, 5000));
      } while (Date.now() < deadline);
      return { ...result, requestId: run.requestId, expectedRemoteCommit: run.summary.expectedRemoteCommit };
    } catch (e) {
      return { status: 'blocked', reason: reason(e), ...(run ? { requestId: run.requestId, receipt: run.receipt, recovery: '只用 --resume 继续；不得重发提交' } : {}) };
    } finally { if (api) await api.close(); }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code; }).catch(e => { emit({ status: 'blocked', reason: reason(e) }); process.exitCode = 1; });
}
