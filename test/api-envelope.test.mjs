// In-memory transport CONTRACT FIXTURES, not authenticated API or model-quality evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { externalPolish } from '../server/model-bridge.mjs';

const input = { revision: 1, document: '它负责导览。', blocks: [{ id: 'b1', text: '它负责导览。', locked: false }], sources: [] };
const result = { summary: '合同样本', changes: [{ blockId: 'b1', before: '它负责导览。', after: '语音系统负责导览。', reason: '明确指代' }] };
const text = JSON.stringify(result);
const env = { DW_API_KEY_ENV: 'FIXTURE_ONLY', FIXTURE_ONLY: 'not-a-real-key', DW_MODEL_TIMEOUT_MS: '1000' };
const responses = () => ({ status: 'completed', error: null, incomplete_details: null, output: [{ type: 'reasoning', summary: [] }, { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] }] });
const chat = () => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: text, refusal: null } }] });
const call = (body, apiStyle = 'responses') => externalPolish(input, { env: { ...env, DW_API_STYLE: apiStyle }, fetchImpl: async () => new Response(JSON.stringify(body)) });
async function reject(body, code, apiStyle = 'responses') {
  const original = JSON.stringify(input);
  await assert.rejects(() => call(body, apiStyle), error => {
    assert.equal(error.code, code);
    assert.ok(!error.message.includes('PRIVATE_UPSTREAM'));
    return true;
  });
  assert.equal(JSON.stringify(input), original);
}

test('Responses completed and Chat stop return validated edits without applying them', async () => {
  const before = JSON.stringify(input);
  assert.deepEqual((await call(responses())).result, result);
  assert.deepEqual((await call({ ...responses(), output_text: text })).result, result);
  assert.deepEqual((await call(chat(), 'chat-completions')).result, result);
  assert.equal(JSON.stringify(input), before);
});

test('HTTP 200 top-level errors override valid edits in both API styles', async () => {
  for (const [style, valid] of [['responses', responses], ['chat-completions', chat]]) {
    for (const [code, expected] of [['rate_limit_exceeded', 'QUOTA_OR_RATE_LIMIT'], ['insufficient_quota', 'QUOTA_OR_RATE_LIMIT'], ['invalid_api_key', 'AUTH_FAILED'], ['server_error', 'PROVIDER_ERROR']]) {
      await reject({ ...valid(), error: { code, message: 'PRIVATE_UPSTREAM' }, output_text: text }, expected, style);
    }
    for (const error of ['', false, [], 0]) await reject({ ...valid(), error }, 'INVALID_MODEL_OUTPUT', style);
  }
});

test('missing, unknown and nonfinal completion evidence never succeeds', async () => {
  for (const status of [undefined, null, '', 'incomplete', 'in_progress', 'failed', 'cancelled', 'queued', 'unknown']) await reject({ ...responses(), status }, 'INCOMPLETE_OUTPUT');
  for (const finish_reason of [undefined, null, '', 'length', 'content_filter', 'tool_calls', 'function_call', 'unknown']) {
    const body = chat(); body.choices[0].finish_reason = finish_reason;
    await reject(body, 'INCOMPLETE_OUTPUT', 'chat-completions');
  }
  await reject({ ...responses(), incomplete_details: { reason: 'max_output_tokens' } }, 'INCOMPLETE_OUTPUT');
  const partial = responses(); partial.output[1].status = 'incomplete';
  await reject(partial, 'INCOMPLETE_OUTPUT');
});

test('malformed Responses containers cannot hide behind valid output_text', async () => {
  for (const body of [null, [], 'text', 7, {}, { status: 'completed', output_text: text }]) await reject(body, 'INVALID_MODEL_OUTPUT');
  for (const output of [null, {}, [null], ['text'], [{ type: 'message', content: {} }], [{ type: 'message', content: [null] }], [{ type: 'message', content: [{ type: 'output_text', text: {} }] }], [{ type: 'function_call', arguments: text }]]) await reject({ ...responses(), output, output_text: text }, 'INVALID_MODEL_OUTPUT');
  await reject({ ...responses(), output_text: 'different valid-looking text' }, 'INVALID_MODEL_OUTPUT');
  await reject({ ...responses(), output_text: {} }, 'INVALID_MODEL_OUTPUT');
  await reject({ ...responses(), output: [] }, 'INVALID_MODEL_OUTPUT');
});

test('malformed Chat choices/messages and unexpected tool results are rejected', async () => {
  for (const choices of [undefined, null, {}, [], [null], [{}], [{ message: [] }], [...chat().choices, ...chat().choices]]) await reject({ choices }, 'INVALID_MODEL_OUTPUT', 'chat-completions');
  for (const patch of [{ content: [] }, { role: 'user' }, { refusal: {} }, { tool_calls: {} }, { tool_calls: [{}] }, { function_call: {} }]) {
    const body = chat(); Object.assign(body.choices[0].message, patch);
    await reject(body, 'INVALID_MODEL_OUTPUT', 'chat-completions');
  }
});

test('explicit refusal takes precedence over accompanying valid edits', async () => {
  const body = responses(); body.output[1].content.push({ type: 'refusal', refusal: 'PRIVATE_UPSTREAM' });
  await reject({ ...body, output_text: text }, 'MODEL_REFUSAL');
  const completion = chat(); completion.choices[0].message.refusal = 'PRIVATE_UPSTREAM';
  await reject(completion, 'MODEL_REFUSAL', 'chat-completions');
});

test('cancellation, timeout and invalid generated JSON preserve the draft', async () => {
  const waiting = (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  const original = JSON.stringify(input);
  const controller = new AbortController();
  const pending = externalPolish(input, { env, signal: controller.signal, fetchImpl: waiting });
  controller.abort();
  await assert.rejects(pending, error => error.code === 'CANCELLED');
  await assert.rejects(() => externalPolish(input, { env: { ...env, DW_MODEL_TIMEOUT_MS: '50' }, fetchImpl: waiting }), error => error.code === 'TIMEOUT');
  const body = responses(); body.output[1].content[0].text = '{invalid';
  await reject(body, 'INVALID_MODEL_OUTPUT');
  assert.equal(JSON.stringify(input), original);
});
