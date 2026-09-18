// Real Chrome windows; all model responses below are labeled CONTRACT FIXTURES.
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { PROJECT_ROOT } from '../server/paths.mjs';
const { chromium } = await import('playwright');
const out = path.join(PROJECT_ROOT, 'output/playwright/multi-window');
const profile = path.join(PROJECT_ROOT, '.runtime/browser-profiles', `multi-window-${randomUUID()}`);
await mkdir(out, { recursive: true }); await mkdir(profile, { recursive: true });
const context = await chromium.launchPersistentContext(profile, {
  headless: true, executablePath: process.env.DW_BROWSER_BIN || undefined,
  viewport: { width: 1560, height: 1000 }, downloadsPath: out, tracesDir: out,
  args: [`--disk-cache-dir=${path.join(PROJECT_ROOT, '.runtime/browser-cache/multi-window')}`, `--crash-dumps-dir=${out}`],
});
const url = `http://127.0.0.1:${process.env.DW_PORT || 6410}`;
const reports = [], pageErrors = [];
context.setDefaultTimeout(10_000);
context.setDefaultNavigationTimeout(10_000);
const watch = p => { p.on('pageerror', e => pageErrors.push(e.message)); return p; };
const a = watch(context.pages()[0] || await context.newPage());
const editor = p => p.locator('#draft textarea').nth(1);
const shared = p => p.evaluate(() => JSON.parse(localStorage.getItem('draft-weave.project.v1')));
const copies = p => p.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('draft-weave.window-copy.v1.')).map(k => JSON.parse(localStorage.getItem(k))));
async function check(name, fn) { await fn(); reports.push({ name, passed: true }); console.log(`PASS ${name}`); }
async function exportFile(p, kind) {
  await p.locator(`[data-action="${kind === 'project' ? 'save-project' : 'export'}"]`).first().click();
  await p.locator('#export-dialog').waitFor({ state: 'visible' });
  const download = p.waitForEvent('download'); await p.locator('#export-download').click();
  const file = await download; assert.equal(await file.failure(), null);
  const content = await readFile(await file.path(), 'utf8');
  await p.locator('#export-dialog [data-action="close-dialog"]').first().click();
  return content;
}
await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
try {
  await a.goto(url); await a.locator('[data-action="first-chapter"]').click();
  await a.waitForFunction(() => document.querySelector('#save-state').textContent === '已自动保存 · 本地');
  const b = watch(await context.newPage()); await b.goto(url);
  await b.locator('#window-banner').waitFor({ state: 'visible' });
  let aText, bText;
  await check('simultaneous focused inputs use separate copies; storage events preserve cursor and text', async () => {
    bText = '【乙窗口独立成稿】社区服务需要保留居民访谈的上下文。';
    await editor(b).fill(bText); await editor(b).evaluate(el => el.setSelectionRange(3, 8));
    aText = '【甲窗口默认成稿】服务方案先试行，再根据反馈修订。'; await editor(a).fill(aText);
    await b.waitForFunction(() => JSON.parse(localStorage.getItem('draft-weave.project.v1')).draft[1].text.includes('甲窗口'));
    assert.equal((await shared(b)).draft[1].text, aText);
    assert.equal(await editor(b).inputValue(), bText);
    assert.deepEqual(await editor(b).evaluate(el => [document.activeElement === el, el.selectionStart, el.selectionEnd]), [true, 3, 8]);
    assert.ok((await copies(a)).some(c => JSON.parse(c.raw).draft[1]?.text === bText));
    await b.evaluate(() => window.dispatchEvent(new StorageEvent('storage', { key: 'draft-weave.project.v1', newValue: '{"obsolete":"delayed notification"}' })));
    assert.equal(await editor(b).inputValue(), bText);
    assert.deepEqual(await editor(b).evaluate(el => [document.activeElement === el, el.selectionStart, el.selectionEnd]), [true, 3, 8]);
    await b.screenshot({ path: path.join(out, 'independent-window.png'), fullPage: true });
  });
  await check('duplicated session storage gets a distinct copy and cannot overwrite its opener', async () => {
    const opened = b.waitForEvent('popup'); await b.evaluate(() => window.open(location.href));
    const duplicate = watch(await opened); await duplicate.waitForLoadState('domcontentloaded');
    assert.equal(await editor(duplicate).inputValue(), bText);
    await editor(duplicate).fill('【复制标签页】独立保存此内容。');
    assert.equal(await editor(b).inputValue(), bText);
    assert.equal((await shared(duplicate)).draft[1].text, aText);
    assert.ok((await copies(duplicate)).some(copy => JSON.parse(copy.raw).draft[1]?.text === bText));
    await duplicate.close();
  });
  await check('late model reply stays in its branch and cannot overwrite either focused input', async () => {
    let release, received;
    const gate = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { received = resolve; });
    await b.route('**/api/polish', async route => {
      const input = route.request().postDataJSON(); received(input); await gate;
      const block = input.input.blocks[1];
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ provider: 'external-api', model: 'fixture', result: { summary: 'CONTRACT FIXTURE', changes: [{ blockId: block.id, before: block.text, after: block.text + '然后复盘。', reason: 'CONTRACT FIXTURE: test delayed response only.' }] } }) });
    });
    await b.locator('[data-action="polish"]').click(); await started;
    bText += '【请求之后继续输入】'; await editor(b).fill(bText);
    aText += '【另一窗口同步继续】'; await editor(a).fill(aText);
    release();
    await b.waitForFunction(() => !document.querySelector('#polish-button').classList.contains('busy'));
    const branch = (await copies(b)).find(c => JSON.parse(c.raw).draft[1]?.text === bText && JSON.parse(c.raw).review);
    assert.ok(branch); assert.equal(JSON.parse(branch.raw).review.changes[0].status, 'stale');
    assert.equal((await shared(a)).draft[1].text, aText);
    assert.equal(await editor(a).inputValue(), aText);
    assert.equal(await editor(b).inputValue(), bText);
    await b.unroute('**/api/polish'); await b.locator('[data-action="tab-draft"]').click();
  });
  await check('both windows export their own exact draft and project', async () => {
    assert.ok((await exportFile(a, 'markdown')).includes(aText));
    const bMarkdown = await exportFile(b, 'markdown');
    assert.ok(bMarkdown.includes(bText)); assert.ok(!bMarkdown.includes(aText));
    assert.equal(JSON.parse(await exportFile(b, 'project')).draft[1].text, bText);
  });
  await check('refresh restores the secondary branch; closing the writer requires explicit promotion and archives old default', async () => {
    await b.reload(); assert.equal(await editor(b).inputValue(), bText);
    assert.equal((await shared(b)).draft[1].text, aText);
    await editor(b).focus(); await editor(b).evaluate(el => el.setSelectionRange(2, 5));
    await a.close(); await b.locator('#use-window-draft').waitFor({ state: 'visible' });
    assert.equal((await shared(b)).draft[1].text, aText);
    assert.deepEqual(await editor(b).evaluate(el => [document.activeElement === el, el.selectionStart, el.selectionEnd]), [true, 2, 5]);
    await b.locator('#use-window-draft').click();
    assert.equal((await shared(b)).draft[1].text, bText);
    assert.ok((await copies(b)).some(c => c.title === '切换前的默认草稿' && JSON.parse(c.raw).draft[1].text === aText));
  });
  const c = watch(await context.newPage()); await c.goto(url);
  let cText = '【丙窗口恢复稿】异常关闭之后仍然可以取回此段。';
  await check('renderer crash releases ownership and preserves focused checkpoints without unload', async () => {
    console.log('CHECK crash: edit both windows');
    await editor(c).fill(cText); await editor(c).evaluate(el => el.setSelectionRange(1, 4));
    bText += '【崩溃之前最后一次输入】'; await editor(b).fill(bText);
    const crash = await context.newCDPSession(b);
    const crashed = b.waitForEvent('crash', { timeout: 10_000 });
    // Chromium intentionally does not reply to Page.crash. Await the actual renderer event.
    void crash.send('Page.crash').catch(() => {});
    await crashed;
    console.log('CHECK crash: renderer stopped; awaiting lock release');
    await c.locator('#use-window-draft').waitFor({ state: 'visible' });
    assert.equal((await shared(c)).draft[1].text, bText);
    assert.equal(await editor(c).inputValue(), cText);
    assert.deepEqual(await editor(c).evaluate(el => [document.activeElement === el, el.selectionStart, el.selectionEnd]), [true, 1, 4]);
    assert.ok((await copies(c)).some(copy => JSON.parse(copy.raw).draft[1]?.text === bText));
    console.log('CHECK crash: recovery verified; closing crashed target');
    await b.close();
  });
  await check('failed preservation cannot replace the default; retry succeeds after storage recovers', async () => {
    await c.evaluate(() => {
      window.originalSetItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (key.startsWith('draft-weave.window-copy.v1.')) throw new DOMException('test quota', 'QuotaExceededError');
        return window.originalSetItem.call(this, key, value);
      };
    });
    await c.locator('#use-window-draft').click();
    assert.equal((await shared(c)).draft[1].text, bText);
    cText += '【容量不足时的输入】'; await editor(c).fill(cText);
    assert.match(await c.locator('#save-state').textContent(), /未成功/);
    assert.equal((await shared(c)).draft[1].text, bText);
    assert.equal(JSON.parse(await exportFile(c, 'project')).draft[1].text, cText);
    await c.evaluate(() => { Storage.prototype.setItem = window.originalSetItem; });
    await editor(c).fill(cText + '【恢复】'); cText += '【恢复】';
    await c.locator('#use-window-draft').click();
    assert.equal((await shared(c)).draft[1].text, cText);
  });
  await check('without Web Locks, editing and refresh use a separate copy and leave default untouched', async () => {
    const d = watch(await context.newPage());
    await d.addInitScript(() => Object.defineProperty(navigator, 'locks', { value: undefined }));
    await d.goto(url); await editor(d).fill('【无锁浏览器】此段只保存在独立窗口副本。');
    assert.match(await d.locator('#window-message').textContent(), /不支持写入锁/);
    assert.equal((await shared(d)).draft[1].text, cText);
    await d.reload(); assert.match(await editor(d).inputValue(), /无锁浏览器/);
    assert.equal((await shared(d)).draft[1].text, cText);
    await d.close();
  });
  await check('closed-window copies remain independently downloadable and explicitly restorable', async () => {
    await c.locator('[data-action="window-drafts"]').click();
    const archived = c.locator('.window-copy').filter({ has: c.locator('strong', { hasText: '切换前的默认草稿' }) }).first();
    const download = c.waitForEvent('download'); await archived.locator('[data-action="download-window"]').click();
    const file = await download; const raw = await readFile(await file.path(), 'utf8');
    assert.equal(JSON.parse(raw).draft[1].text, bText);
    await archived.locator('[data-action="restore-window"]').click();
    assert.equal(await editor(c).inputValue(), bText);
    assert.ok((await copies(c)).some(copy => copy.title === '恢复前的本窗口草稿' && JSON.parse(copy.raw).draft[1]?.text === cText));
    await c.locator('[data-action="window-drafts"]').click();
    const before = await c.locator('.window-copy').count();
    await c.locator('[data-action="delete-window"]').first().click();
    assert.equal(await c.locator('.window-copy').count(), before - 1);
    await c.screenshot({ path: path.join(out, 'recoverable-copies.png'), fullPage: true });
  });
  assert.deepEqual(pageErrors, []);
  await writeFile(path.join(out, 'results.json'), JSON.stringify({ reports, pageErrors, browser: context.browser()?.version(), paidModelCalls: 0 }, null, 2));
} finally {
  await context.tracing.stop({ path: path.join(out, 'trace.zip') }).catch(() => {});
  await context.close();
}
