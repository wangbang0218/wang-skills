import test from 'node:test';
import assert from 'node:assert/strict';
import { prepare, readOnlyApi } from './prepare-core.mjs';
import { repositoryKey } from './project.mjs';
const project = { status: 'project_resolved', repository: 'git.example/a/demo', remoteCommit: 'a'.repeat(40), worktreeDirty: false, commitsDiffer: false };
const app = { app_id: 1, app_name: 'demo', git_url: 'git@git.example:a/demo.git', state: 1 };
const env = { env_id: 2, env_type: 'dev', target_key: 'dev:2:a', alias_name: '开发', scope_ref_name: 'a' };
const inst = { app_id: 1, env_id: 2, appinst_id: 3, inst_type: 'k8s', inst_name: 'a' };
function fixture({ apps = [app], envs = [env], instances = [inst], pages } = {}) {
  const calls = [];
  return { calls, async get(path, p) {
    calls.push([path, p]);
    if (path.endsWith('/list')) return p.app_id ? apps.find(a => String(a.app_id) === String(p.app_id)) : { app_list: pages ? pages[p.current_page - 1] : apps, total: pages ? pages.flat().length : apps.length };
    if (path.endsWith('/env')) return envs;
    if (path.endsWith('/instance')) return { appInsts: instances.filter(i => i.inst_type === p.deploy_type) };
    throw Error('unexpected endpoint');
  } };
}
test('仓库 SSH/HTTPS 身份一致且不输出凭据', () => {
  assert.equal(repositoryKey('https://user:secret@git.example/a/demo.git'), project.repository);
  assert.equal(repositoryKey('ssh://git@git.example:22/a/demo.git'), project.repository);
  assert.equal(repositoryKey('/tmp/demo'), null);
});
test('唯一目标生成只读方案，逐页查找应用', async () => {
  const api = fixture({ pages: [[{ ...app, app_id: 9, git_url: 'https://elsewhere/a.git' }], [app]] });
  const result = await prepare(project, api);
  assert.equal(result.status, 'prepared');
  assert.equal(result.environment.type, 'dev');
  assert.equal(result.instances[0].instanceId, '3');
  assert.equal(api.calls.filter(([p, q]) => p.endsWith('/list') && q.current_page).length, 2);
});
test('同仓库多应用需要选择且禁止无关应用 ID', async () => {
  const api = fixture({ apps: [app, { ...app, app_id: 4 }] });
  assert.equal((await prepare(project, api)).question, 'application');
  assert.equal((await prepare(project, api, { appId: '7' })).reason, 'application_selection_invalid');
});
test('同名 DEV 按 targetKey 区分，不能选择 PROD', async () => {
  const api = fixture({ envs: [env, { ...env, target_key: 'dev:2:b' }, { ...env, env_type: 'prod', target_key: 'prod:2:a' }] });
  const result = await prepare(project, api);
  assert.equal(result.question, 'environment');
  assert.equal(result.candidates.length, 2);
  assert.equal((await prepare(project, api, { targetKey: 'prod:2:a' })).reason, 'dev_target_selection_invalid');
  assert.equal((await prepare(project, api, { targetKey: env.target_key })).status, 'prepared');
});
test('部署类型及多个实例逐层消歧', async () => {
  const api = fixture({ instances: [inst, { ...inst, appinst_id: 4 }, { ...inst, appinst_id: 5, inst_type: 'server' }] });
  assert.equal((await prepare(project, api)).question, 'deployment_type');
  assert.equal((await prepare(project, api, { deployType: 'k8s' })).question, 'instances');
  assert.equal((await prepare(project, api, { deployType: 'k8s', instanceIds: ['3', '4'] })).maxSelections, 1);
  assert.equal((await prepare(project, api, { deployType: 'k8s', instanceIds: ['3'] })).instances.length, 1);
  assert.equal((await prepare(project, api, { deployType: 'k8s', instanceIds: ['5'] })).reason, 'instance_selection_invalid');
});
test('代码差异必须显式确认完整远端提交，远端变化使确认失效', async () => {
  const api = fixture();
  assert.equal((await prepare({ ...project, worktreeDirty: true }, api)).question, 'code_version');
  assert.equal(api.calls.length, 0);
  assert.equal((await prepare({ ...project, commitsDiffer: true }, api, { acceptRemoteCommit: project.remoteCommit })).status, 'prepared');
  assert.equal((await prepare(project, api, { acceptRemoteCommit: 'b'.repeat(40) })).reason, 'remote_commit_changed');
});
test('缺少 DEV 或实例时阻塞', async () => {
  assert.equal((await prepare(project, fixture({ envs: [] }))).reason, 'no_dev_environment');
  assert.equal((await prepare(project, fixture({ instances: [] }))).reason, 'no_deployable_instance');
});
test('HTTP 仅允许固定只读端点，认证失败不泄漏响应', async () => {
  let calls = 0;
  const api = await readOnlyApi('secret', { newContext: async () => ({
    get: async (url, options) => {
      calls++; assert.equal(new URL(url).origin, 'https://bwtops.bwton.cn');
      assert.deepEqual(options.headers, { 'X-Token': 'secret' });
      assert.equal(options.maxRedirects, 0);
      return { status: () => 200, json: async () => ({ code: 1001, msg: 'secret' }), dispose: async () => {} };
    }, dispose: async () => {},
  }) });
  await assert.rejects(api.get('/bwton/app/cicd', {}), /unsupported_read_endpoint/);
  assert.equal(calls, 0);
  await assert.rejects(api.get('/bwton/app/list', {}), /^Error: auth_required$/);
  await api.close();
});
