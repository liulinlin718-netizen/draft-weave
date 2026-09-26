import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir, symlink, unlink } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { packageApp } from '../scripts/package.mjs';
import { PROJECT_ROOT, runtimePaths, checkedPath, childEnvironment } from '../server/paths.mjs';

const runRoot = path.join(PROJECT_ROOT, '.runtime', 'release-checks', randomUUID());
const data = path.join(runRoot, '用户资料 with spaces');

test('explicit data directory contains export, CLI and browser cache paths without changing parent environment', async () => {
  const env = { DW_DATA_DIR: data, TEMP: 'unchanged', APPDATA: 'unchanged' };
  const paths = await runtimePaths(env);
  assert.equal(paths.root, data);
  const isolated = childEnvironment(paths, env);
  for (const key of ['TEMP', 'TMP', 'TMPDIR', 'APPDATA', 'LOCALAPPDATA', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME']) {
    assert.equal(await checkedPath(isolated[key], data), isolated[key]);
  }
  assert.equal(env.TEMP, 'unchanged'); assert.equal(env.APPDATA, 'unchanged');
  await assert.rejects(runtimePaths({ DW_DATA_DIR: data, CODEX_PROJECT_PROFILE_DIR: path.join(runRoot, 'outside') }), { code: 'UNSAFE_PATH' });
  await assert.rejects(checkedPath(path.join(data, '..', 'escape.md'), data), { code: 'UNSAFE_PATH' });
  const link = path.join(data, 'linked');
  await symlink(runRoot, link, process.platform === 'win32' ? 'junction' : 'dir');
  try { await assert.rejects(checkedPath(path.join(link, 'bad.md'), data), { code: 'UNSAFE_PATH' }); }
  finally { await unlink(link); }
});

test('allowlisted release runs from a moved Unicode/space directory and exports to separate user data', async () => {
  const installation = path.join(runRoot, '可搬移 application');
  const pack = await packageApp(installation);
  assert.ok(pack.files.length > 10);
  assert.ok(pack.files.includes('README.md'));
  assert.ok(pack.files.includes('README.zh-CN.md'));
  const manifest = JSON.parse(await readFile(path.join(installation, 'package.json'), 'utf8'));
  const sourceManifest = JSON.parse(await readFile(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
  assert.equal(manifest.name, 'draft-weave');
  assert.equal(manifest.version, sourceManifest.version);
  assert.ok(!pack.files.some(file => /(?:^|\/)(?:\.runtime|output|outputs|test|node_modules)(?:\/|$)|AGENTS|STATUS|VALIDATION|START_TASK/.test(file)));
  for (const file of pack.files.filter(file => /\.(mjs|ps1|html)$/.test(file))) {
    assert.doesNotMatch(await readFile(path.join(installation, file), 'utf8'), /[A-Z]:[/\\]Users[/\\][^\s'"`]+|Use-DDriveDev/i);
  }
  const { runtimePaths: movedPaths } = await import(pathToFileURL(path.join(installation, 'server', 'paths.mjs')).href);
  assert.equal((await movedPaths({})).root, installation);
  const document = '# 自定义研发笔记\n\n用户自己的正文，包含中文与 emoji 🪡。\n';
  const env = { ...process.env, DW_PORT: '6413', DW_DATA_DIR: data, CODEX_PROJECT_PROFILE_DIR: '' };
  const child = spawn(process.execPath, [path.join(installation, 'server.mjs')], { cwd: runRoot, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit'); let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const base = 'http://127.0.0.1:6413';
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Server did not start: ${stderr}`)), 10000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error(`Startup failed: ${stderr}`)); });
      child.stdout.on('data', chunk => { if (String(chunk).includes(base)) { clearTimeout(timer); resolve(); } });
    });
    assert.match(await (await fetch(base)).text(), /文稿拼接画布/);
    assert.ok(pack.files.includes('public/window-drafts.mjs'));
    const windows = await fetch(base + '/window-drafts.mjs');
    assert.equal(windows.status, 200);
    assert.match(await windows.text(), /draft-weave.default-writer.v1/);
    for (const module of ['input-journal.mjs', 'polish-request.mjs']) {
      assert.ok(pack.files.includes(`public/${module}`));
      const response = await fetch(base + '/' + module);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /javascript/);
    }
    const exported = await fetch(`${base}/api/export`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ filename: '研发笔记.md', content: document }) });
    assert.equal(exported.status, 201);
    const result = await exported.json();
    assert.equal(path.dirname(result.path), path.join(data, 'outputs', 'exports'));
    assert.equal(await readFile(result.path, 'utf8'), document);
    const downloaded = await fetch(base + result.downloadUrl);
    assert.match(downloaded.headers.get('content-disposition'), /attachment/);
    assert.equal(await downloaded.text(), document);
    assert.equal((await fetch(base + '/.runtime/codex-profile/auth.json')).status, 404);
    assert.deepEqual(await readdir(path.join(installation, 'outputs', 'exports')), []);
    await writeFile(path.join(runRoot, 'result.json'), JSON.stringify({ passed: true, release: pack, data, actualExport: result.path }, null, 2));
  } finally { child.kill(); await exited; }
});
