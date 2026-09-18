// Targeted real-browser race regression. Routed replies are CONTRACT FIXTURES only.
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { ensureDirectory, RUNTIME_ROOT, PROJECT_ROOT } from '../server/paths.mjs';

const { chromium } = await import('playwright');
const profile = await ensureDirectory(path.join(RUNTIME_ROOT, 'browser-profiles', 'editor-race'));
const cache = await ensureDirectory(path.join(RUNTIME_ROOT, 'browser-cache', 'editor-race'));
const artifacts = await ensureDirectory(path.join(PROJECT_ROOT, 'output', 'playwright', 'editor-race'));
const context = await chromium.launchPersistentContext(profile, { headless: true, executablePath: process.env.DW_BROWSER_BIN || undefined, downloadsPath: artifacts, tracesDir: artifacts, args: [`--disk-cache-dir=${cache}`, `--crash-dumps-dir=${artifacts}`] });
const page = await context.newPage();
// beforeunload deliberately persists the current project; clear at the next page's
// initialization, after that lifecycle write and before the application loads.
await page.addInitScript(() => localStorage.clear());
const reports = [];
const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem('draft-weave.project.v1')));
const url = `http://127.0.0.1:${process.env.DW_PORT || 6410}`;
async function reset() {
  await page.goto(url);
  await page.locator('[data-action="first-chapter"]').click();
}
async function delayedReply(mode) {
  let release; let received;
  const wait = new Promise(resolve => { release = resolve; });
  const requestReceived = new Promise(resolve => { received = resolve; });
  await page.route('**/api/polish', async route => {
    const request = route.request().postDataJSON(); received(request);
    await wait;
    const block = request.input.blocks[1];
    const payload = mode === 'error'
      ? { error: { code: 'FIXTURE_UPSTREAM_ERROR', message: 'CONTRACT FIXTURE：故障回包' } }
      : { result: { summary: 'CONTRACT FIXTURE：延迟到达的修改集', changes: [{ blockId: block.id, before: block.text, after: `此外，${block.text}`, reason: 'CONTRACT FIXTURE：回归异步聚焦编辑，不代表模型效果。' }] }, provider: 'external-api', model: 'fixture', requestId: request.requestId };
    try { await route.fulfill({ status: mode === 'error' ? 502 : 200, contentType: 'application/json', body: JSON.stringify(payload) }); } catch { /* A cancelled fetch may already be detached. */ }
  });
  return { release, requestReceived };
}
async function editWhileWaiting() {
  const editor = page.locator('#draft textarea').nth(1);
  const text = (await editor.inputValue()) + '【聚焦输入尚未离开编辑器】';
  await editor.fill(text);
  assert.equal(await editor.evaluate(element => document.activeElement === element), true);
  return text;
}

try {
  await reset(); let gate = await delayedReply('success');
  await page.locator('[data-action="polish"]').click(); const request = await gate.requestReceived;
  let typed = await editWhileWaiting(); gate.release();
  await page.waitForFunction(() => !document.querySelector('#polish-button').classList.contains('busy'));
  let restored = await saved();
  assert.equal(restored.draft[1].text, typed);
  assert.ok(restored.revision > request.input.revision);
  assert.equal(restored.review.changes[0].status, 'stale');
  assert.equal(await page.locator('[data-action="accept"]').first().isDisabled(), true);
  reports.push({ name: 'successful late reply preserves focused edit and marks diff stale', passed: true });
  await page.unroute('**/api/polish');

  await reset(); gate = await delayedReply('error');
  await page.locator('[data-action="polish"]').click(); await gate.requestReceived;
  typed = await editWhileWaiting(); gate.release();
  await page.waitForFunction(() => !document.querySelector('#polish-button').classList.contains('busy'));
  restored = await saved();
  assert.equal(restored.draft[1].text, typed);
  assert.equal(await page.locator('#draft textarea').nth(1).inputValue(), typed);
  reports.push({ name: 'failed late reply preserves focused edit in DOM and persisted project', passed: true });
  await page.unroute('**/api/polish');

  await reset(); gate = await delayedReply('success');
  await page.locator('[data-action="polish"]').click(); await gate.requestReceived;
  await page.locator('[data-action="cancel"]').click();
  typed = await editWhileWaiting();
  const afterCancel = await page.locator('#request-state').textContent();
  gate.release();
  await page.locator('#draft textarea').nth(1).blur();
  await page.waitForTimeout(150);
  restored = await saved();
  assert.equal(restored.draft[1].text, typed);
  assert.equal(restored.review, null);
  assert.equal(await page.locator('#request-state').textContent(), afterCancel);
  reports.push({ name: 'cancelled late reply does not replace draft, review or request state', passed: true });
  await page.unroute('**/api/polish');

  await reset(); gate = await delayedReply('success');
  const cancellations = [];
  await page.route('**/api/cancel', async route => {
    cancellations.push(route.request().postDataJSON().requestId);
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ cancelled: true }) });
  });
  await page.locator('[data-action="polish"]').click();
  const pendingRequest = await gate.requestReceived;
  const importedBlock = pendingRequest.input.blocks[1];
  const imported = {
    summary: 'CONTRACT FIXTURE：用户离线导入的待审修改集',
    changes: [{ blockId: importedBlock.id, before: importedBlock.text, after: `进一步说，${importedBlock.text}`, reason: 'CONTRACT FIXTURE：验证导入优先于迟到请求。' }],
  };
  await page.locator('#review-file').setInputFiles({ name: 'editor-race-import.fixture.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(imported)) });
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('draft-weave.project.v1'))?.review?.metadata?.provider === 'imported');
  assert.deepEqual(cancellations, [pendingRequest.requestId]);
  assert.equal(await page.locator('#polish-button').evaluate(button => button.classList.contains('busy')), false);
  const importedState = await page.locator('#request-state').textContent();
  assert.match(importedState, /离线修改集/);
  gate.release();
  await page.waitForTimeout(150);
  restored = await saved();
  assert.equal(restored.review.metadata.provider, 'imported');
  assert.equal(restored.review.summary, imported.summary);
  assert.equal(restored.review.changes[0].after, imported.changes[0].after);
  assert.equal(restored.review.changes[0].status, 'pending');
  assert.equal(restored.draft[1].text, importedBlock.text, 'unaccepted imported suggestion must not alter draft');
  assert.equal(await page.locator('#request-state').textContent(), importedState);
  reports.push({ name: 'valid imported review cancels active request and survives its late reply without applying changes', passed: true });
  await writeFile(path.join(artifacts, 'results.json'), JSON.stringify(reports, null, 2));
  console.log(JSON.stringify(reports, null, 2));
} finally { await context.close(); }
