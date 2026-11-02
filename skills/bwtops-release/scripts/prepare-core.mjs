import { ORIGIN } from './auth.mjs';
import { PreparationError, repositoryKey } from './project.mjs';

const READ_PATHS = new Set(['/bwton/app/list', '/bwton/app/env', '/bwton/app/instance', '/bwton/app/applog', '/bwton/app/applog/jenkins', '/bwton/logs/info', '/bwton/user/info', '/bwton/oapi/sca']);

export async function readOnlyApi(token, request) {
  const client = await request.newContext();
  return {
    async get(endpoint, params) {
      if (!READ_PATHS.has(endpoint)) throw new PreparationError('unsupported_read_endpoint');
      const url = new URL(endpoint, ORIGIN);
      url.search = new URLSearchParams(params).toString();
      let response;
      try { response = await client.get(url.href, { headers: { 'X-Token': token }, maxRedirects: 0, timeout: 15000 }); }
      catch { throw new PreparationError('network_error'); }
      try {
        if (response.status() === 401) throw new PreparationError('auth_required');
        if (response.status() === 403) throw new PreparationError('permission_denied');
        if (response.status() !== 200) throw new PreparationError('http_error');
        let body;
        try { body = await response.json(); } catch { throw new PreparationError('invalid_response'); }
        if ([1001, 1002].includes(body?.code)) throw new PreparationError('auth_required');
        if (body?.code !== 200) throw new PreparationError('api_error');
        return body.data;
      } finally { await response.dispose(); }
    },
    close: () => client.dispose(),
  };
}

function requireShape(condition) {
  if (!condition) throw new PreparationError('invalid_response');
}
const id = value => String(value);
const hasId = value => value !== undefined && value !== null && String(value) !== '';
const question = (name, candidates, context) => ({ status: 'needs_selection', question: name, candidates, context });
const blocked = reason => ({ status: 'blocked', reason });

async function applications(api) {
  const apps = new Map();
  for (let page = 1; page <= 1000; page++) {
    const data = await api.get('/bwton/app/list', {
      current_page: page, page_size: 100, state: 1,
      app_type: '', app_flag: '', app_name: '', prolineid: '', git_url: '', owner_id: '',
    });
    requireShape(Array.isArray(data?.app_list) && Number.isInteger(data.total) && data.total >= 0);
    const before = apps.size;
    for (const app of data.app_list) {
      requireShape(hasId(app.app_id) && typeof app.app_name === 'string');
      apps.set(id(app.app_id), app);
    }
    if (apps.size >= data.total) return [...apps.values()];
    if (apps.size === before) throw new PreparationError('incomplete_application_list');
  }
  throw new PreparationError('incomplete_application_list');
}

export async function prepare(project, api, options = {}) {
  if (project.status !== 'project_resolved') return project;
  if (options.acceptRemoteCommit && options.acceptRemoteCommit !== project.remoteCommit) return blocked('remote_commit_changed');
  if ((project.worktreeDirty || project.commitsDiffer) && options.acceptRemoteCommit !== project.remoteCommit) {
    return question('code_version', [
      { action: 'use_remote', commit: project.remoteCommit, label: '仅发布此远端提交，本地改动不包含在内' },
      { action: 'stop', label: '先处理本地代码，再重新准备' },
    ], project);
  }
  const matching = (await applications(api)).filter(app => repositoryKey(app.git_url) === project.repository);
  if (!matching.length) return blocked('application_not_found');
  let app;
  if (options.appId) {
    app = matching.find(a => id(a.app_id) === options.appId);
    if (!app) return blocked('application_selection_invalid');
  } else if (matching.length === 1) app = matching[0];
  else return question('application', matching.map(a => ({ appId: id(a.app_id), name: a.app_name, productLine: a.proline_name })), project);
  const detail = await api.get('/bwton/app/list', { app_id: app.app_id });
  requireShape(detail && hasId(detail.app_id));
  if (id(detail.app_id) !== id(app.app_id) || repositoryKey(detail.git_url) !== project.repository || String(detail.state) !== '1') {
    return blocked('application_changed_or_disabled');
  }
  const context = { project, application: { appId: id(app.app_id), name: detail.app_name, repository: project.repository } };
  const envs = await api.get('/bwton/app/env', { app_id: app.app_id, optype: 'getEnv' });
  requireShape(Array.isArray(envs));
  const devEnvs = envs.filter(e => e.env_type === 'dev');
  requireShape(devEnvs.every(e => hasId(e.env_id)));
  const devs = devEnvs.map(e => ({
    targetKey: e.target_key, envId: id(e.env_id), name: e.alias_name,
    deploymentUnit: e.scope_ref_name || e.env_flag, scopeId: e.scope_id ?? null, type: 'dev',
  }));
  requireShape(devs.every(e => typeof e.targetKey === 'string' && e.targetKey && e.envId !== 'undefined'));
  requireShape(new Set(devs.map(e => e.targetKey)).size === devs.length);
  if (!devs.length) return blocked('no_dev_environment');
  let target;
  if (options.targetKey) {
    target = devs.find(e => e.targetKey === options.targetKey);
    if (!target) return blocked('dev_target_selection_invalid');
  } else if (devs.length === 1) target = devs[0];
  else return question('environment', devs, context);
  context.environment = target;

  // Both read paths were observed in the UI; do not infer deployment type from env names.
  const groups = await Promise.all(['k8s', 'server'].map(async deployType => {
    const result = await api.get('/bwton/app/instance', {
      app_id: app.app_id, deploy_type: deployType, env_id: target.envId, target_key: target.targetKey,
    });
    requireShape(Array.isArray(result?.appInsts));
    return result.appInsts.filter(inst => id(inst.app_id) === id(app.app_id) && id(inst.env_id) === target.envId && inst.inst_type === deployType)
      .map(inst => {
        requireShape(hasId(inst.appinst_id));
        return { instanceId: id(inst.appinst_id), name: inst.inst_name, deployType,
          namespace: inst.k8s_namespace || null, host: inst.host_name || null,
          clusterId: inst.cluster_id ?? null, replicas: inst.k8s_replicas ?? null };
      });
  }));
  const instances = [...new Map(groups.flat().map(i => [i.instanceId, i])).values()];
  if (!instances.length) return blocked('no_deployable_instance');
  const types = [...new Set(instances.map(i => i.deployType))];
  const deployType = options.deployType || (types.length === 1 ? types[0] : null);
  if (!deployType) return question('deployment_type', types.map(type => ({ deployType: type, instanceCount: instances.filter(i => i.deployType === type).length })), context);
  if (!types.includes(deployType)) return blocked('deployment_type_selection_invalid');
  context.deployType = deployType;
  const eligible = instances.filter(i => i.deployType === deployType);
  let selected;
  if (options.instanceIds?.length) {
    const ids = new Set(options.instanceIds);
    selected = eligible.filter(i => ids.has(i.instanceId));
    if (selected.length !== ids.size) return blocked('instance_selection_invalid');
    if (deployType === 'k8s' && selected.length > 1) return { ...question('instances', eligible, context), maxSelections: 1, reason: 'k8s_requires_one_instance' };
  } else if (eligible.length === 1) selected = eligible;
  else return { ...question('instances', eligible, context), maxSelections: deployType === 'k8s' ? 1 : eligible.length };
  return { status: 'prepared', readOnly: true, ...context, instances: selected,
    operation: 'build_and_publish', expectedRemoteCommit: project.remoteCommit,
    checkedAt: new Date().toISOString(),
    remainingChecks: ['build_configuration', 'publish_permissions', 'inflight_tasks', 'submission_time_revalidation'],
    note: '仅完成只读目标与代码准备，尚未验证完整发布配置或提交任何任务。',
  };
}
