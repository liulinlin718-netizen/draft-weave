import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSource, createProject, addSource, getSectionBlockIds, selectSection, selectBlocks, removeBlock,
  replaceBlock, moveBlock, editBlock, toggleLock, setProtection, undo, exportMarkdown, analyzeStructure,
  serializeProject, deserializeProject, buildPolishInput, attachReview, decideChange, validatePolishOutput, protectedTokens, diffText
} from '../public/core.mjs';

const A = parseSource({ id: 'a', name: 'A 稿', text: '# 背景\n\n平台服务 120 人。\n\n这是共同的引言。\n\n## 方法\n\n它能减少重复工作。\n\n# 结尾\n\n继续观察。' });
const B = parseSource({ id: 'b', name: 'B 稿', text: '# 研究\n\n它们需要人工确认。\n\n这是共同的引言。\n\n研究者指出：“保留原始判断。”\n\n# 下一步\n\n形成一致的结尾。' });
function project() { return addSource(addSource(createProject(), A), B); }
function full() { return selectBlocks(project(), 'a', A.blocks.map(block => block.id)); }
function output(changes) { return { summary: '离线契约 fixture：全稿转承与指代建议，不是真实模型结果。', changes }; }
function change(block, after, reason = '明确前文指代。') { return { blockId: block.id, before: block.text, after, reason }; }

test('parser retains complete source and stable block IDs, headings, fenced code, CRLF and line ranges', () => {
  const text = '\uFEFF# 标题\r\n\r\n第一行\r\n第二行\r\n\r\n```md\r\n# 不是标题\r\n\r\n正文\r\n```\r\n\r\n## 小节';
  const first = parseSource({ name: '导入.md', text });
  const second = parseSource({ name: '导入.md', text });
  assert.deepEqual(first, second);
  assert.equal(first.text, text);
  assert.deepEqual(first.blocks.map(block => block.type), ['heading', 'paragraph', 'code', 'heading']);
  assert.equal(first.blocks[1].text, '第一行\n第二行');
  assert.equal(first.blocks[2].startLine, 6);
  assert.equal(first.blocks[2].endLine, 10);
  assert.equal(first.blocks[3].level, 2);
});

test('chapter/section/paragraph mixed selection deduplicates; cancel child and cross-source replacement do not re-add chapter', () => {
  const original = project();
  const p1 = selectSection(original, 'a', A.blocks[0].id);
  assert.equal(original.draft.length, 0);
  assert.equal(p1.draft.length, 5);
  assert.deepEqual(getSectionBlockIds(A, A.blocks[3].id), [A.blocks[3].id, A.blocks[4].id]);
  const p2 = selectBlocks(p1, 'a', [A.blocks[1].id, A.blocks[1].id, A.blocks[4].id]);
  assert.strictEqual(p2, p1);
  const removedId = p1.draft[2].id;
  const p3 = removeBlock(p1, removedId);
  assert.equal(p3.draft.length, 4);
  assert.ok(!p3.draft.some(block => block.sourceBlockId === A.blocks[2].id));
  const replacedId = p3.draft[1].id;
  const p4 = replaceBlock(p3, replacedId, 'b', B.blocks[1].id);
  assert.equal(p4.draft.length, 4);
  assert.equal(p4.draft[1].id, replacedId);
  assert.equal(p4.draft[1].sourceId, 'b');
  assert.ok(!p4.draft.some(block => block.sourceBlockId === A.blocks[2].id));
});

test('replacement refuses duplicate origins and all invalid operations leave original unchanged', () => {
  const p = selectBlocks(full(), 'b', [B.blocks[1].id]);
  const prior = serializeProject(p);
  assert.throws(() => replaceBlock(p, p.draft[0].id, 'b', B.blocks[1].id), { code: 'DUPLICATE_SELECTION' });
  assert.throws(() => selectBlocks(p, 'a', ['missing']), { code: 'SOURCE_BLOCK_NOT_FOUND' });
  assert.throws(() => moveBlock(p, p.draft[0].id, 100), { code: 'INVALID_POSITION' });
  assert.equal(serializeProject(p), prior);
});

test('reordering, undo, file recovery and markdown preserve final order, locks, sources and history', () => {
  let p = full();
  p = toggleLock(p, p.draft[1].id);
  const original = exportMarkdown(p);
  const movedId = p.draft[1].id;
  p = moveBlock(p, movedId, p.draft.length - 1);
  assert.equal(p.draft.at(-1).id, movedId);
  assert.ok(exportMarkdown(p).endsWith('平台服务 120 人。\n'));
  const recovered = deserializeProject(serializeProject(p));
  assert.deepEqual(recovered, p);
  assert.deepEqual(recovered.sources, [A, B]);
  assert.equal(recovered.draft.at(-1).locked, true);
  const undone = undo(recovered);
  assert.equal(exportMarkdown(undone), original);
  assert.ok(undone.revision > recovered.revision);
});

test('project recovery rejects bad JSON, unsupported version, altered source snapshot, broken origin and nested history', () => {
  const valid = full();
  assert.throws(() => deserializeProject('{'), { code: 'INVALID_PROJECT_JSON' });
  const badVersion = { ...valid, version: 2 };
  assert.throws(() => deserializeProject(badVersion), { code: 'UNSUPPORTED_VERSION' });
  const badSource = structuredClone(valid); badSource.sources[0].blocks[0].text = '# 伪造来源';
  assert.throws(() => deserializeProject(badSource), { code: 'INVALID_PROJECT' });
  const badOrigin = structuredClone(valid); badOrigin.draft[0].sourceBlockId = 'missing';
  assert.throws(() => deserializeProject(badOrigin), { code: 'INVALID_PROJECT' });
  const badHistory = structuredClone(valid); badHistory.history[0].history = [];
  assert.throws(() => deserializeProject(badHistory), { code: 'INVALID_PROJECT' });
  const nullHistory = structuredClone(valid); nullHistory.history[0] = null;
  assert.throws(() => deserializeProject(nullHistory), { code: 'INVALID_PROJECT' });
});

test('structure checks find duplicate paragraphs, empty chapters and heading level jumps', () => {
  const source = parseSource({ id: 'structure', name: '结构', text: '# 开始\n\n重复。\n\n### 跳级\n\n重复。\n\n# 空章\n\n# 结尾\n\n正文。' });
  const p = selectBlocks(addSource(createProject(), source), source.id, source.blocks.map(block => block.id));
  const issues = analyzeStructure(p);
  assert.ok(issues.some(issue => issue.type === 'duplicate' && issue.blockIds.length === 2));
  assert.ok(issues.some(issue => issue.type === 'heading-level'));
  assert.ok(issues.some(issue => issue.type === 'empty-section'));
});

test('full-document polish input includes complete ordered draft, all source snapshots and protection', () => {
  let p = full();
  p = toggleLock(p, p.draft[1].id);
  p = moveBlock(p, p.draft[6].id, 0);
  const input = buildPolishInput(p);
  assert.equal(input.document, exportMarkdown(p));
  assert.deepEqual(input.blocks, p.draft);
  assert.deepEqual(input.sources, p.sources);
  assert.deepEqual(input.protection, { numbers: true, quotes: true });
  assert.equal(input.revision, p.revision);
  input.blocks[0].text = '调用端变化';
  assert.notEqual(input.blocks[0].text, p.draft[0].text);
  assert.throws(() => buildPolishInput(createProject()), { code: 'EMPTY_DRAFT' });
});

test('polish suggestions remain unapplied; sequential partial acceptance preserves sibling validity and rejects remainder', () => {
  let p = full();
  const initial = exportMarkdown(p);
  const b1 = p.draft[2]; const b2 = p.draft[4]; const b3 = p.draft[6];
  p = attachReview(p, output([change(b1, '承接前述背景，这是共同的引言。'), change(b2, '该平台能减少重复工作。'), change(b3, '在此基础上，继续观察。')]));
  assert.equal(exportMarkdown(p), initial);
  assert.ok(p.review.changes.every(item => item.status === 'pending'));
  p = decideChange(p, p.review.changes[0].id, 'accept');
  assert.equal(p.review.changes[1].status, 'pending');
  p = decideChange(p, p.review.changes[1].id, 'accept');
  p = decideChange(p, p.review.changes[2].id, 'reject');
  assert.match(exportMarkdown(p), /该平台能减少重复工作/);
  assert.ok(exportMarkdown(p).endsWith('继续观察。\n'));
  assert.deepEqual(p.review.changes.map(item => item.status), ['accepted', 'accepted', 'rejected']);
  assert.deepEqual(deserializeProject(serializeProject(p)), p);
});

test('number, unit, quote, locked-paragraph and before mismatch violations remain visible blocked diffs', () => {
  let p = selectBlocks(full(), 'b', [B.blocks[3].id]);
  p = toggleLock(p, p.draft[4].id);
  const initial = exportMarkdown(p);
  p = attachReview(p, output([
    change(p.draft[1], '平台服务 121 人。'),
    change(p.draft[4], '该平台减少重复工作。'),
    change(p.draft.at(-1), '研究者指出：“删除原始判断。”'),
    { ...change(p.draft[2], '新引言。'), before: '错误原文。' }
  ]));
  assert.deepEqual(p.review.changes.map(item => item.status), ['blocked', 'blocked', 'blocked', 'blocked']);
  assert.deepEqual(p.review.changes.map(item => item.issues[0].code), ['PROTECTED_NUMBERS', 'LOCKED_BLOCK', 'PROTECTED_QUOTES', 'BEFORE_MISMATCH']);
  for (const item of p.review.changes) assert.throws(() => decideChange(p, item.id, 'accept'), { code: 'CHANGE_BLOCKED' });
  assert.equal(exportMarkdown(p), initial);
  assert.notDeepEqual(protectedTokens('预算 10 万元').numbers, protectedTokens('预算 10 元').numbers);
  assert.notDeepEqual(protectedTokens('三个月').numbers, protectedTokens('四个月').numbers);
});

test('request during edits yields stale diffs; ordinary edit and sorting invalidate pending review', () => {
  let p = full();
  const request = buildPolishInput(p);
  const proposal = output([change(p.draft[4], '该平台能减少重复工作。')]);
  p = editBlock(p, p.draft[6].id, '继续长期观察。');
  p = attachReview(p, proposal, request.revision);
  assert.equal(p.review.changes[0].status, 'stale');
  assert.throws(() => decideChange(p, p.review.changes[0].id, 'accept'), { code: 'CHANGE_BLOCKED' });
  let q = full();
  q = attachReview(q, output([change(q.draft[4], '该平台能减少重复工作。')]));
  q = moveBlock(q, q.draft[6].id, 0);
  assert.equal(q.review.changes[0].status, 'stale');
  assert.equal(deserializeProject(serializeProject(q)).review.changes[0].status, 'stale');
});

test('undo restores a review safely after acceptance; no duplicate acceptance and pending state rebinds revision', () => {
  let p = full();
  p = attachReview(p, output([change(p.draft[4], '该平台能减少重复工作。')]));
  const oldRevision = p.revision;
  p = decideChange(p, p.review.changes[0].id, 'accept');
  assert.throws(() => decideChange(p, p.review.changes[0].id, 'accept'), { code: 'ALREADY_DECIDED' });
  p = undo(p);
  assert.ok(p.revision > oldRevision);
  assert.equal(p.review.expectedRevision, p.revision);
  assert.equal(p.review.changes[0].status, 'pending');
  p = decideChange(p, p.review.changes[0].id, 'accept');
  assert.match(exportMarkdown(p), /该平台能减少重复工作/);
});

test('strict output schema rejects extra properties, duplicates, missing fields and null; malformed outputs keep draft', () => {
  const p = full();
  const c = change(p.draft[4], '该平台能减少重复工作。');
  for (const bad of [null, { ...output([]), overwrite: true }, output([{ ...c, extra: 1 }]), output([c, c]), output([{ blockId: c.blockId, after: c.after }])]) {
    assert.throws(() => validatePolishOutput(bad), { code: 'INVALID_MODEL_OUTPUT' });
    assert.throws(() => attachReview(p, bad), { code: 'INVALID_MODEL_OUTPUT' });
  }
  assert.equal(p.review, null);
});

test('explicit protection toggle expires older suggestions and permits a newly requested number change', () => {
  let p = full();
  p = attachReview(p, output([change(p.draft[4], '该平台能减少重复工作。')]));
  p = setProtection(p, { numbers: false });
  assert.equal(p.review.changes[0].status, 'stale');
  p = attachReview(p, output([change(p.draft[1], '平台服务 121 人。')]));
  assert.equal(p.review.changes[0].status, 'pending');
  p = decideChange(p, p.review.changes[0].id, 'accept');
  assert.match(exportMarkdown(p), /121 人/);
});

test('unknown model block remains visible but cannot apply; imported pending guard tampering is rejected', () => {
  const original = full();
  let p = attachReview(original, output([{ blockId: 'unknown', before: '不存在。', after: '伪造段落。', reason: '离线坏输出。' }]));
  assert.equal(p.review.changes[0].status, 'blocked');
  assert.equal(p.review.changes[0].issues[0].code, 'UNKNOWN_BLOCK');
  assert.throws(() => decideChange(p, p.review.changes[0].id, 'accept'), { code: 'CHANGE_BLOCKED' });
  const tampered = structuredClone(p); tampered.review.changes[0].status = 'pending'; tampered.review.changes[0].issues = [];
  assert.throws(() => deserializeProject(tampered), { code: 'INVALID_PROJECT' });
  const brokenReview = structuredClone(p); brokenReview.review.changes[0] = null;
  assert.throws(() => deserializeProject(brokenReview), { code: 'INVALID_PROJECT' });
  p = decideChange(p, p.review.changes[0].id, 'reject');
  assert.equal(exportMarkdown(p), exportMarkdown(original));
  assert.equal(deserializeProject(serializeProject(p)).review.changes[0].status, 'rejected');
});

test('an explicit manual edit of a locked paragraph remains possible and undo restores exact protected text', () => {
  let p = full();
  p = toggleLock(p, p.draft[1].id);
  p = editBlock(p, p.draft[1].id, '平台服务 121 人。');
  assert.equal(p.draft[1].locked, true);
  assert.equal(p.draft[1].text, '平台服务 121 人。');
  p = undo(p);
  assert.equal(p.draft[1].text, '平台服务 120 人。');
  assert.equal(p.draft[1].locked, true);
});

test('stable IDs retain duplicate paragraphs independently and never silently replace a colliding explicit source ID', () => {
  const source = parseSource({ id: 'stable', name: '稳定稿', text: '# 重复\n\n相同文字。\n\n相同文字。' });
  assert.equal(new Set(source.blocks.map(block => block.id)).size, 3);
  assert.deepEqual(parseSource(source).blocks, source.blocks);
  let p = addSource(createProject(), source);
  assert.strictEqual(addSource(p, structuredClone(source)), p);
  assert.throws(() => addSource(p, { id: 'stable', name: '冒用同一来源', text: '不同来源。' }), { code: 'DUPLICATE_SOURCE_ID' });
  p = selectBlocks(p, 'stable', source.blocks.map(block => block.id));
  assert.deepEqual(deserializeProject(serializeProject(p)).sources[0].blocks, source.blocks);
  const reorderedKeys = JSON.parse(serializeProject(p));
  reorderedKeys.sources[0].blocks = reorderedKeys.sources[0].blocks.map(block => Object.fromEntries(Object.entries(block).reverse()));
  assert.equal(deserializeProject(reorderedKeys).sources[0].blocks[1].id, source.blocks[1].id);
});

test('forged pending status and revision cannot reactivate stale whole-document advice', () => {
  let p = full();
  p = attachReview(p, output([change(p.draft[4], '该平台能减少重复工作。')]));
  p = editBlock(p, p.draft[6].id, '结论已由用户改变。');
  const forged = structuredClone(p);
  forged.review.expectedRevision = forged.revision;
  forged.review.changes[0].status = 'pending'; forged.review.changes[0].issues = [];
  assert.throws(() => deserializeProject(forged), { code: 'INVALID_PROJECT' });
  assert.throws(() => decideChange(forged, forged.review.changes[0].id, 'accept'), { code: 'CHANGE_BLOCKED' });
  const staleAtCreation = attachReview(full(), output([]), 0);
  assert.equal(staleAtCreation.review.staleAtCreation, true);
});

test('forged accepted status cannot prove a change was applied or bypass numeric guards', () => {
  let p = full();
  p = attachReview(p, output([change(p.draft[1], '平台服务 121 人。')]));
  const forged = structuredClone(p);
  forged.review.changes[0].status = 'accepted'; forged.review.changes[0].issues = [];
  assert.throws(() => deserializeProject(forged), { code: 'INVALID_PROJECT' });
  forged.draft[1].text = '平台服务 121 人。';
  assert.throws(() => deserializeProject(forged), { code: 'INVALID_PROJECT' });
});

test('changing protection cannot retroactively unblock old suggestions; restored locked proposals are guarded again', () => {
  let p = full();
  p = attachReview(p, output([change(p.draft[1], '平台服务 121 人。')]));
  p = setProtection(p, { numbers: false });
  assert.throws(() => decideChange(p, p.review.changes[0].id, 'accept'), { code: 'CHANGE_BLOCKED' });
  const forged = structuredClone(p); forged.review.changes[0].status = 'pending'; forged.review.expectedRevision = forged.revision;
  assert.throws(() => deserializeProject(forged), { code: 'INVALID_PROJECT' });
  p = undo(p);
  assert.equal(p.protection.numbers, true);
  assert.equal(p.review.changes[0].status, 'blocked');
  p = deserializeProject(serializeProject(p));
  assert.throws(() => decideChange(p, p.review.changes[0].id, 'accept'), { code: 'CHANGE_BLOCKED' });
});

test('history snapshots cannot change project identity, reorder revisions, inject origins or replace coherent sources', () => {
  let p = full();
  p = editBlock(p, p.draft[6].id, '继续长期观察。');
  const mutated = mutateHistory => { const forged = structuredClone(p); mutateHistory(forged.history.at(-1)); return forged; };
  const cases = [
    mutated(state => { state.id = 'other_project'; }),
    mutated(state => { state.revision = p.revision + 1; }),
    mutated(state => { state.draft[0].sourceBlockId = 'invented_origin'; }),
    mutated(state => { state.sources[0].name = '伪造但结构有效的来源名称'; }),
    mutated(state => {
      const oldSource = state.sources[0];
      const replacement = parseSource({ ...oldSource, text: oldSource.text.replace('120 人', '999 人') });
      state.sources[0] = replacement;
      for (const block of state.draft) {
        if (block.sourceId !== oldSource.id) continue;
        const index = oldSource.blocks.findIndex(item => item.id === block.sourceBlockId);
        block.sourceBlockId = replacement.blocks[index].id;
        block.text = replacement.blocks[index].text;
      }
    })
  ];
  for (const forged of cases) {
    assert.throws(() => deserializeProject(forged), { code: 'INVALID_PROJECT' });
    assert.throws(() => serializeProject(forged), { code: 'INVALID_PROJECT' });
    assert.throws(() => undo(forged), { code: 'INVALID_PROJECT' });
  }
});

test('undo after partial acceptance or ordinary edits restores a coherent bound review', () => {
  let p = full();
  p = attachReview(p, output([change(p.draft[2], '承接背景，这是共同的引言。'), change(p.draft[4], '该平台能减少重复工作。')]));
  p = decideChange(p, p.review.changes[0].id, 'accept');
  p = editBlock(p, p.draft[6].id, '新的观察结论。');
  assert.equal(p.review.changes[1].status, 'stale');
  p = undo(deserializeProject(serializeProject(p)));
  assert.deepEqual(p.review.changes.map(item => item.status), ['accepted', 'pending']);
  assert.equal(p.review.expectedRevision, p.revision);
  p = decideChange(p, p.review.changes[1].id, 'accept');
  assert.deepEqual(deserializeProject(serializeProject(p)).review.changes.map(item => item.status), ['accepted', 'accepted']);
});

test('character diff is deterministic and preserves Unicode code points, insertions, deletions and equal text', () => {
  assert.deepEqual(diffText('前文：它能减少工作。', '前文：该平台能减少工作。'), { prefix: '前文：', removed: '它', added: '该平台', suffix: '能减少工作。' });
  assert.deepEqual(diffText('🧑成果', '🧠成果'), { prefix: '', removed: '🧑', added: '🧠', suffix: '成果' });
  for (const [before, after] of [['', '新增'], ['删除', ''], ['相同', '相同'], ['甲甲', '甲'], ['甲', '甲甲']]) {
    const result = diffText(before, after);
    assert.equal(result.prefix + result.removed + result.suffix, before);
    assert.equal(result.prefix + result.added + result.suffix, after);
  }
});

test('reversible blank project preserves historical sources while current source list is empty', () => {
  const original = full();
  const prior = structuredClone(original); delete prior.history;
  const blank = createProject(); blank.id = original.id; blank.revision = original.revision + 1;
  blank.history = [...original.history, prior];
  const restored = deserializeProject(serializeProject(blank));
  assert.equal(restored.sources.length, 0);
  const recovered = undo(restored);
  assert.deepEqual(recovered.sources, original.sources);
  assert.deepEqual(recovered.draft, original.draft);
});

test('project file size is bounded in UTF-8 bytes before JSON parsing', () => {
  const overLimit = '中'.repeat(16_666_667);
  assert.ok(overLimit.length < 50_000_000);
  assert.throws(() => deserializeProject(overLimit), { code: 'TOO_LARGE' });
});
