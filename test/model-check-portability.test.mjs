// Real moved-installation prepare-only checks; no provider status, login or model calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, writeFile, readdir, lstat, realpath } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { packageApp } from '../scripts/package.mjs';
import { PROJECT_ROOT, checkedPath, isWithin } from '../server/paths.mjs';
import { deserializeProject, serializeProject, buildPolishInput, exportMarkdown } from '../public/core.mjs';
import { buildModelCase } from '../scripts/prepare-model-cases.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fileSnapshot(directory) {
  const result = {};
  async function walk(current) {
    for (const name of (await readdir(current)).sort()) {
      const filename = path.join(current, name);
      const info = await lstat(filename);
      assert.equal(info.isSymbolicLink(), false, `Unexpected link: ${filename}`);
      if (info.isDirectory()) await walk(filename);
      else result[path.relative(directory, filename)] = hash(await readFile(filename));
    }
  }
  await walk(directory);
  return result;
}

test('moved checker prepares both fixed baselines from unrelated cwd into an independent Chinese-space data directory', { timeout: 120000 }, async t => {
  const parent = await checkedPath(path.join(PROJECT_ROOT, '.runtime/model-check-portability'));
  await mkdir(parent, {recursive: true});
  const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const unique = await checkedPath(path.join(parent, stamp));
  await mkdir(unique);
  const installation = path.join(unique, '中文 安装包');
  const dataRoot = path.join(unique, '独立 业务目录');
  const unrelatedCwd = path.join(unique, '无关 cwd');
  await mkdir(unrelatedCwd);
  const sourcePackage = JSON.parse(await readFile(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
  const copied = await packageApp(installation);
  assert.ok(copied.files.includes('scripts/check-model.mjs'));
  const packageJson = JSON.parse(await readFile(path.join(installation, 'package.json'), 'utf8'));
  assert.equal(packageJson.version, sourcePackage.version);
  const installationBefore = await fileSnapshot(installation);
  const manifestPath = process.env.DW_MODEL_CASE_MANIFEST ? path.resolve(process.env.DW_MODEL_CASE_MANIFEST) : null;
  const baselineRoot = manifestPath ? path.dirname(manifestPath) : path.join(dataRoot, '.runtime/portability-inputs');
  const baselines = new Map();
  if (manifestPath) {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    for (const caseId of ['normal', 'protected-conflict']) {
      const prepared = manifest.cases.find(entry => entry.caseId === caseId)?.files?.prepared;
      assert.ok(prepared?.path && prepared.sha256, `Missing prepared baseline: ${caseId}`);
      const filename = path.resolve(path.dirname(manifestPath), prepared.path);
      assert.equal(hash(await readFile(filename)), prepared.sha256);
      baselines.set(caseId, filename);
    }
  } else {
    // A clean checkout has no ignored .runtime baselines: prepare from committed fictional material.
    await mkdir(baselineRoot, {recursive: true});
    for (const caseId of ['normal', 'protected-conflict']) {
      const {project} = await buildModelCase(caseId);
      const filename = path.join(baselineRoot, `${caseId}-prepared.json`);
      await writeFile(filename, serializeProject(project), {flag: 'wx'});
      baselines.set(caseId, filename);
    }
  }
  const checker = path.join(installation, 'scripts/check-model.mjs');
  const childEnv = {...process.env, DW_DATA_DIR: dataRoot,
    DW_CODEX_BIN: path.join(unique, '不应调用', 'missing-codex.exe'),
    TEMP: path.join(dataRoot, '.runtime/temp'), TMP: path.join(dataRoot, '.runtime/temp'), TMPDIR: path.join(dataRoot, '.runtime/temp'),
    APPDATA: path.join(dataRoot, '.runtime/app-data'), LOCALAPPDATA: path.join(dataRoot, '.runtime/app-data'),
    XDG_CACHE_HOME: path.join(dataRoot, '.runtime/cache'), XDG_CONFIG_HOME: path.join(dataRoot, '.runtime/config'), XDG_DATA_HOME: path.join(dataRoot, '.runtime/app-data'),
  };
  for (const name of Object.keys(childEnv)) {
    if (/^(CODEX_PROJECT_PROFILE_DIR|CODEX_HOME|CODEX_SQLITE_HOME|CODEX_API_KEY|OPENAI_API_KEY)$/i.test(name)) delete childEnv[name];
  }
  assert.equal(Object.keys(childEnv).some(name => /^CODEX_PROJECT_PROFILE_DIR$/i.test(name)), false);
  const reportDirectory = path.join(dataRoot, '.runtime/model-validation');
  const reports = [];
  for (const caseId of ['normal', 'protected-conflict']) {
    await t.test(`${caseId}: actual child output is input-only, source-identical and data-root-contained`, async () => {
      const baseline = baselines.get(caseId);
      const baselineBytes = await readFile(baseline);
      const original = deserializeProject(baselineBytes.toString('utf8'));
      const reportsBefore = new Set(await readdir(reportDirectory).catch(error => {if (error.code === 'ENOENT') return []; throw error;}));
      const args = [checker, '--prepare-only', '--project', baseline];
      const child = spawnSync(process.execPath, args, {cwd: unrelatedCwd, env: childEnv, encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024});
      assert.equal(child.error, undefined, child.error?.message);
      assert.equal(child.status, 0, `Moved prepare-only failed:\n${child.stdout}\n${child.stderr}`);
      assert.equal(child.signal, null);
      const added = (await readdir(reportDirectory)).filter(name => name.endsWith('-report.json') && !reportsBefore.has(name));
      assert.equal(added.length, 1);
      const reportPath = path.join(reportDirectory, added[0]);
      const report = JSON.parse(await readFile(reportPath, 'utf8'));
      assert.equal(report.mode, 'prepare-only');
      assert.equal(report.evidence, 'runtime');
      assert.equal(report.status, 'PREPARED');
      assert.equal(report.provider, null);
      assert.equal(Object.hasOwn(report, 'providers'), false);
      for (const key of ['bridgeCallAttempted', 'validatedModelOutputReceived', 'validatedGenerationCompleted', 'liveValidatedGenerationCompleted', 'reviewArtifactSaved']) assert.equal(report[key], false, key);
      assert.equal(report.rawResult, null);
      assert.equal(report.reviewProject, null);
      assert.equal(report.draftUnchanged, true);
      assert.equal(report.review.appliedAutomatically, false);
      assert.equal(report.sourceFiles.length, 1);
      assert.equal(report.sourceFiles[0].path, baseline);
      assert.equal(report.sourceFiles[0].sha256, hash(baselineBytes));
      for (const filename of [reportPath, report.preparedProject, report.preparedMarkdown, report.modelInput]) {
        assert.equal(isWithin(dataRoot, filename), true);
        await checkedPath(filename, dataRoot);
        assert.equal(isWithin(await realpath(dataRoot), await realpath(filename)), true);
      }
      const writtenBytes = await readFile(report.preparedProject);
      const inputBytes = await readFile(report.modelInput);
      const written = deserializeProject(writtenBytes.toString('utf8'));
      assert.deepEqual(written, original);
      assert.equal(await readFile(report.preparedMarkdown, 'utf8'), exportMarkdown(original));
      assert.deepEqual(JSON.parse(inputBytes.toString('utf8')), buildPolishInput(original));
      assert.equal(report.preparedProjectSha256, hash(writtenBytes));
      assert.equal(report.modelInputSha256, hash(inputBytes));
      assert.deepEqual(await readFile(baseline), baselineBytes);
      assert.deepEqual(written.protection, {numbers: true, quotes: true});
      assert.equal(written.draft.filter(block => block.locked).length, caseId === 'protected-conflict' ? 1 : 0);
      const logDirectory = path.join(dataRoot, '.runtime/portability-evidence');
      await mkdir(logDirectory, {recursive: true});
      await writeFile(path.join(logDirectory, `${caseId}.json`), JSON.stringify({caseId, executable: process.execPath, args, cwd: unrelatedCwd, dataRoot, installation, reportPath, exitCode: child.status, stdout: child.stdout, stderr: child.stderr}, null, 2), {flag: 'wx'});
      reports.push({caseId, reportPath});
    });
  }
  assert.deepEqual(await fileSnapshot(installation), installationBefore);
  await assert.rejects(lstat(path.join(installation, '.runtime')), {code: 'ENOENT'});
  assert.deepEqual(await readdir(unrelatedCwd), []);
  for (const filename of Object.keys(await fileSnapshot(dataRoot))) await checkedPath(path.join(dataRoot, filename), dataRoot);
  assert.equal(reports.length, 2);
  const result = {status: 'passed', caseCount: 2, installation, dataRoot, unrelatedCwd, version: packageJson.version,
    packaging: 'packageApp runtime allowlist', installationUnchanged: true, installationRuntimeCreated: false,
    bridgeCallAttempted: false, providerStatusChecked: false, baselineRoot, manifestPath,
    inputMode: manifestPath ? 'provided-manifest' : 'prepared-from-committed-fictional-material', reports};
  const resultPath = path.join(dataRoot, '.runtime/portability-evidence/result.json');
  await writeFile(resultPath, JSON.stringify(result, null, 2), {flag: 'wx'});
  console.log(JSON.stringify({...result, resultPath}, null, 2));
});
