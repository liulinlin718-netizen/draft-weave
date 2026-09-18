import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as core from '../public/core.mjs';
import { buildModelCase, prepareModelCases, CASE_IDS, PROJECT_ROOT } from '../scripts/prepare-model-cases.mjs';

test('new fictional inputs use three gallery drafts each, retain origin mapping and round-trip through current core', async () => {
  for (const caseId of CASE_IDS) {
    const entry = await buildModelCase(caseId);
    assert.equal(entry.project.sources.length, 3);
    assert.equal(new Set(entry.project.draft.map(block => block.sourceId)).size, 3);
    assert.match(entry.markdown, /展馆|展厅|展柜/);
    assert.doesNotMatch(entry.markdown, /图书馆|借书/);
    assert.ok(entry.project.sources.every(source => source.text.includes('虚构业务测试材料')));
    assert.deepEqual(entry.project.protection, { numbers: true, quotes: true });
    assert.equal(entry.project.review, null);
    assert.deepEqual(core.deserializeProject(core.serializeProject(entry.project)), entry.project);
    assert.deepEqual(entry.input, core.buildPolishInput(entry.project));
    assert.equal(entry.markdown, entry.input.document);
    assert.ok(entry.input.document.includes('8周'));
    assert.ok(entry.project.draft.every(block => entry.project.sources.find(source => source.id === block.sourceId)?.blocks.some(sourceBlock => sourceBlock.id === block.sourceBlockId)));
  }
});

test('normal case actually contains repeated introduction, differing names and references across selected sections', async () => {
  const { project, criteria } = await buildModelCase('normal');
  const repeated = project.draft.filter(block => block.text.startsWith('展馆语音导览应帮助观众'));
  assert.equal(repeated.length, 2);
  assert.notEqual(repeated[0].sourceId, repeated[1].sourceId);
  const paragraphs = project.draft.filter(block => block.type === 'paragraph').map(block => block.text).join('\n');
  for (const cue of ['耳伴服务', '随身讲解', '移动听展', '它需要', '它不能']) assert.ok(paragraphs.includes(cue));
  assert.equal(project.draft.filter(block => block.locked).length, 0);
  for (const dimension of ['whole-document-transition', 'terminology', 'repeated-introduction', 'ambiguous-reference']) assert.ok(criteria.manualReview.some(item => item.id === dimension));
  // The cue assertions above test input construction, never a model-output quality verdict.
});

test('protected case preserves two contradictory attributed facts without evidence and identifies an exact locked paragraph', async () => {
  const { project, criteria } = await buildModelCase('protected-conflict');
  assert.equal(criteria.resolved.conflicts.length, 1);
  const conflict = criteria.resolved.conflicts[0];
  assert.equal(conflict.statements.length, 2);
  assert.equal(conflict.evidenceAvailable, false);
  assert.notEqual(conflict.statements[0].sourceId, conflict.statements[1].sourceId);
  assert.match(conflict.statements[0].exactText, /2026-11-06 开馆时，东厅导览终端已启用/);
  assert.match(conflict.statements[1].exactText, /2026-11-06 开馆时，东厅导览终端未启用/);
  assert.equal(criteria.resolved.locks.length, 1);
  const locked = project.draft.find(block => block.id === criteria.resolved.locks[0].blockId);
  assert.equal(locked.locked, true);
  assert.equal(locked.text, criteria.resolved.locks[0].exactText);
  assert.ok(criteria.manualReview.some(item => item.id === 'unresolved-conflict'));
  assert.ok(criteria.manualReview.some(item => item.id === 'no-fabricated-evidence'));
});

test('new protected inputs exercise unit, quote and whole-paragraph guards without fabricating model results', async () => {
  const { project, criteria } = await buildModelCase('protected-conflict');
  const numerical = project.draft.find(block => block.text.includes('120 MB'));
  const quoted = project.draft.find(block => block.text.includes('“请保留静音播放提示'));
  const locked = project.draft.find(block => block.locked);
  const inspect = (block, after) => core.validateChange(project, { blockId: block.id, before: block.text, after, reason: 'Deterministic guard boundary test only; no model response.' });
  assert.ok(inspect(numerical, numerical.text.replace('120 MB', '120 GB')).some(issue => issue.code === 'PROTECTED_NUMBERS'));
  assert.ok(inspect(quoted, quoted.text.replace('静音播放提示', '自动播放提示')).some(issue => issue.code === 'PROTECTED_QUOTES'));
  assert.ok(inspect(locked, `${locked.text}修改。`).some(issue => issue.code === 'LOCKED_BLOCK'));
  const fact = project.draft.find(block => block.id === criteria.resolved.conflicts[0].statements[0].blockId);
  assert.deepEqual(inspect(fact, fact.text.replace('已启用', '未启用')), []);
  assert.match(criteria.automaticProtectionLimitation, /人工语义/);
  assert.equal(project.review, null);
});

test('both cases require contextual human review and a no-fake-result timeout recovery plan', async () => {
  for (const caseId of CASE_IDS) {
    const { criteria } = await buildModelCase(caseId);
    assert.equal(criteria.liveExecution, 'not-run');
    assert.equal(criteria.fictitious, true);
    assert.match(criteria.qualityJudgment, /全文/);
    assert.match(criteria.qualityJudgment, /关键词/);
    assert.ok(criteria.manualReview.every(item => item.id && item.inspect && item.pass && item.fail));
    assert.ok(criteria.manualReview.some(item => item.id === 'protected-values'));
    assert.ok(criteria.manualReview.some(item => item.id === 'explicit-review'));
    assert.ok(criteria.timeoutRecoveryPlan.length >= 5);
    assert.ok(criteria.timeoutRecoveryPlan.some(step => /prepared\.json/.test(step)));
    assert.ok(criteria.timeoutRecoveryPlan.some(step => /旧|过期/.test(step)));
    assert.ok(criteria.timeoutRecoveryPlan.some(step => /效果未验证/.test(step)));
  }
});

test('preparation writes exclusive batches, source/output hashes and unchanged recoverable baselines', async () => {
  const first = await prepareModelCases();
  const originalManifest = await readFile(first.manifestPath, 'utf8');
  const second = await prepareModelCases();
  assert.notEqual(first.manifestPath, second.manifestPath);
  assert.equal(await readFile(first.manifestPath, 'utf8'), originalManifest);
  const status = JSON.parse(await readFile(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
  assert.equal(first.manifest.productVersion, status.version);
  assert.equal(first.manifest.liveModelRequestExecuted, false);
  assert.equal(first.manifest.materialKind, 'fictional-input-only');
  for (const entry of first.manifest.cases) {
    for (const artifact of [...Object.values(entry.files), ...entry.sources]) {
      const bytes = await readFile(artifact.path);
      assert.equal(bytes.length, artifact.bytes);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256);
      assert.ok(artifact.path.startsWith(PROJECT_ROOT + path.sep));
    }
    const project = core.deserializeProject(await readFile(entry.files.prepared.path, 'utf8'));
    const input = JSON.parse(await readFile(entry.files.input.path, 'utf8'));
    assert.deepEqual(input, core.buildPolishInput(project));
    assert.equal(await readFile(entry.files.markdown.path, 'utf8'), core.exportMarkdown(project));
    assert.equal(project.review, null);
  }
  console.log(`Prepared input-only baseline: ${first.manifestPath}`);
  console.log(`Distinct second batch: ${second.manifestPath}`);
});
