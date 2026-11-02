import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

export class PreparationError extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}

export function repositoryKey(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  try {
    let host, repo, port = '';
    if (raw.includes('://')) {
      const u = new URL(raw);
      if (!['https:', 'http:', 'ssh:', 'git:'].includes(u.protocol) || u.search || u.hash) return null;
      host = u.hostname.toLowerCase(); repo = u.pathname;
      // Default SSH/HTTPS/HTTP ports refer to the same repository identity.
      if (u.port && !((u.protocol === 'ssh:' && u.port === '22') ||
        (u.protocol === 'git:' && u.port === '9418'))) port = `:${u.port}`;
    } else {
      const match = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/.exec(raw);
      if (!match || raw.includes('::') || /^[A-Za-z]:[\\/]/.test(raw)) return null;
      host = match[1].toLowerCase(); repo = match[2];
    }
    repo = repo.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
    if (!host || !repo || repo.split('/').some(x => !x || x === '.' || x === '..')) return null;
    return `${host}${port}/${repo}`;
  } catch { return null; }
}

async function git(repo, args, optional = false) {
  try {
    const { stdout } = await exec('git', ['-C', repo, ...args], {
      encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never',
        GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=15' },
    });
    return stdout.trim();
  } catch {
    if (optional) return null;
    throw new PreparationError('git_read_failed');
  }
}

export async function inspectProject(options) {
  const root = await git(options.repo, ['rev-parse', '--show-toplevel'], true);
  if (!root) return { status: 'needs_selection', question: 'project', message: '请指定要发布的 Git 项目目录。' };
  const names = (await git(root, ['remote'])).split('\n').filter(Boolean);
  const remotes = [];
  for (const name of names) {
    const url = await git(root, ['remote', 'get-url', name]);
    const key = repositoryKey(url);
    if (key) remotes.push({ name, repository: key }); // Never print credential-bearing remote URLs.
  }
  if (!remotes.length) return { status: 'blocked', reason: 'no_supported_remote', root };
  let remote = options.remote;
  if (remote && !remotes.some(r => r.name === remote)) return { status: 'blocked', reason: 'invalid_remote' };
  if (!remote) remote = remotes.find(r => r.name === 'origin')?.name || (remotes.length === 1 ? remotes[0].name : null);
  if (!remote) return { status: 'needs_selection', question: 'remote', candidates: remotes, root };
  const currentBranch = await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], true);
  const branch = options.branch || currentBranch;
  if (branch && await git(root, ['check-ref-format', `refs/heads/${branch}`], true) === null) {
    return { status: 'blocked', reason: 'invalid_branch' };
  }
  // ls-remote reads the actual remote tip without changing local refs or the checkout.
  let refs;
  try { refs = await git(root, ['ls-remote', '--heads', remote, ...(branch ? [`refs/heads/${branch}`] : [])]); }
  catch { throw new PreparationError('remote_query_failed'); }
  const remoteBranches = refs.split('\n').filter(Boolean).map(line => {
    const [commit, ref] = line.split(/\s+/);
    return { branch: ref?.replace(/^refs\/heads\//, ''), commit };
  });
  if (!branch) return { status: 'needs_selection', question: 'branch', reason: 'detached_head', root, remote, candidates: remoteBranches };
  const remoteCommit = remoteBranches.find(r => r.branch === branch)?.commit;
  if (!remoteCommit) return { status: 'needs_selection', question: 'branch', reason: 'remote_branch_missing', root, remote, branch };
  const localCommit = await git(root, ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`], true);
  const dirty = await git(root, ['status', '--porcelain=v1', '--untracked-files=normal']);
  return { status: 'project_resolved', root, remote,
    repository: remotes.find(r => r.name === remote).repository,
    currentBranch, branch, localCommit, remoteCommit,
    worktreeDirty: Boolean(dirty), commitsDiffer: localCommit !== null && localCommit !== remoteCommit };
}
