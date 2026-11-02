import path from 'node:path';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { fingerprint } from './release-core.mjs';

export async function save(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(value), { mode: 0o600 }); await rename(temp, file);
}
export async function unlock(dir, run) {
  if (!/^[a-f0-9]{64}$/.test(run.lockKey || '')) return;
  const file = path.join(dir, `${run.lockKey}.lock`);
  try { if (await readFile(file, 'utf8') === run.requestId) await unlink(file); } catch { /* Retained lock blocks further submission. */ }
}
export async function submitOnce(dir, requestId, ready, post) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${requestId}.json`);
  const lockKey = fingerprint({ appId: ready.summary.application.appId, envId: ready.summary.environment.envId });
  const run = { requestId, status: 'submission_unknown', summary: ready.summary,
    planHash: ready.planHash, lockKey, createdAt: new Date().toISOString() };
  try { await writeFile(file, JSON.stringify(run), { flag: 'wx', mode: 0o600 }); }
  catch { return { status: 'blocked', reason: 'request_id_exists_or_unwritable', requestId }; }
  try { await writeFile(path.join(dir, `${lockKey}.lock`), requestId, { flag: 'wx', mode: 0o600 }); }
  catch { run.status = 'not_submitted'; await save(file, run); return { status: 'blocked', reason: 'target_locked_or_unwritable', requestId }; }
  // Intent is durable before POST. Keep it and the target lock if POST or persistence throws.
  const result = await post();
  Object.assign(run, result); await save(file, run);
  if (run.status === 'rejected') await unlock(dir, run);
  return run;
}
