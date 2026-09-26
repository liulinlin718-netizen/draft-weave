import test from 'node:test';
import assert from 'node:assert/strict';
import { windowDrafts, DEFAULT_DRAFT } from '../public/window-drafts.mjs';
import { COPY_PREFIX, INPUT_PREFIX, inputJournalKey, recoverInput } from '../public/input-journal.mjs';
import { createProject, parseSource, addSource, selectBlocks, editBlock, moveBlock, serializeProject, deserializeProject, undo, attachReview } from '../public/core.mjs';

const SESSION = 'draft-weave.window-copy.current.v1';
const raw = project => serializeProject(project, { includeHistory: false, compact: true });
class Storage {
  data = new Map(); operations = []; fail = () => false;
  get length() { return this.data.size; }
  key(index) { return [...this.data.keys()][index] ?? null; }
  getItem(key) { this.operations.push(['get', key]); if (this.fail('get', key)) throw new Error('blocked read'); return this.data.get(key) ?? null; }
  setItem(key, value) { this.operations.push(['set', key, value]); if (this.fail('set', key, value)) throw new Error('QuotaExceededError'); this.data.set(key, String(value)); }
  removeItem(key) { this.operations.push(['remove', key]); if (this.fail('remove', key)) throw new Error('blocked remove'); this.data.delete(key); }
}
let identity = 0;
function fixture({ storage = new Storage(), session = new Storage(), locks = {} } = {}) {
  const statuses = [], listeners = new Map();
  const store = windowDrafts(value => statuses.push(value), { localStorage: storage, sessionStorage: session, locks,
    window: { addEventListener: (name, fn) => listeners.set(name, fn) }, randomUUID: () => `window-${++identity}`, now: () => '2026-09-26T00:00:00.000Z' });
  store.restore();
  return { store, storage, session, statuses, listeners, key: () => session.getItem(SESSION), status: () => statuses.at(-1) };
}
function project() {
  const source = parseSource({ id: 'sample', name: '试点稿', text: '# 展馆试点\n\n开放 8 周，保留“逐项审阅”。\n\n这一段等待补充。' });
  const selected = selectBlocks(addSource(createProject({ title: '输入恢复' }), source), source.id, source.blocks.map(block => block.id));
  selected.history = [];
  return selected;
}
function input(project, text, index = 1) {
  const block = project.draft[index];
  return { projectId: project.id, revision: project.revision, blockId: block.id, before: block.text, text };
}
function saved(f, p) {
  assert.equal(f.store.save(raw(p), p.title).copied, true);
  return f.key();
}

test('each input writes only its window journal; continuous typing keeps the latest text and one undo', () => {
  const f = fixture(), p = project(), key = saved(f, p), checkpoint = f.storage.getItem(key);
  f.storage.operations = [];
  for (const text of ['新', '新增', '新增尾字']) assert.equal(f.store.recordInput(input(p, text)), true);
  assert.deepEqual(f.storage.operations.map(op => [op[0], op[1]]), Array.from({ length: 3 }, () => ['set', inputJournalKey(key)]));
  assert.equal(f.storage.getItem(key), checkpoint);
  const journal = JSON.parse(f.storage.getItem(inputJournalKey(key)));
  assert.equal(journal.entries.length, 1);
  assert.equal(journal.entries[0].text, '新增尾字');
  assert.equal('sources' in journal, false);
  const reloaded = fixture({ storage: f.storage, session: f.session }).store.restore();
  const recovered = deserializeProject(reloaded.recovery);
  assert.equal(reloaded.inputRecovered, true);
  assert.equal(recovered.draft[1].text, '新增尾字');
  assert.equal(recovered.history.length, 1);
  assert.deepEqual(undo(recovered).draft, p.draft);
  assert.equal(f.storage.getItem(key), checkpoint);
  assert.notEqual(f.storage.getItem(inputJournalKey(key)), null);
});

test('successful checkpoint writes copy before deleting input, then starts a new binding', () => {
  const f = fixture(), p = project(), key = saved(f, p), beforeId = JSON.parse(f.storage.getItem(key)).checkpointId;
  f.store.recordInput(input(p, '补充完成。'));
  f.storage.operations = [];
  const next = editBlock(p, p.draft[1].id, '补充完成。');
  assert.equal(f.store.save(raw(next), next.title).copied, true);
  const ops = f.storage.operations;
  assert.ok(ops.findIndex(op => op[0] === 'set' && op[1] === key) < ops.findIndex(op => op[0] === 'remove' && op[1] === inputJournalKey(key)));
  const record = JSON.parse(f.storage.getItem(key));
  assert.notEqual(record.checkpointId, beforeId);
  assert.equal(record.summary, '补充完成。');
  assert.equal(record.size, new TextEncoder().encode(raw(next)).byteLength);
  assert.equal(f.storage.getItem(inputJournalKey(key)), null);
  assert.equal(f.store.recordInput(input(next, '补充完成。继续')), true);
  assert.equal(JSON.parse(f.storage.getItem(inputJournalKey(key))).checkpointId, record.checkpointId);
});

test('copy quota failures preserve the last checkpoint and accept typing across committed revisions', () => {
  const f = fixture(), original = project(), key = saved(f, original), checkpoint = f.storage.getItem(key);
  f.storage.fail = (op, item) => op === 'set' && item.startsWith(COPY_PREFIX);
  let p = original;
  for (const text of ['补', '补充', '补充到最后']) {
    assert.equal(f.store.recordInput(input(p, text)), true);
    p = editBlock(p, p.draft[1].id, text);
    p.history = [];
    assert.equal(f.store.save(raw(p), p.title).copied, false);
  }
  assert.equal(f.store.recordInput(input(p, '补充到最后一个尾字')), true);
  assert.equal(f.storage.getItem(key), checkpoint);
  const recovered = deserializeProject(f.store.read(key).raw);
  assert.equal(recovered.draft[1].text, '补充到最后一个尾字');
  assert.equal(recovered.history.length, 1);
  assert.deepEqual(undo(recovered).draft, original.draft);
  f.storage.fail = () => false;
  p = editBlock(p, p.draft[1].id, '补充到最后一个尾字');
  assert.equal(f.store.save(raw(p), p.title).copied, true);
  assert.equal(f.storage.getItem(inputJournalKey(key)), null);
});

test('failed checkpoints spanning blocks replay atomically with one undo and stale review', () => {
  const f = fixture();
  let p = project();
  p = attachReview(p, { summary: '离线合同', changes: [{ blockId: p.draft[2].id, before: p.draft[2].text, after: '接着，这一段等待补充。', reason: '转承' }] });
  p.history = [];
  const original = p, key = saved(f, p);
  f.storage.fail = (op, item) => op === 'set' && item === key;
  for (const index of [1, 2]) {
    const text = `${p.draft[index].text} 手动补充。`;
    f.store.recordInput(input(p, text, index));
    p = editBlock(p, p.draft[index].id, text);
    assert.equal(f.store.save(raw(p), p.title).copied, false);
  }
  const recovered = deserializeProject(f.store.read(key).raw);
  assert.deepEqual(recovered.draft, p.draft);
  assert.equal(recovered.review.changes[0].status, 'stale');
  assert.equal(recovered.history.length, 1);
  assert.deepEqual(undo(recovered).draft, original.draft);
  assert.equal(undo(recovered).review.changes[0].status, 'pending');
});

test('a default write failure leaves the full independent copy recoverable and future journal usable', async () => {
  const f = fixture({ locks: { request: async (_name, _options, callback) => callback() } }), p = project();
  f.store.start();
  const key = saved(f, p);
  f.store.recordInput(input(p, '独立副本的最新文字'));
  const next = editBlock(p, p.draft[1].id, '独立副本的最新文字');
  f.storage.fail = (op, item) => op === 'set' && item === DEFAULT_DRAFT;
  const state = f.store.save(raw(next), next.title);
  assert.equal(state.copied, true);
  assert.match(state.error, /自动保存未成功/);
  assert.equal(deserializeProject(f.store.read(key).raw).draft[1].text, '独立副本的最新文字');
  assert.equal(f.storage.getItem(inputJournalKey(key)), null);
  assert.equal(f.store.recordInput(input(next, '独立副本的最新文字与尾字')), true);
  f.store.stop();
});

test('journal quota failure preserves persisted input and exposes the newest input for download, then retries', () => {
  const f = fixture(), p = project(), key = saved(f, p);
  f.store.recordInput(input(p, '已经落盘'));
  const prior = f.storage.getItem(inputJournalKey(key));
  f.storage.fail = (op, item) => op === 'set' && item.startsWith(INPUT_PREFIX);
  assert.equal(f.store.recordInput(input(p, '尚未落盘的尾字')), false);
  assert.equal(f.storage.getItem(inputJournalKey(key)), prior);
  assert.match(f.status().inputError, /尚未安全保存/);
  assert.equal(JSON.parse(f.status().inputRecoveryRaw).entries[0].text, '尚未落盘的尾字');
  f.storage.fail = () => false;
  assert.equal(f.store.recordInput(input(p, '重试完整尾字')), true);
  assert.equal(deserializeProject(f.store.read(key).raw).draft[1].text, '重试完整尾字');
});

test('mismatched input project/revision/before is never appended or silently dropped', () => {
  const f = fixture(), p = project(), key = saved(f, p);
  f.store.recordInput(input(p, '合法输入'));
  const prior = f.storage.getItem(inputJournalKey(key));
  for (const override of [{ projectId: 'another' }, { revision: p.revision + 1 }, { before: '不同原文' }, { blockId: 'missing' }]) {
    const attempt = { ...input(p, '应单独下载'), ...override };
    assert.equal(f.store.recordInput(attempt), false);
    assert.equal(f.storage.getItem(inputJournalKey(key)), prior);
    assert.deepEqual(JSON.parse(f.status().inputRecoveryRaw).unappliedInput, attempt);
  }
});

test('an unrelated failed structural mutation cannot authorize a new input revision', () => {
  const f = fixture(), p = project(), key = saved(f, p);
  f.store.recordInput(input(p, '合法但未提交'));
  f.storage.fail = (op, item) => op === 'set' && item === key;
  const moved = moveBlock(p, p.draft[2].id, 0);
  assert.equal(f.store.save(raw(moved), moved.title).copied, false);
  assert.equal(f.store.recordInput({ ...input(p, '不能自动合并'), revision: moved.revision }), false);
  assert.equal(deserializeProject(f.store.read(key).raw).draft[1].text, '合法但未提交');
});

test('two windows keep separate journals and session restores; copied foreign journal is rejected', () => {
  const storage = new Storage(), first = fixture({ storage }), second = fixture({ storage }), p = project();
  const firstKey = saved(first, p), secondKey = saved(second, p);
  first.store.recordInput(input(p, '窗口甲'));
  second.store.recordInput(input(p, '窗口乙'));
  assert.notEqual(firstKey, secondKey);
  assert.equal(deserializeProject(first.store.restore().recovery).draft[1].text, '窗口甲');
  assert.equal(deserializeProject(second.store.restore().recovery).draft[1].text, '窗口乙');
  const stolen = storage.getItem(inputJournalKey(firstKey));
  storage.setItem(inputJournalKey(secondKey), stolen);
  const result = second.store.read(secondKey);
  assert.equal(result.raw, raw(p));
  assert.equal(result.inputRecoveryRaw, stolen);
  assert.match(result.inputError, /不匹配/);
});

test('bad/mismatched journals retain raw project and exact downloadable journal with no partial replay', () => {
  const f = fixture(), p = project(), key = saved(f, p);
  f.store.recordInput(input(p, '第一段新文'));
  const record = JSON.parse(f.storage.getItem(key)), valid = JSON.parse(f.storage.getItem(inputJournalKey(key)));
  const bads = ['{broken', JSON.stringify({ ...valid, checkpointId: 'old-checkpoint' }), JSON.stringify({ ...valid, projectId: 'another-project' }),
    JSON.stringify({ ...valid, revision: valid.revision + 1 }), JSON.stringify({ ...valid, entries: [...valid.entries, { blockId: p.draft[2].id, before: '不匹配', text: '不应用' }] })];
  for (const bad of bads) {
    const result = recoverInput(record, key, bad);
    assert.equal(result.raw, raw(p));
    assert.equal(result.inputRecovered, false);
    assert.equal(result.inputRecoveryRaw, bad);
    assert.ok(result.inputError);
  }
});

test('legacy v1 copies remain listable/restorable; absent checkpoint IDs never accept a journal', () => {
  const f = fixture(), p = project(), key = COPY_PREFIX + 'legacy';
  f.storage.setItem(key, JSON.stringify({ raw: raw(p), title: '旧稿', updatedAt: '2026-01-01' }));
  f.session.setItem(SESSION, key);
  assert.equal(f.store.restore().recovery, raw(p));
  assert.equal(f.store.list()[0].summary, '旧版副本，恢复或下载时读取。');
  assert.equal(f.store.read(key).summary, p.draft[1].text);
  f.storage.setItem(inputJournalKey(key), JSON.stringify({ version: 1, copyKey: key, projectId: p.id, revision: p.revision, entries: [] }));
  const result = f.store.restore();
  assert.equal(result.recovery, raw(p));
  assert.ok(result.inputError);
  assert.notEqual(result.inputRecoveryRaw, null);
});

test('damaged copies and raw errors remain accessible by list/read/download without replacement', () => {
  const f = fixture(), p = project(), key = saved(f, p), prior = f.storage.getItem(key);
  assert.equal(f.store.save('{not-json', '损坏').copied, false);
  assert.equal(f.storage.getItem(key), prior);
  const damaged = COPY_PREFIX + 'damaged', invalidProject = COPY_PREFIX + 'invalid-project';
  f.storage.setItem(damaged, 'exact broken bytes');
  f.storage.setItem(invalidProject, JSON.stringify({ raw: '{bad project}', title: '损坏项目' }));
  assert.equal(f.store.read(damaged).raw, 'exact broken bytes');
  assert.equal(f.store.read(invalidProject).raw, '{bad project}');
  assert.ok(f.store.list().some(item => item.key === damaged));
  f.session.setItem(SESSION, damaged);
  assert.equal(f.store.restore().recovery, 'exact broken bytes');
});

test('list uses stored summaries, read recovers a selected copy, and no history is automatically removed', () => {
  const f = fixture(), p = project(), key = saved(f, p);
  f.store.recordInput(input(p, '恢复后的预览'));
  f.store.archive(raw(p), '历史副本');
  const before = [...f.storage.data];
  const listed = f.store.list(), listedCurrent = listed.find(item => item.key === key);
  assert.equal(listed.length, 2);
  assert.equal(listedCurrent.summary, p.draft[1].text);
  assert.equal(listedCurrent.raw, raw(p));
  assert.equal(listedCurrent.hasInput, true);
  assert.equal(f.store.read(key).summary, '恢复后的预览');
  assert.equal(f.store.list({ recover: true }).find(item => item.key === key).inputRecovered, true);
  assert.deepEqual([...f.storage.data], before);
  assert.throws(() => f.store.remove(key), /当前窗口/);
});

test('stale complete saves cannot clear newer pending text and no-checkpoint input is downloadable', () => {
  const f = fixture(), p = project();
  assert.equal(f.store.recordInput(input(p, '还没有副本')), false);
  assert.equal(JSON.parse(f.status().inputRecoveryRaw).unappliedInput.text, '还没有副本');
  const key = saved(f, p);
  f.store.recordInput(input(p, '刚输入的末尾'));
  const journalRaw = f.storage.getItem(inputJournalKey(key));
  assert.equal(f.store.save(raw(p), p.title).copied, false);
  assert.equal(f.storage.getItem(inputJournalKey(key)), journalRaw);
});

test('journal cleanup failure cannot bind later input to an old checkpoint', () => {
  const f = fixture(), p = project(), key = saved(f, p);
  f.store.recordInput(input(p, '已提交'));
  f.storage.fail = (op, item) => op === 'remove' && item === inputJournalKey(key);
  const next = editBlock(p, p.draft[1].id, '已提交');
  assert.equal(f.store.save(raw(next), next.title).copied, true);
  assert.ok(f.status().inputError);
  const checkpointId = JSON.parse(f.storage.getItem(key)).checkpointId;
  assert.equal(f.store.recordInput(input(next, '已提交并续写')), true);
  assert.equal(JSON.parse(f.storage.getItem(inputJournalKey(key))).checkpointId, checkpointId);
  assert.equal(deserializeProject(f.store.read(key).raw).draft[1].text, '已提交并续写');
});

test('explicit undo after failed checkpoint archives its input before replacing the current copy', () => {
  const f = fixture(), p = project(), key = saved(f, p);
  f.store.recordInput(input(p, '稍后撤销的文字'));
  const edited = editBlock(p, p.draft[1].id, '稍后撤销的文字');
  f.storage.fail = (op, item) => op === 'set' && item === key;
  assert.equal(f.store.save(raw(edited), edited.title).copied, false);
  const undone = undo(edited);
  f.storage.fail = () => false;
  f.storage.operations = [];
  assert.equal(f.store.save(raw(undone), undone.title, { replaceInput: true }).copied, true);
  const archive = f.store.list().find(item => item.key !== key);
  assert.equal(deserializeProject(f.store.read(archive.key).raw).draft[1].text, '稍后撤销的文字');
  assert.deepEqual(deserializeProject(f.store.restore().recovery).draft, p.draft);
  assert.equal(f.storage.getItem(inputJournalKey(key)), null);
  const writes = f.storage.operations.filter(op => op[0] === 'set');
  const archiveCopyIndex = writes.findIndex(op => op[1] === archive.key);
  const archiveJournalIndex = writes.findIndex(op => op[1] === inputJournalKey(archive.key));
  const currentIndex = writes.findIndex(op => op[1] === key);
  assert.ok(archiveCopyIndex < archiveJournalIndex && archiveJournalIndex < currentIndex);
});

test('explicit replacement never destroys pending input when either archive write or new checkpoint fails', () => {
  for (const stage of ['archive-copy', 'archive-journal', 'new-copy']) {
    const f = fixture(), p = project(), key = saved(f, p);
    f.store.recordInput(input(p, '归档失败仍能恢复'));
    const replacement = undo(editBlock(p, p.draft[1].id, '归档失败仍能恢复'));
    const checkpoint = f.storage.getItem(key), journalRaw = f.storage.getItem(inputJournalKey(key));
    f.storage.fail = (op, item) => op === 'set' && (stage === 'archive-copy' ? item.startsWith(COPY_PREFIX) && item !== key :
      stage === 'archive-journal' ? item.startsWith(INPUT_PREFIX) && item !== inputJournalKey(key) : item === key);
    assert.equal(f.store.save(raw(replacement), replacement.title, { replaceInput: true }).copied, false, stage);
    assert.equal(f.storage.getItem(key), checkpoint, stage);
    assert.equal(f.storage.getItem(inputJournalKey(key)), journalRaw, stage);
    assert.ok(f.status().error, stage);
    f.storage.fail = () => false;
    assert.equal(f.store.save(raw(replacement), replacement.title, { replaceInput: true }).copied, true, stage);
    assert.equal(f.store.restore().recovery, raw(replacement), stage);
  }
});

test('serialization failure before save still permits later revisions after verified advanceInput', () => {
  const f = fixture(), initial = project(), key = saved(f, initial), checkpoint = f.storage.getItem(key);
  // Inject a serializer size error at the caller boundary; no full save is made.
  const failSerialization = () => { throw Object.assign(new Error('项目内容超过 50 MB'), { code: 'TOO_LARGE' }); };
  let p = initial;
  for (const text of ['序列化失败前', '序列化失败后的续写']) {
    assert.equal(f.store.recordInput(input(p, text)), true);
    p = editBlock(p, p.draft[1].id, text);
    p.history = [];
    assert.equal(f.store.advanceInput(p), true);
    try { f.store.save(failSerialization(p), p.title); assert.fail('serializer should throw'); }
    catch (failure) { assert.equal(failure.code, 'TOO_LARGE'); }
  }
  assert.equal(f.store.recordInput(input(p, '最后一个尾字仍在')), true);
  assert.equal(f.storage.getItem(key), checkpoint);
  const recovered = deserializeProject(f.store.read(key).raw);
  assert.equal(recovered.draft[1].text, '最后一个尾字仍在');
  assert.equal(recovered.history.length, 1);
  assert.deepEqual(undo(recovered).draft, initial.draft);
  p = editBlock(p, p.draft[1].id, '最后一个尾字仍在');
  assert.equal(f.store.advanceInput(p), true);
  f.storage.fail = (op, item) => op === 'set' && item === key;
  assert.equal(f.store.save(raw(p), p.title).copied, false);
  assert.equal(f.store.recordInput(input(p, '提前推进后配额失败也能续写')), true);
  assert.equal(deserializeProject(f.store.read(key).raw).draft[1].text, '提前推进后配额失败也能续写');
});

test('advanceInput rejects unrelated mutations without authorizing a new input revision', () => {
  const f = fixture(), p = project(), key = saved(f, p);
  f.store.recordInput(input(p, '正确输入'));
  const moved = moveBlock(p, p.draft[2].id, 0);
  assert.equal(f.store.advanceInput(moved), false);
  assert.equal(f.store.recordInput({ ...input(p, '不能越过基准'), revision: moved.revision }), false);
  assert.equal(deserializeProject(f.store.read(key).raw).draft[1].text, '正确输入');
});
