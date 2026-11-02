import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { inspectProject } from './project.mjs';
test('真实 Git 仓库：拒绝不支持的远端、无效 remote 和分支，识别非仓库', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bwtops-git-'));
  const remote = path.join(root, 'remote.git');
  const repo = path.join(root, 'work');
  const git = (args, cwd = root) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  try {
    git(['init', '--bare', remote]); git(['init', '-b', 'main', repo]);
    git(['config', 'user.email', 'test@example.invalid'], repo); git(['config', 'user.name', 'Test'], repo);
    await writeFile(path.join(repo, 'app.txt'), 'a'); git(['add', '.'], repo); git(['commit', '-m', 'initial'], repo);
    git(['remote', 'add', 'origin', 'https://git.example/a/demo.git'], repo);
    git(['remote', 'set-url', 'origin', `ext::git-upload-pack ${remote}`], repo);
    // inspectProject intentionally rejects local/ext transports; verify that boundary here.
    assert.equal((await inspectProject({ repo })).reason, 'no_supported_remote');
    git(['remote', 'set-url', 'origin', 'https://git.example/a/demo.git'], repo);
    assert.equal((await inspectProject({ repo, remote: 'missing' })).reason, 'invalid_remote');
    assert.equal((await inspectProject({ repo, branch: 'bad..branch' })).reason, 'invalid_branch');
    assert.equal((await inspectProject({ repo: root })).question, 'project');
  } finally { await rm(root, { recursive: true, force: true }); }
});
