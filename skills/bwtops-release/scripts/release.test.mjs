import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildRelease, submit, track } from './release-core.mjs';
import { submitOnce, unlock } from './run-store.mjs';
const plan = { status: 'prepared', application: { appId: '1' }, environment: { envId: '2', targetKey: 'dev:2', type: 'dev' },
  instances: [{ instanceId: '3', namespace: 'demo-dev' }], deployType: 'k8s',
  project: { repository: 'git.example/a/demo', branch: 'current', remoteCommit: 'a'.repeat(40) } };
const app = { app_id: 1, state: 1, git_url: 'git@git.example:a/demo.git', app_name: 'demo', app_type: 'H5-NODEJS',
  build_params: 'npm run build:${env}', proline_id: 4, proline_name: 'a', k8s_template: 'h5', build_num: 1 };
const inst = { appinst_id: 3, app_id: 1, env_id: 2, inst_type: 'k8s', cluster_id: 10, k8s_namespace: 'demo-dev' };
const env = { env_id: 2, target_key: 'dev:2', env_type: 'dev', manual_deploy_enabled: false };
const history = { app_id: 1, compiler_version: 'NODE22', git_branch: 'STALE', packageId: 123, user_id: 99, scaList: ['old'] };
const receipt = { appId: '1', envId: '2', buildId: 'build-1', batch: 'batch-1', logsId: '9' };
const row = { app_id: 1, env_id: 2, build_id: 'build-1', batch: 'batch-1', build_applog_id: 8, log_id: 9, op_type: 'publish', state: 'success' };
function apiFixture(overrides = {}) {
  return { async get(endpoint, p) {
    if (endpoint.endsWith('/list')) return overrides.app || app;
    if (endpoint.endsWith('/env')) return [overrides.env || env];
    if (endpoint.endsWith('/instance')) return p.current_page ? { envList: [{ env_id: 2, auth_state: overrides.approval || 'N' }] } : { appInsts: [inst] };
    if (endpoint.endsWith('/user/info')) return { user_id: 7 };
    if (endpoint.endsWith('/sca')) return overrides.sca || [{ branch: 'current', task_id: 'fresh' }];
    if (endpoint.endsWith('/applog')) return p.log_type === 'cicdparam' ? overrides.history || history : overrides.rows || [];
    if (endpoint.endsWith('/jenkins')) return overrides.build || { applog_id: 8, state: 'success', summary: { is_finished: true } };
    if (endpoint.endsWith('/logs/info')) return overrides.runtime || { logs_id: 9, state: 'success', runner_result: { publish_status: 'success', startup_status: 'normal' } };
    throw Error('unexpected endpoint');
  } };
}
test('按当前配置重建请求，不复用历史分支、产物、扫描结果或操作人', async () => {
  const r = await buildRelease(plan, apiFixture());
  assert.equal(r.status, 'ready'); assert.equal(r.payload.git_branch, 'current');
  assert.equal(r.payload.packageId, ''); assert.equal(r.payload.create_userid, 7);
  assert.equal(r.payload.scaList[0].task_id, 'fresh'); assert.equal(r.payload.compiler_version, 'NODE22');
  assert.equal(r.payload.target_key, 'dev:2'); assert.equal(r.payload.cicdType, 'cicd');
  assert.equal(r.summary.permission, 'server_enforced_on_submit');
});
test('缺失编译器需选择；活动任务阻塞', async () => {
  assert.equal((await buildRelease(plan, apiFixture({ history: {} }))).question, 'compiler');
  assert.equal((await buildRelease(plan, apiFixture({ rows: [{ ...row, state: 'wait' }] }))).reason, 'inflight_tasks');
  assert.equal((await buildRelease(plan, apiFixture({ rows: [{ ...row, state: 'unexpected-state' }] }))).reason, 'inflight_tasks');
});
test('拒绝生产、审批、手工部署和多 K8s 实例', async () => {
  await assert.rejects(buildRelease({ ...plan, environment: { ...plan.environment, type: 'prod' } }, apiFixture()), /dev_preparation_required/);
  await assert.rejects(buildRelease(plan, apiFixture({ approval: 'Y' })), /environment_approval/);
  await assert.rejects(buildRelease(plan, apiFixture({ env: { ...env, manual_deploy_enabled: 'yes' } })), /manual_deploy/);
  await assert.rejects(buildRelease({ ...plan, instances: [plan.instances[0], plan.instances[0]] }, apiFixture()), /one_instance/);
});
test('精确关联自己的任务，Jenkins 成功不足以证明发布成功', async () => {
  assert.equal((await track(apiFixture({ rows: [{ ...row, batch: 'other' }] }), receipt)).phase, 'awaiting_correlated_record');
  assert.equal((await track(apiFixture({ rows: [row], runtime: { logs_id: 9, state: 'wait' } }), receipt)).status, 'running');
  assert.equal((await track(apiFixture({ rows: [row] }), receipt)).status, 'success');
  assert.equal((await track(apiFixture({ rows: [row], build: { applog_id: 8, state: 'error' } }), receipt)).phase, 'build');
  assert.equal((await track(apiFixture({ rows: [row], runtime: { logs_id: 9, state: 'success', runner_result: { publish_status: 'success', startup_status: 'abnormal' } } }), receipt)).status, 'failed');
});
test('POST 不重试，异常与残缺回执标记结果不明', async () => {
  let calls = 0;
  const request = { newContext: async () => ({ dispose: async () => {}, post: async (url, opts) => {
    calls++; assert.equal(url, 'https://bwtops.bwton.cn/bwton/app/cicd'); assert.equal(opts.maxRetries, 0); throw Error('secret');
  } }) };
  assert.equal((await submit('secret', request, {})).status, 'submission_unknown'); assert.equal(calls, 1);
});
test('提交意图先落盘，响应丢失与新请求 ID 都不能重复提交同一目标', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bwtops-runs-'));
  const ready = await buildRelease(plan, apiFixture()); let calls = 0;
  try {
    const post = async () => { calls++; assert.equal(JSON.parse(await readFile(path.join(dir, 'request-1.json'))).status, 'submission_unknown'); return { status: 'submission_unknown' }; };
    await submitOnce(dir, 'request-1', ready, post);
    assert.equal((await submitOnce(dir, 'request-1', ready, post)).status, 'blocked');
    assert.equal((await submitOnce(dir, 'request-2', ready, post)).status, 'blocked');
    assert.equal(calls, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('持久化回执可恢复，终态解锁后才能再次发布', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bwtops-runs-'));
  const ready = await buildRelease(plan, apiFixture());
  try {
    const run = await submitOnce(dir, 'request-1', ready, async () => ({ status: 'submitted', receipt }));
    assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'request-1.json'))).receipt, receipt);
    await unlock(dir, run);
    assert.equal((await submitOnce(dir, 'request-2', ready, async () => ({ status: 'submitted', receipt }))).status, 'submitted');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('POST 回执验证及权限拒绝，不输出服务端原文', async () => {
  const ready = await buildRelease(plan, apiFixture());
  const transport = (status, body) => ({ newContext: async () => ({ dispose: async () => {},
    post: async () => ({ status: () => status, json: async () => body }) }) });
  assert.equal((await submit('secret', transport(403, {}), ready.payload)).reason, 'permission_denied');
  assert.equal((await submit('secret', transport(200, { code: 200, data: {} }), ready.payload)).status, 'submission_unknown');
  const good = { code: 200, data: { app_id: 1, env_id: 2, build_id: 'build-1', batch: 'batch-1', logs_id: 9 } };
  assert.deepEqual((await submit('secret', transport(200, good), ready.payload)).receipt, receipt);
  assert.equal((await submit('secret', transport(200, { ...good, data: { ...good.data, env_id: 88 } }), ready.payload)).status, 'submission_unknown');
});
test('提交异常仍保留意图及锁，不因进程中断开放重试', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bwtops-runs-'));
  const ready = await buildRelease(plan, apiFixture()); let calls = 0;
  try {
    await assert.rejects(submitOnce(dir, 'request-1', ready, async () => { calls++; throw Error('interrupted'); }), /interrupted/);
    assert.equal(JSON.parse(await readFile(path.join(dir, 'request-1.json'))).status, 'submission_unknown');
    assert.equal((await submitOnce(dir, 'request-2', ready, async () => { calls++; })).status, 'blocked');
    assert.equal(calls, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('平台返回其他扫描分支时保留服务端风险数据并明确覆盖范围', async () => {
  const result = await buildRelease(plan, apiFixture({ sca: [{ branch: 'old' }] }));
  assert.equal(result.summary.sca.coverage, 'current_branch_not_verified');
  assert.deepEqual(result.summary.sca.returnedBranches, ['old']);
  assert.equal(result.payload.scaList[0].branch, 'old');
});
