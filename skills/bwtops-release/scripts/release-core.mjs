import { createHash } from 'node:crypto';
import { ORIGIN } from './auth.mjs';
import { PreparationError, repositoryKey } from './project.mjs';

const fail = reason => { throw new PreparationError(reason); };
const same = (a, b) => String(a) === String(b);
const terminal = new Set(['success', 'error', 'canceled', 'timeout']);
const failures = new Set(['error', 'failed', 'failure', 'canceled', 'cancelled', 'aborted', 'timeout']);
const enabled = x => ['1', 'y', 'yes', 'true', 'on'].includes(String(x ?? '').trim().toLowerCase());
export const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function records(api, appId, envId) {
  const rows = await api.get('/bwton/app/applog', { app_id: appId, env_id: envId, log_type: 'all', limit_size: 200 });
  if (!Array.isArray(rows)) fail('invalid_task_records');
  return rows;
}

export function conflicts(rows, plan) {
  return rows.filter(row => same(row.app_id, plan.application.appId) && same(row.env_id, plan.environment.envId)
    && (!terminal.has(row.state) || (row.build_log_state && !terminal.has(row.build_log_state))));
}

// Reconstruct from current platform configuration. Never spread historical cicdparam.
export async function buildRelease(plan, api, options = {}) {
  if (plan.status !== 'prepared' || plan.environment.type !== 'dev') fail('dev_preparation_required');
  if (plan.deployType !== 'k8s') fail('unsupported_release_contract');
  if (plan.instances.length !== 1) fail('k8s_requires_one_instance');
  const appId = plan.application.appId;
  const [app, history, envs, result, user, rows, instancePage] = await Promise.all([
    api.get('/bwton/app/list', { app_id: appId }),
    api.get('/bwton/app/applog', { app_id: appId, log_type: 'cicdparam' }),
    api.get('/bwton/app/env', { app_id: appId, optype: 'getEnv' }),
    api.get('/bwton/app/instance', { app_id: appId, env_id: plan.environment.envId, target_key: plan.environment.targetKey, deploy_type: 'k8s' }),
    api.get('/bwton/user/info', {}), records(api, appId, plan.environment.envId),
    api.get('/bwton/app/instance', { app_id: appId, current_page: 1, page_size: 6, env_flag: '', inst_type: '' }),
  ]);
  if (!same(app?.app_id, appId) || repositoryKey(app.git_url) !== plan.project.repository || !same(app.state, 1)) fail('application_changed');
  if (app.app_type !== 'H5-NODEJS') fail('unsupported_application_type');
  if (!Array.isArray(envs) || !Array.isArray(result?.appInsts)) fail('invalid_response');
  const env = envs.find(e => e.target_key === plan.environment.targetKey && same(e.env_id, plan.environment.envId));
  if (!env || env.env_type !== 'dev') fail('dev_target_changed');
  let extension = env.extend || {};
  if (typeof extension === 'string') { try { extension = JSON.parse(extension); } catch { fail('invalid_environment_configuration'); } }
  if (enabled(extension.manual_deploy_enabled ?? env.manual_deploy_enabled)) fail('manual_deploy_required');
  const approval = instancePage?.targetList?.find(e => e.target_key === env.target_key)?.auth_state
    ?? instancePage?.envList?.find(e => same(e.env_id, env.env_id))?.auth_state;
  if (approval !== 'N') fail('environment_approval_or_unknown');
  const inst = result.appInsts.find(i => same(i.appinst_id, plan.instances[0].instanceId));
  if (!inst || !same(inst.app_id, appId) || !same(inst.env_id, env.env_id) || inst.inst_type !== 'k8s'
    || !inst.cluster_id || !inst.k8s_namespace || inst.k8s_namespace !== plan.instances[0].namespace) fail('instance_changed');
  const active = conflicts(rows, plan);
  if (active.length) return { status: 'blocked', reason: 'inflight_tasks', tasks: active.map(r => ({ buildId: r.build_id, batch: r.batch, state: r.state })) };
  const compiler = options.compiler || (same(history?.app_id, appId) ? history.compiler_version : null);
  const compilers = ['NODE14', 'NODE16', 'NODE18', 'NODE20', 'NODE22'];
  if (!compilers.includes(compiler)) return { status: 'needs_selection', question: 'compiler', candidates: compilers };
  if (typeof app.build_params !== 'string' || !app.build_params.trim() || !app.proline_id || !app.proline_name || !app.k8s_template) fail('incomplete_build_configuration');
  if (!Number.isInteger(user?.user_id) || user.user_id <= 0) fail('current_user_unavailable');
  const sca = await api.get('/bwton/oapi/sca', { proline_name: app.proline_name, app_name: app.app_name, branch: plan.project.branch });
  if (!Array.isArray(sca)) fail('invalid_sca_response');
  const payload = {
    release_info: '', git_branch: plan.project.branch, envVal: env.target_key,
    envInfo: { envId: String(env.env_id), targetKey: env.target_key, scopeId: env.scope_id ?? null },
    target_key: env.target_key, scope_id: env.scope_id ?? null, deployType: 'k8s', nacosId: null,
    cicdType: 'cicd', exeMode: 'order', packageId: '', curInstList: [inst],
    k8snameSpace: null, k8sTemplate: app.k8s_template, k8s_yaml_path: inst.k8s_yml_path ?? null,
    compiler_version: compiler, build_tool: null,
    ...Object.fromEntries(['app_id', 'proline_id', 'app_name', 'git_url', 'build_params', 'proline_name', 'app_type',
      'build_num', 'target_name', 'replace_start_sh', 'dockerfile_path', 'replace_logback'].map(k => [k, app[k] ?? null])),
    arch32: 'Y', scaList: sca, user_id: user.user_id, create_userid: user.user_id,
    release_id: '', batch: '', build_id: '', need_buildid: 1, passPackage: true, optype: 'publish',
  };
  const summary = { application: plan.application, environment: plan.environment, instances: plan.instances,
    branch: plan.project.branch, expectedRemoteCommit: plan.project.remoteCommit, compiler,
    buildParams: app.build_params, template: app.k8s_template, operation: 'build_and_publish',
    permission: 'server_enforced_on_submit', recentTasksChecked: rows.length,
    sca: { requestedBranch: plan.project.branch, returnedBranches: [...new Set(sca.map(item => item.branch || 'unknown'))],
      coverage: sca.length && sca.every(item => item.branch === plan.project.branch) ? 'branch_matches_commit_not_verified' : 'current_branch_not_verified' } };
  return { status: 'ready', summary, payload, planHash: fingerprint({ summary, payload }) };
}

export async function submit(token, request, payload) {
  const client = await request.newContext();
  try {
    // No retries: any lost response is ambiguous, including HTTP 5xx and malformed success.
    const r = await client.post(`${ORIGIN}/bwton/app/cicd`, {
      headers: { 'X-Token': token }, data: payload, maxRedirects: 0, maxRetries: 0, timeout: 90000,
    });
    if ([401, 403].includes(r.status())) return { status: 'rejected', reason: r.status() === 401 ? 'auth_required' : 'permission_denied' };
    if (r.status() !== 200) return { status: 'submission_unknown', reason: 'unexpected_http_status' };
    let b; try { b = await r.json(); } catch { return { status: 'submission_unknown', reason: 'invalid_response' }; }
    if ([1001, 1002].includes(b?.code)) return { status: 'rejected', reason: 'auth_required' };
    if (b?.code !== 200) return { status: 'submission_unknown', reason: 'api_error_check_records', code: typeof b?.code === 'number' ? b.code : null };
    const d = b.data;
    if (!d?.build_id || !d.batch || !d.logs_id || !same(d.app_id, payload.app_id) || !same(d.env_id, payload.envInfo.envId)) {
      return { status: 'submission_unknown', reason: 'missing_or_mismatched_receipt' };
    }
    return { status: 'submitted', receipt: { appId: String(d.app_id), envId: String(d.env_id),
      buildId: d.build_id, batch: d.batch, logsId: String(d.logs_id) } };
  } catch { return { status: 'submission_unknown', reason: 'request_interrupted' }; }
  finally { await client.dispose(); }
}

export async function track(api, receipt) {
  const rows = await records(api, receipt.appId, receipt.envId);
  const matched = rows.filter(r => same(r.app_id, receipt.appId) && same(r.env_id, receipt.envId)
    && r.build_id === receipt.buildId && r.batch === receipt.batch);
  const row = matched.find(r => r.build_applog_id);
  if (!row) return { status: 'running', phase: 'awaiting_correlated_record', receipt };
  const build = await api.get('/bwton/app/applog/jenkins', { applog_id: row.build_applog_id, cursor: 0 });
  if (!same(build?.applog_id, row.build_applog_id)) fail('build_identity_mismatch');
  if (failures.has(build.state)) return { status: 'failed', phase: 'build', receipt, state: build.state };
  if (build.state !== 'success' || build.summary?.is_finished !== true) return { status: 'running', phase: 'build', receipt, state: build.state };
  const runtime = await api.get('/bwton/logs/info', { logs_id: receipt.logsId, option: 'runtime', index: 0 });
  if (!same(runtime?.logs_id, receipt.logsId)) fail('release_identity_mismatch');
  const runner = runtime.runner_result || {};
  if ([runtime.state, runner.publish_status, runner.stage, runner.startup_status].some(s => failures.has(s) || s === 'abnormal')) {
    return { status: 'failed', phase: 'release', receipt, state: runtime.state, publishStatus: runner.publish_status, startupStatus: runner.startup_status };
  }
  const succeeded = runtime.state === 'success' && runner.publish_status === 'success' && runner.startup_status === 'normal'
    && matched.some(r => r.op_type === 'publish' && same(r.log_id, receipt.logsId) && r.state === 'success');
  return { status: succeeded ? 'success' : 'running', phase: succeeded ? 'complete' : 'release', receipt,
    buildState: build.state, releaseState: runtime.state, publishStatus: runner.publish_status,
    startupStatus: runner.startup_status, sourcePackage: row.source_package || null,
    gitBranch: row.git_branch || null, commitId: row.commit_id || null,
    verification: '平台构建、发布和启动状态；不代表业务功能回归或完整提交哈希验证' };
}
