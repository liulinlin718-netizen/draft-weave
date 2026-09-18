// All successful model outputs in this file are CONTRACT FIXTURES, not model quality evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { writeFile, readFile, mkdir, symlink, unlink } from 'node:fs/promises';
import { BridgeError, externalConfig, externalPayload, externalPolish, parseResult, codexEnvironment, inspectLogin, parseCodexJsonl, codexPolish, runCli, providerStatus } from '../server/model-bridge.mjs';
import { PROJECT_ROOT, RUNTIME_ROOT, checkedPath } from '../server/paths.mjs';
import { createApp } from '../server.mjs';

const INPUT = { version: 1, revision: 2, document: '# 一\n\n它使操作方便。\n\n## 二\n\n编辑器提供审阅。', blocks: [{ id: 'b1', text: '它使操作方便。', locked: false }, { id: 'b2', text: '编辑器提供审阅。', locked: false }], sources: [{ id: 'source-1', name: '稿 A', text: '完整原稿快照', blocks: [] }], protection: { numbers: true, quotes: true } };
const RESULT = { summary: 'CONTRACT FIXTURE：全文指代与术语审查。', changes: [{ blockId: 'b1', before: '它使操作方便。', after: '文稿编辑器使操作方便。', reason: '结合下一节明确指代。' }] };
const ENV = { DW_API_KEY_ENV: 'DW_TEST_FIXTURE_CREDENTIAL', DW_TEST_FIXTURE_CREDENTIAL: 'non-secret-contract-fixture', DW_MODEL_TIMEOUT_MS: '2000' };
const contractResponse = () => new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(RESULT) }] }], usage: { input_tokens: 10, output_tokens: 20 } }), { status: 200 });
const rejectsCode = (fn, code) => assert.rejects(fn, error => error.code === code);

test('external-api passes entire draft and sources, never only seam snippets (CONTRACT FIXTURE)', async () => {
  let request;
  const outcome = await externalPolish(INPUT, { env: ENV, fetchImpl: async (url, options) => { request = { url, ...options }; return contractResponse(); } });
  assert.equal(request.url, 'https://api.openai.com/v1/responses');
  const payload = JSON.parse(request.body);
  assert.deepEqual(JSON.parse(payload.input), INPUT);
  assert.equal(payload.text.format.type, 'json_schema');
  assert.equal(payload.store, false);
  assert.equal(request.redirect, 'error');
  assert.deepEqual(outcome.result, RESULT);
  assert.equal(outcome.provider, 'external-api');
});

test('both API styles support schema, object and plain modes without assuming schema support', () => {
  for (const apiStyle of ['responses', 'chat-completions']) for (const structuredOutput of ['json-schema', 'json-object', 'plain']) {
    const payload = externalPayload(INPUT, { apiStyle, structuredOutput, model: 'fixture-model' });
    const format = apiStyle === 'responses' ? payload.text?.format : payload.response_format;
    assert.equal(format?.type, structuredOutput === 'plain' ? undefined : structuredOutput.replace('-', '_'));
    assert.deepEqual(JSON.parse(apiStyle === 'responses' ? payload.input : payload.messages[1].content), INPUT);
  }
  assert.throws(() => externalConfig({ DW_API_BASE_URL: 'http://remote.invalid/v1' }), /HTTPS/);
  assert.throws(() => externalConfig({ DW_API_BASE_URL: 'https://example.invalid/v1?key=not-a-real-key' }), /URL/);
});

test('Chat Completions adapter parses actual transport shape (CONTRACT FIXTURE)', async () => {
  const result = await externalPolish(INPUT, { env: { ...ENV, DW_API_STYLE: 'chat-completions' }, fetchImpl: async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(RESULT) } }] })) });
  assert.deepEqual(result.result, RESULT);
});

test('unconfigured API makes no request and does not fall back to fixture', async () => {
  let calls = 0;
  await rejectsCode(() => externalPolish(INPUT, { env: { DW_API_KEY_ENV: 'ABSENT' }, fetchImpl: async () => { calls++; } }), 'NOT_CONFIGURED');
  assert.equal(calls, 0);
});

test('timeout, cancellation, quota and malformed response preserve input', async () => {
  const original = JSON.stringify(INPUT);
  const waitingFetch = (_url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  await rejectsCode(() => externalPolish(INPUT, { env: { ...ENV, DW_MODEL_TIMEOUT_MS: '50' }, fetchImpl: waitingFetch }), 'TIMEOUT');
  const controller = new AbortController();
  const pending = externalPolish(INPUT, { env: ENV, signal: controller.signal, fetchImpl: waitingFetch });
  controller.abort();
  await rejectsCode(() => pending, 'CANCELLED');
  await rejectsCode(() => externalPolish(INPUT, { env: ENV, fetchImpl: async () => new Response('private upstream body must not be exposed', { status: 429 }) }), 'QUOTA_OR_RATE_LIMIT');
  await rejectsCode(() => externalPolish(INPUT, { env: ENV, fetchImpl: async () => new Response('not-json') }), 'INVALID_MODEL_OUTPUT');
  assert.equal(JSON.stringify(INPUT), original);
});

test('invalid model schema, stale before, nonexistent block and duplicate block are rejected', () => {
  for (const invalid of [{ summary: 'x', changes: [], extra: true }, { ...RESULT, changes: [{ ...RESULT.changes[0], before: 'wrong' }] }, { ...RESULT, changes: [{ ...RESULT.changes[0], blockId: 'absent' }] }, { ...RESULT, changes: [RESULT.changes[0], RESULT.changes[0]] }]) {
    assert.throws(() => parseResult(JSON.stringify(invalid), INPUT), error => error.code === 'INVALID_MODEL_OUTPUT');
  }
});

test('CLI child removes API credentials; parent environment unchanged; all managed paths stay D project', async () => {
  const env = { ...process.env, OPENAI_API_KEY: 'fixture-a', CODEX_API_KEY: 'fixture-b', AZURE_OPENAI_API_KEY: 'fixture-c', CODEX_ACCESS_TOKEN: 'fixture-d', DW_API_KEY_ENV: 'CUSTOM_BILLING_SECRET', CUSTOM_BILLING_SECRET: 'fixture-e', OPENAI_BASE_URL: 'https://external.invalid', CODEX_HOME: path.resolve(PROJECT_ROOT,'../parent-profile'), CODEX_SQLITE_HOME: path.resolve(PROJECT_ROOT,'../parent-db'), CODEX_PROJECT_PROFILE_DIR: path.join(RUNTIME_ROOT, 'bridge-test-profile') };
  const copy = { ...env };
  const isolated = await codexEnvironment(env);
  assert.deepEqual(env, copy);
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'AZURE_OPENAI_API_KEY', 'CODEX_ACCESS_TOKEN', 'CUSTOM_BILLING_SECRET', 'OPENAI_BASE_URL']) assert.equal(isolated.env[key], undefined, key);
  assert.equal(isolated.env.CODEX_HOME, isolated.paths.profile);
  assert.equal(isolated.env.CODEX_SQLITE_HOME, path.join(isolated.paths.profile, 'sqlite'));
  assert.equal(isolated.env.TEMP, path.join(RUNTIME_ROOT, 'temp'));
  assert.equal(await checkedPath(isolated.env.CODEX_HOME), isolated.env.CODEX_HOME);
  await rejectsCode(() => codexEnvironment({ CODEX_PROJECT_PROFILE_DIR: path.resolve(PROJECT_ROOT,'../unsafe-profile') }), 'UNSAFE_PATH');
});

test('ChatGPT status required; API-key login or unknown success never counts', () => {
  assert.deepEqual(inspectLogin({ code: 0, stdout: '', stderr: 'Logged in using ChatGPT' }), { authMode: 'chatgpt', ready: true });
  assert.throws(() => inspectLogin({ code: 0, stdout: 'Logged in using an API key', stderr: '' }), error => error.code === 'AUTH_MODE_MISMATCH');
  assert.throws(() => inspectLogin({ code: 1, stdout: '', stderr: 'Not logged in' }), error => error.code === 'NOT_LOGGED_IN');
  assert.throws(() => inspectLogin({ code: 0, stdout: 'success', stderr: '' }), error => error.code === 'NOT_LOGGED_IN');
});

test('CLI passes prompt only via stdin, pins file ChatGPT and sandbox, parses final (CONTRACT FIXTURE)', async () => {
  const calls = [];
  const result = await codexPolish(INPUT, { env: { ...process.env, DW_MODEL_TIMEOUT_MS: '2000' }, runCliImpl: async (exe, args, options) => {
    calls.push({ exe, args, options });
    if (args.includes('login')) return { code: 0, stdout: '', stderr: 'Logged in using ChatGPT' };
    return { code: 0, stderr: '', stdout: [JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(RESULT) } }), JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 4 } })].join('\n') };
  } });
  assert.deepEqual(result.result, RESULT);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].args.at(-1), '-');
  assert.ok(calls[1].args.includes('--ephemeral'));
  assert.ok(calls[1].args.includes('--ignore-user-config'));
  assert.ok(calls[1].args.includes('cli_auth_credentials_store="file"'));
  assert.ok(calls[1].args.includes('forced_login_method="chatgpt"'));
  assert.ok(calls[1].args.includes('model_reasoning_effort="ultra"'));
  assert.ok(calls[1].args.includes('gpt-6-astra'));
  assert.ok(calls[1].args.includes('read-only'));
  assert.ok(calls[1].options.stdin.includes(JSON.stringify(INPUT)));
  assert.ok(!calls[1].args.join(' ').includes(INPUT.document));
});

test('CLI unlogged profile refuses before model invocation', async () => {
  let calls = 0;
  await rejectsCode(() => codexPolish(INPUT, { runCliImpl: async () => { calls++; return { code: 1, stdout: '', stderr: 'Not logged in' }; } }), 'NOT_LOGGED_IN');
  assert.equal(calls, 1);
});

test('CLI nonzero, quota, absent completed/final and malformed JSONL rejected', () => {
  assert.throws(() => parseCodexJsonl('', 0), error => error.code === 'INCOMPLETE_OUTPUT');
  assert.throws(() => parseCodexJsonl('{bad json', 0), error => error.code === 'INVALID_MODEL_OUTPUT');
  assert.throws(() => parseCodexJsonl(JSON.stringify({ type: 'turn.failed', error: { message: 'quota exceeded' } }), 1), error => error.code === 'QUOTA_OR_RATE_LIMIT');
  assert.throws(() => parseCodexJsonl(JSON.stringify({ type: 'turn.completed' }), 1), error => error.code === 'CLI_FAILED');
});

test('spawn uses parameter arrays, no shell, hidden window and bounded UTF-8 stdout', async () => {
  let recorded;
  const result = await runCli('fixture-codex.exe', ['exec', '-'], { stdin: 'not shell $(evil)', timeout: 1000, spawnImpl: (exe, args, options) => {
    recorded = { exe, args, options };
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
    queueMicrotask(() => { const bytes = Buffer.from('中文'); child.stdout.write(bytes.subarray(0, 1)); child.stdout.write(bytes.subarray(1)); child.stdout.end(); child.emit('close', 0); });
    return child;
  } });
  assert.equal(recorded.options.shell, false);
  assert.equal(recorded.options.windowsHide, true);
  assert.deepEqual(recorded.args, ['exec', '-']);
  assert.equal(result.stdout, '中文');
});

test('CLI cancellation and timeout terminate owned child and distinguish failures (CONTRACT FIXTURE)', async () => {
  let killed = 0;
  const spawnImpl = () => {
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => { killed++; };
    return child;
  };
  await rejectsCode(() => runCli('fixture-codex', ['exec', '-'], { timeout: 50, spawnImpl }), 'TIMEOUT');
  const controller = new AbortController();
  const pending = runCli('fixture-codex', ['exec', '-'], { signal: controller.signal, timeout: 2000, spawnImpl });
  controller.abort(); await rejectsCode(() => pending, 'CANCELLED');
  assert.equal(killed, 2);
  await rejectsCode(() => runCli('draft-weave-clearly-absent-cli-20260917.exe', [], { timeout: 1000 }), 'CLI_NOT_INSTALLED');
});

test('unsafe traversal and Windows junction rejected using actual filesystem resolution', async () => {
  await rejectsCode(() => checkedPath(path.join(PROJECT_ROOT, '..', 'another-project', 'bad.md')), 'UNSAFE_PATH');
  const link = path.join(RUNTIME_ROOT, 'bridge-junction-test');
  try { await symlink(PROJECT_ROOT, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EEXIST') await unlink(link); else throw error; await symlink(PROJECT_ROOT, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  try { await rejectsCode(() => checkedPath(path.join(link, 'escape.md')), 'UNSAFE_PATH'); }
  finally { await unlink(link); }
});

test('status reports absent credentials without exposing secret values (CONTRACT FIXTURE login status)', async () => {
  const status = await providerStatus({ env: { DW_API_KEY_ENV: 'ABSENT' }, runCliImpl: async () => ({ code: 1, stdout: '', stderr: 'Not logged in' }) });
  assert.equal(status['external-api'].code, 'NOT_CONFIGURED');
  assert.equal(status['codex-cli'].code, 'NOT_LOGGED_IN');
  assert.equal(status['external-api'].ready, false);
});

test('HTTP export stays D, forbids cross origin/profile access, cancellation preserves request (CONTRACT FIXTURE)', async () => {
  const server = await createApp({ statusImpl: async () => ({ fixture: true }), polishImpl: async (_provider, _input, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new BridgeError('CANCELLED', '合同测试取消', 499)), { once: true })) });
  let port;
  for (const candidate of [6419, 6418, 6417, 6416, 6415]) {
    try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(candidate, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); }); port = candidate; break; }
    catch (error) { if (error.code !== 'EADDRINUSE') throw error; }
  }
  assert.ok(port, 'test requires one allowed free port');
  const base = `http://127.0.0.1:${port}`;
  const post = (route, value, extra = {}) => fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(value) });
  try {
    const denied = await post('/api/export', { filename: 'x.md', content: 'no' }, { Origin: 'https://evil.invalid' }); assert.equal(denied.status, 403);
    const profile = await fetch(`${base}/.runtime/codex-profile/auth.json`); assert.equal(profile.status, 404);
    const badName = await post('/api/export', { filename: '../bad.md', content: 'no' }); assert.equal(badName.status, 400);
    const exported = await post('/api/export', { filename: 'bridge-contract-fixture.md', content: INPUT.document }); assert.equal(exported.status, 201);
    const record = await exported.json(); assert.ok(record.path.startsWith(path.join(PROJECT_ROOT, 'outputs', 'exports')));
    assert.equal(await readFile(record.path, 'utf8'), INPUT.document);
    assert.equal(await (await fetch(base + record.downloadUrl)).text(), INPUT.document);
    const pending = post('/api/polish', { requestId: 'contract-cancel', provider: 'external-api', input: INPUT });
    let cancelled = false;
    for (let attempt = 0; attempt < 20 && !cancelled; attempt++) { await new Promise(resolve => setTimeout(resolve, 10)); cancelled = (await (await post('/api/cancel', { requestId: 'contract-cancel' })).json()).cancelled; }
    assert.equal(cancelled, true); assert.equal((await pending).status, 499);
    const large = await post('/api/export', { filename: 'large-contract-fixture.json', content: JSON.stringify({ fixture: true, text: '段落'.repeat(400_000) }) });
    assert.equal(large.status, 201, 'project snapshots larger than 2 MB remain exportable');
  } finally { await new Promise(resolve => server.close(resolve)); }
});
