import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSource, createProject, addSource, selectBlocks, selectSection, completeSection,
  editBlock, toggleLock, removeBlock, undo, attachReview, decideChange,
  serializeProject, deserializeProject, exportMarkdown
} from '../public/core.mjs';

const A = parseSource({ id: 'opt_a', name: 'A 稿', text: '# A 章\n\n第一段。\n\n## 子节\n\n第二段。\n\n# B 章\n\n结尾。' });
const B = parseSource({ id: 'opt_b', name: '另一稿', text: '# 其他章节\n\n无关正文。' });
const origin = block => `${block.sourceId}/${block.sourceBlockId}`;
const base = () => addSource(addSource(createProject(), A), B);
const diff = (block, after) => ({ blockId: block.id, before: block.text, after, reason: '离线回归：补足连接。' });
const stateOnly = project => ({ ...project, history: [] });
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(freeze);
  }
  return value;
}

test('completeSection fills at the first selected block and retains edits, locks, origins and unrelated order in one undo', () => {
  let project = selectSection(base(), B.id, B.blocks[0].id);
  project = selectBlocks(project, A.id, [A.blocks[3].id]);
  project = selectSection(project, A.id, A.blocks[4].id);
  project = selectBlocks(project, A.id, [A.blocks[1].id]);
  const editedId = project.draft.find(block => block.sourceBlockId === A.blocks[3].id).id;
  project = toggleLock(editBlock(project, editedId, '人工改写的第二段。'), editedId);
  const reviewed = project.draft.find(block => block.sourceId === B.id && block.type === 'paragraph');
  project = attachReview(project, { summary: '离线回归', changes: [diff(reviewed, '此外，无关正文。')] });
  const original = serializeProject(project);
  const unrelated = project.draft.filter(block => ![A.blocks[0].id, A.blocks[1].id, A.blocks[2].id, A.blocks[3].id].includes(block.sourceBlockId));
  freeze(project);

  const completed = completeSection(project, A.id, A.blocks[0].id);
  assert.deepEqual(completed.draft.map(block => block.text), ['# 其他章节', '无关正文。', '# A 章', '第一段。', '## 子节', '人工改写的第二段。', '# B 章', '结尾。']);
  assert.deepEqual(completed.draft.find(block => block.id === editedId), project.draft.find(block => block.id === editedId));
  assert.deepEqual(completed.draft.filter(block => unrelated.some(other => other.id === block.id)), unrelated);
  for (const block of project.draft) assert.deepEqual(completed.draft.find(item => item.id === block.id), block);
  assert.equal(new Set(completed.draft.map(origin)).size, completed.draft.length);
  assert.equal(completed.revision, project.revision + 1);
  assert.equal(completed.history.length, project.history.length + 1);
  assert.equal(completed.review.changes[0].status, 'stale');
  assert.equal(serializeProject(project), original);

  const restored = undo(completed);
  assert.deepEqual(restored.draft, project.draft);
  assert.deepEqual(restored.sources, project.sources);
  assert.equal(restored.review.changes[0].status, 'pending');
  assert.equal(restored.review.expectedRevision, restored.revision);
  assert.equal(decideChange(restored, restored.review.changes[0].id, 'accept').draft.find(block => block.id === reviewed.id).text, '此外，无关正文。');
});

test('completeSection appends an unselected scope, stops at its sibling, deduplicates and returns the same project on no-op', () => {
  const project = selectSection(base(), B.id, B.blocks[0].id);
  const completed = completeSection(project, A.id, A.blocks[0].id);
  assert.deepEqual(completed.draft.slice(2).map(block => block.sourceBlockId), A.blocks.slice(0, 4).map(block => block.id));
  assert.deepEqual(completed.draft.slice(0, 2), project.draft);
  assert.strictEqual(completeSection(completed, A.id, A.blocks[0].id), completed);
  assert.strictEqual(completeSection(completed, A.id, A.blocks[2].id), completed);
  assert.strictEqual(completeSection(completed, A.id, A.blocks[1].id), completed);

  const withoutChild = removeBlock(completed, completed.draft.find(block => block.sourceBlockId === A.blocks[1].id).id);
  const withFollowingChapter = selectSection(withoutChild, A.id, A.blocks[4].id);
  const refilled = completeSection(withFollowingChapter, A.id, A.blocks[0].id);
  assert.deepEqual(refilled.draft.slice(2).map(block => block.sourceBlockId), A.blocks.map(block => block.id));
  assert.equal(new Set(refilled.draft.map(origin)).size, refilled.draft.length);
  const before = serializeProject(refilled);
  assert.throws(() => completeSection(refilled, 'missing', A.blocks[0].id), { code: 'SOURCE_NOT_FOUND' });
  assert.throws(() => completeSection(refilled, A.id, 'missing'), { code: 'SOURCE_BLOCK_NOT_FOUND' });
  assert.equal(serializeProject(refilled), before);
});

test('completeSection keeps distinct identical paragraphs and does not mistake another source for the same scope', () => {
  const source = parseSource({ id: 'duplicate_text', name: '相同正文', text: '# 章节\n\n相同正文。\n\n相同正文。' });
  let project = addSource(base(), source);
  project = selectBlocks(project, B.id, [B.blocks[1].id]);
  project = selectBlocks(project, source.id, [source.blocks[2].id]);
  const completed = completeSection(project, source.id, source.blocks[0].id);
  assert.deepEqual(completed.draft.map(block => block.text), ['无关正文。', '# 章节', '相同正文。', '相同正文。']);
  assert.equal(new Set(completed.draft.map(origin)).size, 4);
  assert.equal(completed.draft.at(-1).id, project.draft.at(-1).id);
  assert.strictEqual(completeSection(completed, source.id, source.blocks[0].id), completed);
});

test('mutations keep the 80-snapshot bound, input immutability and safe review undo after history cloning is removed', () => {
  let project = selectSection(base(), A.id, A.blocks[0].id);
  const id = project.draft[1].id;
  for (let i = 0; i < 85; i++) project = editBlock(project, id, `人工正文 ${i}。`);
  project = attachReview(project, { summary: '离线回归', changes: [diff(project.draft[1], `${project.draft[1].text}因此继续。`)] });
  assert.equal(project.history.length, 80);
  const original = serializeProject(project);
  freeze(project);
  const edited = editBlock(project, id, '用户继续编辑。');
  assert.equal(edited.history.length, 80);
  assert.equal(edited.history.some(state => Object.hasOwn(state, 'history')), false);
  assert.deepEqual(edited.history.slice(0, -1), project.history.slice(1));
  assert.equal(edited.review.changes[0].status, 'stale');
  assert.equal(serializeProject(project), original);
  const restored = undo(edited);
  assert.deepEqual(restored.draft, project.draft);
  assert.equal(restored.review.changes[0].status, 'pending');
  assert.equal(restored.review.expectedRevision, restored.revision);
  assert.equal(decideChange(restored, restored.review.changes[0].id, 'accept').review.changes[0].status, 'accepted');
});

test('serializeProject defaults remain byte-compatible and compact/emergency files recover the existing version 1 format', () => {
  const source = parseSource({ id: 'legacy_source', name: '旧版来源', text: '旧版正文。' });
  const legacy = {
    version: 1, id: 'legacy_project', title: '旧版项目', sources: [source],
    draft: [{ id: 'legacy_draft', sourceId: source.id, sourceBlockId: source.blocks[0].id, text: '旧版人工正文。', type: 'paragraph', level: 0, locked: true }],
    revision: 2, protection: { numbers: true, quotes: false }, review: null,
    history: [{ version: 1, id: 'legacy_project', title: '旧版项目', sources: [], draft: [], revision: 0, protection: { numbers: true, quotes: true }, review: null }]
  };
  const restored = deserializeProject(JSON.stringify(legacy, null, 2));
  assert.deepEqual(restored, legacy);
  assert.equal(serializeProject(restored), JSON.stringify(legacy, null, 2));
  assert.equal(serializeProject(restored, { compact: true }), JSON.stringify(legacy));
  assert.deepEqual(deserializeProject(serializeProject(restored, { compact: true })), legacy);
  assert.equal(serializeProject(restored, { includeHistory: false }), JSON.stringify(stateOnly(legacy), null, 2));
  assert.deepEqual(deserializeProject(serializeProject(restored, { includeHistory: false, compact: true })), stateOnly(legacy));
  assert.throws(() => serializeProject(restored, { compact: 'yes' }), { code: 'INVALID_DATA' });
  assert.throws(() => serializeProject(restored, { includeHistory: 0 }), { code: 'INVALID_DATA' });
});

test('emergency serialization skips unusable old history but still rejects broken current sources, origins and unsafe review', () => {
  let project = selectSection(base(), A.id, A.blocks[0].id);
  project = attachReview(project, { summary: '离线回归', changes: [diff(project.draft[1], '此外，第一段。')] });
  const circularHistory = [];
  circularHistory.push(circularHistory);
  project = { ...project, history: circularHistory };
  assert.throws(() => serializeProject(project), { code: 'INVALID_PROJECT' });
  const restored = deserializeProject(serializeProject(project, { includeHistory: false, compact: true }));
  assert.deepEqual(restored, stateOnly(project));
  assert.strictEqual(project.history, circularHistory);
  assert.strictEqual(project.history[0], circularHistory);
  assert.equal(restored.review.changes[0].status, 'pending');
  assert.equal(decideChange(restored, restored.review.changes[0].id, 'accept').review.changes[0].status, 'accepted');

  const badSource = structuredClone(restored); badSource.sources[0].blocks[0].text = '# 篡改来源';
  const badOrigin = structuredClone(restored); badOrigin.draft[0].sourceBlockId = 'missing';
  const badReview = structuredClone(restored); badReview.review.changes[0].after = '新增 8 位。';
  for (const invalid of [badSource, badOrigin, badReview]) assert.throws(() => serializeProject(invalid, { includeHistory: false }), { code: 'INVALID_PROJECT' });
  assert.throws(() => serializeProject(null, { includeHistory: false }), { code: 'UNSUPPORTED_VERSION' });
});

test('an oversized 80-history project can save a small emergency file with complete sources, locks, protection and review', () => {
  const source = parseSource({ id: 'large_review_source', name: '长稿', text: `# 长稿\n\n${'原'.repeat(36_000)}\n\n周期 8 周，引用“保留原话”。\n\n人工结尾。` });
  let project = selectSection(addSource(createProject(), source), source.id, source.blocks[0].id);
  project = toggleLock(project, project.draft[2].id);
  const review = () => ({ summary: '离线回归：一处待审、一处保护拦截。', changes: [diff(project.draft[1], `${project.draft[1].text}因此继续。`), diff(project.draft[2], '周期 8 季，引用“保留原话”。')] });
  project = attachReview(project, review());
  for (let i = 0; i < 80; i++) project = editBlock(project, project.draft[3].id, i % 2 ? '结尾乙。' : '结尾甲。');
  project = attachReview(project, review());
  const expectedCurrent = stateOnly(project);
  const history = project.history;
  freeze(project);
  assert.equal(history.length, 80);
  assert.throws(() => serializeProject(project), { code: 'TOO_LARGE' });
  const emergency = serializeProject(project, { includeHistory: false, compact: true });
  assert.ok(new TextEncoder().encode(emergency).byteLength < 1_000_000);
  const restored = deserializeProject(emergency);
  assert.deepEqual(restored, expectedCurrent);
  assert.strictEqual(project.history, history);
  assert.equal(project.history.length, 80);
  assert.deepEqual(project.sources, [source]);
  assert.deepEqual(restored.review.changes.map(change => change.status), ['pending', 'blocked']);
  assert.equal(restored.draft[2].locked, true);
  assert.deepEqual(restored.protection, { numbers: true, quotes: true });
  assert.equal(exportMarkdown(restored), exportMarkdown(project));
  assert.throws(() => decideChange(restored, restored.review.changes[1].id, 'accept'), { code: 'CHANGE_BLOCKED' });
  const accepted = decideChange(restored, restored.review.changes[0].id, 'accept');
  assert.equal(accepted.review.changes[0].status, 'accepted');
  assert.equal(accepted.review.changes[1].status, 'blocked');
  assert.deepEqual(deserializeProject(serializeProject(restored)), restored);
});
