// Real browser acceptance. Imported suggestions and routed failures are explicitly CONTRACT FIXTURES.
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { checkedPath, PROJECT_ROOT } from '../server/paths.mjs';
const { chromium } = await import('playwright');
const out = await checkedPath(path.join(PROJECT_ROOT, 'output/playwright'));
const profile = await checkedPath(path.join(PROJECT_ROOT, '.runtime/browser-profiles', `validation-${randomUUID()}`));
await mkdir(out, { recursive: true }); await mkdir(profile, { recursive: true });
const reports = [], consoleErrors = [];
const context = await chromium.launchPersistentContext(profile, {
  headless: true, executablePath: process.env.DW_BROWSER_BIN || undefined,
  viewport: { width: 1560, height: 1000 }, locale: 'zh-CN', acceptDownloads: true,
  downloadsPath: path.join(out, 'downloads'), tracesDir: path.join(out, 'traces'),
  args: [`--crash-dumps-dir=${path.join(out, 'crash-dumps')}`, `--disk-cache-dir=${path.join(PROJECT_ROOT, '.runtime/browser-cache/validation')}`],
});
const page = context.pages()[0] || await context.newPage();
page.on('pageerror', error => consoleErrors.push(error.message));
await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
const url = `http://127.0.0.1:${process.env.DW_PORT || 6410}`;
const click = action => page.locator(`[data-action="${action}"]`).first().click();
const project = () => page.evaluate(() => JSON.parse(localStorage.getItem('draft-weave.project.v1')));
const paragraphs = () => page.locator('#draft [data-draft-id]');
const textareas = () => page.locator('#draft textarea');
const waitCount = count => page.waitForFunction(n => document.querySelectorAll('#draft [data-draft-id]').length === n, count);
async function dragBlockBefore(id, target) {
  // dragTo scrolls the distant target before its first move, so the source can leave the pointer
  // before Chrome starts native dragging. Start dragging visibly before scrolling the target.
  const handle = page.locator(`[data-drag-id="${id}"]`);
  await handle.hover();
  const box = await handle.boundingBox();
  assert.ok(box);
  await page.evaluate(() => {
    window.__nativeDragWitness = { started: false, dropped: false };
    document.addEventListener('dragstart', () => { window.__nativeDragWitness.started = true; }, { once: true });
    document.addEventListener('drop', () => { window.__nativeDragWitness.dropped = true; }, { once: true });
  });
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x - 12, y - 12, { steps: 4 });
  await page.waitForFunction(() => window.__nativeDragWitness.started);
  await target.scrollIntoViewIfNeeded();
  const destination = await target.boundingBox();
  assert.ok(destination);
  await page.mouse.move(destination.x + 30, destination.y + 3, { steps: 10 });
  await page.mouse.move(destination.x + 31, destination.y + 4);
  await page.mouse.up();
  assert.deepEqual(await page.evaluate(() => window.__nativeDragWitness), { started: true, dropped: true });
}
async function check(name, fn) { await fn(); reports.push({ name, passed: true }); console.log(`PASS ${name}`); }
async function savedFile(kind) {
  await click(kind === 'project' ? 'save-project' : 'export');
  await page.locator('#export-dialog').waitFor({ state: 'visible' });
  const target = await page.locator('#export-path').textContent();
  await checkedPath(target);
  const content = await readFile(target, 'utf8');
  const received = page.waitForEvent('download');
  await page.locator('#export-download').click();
  const download = await received;
  assert.equal(await download.failure(), null);
  const downloaded = await download.path();
  assert.equal(await readFile(downloaded, 'utf8'), content, 'browser download must equal the saved draft snapshot');
  await page.screenshot({ path: path.join(out, `export-${kind}.png`), fullPage: true });
  await page.locator('#export-dialog [data-action="close-dialog"]').first().click();
  return { target, content };
}
try {
  // Leave the app first: its beforeunload autosave would otherwise overwrite localStorage.clear().
  await page.goto('about:blank');
  const storage = await context.newCDPSession(page);
  await storage.send('Storage.clearDataForOrigin', { origin: new URL(url).origin, storageTypes: 'local_storage' });
  await storage.detach();
  await page.goto(url);
  await page.locator('.source-text').first().waitFor();
  await check('first screen contains directly operable A/B source documents', async () => {
    assert.equal(await page.locator('.source-column').count(), 2);
    assert.ok(await page.locator('.source-text').count() > 10);
    await page.screenshot({ path: path.join(out, '01-initial-canvas.png'), fullPage: true });
  });
  await check('chapter select, child cancellation and two cross-draft replacements deduplicate', async () => {
    await page.locator('[data-action="section"][data-source-id="source-a"]').nth(1).click();
    await waitCount(6);
    const cancel = page.locator('[data-action="select"][data-source-id="source-a"]').filter({ hasText: '过去的改造' });
    await cancel.click(); await waitCount(5);
    const firstTarget = paragraphs().filter({ has: page.locator('textarea', { hasText: '社区图书馆不只是' }) });
    await firstTarget.locator('[data-action="replace"]').click();
    await page.locator('[data-action="select"][data-source-id="source-b"]').filter({ hasText: '首先，应把有限资源' }).click();
    await waitCount(5);
    await cancel.click(); await waitCount(6);
    await paragraphs().last().locator('[data-action="replace"]').click();
    await page.locator('[data-action="select"][data-source-id="source-b"]').filter({ hasText: '其次，社区阅读空间' }).click();
    await waitCount(6);
    const data = await project();
    assert.equal(new Set(data.draft.map(b => `${b.sourceId}:${b.sourceBlockId}`)).size, 6);
    assert.equal(data.draft.filter(b => b.sourceId === 'source-b').length, 2);
  });
  await check('source location, C chapter insertion and actual drag sorting', async () => {
    await page.getByLabel('候选稿 2', { exact: true }).selectOption('source-c');
    await page.locator('[data-action="section"][data-source-id="source-c"]').last().click();
    await waitCount(9);
    await page.locator('[data-action="select"][data-source-id="source-a"]').first().click(); await waitCount(10);
    const titleId = (await project()).draft.at(-1).id;
    await dragBlockBefore(titleId, paragraphs().first());
    assert.equal((await project()).draft[0].id, titleId);
    await click('undo'); assert.equal((await project()).draft.at(-1).id, titleId);
    await dragBlockBefore(titleId, paragraphs().first());
    await paragraphs().filter({ has: page.locator('textarea', { hasText: '首先，应把有限资源' }) }).locator('[data-action="origin"]').click();
    assert.equal(await page.getByLabel('候选稿 2', { exact: true }).inputValue(), 'source-b');
  });
  await check('manual editing and undo, quote block lock', async () => {
    const editor = textareas().filter({ hasText: '首先，应把有限资源' });
    const before = await editor.inputValue();
    await editor.fill(`从需求出发，${before}`); await editor.blur();
    assert.equal((await project()).draft.find(b => b.text.includes('从需求出发，')).text, `从需求出发，${before}`);
    await click('undo'); assert.ok(!(await project()).draft.some(b => b.text.startsWith('从需求出发，')));
    await paragraphs().filter({ has: page.locator('textarea', { hasText: '一位虚构受访者说' }) }).locator('[data-action="lock"]').click();
    assert.ok(await textareas().filter({ hasText: '一位虚构受访者说' }).getAttribute('readonly') !== null);
    await page.screenshot({ path: path.join(out, '02-assembled-canvas.png'), fullPage: true });
  });
  let saved;
  await check('project save, refresh restore and Markdown export have identical text/order', async () => {
    const before = await project();
    saved = await savedFile('project');
    assert.deepEqual(JSON.parse(saved.content).draft, before.draft);
    await page.reload(); await waitCount(10);
    assert.deepEqual((await project()).draft, before.draft);
    const markdown = await savedFile('markdown');
    assert.equal(markdown.content, before.draft.map(b => b.text).join('\n\n') + '\n');
    await page.locator('#project-file').setInputFiles(saved.target);
    await page.waitForFunction(id => JSON.parse(localStorage.getItem('draft-weave.project.v1')).id === id, before.id);
    assert.deepEqual((await project()).draft, before.draft);
  });
  await check('real unconfigured CLI fails explicitly and retains complete manuscript', async () => {
    const before = (await project()).draft;
    const responsePromise = page.waitForResponse(r => r.url().endsWith('/api/polish'));
    await click('polish');
    const response = await responsePromise;
    assert.equal((await response.json()).error.code, 'NOT_LOGGED_IN');
    await page.locator('#settings-dialog').waitFor({ state: 'visible' });
    assert.deepEqual((await project()).draft, before);
    await page.locator('#settings-dialog [data-action="close-dialog"]').click();
  });
  await check('CONTRACT FIXTURE: imported whole-document diff, three accepts, one rejection, numeric and quote/lock interception', async () => {
    const data = await project();
    const first = data.draft.find(b => b.text.startsWith('首先，应把'));
    const second = data.draft.find(b => b.text.startsWith('其次，'));
    const ending = data.draft.filter(b => b.sourceId === 'source-c' && b.type === 'paragraph');
    const numbers = data.draft.find(b => b.text.includes('120 位'));
    const quote = data.draft.find(b => b.locked);
    const suggestions = { summary: '离线合同 fixture：演示全文转承、指代与术语审阅；非实时模型输出。', changes: [
      { blockId: first.id, before: first.text, after: `回应这些走访发现，${first.text}`, reason: '把走访背景连接到服务方案。' },
      { blockId: second.id, before: second.text, after: second.text.replace('社区阅读空间', '社区图书馆').replace('它不应', '这一开放时段不应'), reason: '统一全文术语，明确“它”的指代。' },
      { blockId: ending[0].id, before: ending[0].text, after: `在上述试行安排的基础上，${ending[0].text}`, reason: '把结尾连接到前文的试行安排。' },
      { blockId: ending[1].id, before: ending[1].text, after: ending[1].text.replace('我们不必等待', '我们应该等待'), reason: '保留数字但故意反转观点的拒绝用 fixture。' },
      { blockId: numbers.id, before: numbers.text, after: numbers.text.replace('120', '121'), reason: '故意破坏数字的拦截 fixture。' },
      { blockId: quote.id, before: quote.text, after: quote.text.replace('更多书架', '更大书架'), reason: '故意破坏引文与整段锁的拦截 fixture。' },
    ] };
    await writeFile(path.join(out, 'review-contract-fixture.json'), JSON.stringify(suggestions, null, 2));
    await writeFile(path.join(out, 'demo-before-review.json'), JSON.stringify(data, null, 2));
    await click('settings');
    await page.locator('#review-file').setInputFiles(path.join(out, 'review-contract-fixture.json'));
    await page.locator('#review').waitFor({ state: 'visible' });
    assert.deepEqual((await project()).draft, data.draft);
    assert.equal(await page.locator('.change.status-blocked').count(), 2);
    assert.equal(await page.locator('.change.status-blocked [data-action="accept"]:disabled').count(), 2);
    await page.screenshot({ path: path.join(out, '03-review-fixture.png'), fullPage: true });
    for (let i = 0; i < 3; i++) await page.locator('[data-action="accept"]:not(:disabled)').first().click();
    await page.locator('.change.status-pending [data-action="reject"]').click();
    const after = await project();
    assert.equal(after.review.changes.filter(c => c.status === 'accepted').length, 3);
    assert.equal(after.draft.find(b => b.id === numbers.id).text, numbers.text);
    assert.equal(after.draft.find(b => b.id === quote.id).text, quote.text);
    assert.equal(after.draft.find(b => b.id === ending[1].id).text, ending[1].text);
    const final = await savedFile('markdown');
    assert.equal(final.content, after.draft.map(b => b.text).join('\n\n') + '\n');
    assert.ok(!final.content.includes('121 位'));
    await writeFile(path.join(out, 'demo-final.md'), final.content);
  });
  await check('CONTRACT FIXTURE: timeout and cancellation leave accepted manuscript intact; reload recovers', async () => {
    const before = (await project()).draft;
    await page.route('**/api/polish', route => route.fulfill({ status: 504, contentType: 'application/json', body: JSON.stringify({ error: { code: 'TIMEOUT', message: '合同 fixture：请求超时；成稿保留。' } }) }));
    await click('polish');
    await page.getByText('合同 fixture：请求超时；成稿保留。', { exact: true }).waitFor();
    assert.deepEqual((await project()).draft, before);
    await page.unroute('**/api/polish');
    let heldRoute;
    await page.route('**/api/polish', route => { heldRoute = route; });
    await click('polish'); await page.locator('#cancel-button').waitFor({ state: 'visible' });
    await click('cancel');
    assert.deepEqual((await project()).draft, before);
    if (heldRoute) await heldRoute.abort().catch(() => {});
    await page.unroute('**/api/polish');
    await page.reload(); await waitCount(10);
    assert.deepEqual((await project()).draft, before);
    assert.equal((await project()).review.changes.filter(c => c.status === 'accepted').length, 3);
  });
  await check('invalid project rejected without losing draft, blank project undo restores sources', async () => {
    const before = await project();
    await page.locator('#project-file').setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{"version":900}') });
    await page.locator('#toast').filter({ hasText: '打开失败' }).waitFor();
    assert.deepEqual((await project()).draft, before.draft);
    await click('new'); await waitCount(0); await page.reload();
    await page.locator('.empty-draft').first().waitFor();
    await click('undo'); await waitCount(10);
    assert.deepEqual((await project()).draft, before.draft);
  });
  await check('Markdown and text imports, duplicate and empty section notices, narrow viewport usable', async () => {
    await page.locator('#source-files').setInputFiles([
      { name: 'D.md', mimeType: 'text/markdown', buffer: Buffer.from('# 导入标题\n\n导入正文。\n\n## 空章节') },
      { name: 'E.txt', mimeType: 'text/plain', buffer: Buffer.from('导入正文。\n\n第二段。') },
    ]);
    await page.locator('[data-action="select"]').filter({ hasText: '导入正文。' }).first().click();
    await page.locator('[data-action="select"]').filter({ hasText: '导入正文。' }).nth(1).click();
    await page.locator('[data-action="select"]').filter({ hasText: '空章节' }).click();
    await page.locator('#structure-notices summary').click();
    assert.ok((await page.locator('#structure-notices').textContent()).includes('重复'));
    assert.ok((await page.locator('#structure-notices').textContent()).includes('没有正文'));
    await page.setViewportSize({ width: 760, height: 1100 });
    assert.ok(await page.locator('[data-action="import"]').first().isVisible());
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    assert.equal(overflow, false);
    await page.screenshot({ path: path.join(out, '04-narrow-layout.png'), fullPage: true });
  });
  await check('damaged autosave survives edit and reload; failed backup preserves it; durable backup resumes saving', async () => {
    const damaged = '{"version":1,"draft":["incomplete user content \u6587\u7a3f"';
    // Seed the same origin without running the app's unload autosave.
    await page.route('**/recovery-seed', route => route.fulfill({ contentType: 'text/html', body: '<title>Storage failure fixture</title>' }));
    await page.goto(`${url}/recovery-seed`);
    await page.evaluate(value => localStorage.setItem('draft-weave.project.v1', value), damaged);
    await page.unroute('**/recovery-seed');
    await page.goto(url);
    await page.locator('#recovery-banner').waitFor({ state: 'visible' });
    await click('first-chapter');
    assert.equal(await page.evaluate(() => localStorage.getItem('draft-weave.project.v1')), damaged);
    await page.reload();
    await page.locator('#recovery-banner').waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => localStorage.getItem('draft-weave.project.v1')), damaged);
    await page.route('**/api/export', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'FIXTURE_WRITE_FAILED', message: '备份写入失败，原始草稿保留。' } }) }));
    await click('recover-local');
    await page.locator('#toast').filter({ hasText: '备份写入失败' }).waitFor();
    assert.equal(await page.locator('#recovery-banner').isVisible(), true);
    assert.equal(await page.evaluate(() => localStorage.getItem('draft-weave.project.v1')), damaged);
    await page.unroute('**/api/export');
    await click('recover-local');
    await page.locator('#export-dialog').waitFor({ state: 'visible' });
    const backupPath = await page.locator('#export-path').textContent();
    await checkedPath(backupPath);
    assert.equal(await readFile(backupPath, 'utf8'), damaged);
    assert.equal(await page.locator('#recovery-banner').isVisible(), false);
    assert.equal((await project()).version, 1);
  });
  assert.deepEqual(consoleErrors, []);
  await writeFile(path.join(out, 'browser-validation.json'), JSON.stringify({ checkedAt: new Date().toISOString(), url, browser: await context.browser()?.version(), profile, fixtureNotice: 'Imported suggestions and timeout/cancel transport are contract fixtures; no real model output.', reports, consoleErrors }, null, 2));
} catch (error) {
  await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {});
  await writeFile(path.join(out, 'browser-failure.json'), JSON.stringify({ reports, error: error.stack, consoleErrors }, null, 2));
  throw error;
} finally {
  await context.tracing.stop({ path: path.join(out, 'browser-validation.zip') }).catch(error => console.error(`Trace unavailable: ${error.message}`));
  await context.close();
}
