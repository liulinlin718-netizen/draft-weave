// Every injected status/model response below is a CONTRACT FIXTURE.
// This suite never checks real login status and never makes a model request.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { checkModel, parseOptions } from '../scripts/check-model.mjs';
import { createProject, addSource, selectBlocks, toggleLock, serializeProject, deserializeProject, exportMarkdown, buildPolishInput } from '../public/core.mjs';
import { ensureDirectory, PROJECT_ROOT } from '../server/paths.mjs';
import { BridgeError } from '../server/model-bridge.mjs';

const hash = input => createHash('sha256').update(input).digest('hex');
const quiet = { log() {}, error() {} };
const unavailable = async () => ({
  'external-api': { ready: false, code: 'NOT_CONFIGURED', message: 'CONTRACT FIXTURE missing key', model: 'fixture-model' },
  'codex-cli': { ready: false, code: 'NOT_LOGGED_IN', message: 'CONTRACT FIXTURE logged out', model: 'fixture-model' },
});
const ready = async () => ({
  'external-api': { ready: true, code: 'READY', message: 'CONTRACT FIXTURE configured only', model: 'fixture-model' },
  'codex-cli': { ready: true, code: 'READY', message: 'CONTRACT FIXTURE ChatGPT status', model: 'fixture-model' },
});
const neverPolish = async () => { assert.fail('This contract case must not call a model.'); };
async function setup() {
  const directory = await ensureDirectory(path.join(PROJECT_ROOT, '.runtime', 'model-check-contract', randomUUID()));
  const env = { ...process.env, DW_DATA_DIR: directory, DW_MODEL_TIMEOUT_MS: '5000' };
  delete env.CODEX_PROJECT_PROFILE_DIR;
  let project = createProject({ title: '独立新稿 · CONTRACT FIXTURE' });
  project = addSource(project, { id: 'new_source', name: '新输入稿.txt', text: '# 新项目\n\n系统服务 120 人。\n\n这让流程更清楚。\n\n“这段引文必须保持。”' });
  project = selectBlocks(project, project.sources[0].id, project.sources[0].blocks.map(block => block.id));
  project = toggleLock(project, project.draft[3].id);
  const filename = path.join(directory, '用户保存项目 含空格.json');
  const serialized = serializeProject(project);
  await writeFile(filename, serialized);
  return { directory, env, project, filename, serialized };
}
const outputFor = input => ({ summary: 'CONTRACT FIXTURE whole-document suggestions', changes: [
  { blockId: input.blocks[2].id, before: input.blocks[2].text, after: '上述分工让流程更清楚。', reason: 'CONTRACT FIXTURE 指代改进' },
  { blockId: input.blocks[1].id, before: input.blocks[1].text, after: '系统服务 121 人。', reason: 'CONTRACT FIXTURE 应拦截的数字修改' },
  { blockId: input.blocks[3].id, before: input.blocks[3].text, after: '“这段引文遭到修改。”', reason: 'CONTRACT FIXTURE 应拦截的锁和引文修改' },
] });

test('argument modes remain non-generating by default; malformed values fail before work', () => {
  assert.equal(parseOptions([]).mode, 'status-only');
  assert.equal(parseOptions(['--provider', 'codex-cli', '--status']).mode, 'status-only');
  assert.equal(parseOptions(['--provider', 'external-api', '--prepare-only']).mode, 'prepare-only');
  assert.equal(parseOptions(['--provider', 'external-api']).mode, 'real-request');
  for (const argv of [['--project'], ['--provider'], ['--timeout-ms'], ['--timeout-ms', '49'], ['--timeout-ms', '600001'], ['--timeout-ms', '1.5'], ['--provider', 'unknown']]) assert.throws(() => parseOptions(argv));
});

test('prepare-only accepts a new saved project, writes exact input/provenance and never probes providers (CONTRACT FIXTURE)', async () => {
  const fixture = await setup(); const originalEnv = { ...fixture.env };
  let statusCalls = 0;
  const result = await checkModel(['--project', fixture.filename, '--prepare-only', '--provider', 'codex-cli', '--timeout-ms', '275'], {
    env: fixture.env, statusImpl: async () => { statusCalls++; assert.fail('prepare-only cannot inspect credentials'); }, polishImpl: neverPolish, logger: quiet,
  });
  assert.equal(result.exitCode, 0); assert.equal(result.record.status, 'PREPARED'); assert.equal(statusCalls, 0);
  assert.equal(result.record.evidence, 'contract-fixture');
  assert.equal(result.record.bridgeCallAttempted, false); assert.equal(result.record.validatedModelOutputReceived, false);
  assert.equal(result.record.reviewArtifactSaved, false);
  assert.equal(result.record.generationElapsedMs, null); assert.equal(result.record.timeoutMs, 275);
  assert.deepEqual(fixture.env, originalEnv);
  assert.equal(await readFile(result.record.preparedProject, 'utf8'), fixture.serialized);
  assert.equal(await readFile(fixture.filename, 'utf8'), fixture.serialized);
  const inputBytes = await readFile(result.record.modelInput);
  assert.deepEqual(JSON.parse(inputBytes), buildPolishInput(fixture.project));
  assert.equal(result.record.modelInputSha256, hash(inputBytes));
  assert.equal(result.record.preparedProjectSha256, hash(fixture.serialized));
  assert.deepEqual(result.record.sourceFiles, [{ path: fixture.filename, sha256: hash(fixture.serialized), bytes: Buffer.byteLength(fixture.serialized) }]);
  assert.equal(result.record.sourceSnapshots[0].sha256, hash(fixture.project.sources[0].text));
  assert.ok(result.reportPath.startsWith(path.join(fixture.directory, '.runtime', 'model-validation')));
  assert.deepEqual(result.record.cost, { status: 'unknown', amount: null, currency: null });
});

test('bad file, malformed JSON and unsupported version are rejected before prepared writes or provider probes (CONTRACT FIXTURE)', async () => {
  for (const bad of ['missing', 'json', 'version']) {
    const fixture = await setup();
    const filename = path.join(fixture.directory, `${bad}.json`);
    if (bad === 'json') await writeFile(filename, '{ invalid private document content');
    if (bad === 'version') await writeFile(filename, JSON.stringify({ version: 999 }));
    let calls = 0;
    const result = await checkModel(['--project', filename, '--prepare-only'], { env: fixture.env, logger: quiet, statusImpl: async () => { calls++; }, polishImpl: neverPolish });
    assert.equal(result.exitCode, 1); assert.equal(calls, 0);
    assert.equal(result.record.preparedProject, null); assert.equal(result.record.modelInput, null);
    assert.equal(result.record.bridgeCallAttempted, false);
    assert.equal(result.record.status, bad === 'missing' ? 'ENOENT' : bad === 'json' ? 'INVALID_PROJECT_JSON' : 'UNSUPPORTED_VERSION');
    assert.deepEqual(await readdir(path.dirname(result.reportPath)), [path.basename(result.reportPath)]);
    assert.ok(!JSON.stringify(result.record).includes('invalid private document content'));
  }
});

test('default status preserves sample path and readiness is never recorded as completed generation (CONTRACT FIXTURE)', async () => {
  const fixture = await setup();
  const outcome = await checkModel([], { env: fixture.env, statusImpl: ready, polishImpl: neverPolish, logger: quiet });
  assert.equal(outcome.exitCode, 0); assert.equal(outcome.record.status, 'STATUS_READY');
  assert.equal(outcome.record.sourceFiles.length, 3);
  assert.equal(outcome.record.bridgeCallAttempted, false); assert.equal(outcome.record.validatedModelOutputReceived, false);
  assert.equal(outcome.record.validatedGenerationCompleted, false); assert.equal(outcome.record.liveValidatedGenerationCompleted, false);
  assert.equal(outcome.record.reviewArtifactSaved, false);
  assert.equal(outcome.record.generationElapsedMs, null); assert.equal(outcome.record.rawResult, null); assert.equal(outcome.record.reviewProject, null);
  assert.equal(outcome.record.usage, null); assert.equal(outcome.record.cost.amount, null);
  const missing = await checkModel(['--status', '--project', fixture.filename], { env: fixture.env, statusImpl: unavailable, polishImpl: neverPolish, logger: quiet });
  assert.equal(missing.exitCode, 1); assert.equal(missing.record.status, 'BACKENDS_UNAVAILABLE');
});

test('both unavailable providers retain the same prepared manuscript and report no generation duration (CONTRACT FIXTURE)', async () => {
  const fixture = await setup();
  for (const provider of ['external-api', 'codex-cli']) {
    const outcome = await checkModel(['--project', fixture.filename, '--provider', provider], { env: fixture.env, statusImpl: unavailable, polishImpl: neverPolish, logger: quiet });
    assert.equal(outcome.exitCode, 1);
    assert.equal(outcome.record.status, provider === 'external-api' ? 'NOT_CONFIGURED' : 'NOT_LOGGED_IN');
    assert.equal(await readFile(outcome.record.preparedProject, 'utf8'), fixture.serialized);
    assert.equal(outcome.record.generationElapsedMs, null); assert.equal(outcome.record.validatedModelOutputReceived, false);
  }
});

test('timeout records bridge-call duration; retry of saved preparation uses identical input and only stages review (CONTRACT FIXTURE)', async () => {
  const fixture = await setup(); const originalEnv = { ...fixture.env }; let received;
  const failed = await checkModel(['--project', fixture.filename, '--provider', 'external-api', '--timeout-ms', '50'], {
    env: fixture.env, statusImpl: ready, logger: quiet,
    polishImpl: async (provider, input, options) => {
      assert.equal(provider, 'external-api'); assert.equal(options.env.DW_MODEL_TIMEOUT_MS, '50'); received = structuredClone(input);
      await new Promise(resolve => setTimeout(resolve, 5));
      throw new BridgeError('TIMEOUT', 'CONTRACT FIXTURE timeout', 504, true);
    },
  });
  assert.equal(failed.exitCode, 1); assert.equal(failed.record.status, 'TIMEOUT');
  assert.equal(failed.record.bridgeCallAttempted, true); assert.equal(failed.record.validatedModelOutputReceived, false);
  assert.equal(failed.record.validatedGenerationCompleted, false); assert.equal(failed.record.reviewArtifactSaved, false);
  assert.ok(failed.record.generationElapsedMs > 0); assert.ok(failed.record.totalElapsedMs >= failed.record.generationElapsedMs);
  assert.equal(failed.record.generationTimingScope, 'bridge-call-including-auth-and-preparation');
  assert.deepEqual(fixture.env, originalEnv);
  const preparedBeforeRetry = await readFile(failed.record.preparedProject, 'utf8');
  assert.equal(preparedBeforeRetry, fixture.serialized);
  const result = outputFor(received);
  const retry = await checkModel(['--project', failed.record.preparedProject, '--provider', 'codex-cli'], {
    env: fixture.env, statusImpl: ready, logger: quiet,
    polishImpl: async (provider, input) => { assert.equal(provider, 'codex-cli'); assert.deepEqual(input, received); return { provider, model: 'fixture-model', usage: { input_tokens: 7, output_tokens: 11 }, result }; },
  });
  assert.equal(retry.exitCode, 0); assert.equal(retry.record.status, 'COMPLETED_REQUIRES_REVIEW');
  assert.equal(retry.record.modelInputSha256, failed.record.modelInputSha256);
  assert.equal(retry.record.preparedProjectSha256, failed.record.preparedProjectSha256);
  assert.equal(await readFile(failed.record.preparedProject, 'utf8'), preparedBeforeRetry);
  assert.equal(await readFile(retry.record.preparedProject, 'utf8'), fixture.serialized);
  assert.deepEqual(JSON.parse(await readFile(retry.record.rawResult, 'utf8')), result);
  const reviewed = deserializeProject(await readFile(retry.record.reviewProject, 'utf8'));
  assert.equal(exportMarkdown(reviewed), exportMarkdown(fixture.project));
  assert.equal(retry.record.review.pending, 1); assert.equal(retry.record.review.blocked, 2); assert.equal(retry.record.review.accepted, 0);
  assert.equal(retry.record.validatedModelOutputReceived, true); assert.equal(retry.record.validatedGenerationCompleted, true);
  assert.equal(retry.record.reviewArtifactSaved, true);
  assert.equal(retry.record.liveValidatedGenerationCompleted, false); assert.equal(reviewed.review.metadata.realModelValidation, false);
  assert.deepEqual(retry.record.usage, { input_tokens: 7, output_tokens: 11 }); assert.equal(retry.record.cost.status, 'unknown');
});

test('successful output without usage retains unknown usage and cost, never zero (CONTRACT FIXTURE)', async () => {
  const fixture = await setup();
  const result = await checkModel(['--project', fixture.filename, '--provider', 'external-api'], {
    env: fixture.env, statusImpl: ready, logger: quiet,
    polishImpl: async (provider, input) => ({ provider, model: 'fixture-model', result: outputFor(input) }),
  });
  assert.equal(result.exitCode, 0); assert.equal(result.record.usage, null); assert.equal(result.record.usageStatus, 'unknown');
  assert.equal(result.record.cost.status, 'unknown'); assert.equal(result.record.cost.amount, null);
});

test('cancellation is passed to the existing bridge contract and preserves prepared bytes (CONTRACT FIXTURE)', async () => {
  const fixture = await setup(); const controller = new AbortController();
  const outcome = await checkModel(['--project', fixture.filename, '--provider', 'codex-cli'], {
    env: fixture.env, statusImpl: ready, signal: controller.signal, logger: quiet,
    polishImpl: async (_provider, _input, { signal }) => new Promise((resolve, reject) => {
      assert.strictEqual(signal, controller.signal);
      signal.addEventListener('abort', () => reject(new BridgeError('CANCELLED', 'CONTRACT FIXTURE cancel', 499)), { once: true });
      queueMicrotask(() => controller.abort());
    }),
  });
  assert.equal(outcome.exitCode, 1); assert.equal(outcome.record.status, 'CANCELLED');
  assert.equal(outcome.record.bridgeCallAttempted, true); assert.equal(outcome.record.validatedModelOutputReceived, false);
  assert.equal(outcome.record.validatedGenerationCompleted, false); assert.equal(outcome.record.reviewArtifactSaved, false);
  assert.ok(outcome.record.generationElapsedMs >= 0); assert.equal(outcome.record.reviewProject, null);
  assert.equal(await readFile(outcome.record.preparedProject, 'utf8'), fixture.serialized);
});
