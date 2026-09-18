import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSource, createProject, addSource, selectBlocks, toggleLock, protectedTokens,
  attachReview, decideChange, serializeProject, deserializeProject, exportMarkdown
} from '../public/core.mjs';

function prepare(before, after) {
  const source = parseSource({ id: 'unit-regression-source', name: '单位保护回归', text: before });
  const project = selectBlocks(addSource(createProject(), source), source.id, source.blocks.map(block => block.id));
  const output = { summary: '离线确定性单位回归，非模型输出。', changes: [{ blockId: project.draft[0].id, before, after, reason: '验证数量单位改变必须被阻止。' }] };
  return { project, output };
}

test('Arabic week/season and person/household units stay protected with adjacent or spaced quantities', () => {
  for (const gap of ['', ' ', '  ', '\t', '\u3000']) {
    for (const [from, to] of [['周', '季'], ['位', '户']]) {
      const before = `数量为 8${gap}${from}。`, after = `数量为 8${gap}${to}。`;
      const { project, output } = prepare(before, after);
      const reviewed = attachReview(project, output);
      assert.deepEqual(protectedTokens(before).numbers, [`8${gap}${from}`]);
      assert.equal(reviewed.review.changes[0].status, 'blocked');
      assert.ok(reviewed.review.changes[0].issues.some(issue => issue.code === 'PROTECTED_NUMBERS'));
      assert.throws(() => decideChange(reviewed, reviewed.review.changes[0].id, 'accept'), { code: 'CHANGE_BLOCKED' });
      assert.equal(exportMarkdown(reviewed), exportMarkdown(project));
    }
  }
});

test('Chinese week/season and person/household quantities include optional unit whitespace', () => {
  for (const gap of ['', ' ', '  ', '\t', '\u3000']) {
    for (const [from, to] of [['周', '季'], ['位', '户']]) {
      const before = `数量为八${gap}${from}。`, after = `数量为八${gap}${to}。`;
      const { project, output } = prepare(before, after);
      const reviewed = attachReview(project, output);
      assert.deepEqual(protectedTokens(before).numbers, [`八${gap}${from}`]);
      assert.equal(reviewed.review.changes[0].status, 'blocked');
      assert.ok(reviewed.review.changes[0].issues.some(issue => issue.code === 'PROTECTED_NUMBERS'));
    }
  }
});

test('normal connective editing with unchanged Arabic and Chinese quantities remains reviewable', () => {
  const before = '试点持续 8 周，为八 位居民提供服务。';
  const after = `承接前述安排，${before}`;
  const { project, output } = prepare(before, after);
  const reviewed = attachReview(project, output);
  assert.equal(reviewed.review.changes[0].status, 'pending');
  assert.equal(exportMarkdown(reviewed), exportMarkdown(project));
  const accepted = decideChange(reviewed, reviewed.review.changes[0].id, 'accept');
  assert.equal(accepted.draft[0].text, after);
  assert.deepEqual(protectedTokens(after), protectedTokens(before));
});

test('whole-block lock independently blocks connective edits even when quantity tokens are identical', () => {
  const before = '试点持续八周。', after = `因此，${before}`;
  let { project, output } = prepare(before, after);
  project = toggleLock(project, project.draft[0].id);
  const reviewed = attachReview(project, output);
  assert.equal(reviewed.review.changes[0].status, 'blocked');
  assert.deepEqual(reviewed.review.changes[0].issues.map(issue => issue.code), ['LOCKED_BLOCK']);
  assert.throws(() => decideChange(reviewed, reviewed.review.changes[0].id, 'accept'), { code: 'CHANGE_BLOCKED' });
  assert.equal(exportMarkdown(reviewed), exportMarkdown(project));
});

test('blocked unit changes and their original manuscript remain protected after save and restore', () => {
  for (const [before, after] of [['试点持续 8 周。', '试点持续 8 季。'], ['服务八位居民。', '服务八户居民。']]) {
    const { project, output } = prepare(before, after);
    const restored = deserializeProject(serializeProject(attachReview(project, output)));
    assert.equal(restored.review.changes[0].status, 'blocked');
    assert.ok(restored.review.changes[0].issues.some(issue => issue.code === 'PROTECTED_NUMBERS'));
    assert.throws(() => decideChange(restored, restored.review.changes[0].id, 'accept'), { code: 'CHANGE_BLOCKED' });
    assert.equal(exportMarkdown(restored), exportMarkdown(project));
  }
});

test('the known conservative treatment of an indefinite 一个 remains unchanged', () => {
  const { project, output } = prepare('为居民提供一个统一入口。', '为居民提供统一入口。');
  const reviewed = attachReview(project, output);
  assert.equal(reviewed.review.changes[0].status, 'blocked');
  assert.ok(reviewed.review.changes[0].issues.some(issue => issue.code === 'PROTECTED_NUMBERS'));
});
