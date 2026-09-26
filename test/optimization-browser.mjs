// Real Chrome UI checks. Model/status replies are deterministic CONTRACT FIXTURES, not live calls.
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import * as core from '../public/core.mjs';
import { createApp } from '../server.mjs';
import { ensureDirectory, RUNTIME_ROOT } from '../server/paths.mjs';
const { chromium } = await import('playwright');
const root = await ensureDirectory(path.join(RUNTIME_ROOT, 'optimization-browser'));
const profile = await ensureDirectory(path.join(root, 'profile-' + Date.now()));
const cache = await ensureDirectory(path.join(root, 'cache'));
const configurationId = 'dwc1_' + 'a'.repeat(43), instructionVersion = 'fixture-v1';
const status = { ready: true, code: 'CONTRACT_FIXTURE', message: 'Contract fixture only', model: 'fixture', configurationId, instructionVersion };
let calls = 0, statusCalls = 0;
const server = await createApp({ env: { ...process.env, DW_DATA_DIR: path.join(root, 'data'), CODEX_PROJECT_PROFILE_DIR: path.join(root, 'data', '.runtime', 'codex-profile') }, statusImpl: async () => { statusCalls++; return { 'codex-cli': status, 'external-api': status }; }, polishImpl: async (provider, input) => {
  calls++; const blocks = input.blocks.filter(b => !b.locked);
  return { provider, model: 'fixture', configurationId, instructionVersion, usage: { input_tokens: 1200, output_tokens: 120 }, result: { summary: 'CONTRACT FIXTURE: browser guard checks', changes: blocks.slice(0,3).map((b, i) => ({ blockId: b.id, before: b.text, after: i === 1 ? b.text.replace('20', '21') : '此外，' + b.text, reason: 'CONTRACT FIXTURE' })) } };
} });
await new Promise((resolve,reject) => { server.once('error',reject); server.listen(6418,'127.0.0.1',resolve); });
const context = await chromium.launchPersistentContext(profile, { headless: true, executablePath: process.env.DW_BROWSER_BIN || undefined, downloadsPath: root, tracesDir: root, viewport: { width:1560,height:1000 }, args: ['--disk-cache-dir=' + cache, '--crash-dumps-dir=' + root] });
let page = await context.newPage(); const errors = [], reports = [];
context.on('page', p => p.on('pageerror', e => errors.push(e.message))); page.on('pageerror',e=>errors.push(e.message));
const url = 'http://127.0.0.1:6418';
function sourceProject() {
  let p = core.createProject({title:'浏览器专项'});
  p = core.addSource(p, core.parseSource({name:'候选甲',text:'# 总稿\n\n## 一章\n\n' + Array.from({length:24},(_,i)=>'段落 ' + i + '，服务读者 20 人。' + '用于阅读位置和段落比较的文字。'.repeat(8)).join('\n\n')}));
  const s=p.sources[0]; p=core.selectBlocks(p,s.id,s.blocks.slice(2,6).map(b=>b.id)); p.history=[]; return p;
}
async function openProject(p) {
  await page.evaluate(()=>document.querySelector('#toast').textContent='');
  await page.locator('#project-file').setInputFiles({ name:'fixture.draftweave.json', mimeType:'application/json', buffer:Buffer.from(JSON.stringify(p)) });
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('项目已恢复'));
}
async function readCurrent() {
  return page.evaluate(() => {
    const key = sessionStorage.getItem('draft-weave.window-copy.current.v1');
    return JSON.parse(JSON.parse(localStorage.getItem(key)).raw);
  });
}
async function emergency(name) {
  const event=page.waitForEvent('download'); await page.locator('[data-action="save-current"]').first().click(); const d=await event;
  const file=path.join(root,name); await d.saveAs(file); return core.deserializeProject(await readFile(file,'utf8'));
}
try {
  await page.goto(url); await page.waitForSelector('.source-text');
  let p=sourceProject(); await openProject(p);
  // Instrument actual localStorage writes. No implementation hooks are required.
  await page.evaluate(() => { window.writeProbe=[]; const set=Storage.prototype.setItem; Storage.prototype.setItem=function(k,v) { if(this===localStorage) window.writeProbe.push({key:k,bytes:new TextEncoder().encode(v).length}); return set.call(this,k,v); }; });
  let editor=page.locator('#draft textarea').first(), original=await editor.inputValue();
  await editor.focus();
  await page.evaluate(() => { window.writeProbe=[]; const el=document.activeElement; for(let i=0;i<20;i++){el.value+='字';el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'字'}));} });
  const immediate=await page.evaluate(()=>window.writeProbe);
  assert.equal(immediate.length,20); assert.ok(immediate.every(w=>w.key.startsWith('draft-weave.input-journal.')));
  const tail=original+'字'.repeat(20); await page.waitForTimeout(1000); assert.equal((await readCurrent()).draft[0].text,tail);
  await editor.fill(tail+'第二段输入'); await page.waitForTimeout(1000); await editor.blur();
  await page.locator('[data-action="undo"]').click(); assert.equal(await page.locator('#draft textarea').first().inputValue(),original);
  reports.push({name:'20 input events write journals only; idle checkpoints preserve one edit undo',passed:true,journalWrites:immediate.length,maxJournalBytes:Math.max(...immediate.map(w=>w.bytes))});

  p=sourceProject(); await openProject(p); editor=page.locator('#draft textarea').first(); original=await editor.inputValue();
  await editor.focus(); await editor.dispatchEvent('compositionstart');
  await editor.fill(original+'中文组词'); await page.waitForTimeout(1100);
  assert.equal((await readCurrent()).draft[0].text,original); assert.equal(await editor.inputValue(),original+'中文组词');
  await editor.dispatchEvent('compositionend'); await page.waitForTimeout(1000); assert.equal((await readCurrent()).draft[0].text,original+'中文组词');
  reports.push({name:'composition text stays live and journaled without checkpointing until compositionend',passed:true});

  p=sourceProject(); await openProject(p); editor=page.locator('#draft textarea').first(); original=await editor.inputValue();
  await page.evaluate(()=>{ const write=Storage.prototype.setItem; window.failCopy=true; Storage.prototype.setItem=function(k,v){ if(this===localStorage && window.failCopy && k.startsWith('draft-weave.window-copy.')) throw new DOMException('Fixture quota failure','QuotaExceededError'); return write.call(this,k,v); }; });
  await editor.fill(original+'【保存失败后撤销】'); await page.waitForTimeout(1000); await editor.blur();
  await page.evaluate(()=>window.failCopy=false); await page.locator('[data-action="undo"]').click();
  assert.equal((await readCurrent()).draft[0].text,original); await page.reload(); await page.waitForSelector('#draft textarea'); assert.equal(await page.locator('#draft textarea').first().inputValue(),original);
  reports.push({name:'failed full checkpoint followed by undo remains undone after durable save and refresh',passed:true});

  p=sourceProject(); const s=p.sources[0]; p=core.moveBlock(p,p.draft[2].id,0); p=core.editBlock(p,p.draft[1].id,p.draft[1].text+'人工改文'); p=core.toggleLock(p,p.draft[1].id); await openProject(p);
  const prior=structuredClone(p.draft), expected=core.completeSection(p,s.id,s.blocks[1].id);
  const body=page.locator('#source-body-0'); await body.evaluate(el=>el.scrollTop=500); const beforeScroll=await body.evaluate(el=>el.scrollTop);
  // A programmatic DOM click avoids moving the source pane just to expose its chapter button.
  await page.locator('[data-action="complete-section"][data-block-id="'+s.blocks[1].id+'"]').evaluate(el=>el.click());
  let current=await readCurrent(); assert.deepEqual(current.draft.map(b=>[b.sourceBlockId,b.text,b.locked]),expected.draft.map(b=>[b.sourceBlockId,b.text,b.locked]));
  assert.equal(await body.evaluate(el=>el.scrollTop),beforeScroll);
  await page.locator('[data-action="undo"]').click(); assert.deepEqual((await readCurrent()).draft,prior);
  reports.push({name:'explicit original-order completion retains edits/locks, reading position and one undo',passed:true});

  p=sourceProject(); p.draft.forEach(b=>b.locked=true); await openProject(p); const lockedCalls=calls, lockedStatus=statusCalls;
  await page.locator('[data-action="polish"]').click(); assert.equal(calls,lockedCalls); assert.equal(statusCalls,lockedStatus); assert.match(await page.locator('#toast').textContent(),/均已锁定/);
  reports.push({name:'all-locked UI blocks before status and model HTTP requests',passed:true});

  p=sourceProject(); await openProject(p); await page.locator('[data-action="polish"]').click(); await page.waitForSelector('.change');
  current=await readCurrent(); assert.equal(current.review.metadata.usage.input_tokens,1200); assert.match(current.review.metadata.inputSignature,/^[a-f0-9]{64}$/);
  const completedCalls=calls; await page.locator('[data-action="polish"]').click(); await page.waitForSelector('#reuse-dialog[open]'); assert.equal(calls,completedCalls);
  await page.locator('[data-action="reuse-review"]').click(); assert.equal(calls,completedCalls);
  await page.locator('.review-context summary').first().click(); assert.match(await page.locator('.review-context').first().textContent(),/后一段.*来源原文/s);
  await page.locator('[data-action="accept-next"]').first().click();
  current=await readCurrent(); assert.equal(current.review.changes[0].status,'accepted'); assert.equal(current.review.changes[1].status,'blocked'); assert.equal(current.review.changes[2].status,'pending');
  assert.equal(await page.evaluate(()=>document.activeElement.dataset.id),current.review.changes[2].id);
  await page.screenshot({path:path.join(root,'review-context.png')});
  reports.push({name:'same-input review reuse makes zero extra calls; usage, inline context and decide-next skip blocked',passed:true});

  // The most recent journal must survive a renderer crash before an idle checkpoint.
  await page.locator('[data-action="tab-draft"]').click(); editor=page.locator('#draft textarea').nth(2); original=await editor.inputValue();
  await editor.fill(original+'【崩溃前尾字】');
  const crashedKey=await page.evaluate(()=>sessionStorage.getItem('draft-weave.window-copy.current.v1'));
  const cdp=await context.newCDPSession(page); const crashed=page.waitForEvent('crash'); cdp.send('Page.crash').catch(()=>{}); await crashed;
  const crashedPage=page; page=await context.newPage(); await page.goto(url); await page.waitForSelector('#draft textarea');
  await page.locator('[data-action="window-drafts"]').click();
  await page.locator('.window-copy').filter({hasText:crashedKey.slice(-6)}).locator('[data-action="restore-window"]').click();
  await crashedPage.close();
  assert.equal(await page.locator('#draft textarea').nth(2).inputValue(),original+'【崩溃前尾字】');
  current=await readCurrent(); assert.equal(current.review.changes[2].status,'stale');
  reports.push({name:'renderer crash then window-copy UI recovery restores unblurred tail and expires pending review',passed:true});

  // A second window restores its own copy and cannot overwrite the first window's tail.
  const firstPage=page; const firstText=await firstPage.locator('#draft textarea').nth(2).inputValue();
  page=await context.newPage(); await page.goto(url); await page.waitForSelector('#draft textarea');
  editor=page.locator('#draft textarea').first(); await editor.fill((await editor.inputValue())+'【第二窗口】'); await editor.blur();
  assert.equal(await firstPage.locator('#draft textarea').nth(2).inputValue(),firstText);
  await page.reload(); await page.waitForSelector('#draft textarea'); assert.match(await page.locator('#draft textarea').first().inputValue(),/第二窗口/);
  await page.close(); page=firstPage;
  reports.push({name:'second window keeps independent durable input across refresh',passed:true});

  p=sourceProject(); await openProject(p); await page.locator('[data-action="polish"]').click(); await page.waitForSelector('.change');
  let releaseStatus, statusReceived; const statusGate=new Promise(resolve=>releaseStatus=resolve), sawStatus=new Promise(resolve=>statusReceived=resolve);
  await page.route('**/api/status',async route=>{statusReceived();await statusGate;await route.fulfill({contentType:'application/json',body:JSON.stringify({providers:{'codex-cli':status,'external-api':status}})});});
  await page.locator('[data-action="polish"]').click(); await sawStatus; await page.locator('[data-action="tab-draft"]').click();
  editor=page.locator('#draft textarea').first(); original=await editor.inputValue(); await editor.fill(original+'【等待连接时输入】'); releaseStatus();
  await page.waitForFunction(()=>!document.querySelector('#polish-button').classList.contains('busy')); assert.equal(await page.locator('#reuse-dialog[open]').count(),0);
  current=await readCurrent(); assert.equal(current.draft[0].text,original+'【等待连接时输入】'); assert.equal(current.review.changes[0].status,'stale');
  await page.unroute('**/api/status');
  reports.push({name:'input during status/hash wait cannot reuse an outdated review and late output is stale',passed:true});

  // Full input crosses the exact UTF-8 HTTP limit; the draft and all sources stay intact.
  p=core.createProject({title:'超限润色'}); p=core.addSource(p,core.parseSource({name:'完整大稿',text:'完整文稿。'.repeat(60000)})); p=core.selectBlocks(p,p.sources[0].id,[p.sources[0].blocks[0].id]); p.history=[];
  await openProject(p); const oversizeCalls=calls; await page.locator('[data-action="polish"]').click(); assert.equal(calls,oversizeCalls); assert.match(await page.locator('#toast').textContent(),/超过 2 MB/);
  const recovered=await emergency('oversize-input-current.draftweave.json'); assert.deepEqual(recovered.sources,p.sources); assert.deepEqual(recovered.draft,p.draft);
  reports.push({name:'UTF-8 byte preflight sends zero model requests without trimming; current export restores',passed:true});

  // A valid compact v1 import can be below 50 MB while pretty full export exceeds it.
  let large, raw, fullBytes;
  for(let width=480;width<=620;width+=2){
    large=core.createProject({title:'长历史应急恢复'});
    const text=Array.from({length:120},(_,i)=>'第'+i+'段。'+'文'.repeat(width)).join('\n\n');
    large=core.addSource(large,core.parseSource({name:'长历史来源',text})); large=core.selectBlocks(large,large.sources[0].id,large.sources[0].blocks.map(b=>b.id)); large.history=[];
    const state=JSON.parse(core.serializeProject(large,{includeHistory:false})); delete state.history;
    large.history=Array.from({length:80},()=>state);
    fullBytes=Buffer.byteLength(JSON.stringify(large,null,2)); raw=JSON.stringify(large);
    if(fullBytes>50_000_000 && Buffer.byteLength(raw)<50_000_000) break;
  }
  assert.ok(fullBytes>50_000_000 && Buffer.byteLength(raw)<50_000_000);
  large.draft[0].locked=true;
  large=core.attachReview(large,{summary:'CONTRACT FIXTURE',changes:[{blockId:large.draft[1].id,before:large.draft[1].text,after:'此外，'+large.draft[1].text,reason:'CONTRACT FIXTURE'}]},large.revision,{provider:'imported'});
  raw=JSON.stringify(large); assert.ok(Buffer.byteLength(raw)<50_000_000);
  await page.evaluate(()=>document.querySelector('#toast').textContent='');
  await page.locator('#project-file').setInputFiles({name:'large-v1.json',mimeType:'application/json',buffer:Buffer.from(raw)});
  await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('项目已恢复'),{},{timeout:60000});
  await page.locator('[data-action="save-project"]').click(); assert.match(await page.locator('#toast').textContent(),/项目文件过大|超过|50/);
  const savedLarge=await emergency('large-history-current.draftweave.json');
  assert.deepEqual(savedLarge.sources,large.sources); assert.deepEqual(savedLarge.draft,large.draft); assert.deepEqual(savedLarge.review,large.review); assert.deepEqual(savedLarge.protection,large.protection); assert.equal(savedLarge.history.length,0);
  await page.locator('#project-file').setInputFiles(path.join(root,'large-history-current.draftweave.json')); await page.waitForSelector('.draft-block.is-locked');
  await page.locator('[data-action="tab-review"]').click(); assert.equal(await page.locator('.change.status-pending').count(),1);
  await page.screenshot({path:path.join(root,'emergency-restored.png')});
  reports.push({name:'over-limit full save has actual current-only download and UI re-import preserving source/lock/review',passed:true,fullBytes,compactImportBytes:Buffer.byteLength(raw),emergencyBytes:Buffer.byteLength(core.serializeProject(savedLarge,{compact:true}))});
  assert.deepEqual(errors,[]);
  await writeFile(path.join(root,'result.json'),JSON.stringify({kind:'real Chrome with contract fixtures; no live login/model calls',reports,modelFixtureCalls:calls,pageErrors:errors},null,2));
  console.log(JSON.stringify({passed:reports.length,reports,artifacts:root},null,2));
} catch(error) { await page.screenshot({path:path.join(root,'failure.png')}).catch(()=>{}); await writeFile(path.join(root,'failure.json'),JSON.stringify({error:error.stack,reports,pageErrors:errors},null,2)); throw error; }
finally { await context.close(); await new Promise(resolve=>server.close(resolve)); }
