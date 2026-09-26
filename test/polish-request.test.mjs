// Provider replies and login status below are explicit CONTRACT FIXTURES.
// No live model call, CLI invocation, login check or credential-file read occurs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createProject, addSource, selectBlocks, editBlock, toggleLock, setProtection, attachReview, decideChange, buildPolishInput, serializeProject, deserializeProject } from '../public/core.mjs';
import { preflightPolishRequest, preparePolishRequest, canReusePolishReview, POLISH_HTTP_BODY_LIMIT, POLISH_INPUT_CHARACTER_LIMIT } from '../public/polish-request.mjs';
import { providerConfiguration, providerStatus, externalPolish, codexPolish, POLISH_INSTRUCTION_VERSION } from '../server/model-bridge.mjs';

const env = { DW_API_KEY_ENV: 'DW_CONTRACT_KEY', DW_CONTRACT_KEY: 'not-a-real-contract-key', DW_API_BASE_URL: 'https://fixture.example.test/v1', DW_API_MODEL: 'contract-model' };
const config = providerConfiguration('external-api', env);
const options = { requestId: 'contract-request-1', provider: 'external-api', ...config };
function projectFixture() {
  let project = createProject({ title: '完整输入 CONTRACT FIXTURE' });
  project = addSource(project, { id: 'a', name: '来源 A', text: '# 背景\n\n服务覆盖 120 人。\n\n它需要明确的分工。' });
  project = addSource(project, { id: 'b', name: '未选入的来源 B', text: '# 候选\n\n未被选择的原稿也须原样保留。' });
  return selectBlocks(project, 'a', project.sources[0].blocks.map(block => block.id));
}
const metadata = prepared => ({ provider: prepared.provider, configurationId: prepared.configurationId, instructionVersion: prepared.instructionVersion, inputSignature: prepared.inputSignature });
const output = project => ({ summary: 'CONTRACT FIXTURE suggestion', changes: [{ blockId: project.draft[2].id, before: project.draft[2].text, after: '这项服务需要明确的分工。', reason: 'CONTRACT FIXTURE 明确指代' }] });

test('preparation retains full manuscript, all sources, protections and exact HTTP bytes without mutation', async () => {
  let project = projectFixture(); project = toggleLock(project, project.draft[1].id);
  const before = serializeProject(project);
  const prepared = await preparePolishRequest(project, options);
  assert.equal(serializeProject(project), before);
  assert.deepEqual(prepared.payload.input, buildPolishInput(project));
  assert.equal(prepared.payload.input.sources.length, 2);
  assert.equal(prepared.payload.input.sources[1].text, project.sources[1].text);
  assert.equal(prepared.requestBytes, Buffer.byteLength(JSON.stringify(prepared.payload), 'utf8'));
  assert.equal(prepared.inputCharacters, JSON.stringify(prepared.payload.input).length);
  assert.equal(prepared.serializedBody, JSON.stringify(prepared.payload));
  const signed = JSON.stringify({ signatureVersion: 1, provider: options.provider, configurationId: options.configurationId, instructionVersion: options.instructionVersion, input: prepared.payload.input });
  assert.equal(prepared.inputSignature, createHash('sha256').update(signed).digest('hex'));
});

test('preflight enforces exact inclusive UTF-8 HTTP and input-character boundaries', () => {
  // Minimal transport-shaped project makes the boundary independent of parser overhead.
  const project = { version: 1, revision: 1, draft: [{ id: 'block', text: 'x', locked: false }], sources: [{ text: '' }], protection: { numbers: true, quotes: true } };
  const base = preflightPolishRequest(project, options);
  const byteRoom = POLISH_HTTP_BODY_LIMIT - base.requestBytes;
  project.sources[0].text = '汉'.repeat(Math.floor(byteRoom / 3)) + 'a'.repeat(byteRoom % 3);
  assert.equal(preflightPolishRequest(project, options).requestBytes, POLISH_HTTP_BODY_LIMIT);
  project.sources[0].text += 'a';
  assert.throws(() => preflightPolishRequest(project, options), error => error.code === 'INPUT_TOO_LARGE' && error.unit === 'utf8-bytes' && error.actual === POLISH_HTTP_BODY_LIMIT + 1);
  project.sources[0].text = 'a'.repeat(POLISH_INPUT_CHARACTER_LIMIT - base.inputCharacters);
  assert.equal(preflightPolishRequest(project, options).inputCharacters, POLISH_INPUT_CHARACTER_LIMIT);
  project.sources[0].text += 'a';
  assert.throws(() => preflightPolishRequest(project, options), error => error.code === 'INPUT_TOO_LARGE' && error.unit === 'utf16-code-units' && error.actual === POLISH_INPUT_CHARACTER_LIMIT + 1);
});

test('all locked rejects before either adapter can inspect credentials or call transport (CONTRACT FIXTURE)', async () => {
  let project = projectFixture();
  for (const block of project.draft) project = toggleLock(project, block.id);
  assert.throws(() => preflightPolishRequest(project, options), error => error.code === 'ALL_BLOCKS_LOCKED');
  let calls = 0;
  const input = buildPolishInput(project);
  await assert.rejects(() => externalPolish(input, { env: {}, fetchImpl: async () => { calls++; } }), error => error.code === 'ALL_BLOCKS_LOCKED');
  await assert.rejects(() => codexPolish(input, { env: {}, runCliImpl: async () => { calls++; } }), error => error.code === 'ALL_BLOCKS_LOCKED');
  assert.equal(calls, 0);
});

test('signature ignores transport requestId but covers source content, revision, lock, protection and configuration', async () => {
  const project = projectFixture();
  const prepared = await preparePolishRequest(project, options);
  assert.equal((await preparePolishRequest(project, { ...options, requestId: 'new-transport-id' })).inputSignature, prepared.inputSignature);
  const cases = [
    [editBlock(project, project.draft[2].id, '另一句正文。'), options],
    [toggleLock(project, project.draft[0].id), options],
    [setProtection(project, { numbers: false }), options],
    [{ ...project, revision: project.revision + 1 }, options],
    [addSource(project, { id: 'c', name: '新增候选', text: '仍然保留完整来源。' }), options],
    [project, { ...options, ...providerConfiguration('external-api', { ...env, DW_API_MODEL: 'different-contract-model' }) }],
    [project, { ...options, provider: 'codex-cli', ...providerConfiguration('codex-cli', {}) }],
    [project, { ...options, instructionVersion: 'future-instruction-version' }],
  ];
  for (const [changed, changedOptions] of cases) assert.notEqual((await preparePolishRequest(changed, changedOptions)).inputSignature, prepared.inputSignature);
  await assert.rejects(() => preparePolishRequest(project, { ...options, configurationId: undefined }), error => error.code === 'CONFIGURATION_UNAVAILABLE');
});

test('review reuse requires exact valid current review; rejection remains reusable and acceptance changes signature', async () => {
  const project = projectFixture(); const prepared = await preparePolishRequest(project, options);
  const reviewed = attachReview(project, output(project), project.revision, metadata(prepared));
  assert.equal(canReusePolishReview(reviewed, prepared), true);
  const restored = deserializeProject(serializeProject(reviewed));
  assert.equal(canReusePolishReview(restored, await preparePolishRequest(restored, options)), true);
  const rejected = decideChange(reviewed, reviewed.review.changes[0].id, 'reject');
  assert.equal(canReusePolishReview(rejected, await preparePolishRequest(rejected, options)), true);
  const accepted = decideChange(reviewed, reviewed.review.changes[0].id, 'accept');
  assert.equal(canReusePolishReview(accepted, await preparePolishRequest(accepted, options)), false);
});

test('reuse rejects stale or forged pending guards even when metadata signature was copied', async () => {
  const project = projectFixture(); const prepared = await preparePolishRequest(project, options);
  const reviewed = attachReview(project, output(project), project.revision, metadata(prepared));
  const forged = mutate => { const copy = structuredClone(reviewed); mutate(copy); return copy; };
  for (const invalid of [
    forged(p => { p.review.staleAtCreation = true; }),
    forged(p => { p.review.expectedRevision++; }),
    forged(p => { p.review.changes[0].status = 'stale'; }),
    forged(p => { p.review.changes[0].issues = [{ code: 'LOCKED_BLOCK', message: '伪造pending带保护冲突' }]; }),
    forged(p => { p.review.changes[0].before = '不匹配原文'; }),
    forged(p => { p.draft[2].locked = true; }),
    forged(p => { p.review.changes[0].after = '偷加 999 人'; }),
    forged(p => { p.review.metadata.configurationId = 'obsolete'; }),
    forged(p => { p.review.metadata.provider = 'imported'; }),
  ]) assert.equal(canReusePolishReview(invalid, prepared), false);
  // An irrelevant damaged history must not trigger a full historical traversal.
  assert.equal(canReusePolishReview({ ...reviewed, history: [{ deliberately: 'not examined' }] }, prepared), true);
});

test('opaque configuration changes with effective API/CLI settings without revealing URL or secret', () => {
  const identity = providerConfiguration('external-api', env);
  assert.deepEqual(providerConfiguration('external-api', { ...env }), identity);
  assert.match(identity.configurationId, /^dwc1_[A-Za-z0-9_-]{43}$/);
  assert.equal(identity.instructionVersion, POLISH_INSTRUCTION_VERSION);
  for (const changed of [
    { DW_API_BASE_URL: 'https://other.example.test/v1' }, { DW_API_STYLE: 'chat-completions' },
    { DW_API_MODEL: 'other-model' }, { DW_API_REASONING_EFFORT: 'ultra' },
    { DW_API_STRUCTURED: 'plain' }, { DW_MODEL_TIMEOUT_MS: '80000' }, { DW_CONTRACT_KEY: 'another-fake-contract-key' },
  ]) assert.notEqual(providerConfiguration('external-api', { ...env, ...changed }).configurationId, identity.configurationId);
  assert.deepEqual(Object.keys(identity).sort(), ['configurationId', 'instructionVersion']);
  assert.ok(!JSON.stringify(identity).includes(env.DW_CONTRACT_KEY));
  assert.ok(!JSON.stringify(identity).includes(env.DW_API_BASE_URL));
  assert.throws(() => providerConfiguration('external-api', { ...env, DW_API_BASE_URL: 'https://secret:credential@fixture.example.test/v1' }), error => error.code === 'INVALID_CONFIG');
  const cli = providerConfiguration('codex-cli', {});
  for (const changed of [{ DW_CODEX_MODEL: 'another-model' }, { DW_CODEX_REASONING_EFFORT: 'high' }, { DW_CODEX_BIN: 'other-cli' }, { CODEX_PROJECT_PROFILE_DIR: 'D:/different-contract-profile' }]) assert.notEqual(providerConfiguration('codex-cli', changed).configurationId, cli.configurationId);
});

test('status can identify unavailable configuration without leaking keys or running real CLI (CONTRACT FIXTURE)', async () => {
  let cliCalls = 0;
  const status = await providerStatus({ env: { ...env, DW_CONTRACT_KEY: undefined }, runCliImpl: async (_exe, args) => { cliCalls++; assert.ok(args.includes('status')); return { code: 1, stdout: '', stderr: 'Not logged in' }; } });
  assert.equal(cliCalls, 1);
  assert.equal(status['external-api'].ready, false); assert.equal(status['external-api'].code, 'NOT_CONFIGURED');
  assert.equal(status['codex-cli'].ready, false); assert.equal(status['codex-cli'].code, 'NOT_LOGGED_IN');
  for (const state of Object.values(status)) assert.match(state.configurationId, /^dwc1_[A-Za-z0-9_-]{43}$/);
  assert.ok(!JSON.stringify(status).includes(env.DW_API_BASE_URL));
  assert.ok(!JSON.stringify(status).includes(env.DW_CONTRACT_KEY));
});

test('actual API adapter includes the configuration used for returned result (CONTRACT FIXTURE response)', async () => {
  const project = projectFixture(); const input = buildPolishInput(project); const expected = providerConfiguration('external-api', env);
  const outcome = await externalPolish(input, { env, fetchImpl: async () => new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(output(project)) }] }] })) });
  assert.equal(outcome.configurationId, expected.configurationId);
  assert.equal(outcome.instructionVersion, expected.instructionVersion);
  assert.deepEqual(outcome.result, output(project));
});
