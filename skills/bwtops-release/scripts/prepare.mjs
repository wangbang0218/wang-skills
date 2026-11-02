#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { main as authenticate } from './auth.mjs';
import { inspectProject, PreparationError } from './project.mjs';
import { prepare, readOnlyApi } from './prepare-core.mjs';

const emit = output => console.log(JSON.stringify(output));
export async function main(args = process.argv.slice(2)) {
  const { values: v } = parseArgs({ args, options: {
    repo: { type: 'string', default: process.cwd() }, remote: { type: 'string' }, branch: { type: 'string' },
    'app-id': { type: 'string' }, 'target-key': { type: 'string' }, 'deploy-type': { type: 'string' },
    'instance-id': { type: 'string', multiple: true }, 'accept-remote-commit': { type: 'string' },
    'state-dir': { type: 'string' }, browser: { type: 'string', default: 'chrome' },
    help: { type: 'boolean', short: 'h' },
  } });
  if (v.help) {
    console.log('只读准备 DEV 发布，不提交任务。\n用法: node scripts/prepare.mjs [--repo <项目目录>] [--remote origin] [--branch <分支>]\n选择参数: --app-id <ID> --target-key <目标键> --deploy-type k8s|server --instance-id <ID>（可重复）\n代码差异: --accept-remote-commit <用户确认的完整远端哈希>\n会话: --state-dir <专用目录> --browser chrome|chromium');
    return 0;
  }
  if (v['deploy-type'] && !['k8s', 'server'].includes(v['deploy-type'])) throw new PreparationError('invalid_deployment_type');
  if (v['accept-remote-commit'] && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(v['accept-remote-commit'])) throw new PreparationError('invalid_commit');
  const project = await inspectProject({ repo: path.resolve(v.repo), remote: v.remote, branch: v.branch });
  if (project.status !== 'project_resolved') { emit(project); return project.status === 'needs_selection' ? 2 : 1; }
  const options = { appId: v['app-id'], targetKey: v['target-key'], deployType: v['deploy-type'],
    instanceIds: v['instance-id'], acceptRemoteCommit: v['accept-remote-commit'] };
  const authArgs = ['--check', '--browser', v.browser];
  if (v['state-dir']) authArgs.push('--state-dir', path.resolve(v['state-dir']));
  return authenticate(authArgs, async (token, request) => {
    let api;
    try { api = await readOnlyApi(token, request); return await prepare(project, api, options); }
    catch (error) { return { status: 'blocked', reason: error instanceof PreparationError ? error.reason : 'unexpected_error' }; }
    finally { if (api) await api.close(); }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    emit({ status: 'blocked', reason: error instanceof PreparationError ? error.reason : 'preparation_failed' });
    process.exitCode = 1;
  });
}
