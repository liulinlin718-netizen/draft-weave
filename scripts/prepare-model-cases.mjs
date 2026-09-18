// Prepare fictional inputs only. No authentication checks, model calls or generated answers.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile, writeFile, mkdir, lstat, realpath } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import * as core from '../public/core.mjs';

export const PROJECT_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export const CASE_IDS = ['normal', 'protected-conflict'];
const materialRoot = path.join(PROJECT_ROOT, 'examples/model-validation');
const outputRoot = path.join(PROJECT_ROOT, '.runtime/model-acceptance/cases');
const sourceFiles = ['source-a.md', 'source-b.md', 'source-c.md'];
const colors = ['#b46c44', '#517c79', '#8a6b9a'];
const sha256 = value => createHash('sha256').update(value).digest('hex');
const inside = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

// Inspect every existing ancestor before creating/writing project-controlled artifacts.
async function ensureDirectory(directory) {
  const absolute = path.resolve(directory);
  if (!inside(PROJECT_ROOT, absolute)) throw new Error('Output must stay inside this project');
  const parsed = path.parse(absolute);
  let cursor = parsed.root;
  for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    let info;
    try { info = await lstat(cursor); }
    catch (error) { if (error.code !== 'ENOENT') throw error; await mkdir(cursor); info = await lstat(cursor); }
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Directory is not a plain directory: ${cursor}`);
  }
  if (!inside(await realpath(PROJECT_ROOT), await realpath(absolute))) throw new Error('Resolved output escapes project');
  return absolute;
}

export async function buildModelCase(caseId) {
  if (!CASE_IDS.includes(caseId)) throw new Error(`Unknown model case: ${caseId}`);
  const directory = path.join(materialRoot, caseId);
  const criteria = JSON.parse(await readFile(path.join(directory, 'criteria.json'), 'utf8'));
  if (criteria.caseId !== caseId || criteria.fictitious !== true || criteria.liveExecution !== 'not-run') throw new Error('Input criteria must remain fictional and unexecuted');
  let project = core.createProject({ title: `虚构验收 · ${criteria.topic}` });
  const sources = [];
  for (const [index, file] of sourceFiles.entries()) {
    const filename = path.join(directory, file);
    const bytes = await readFile(filename);
    const text = bytes.toString('utf8');
    if (!text.includes('虚构业务测试材料')) throw new Error(`Missing fictional-material notice: ${filename}`);
    const id = `${caseId}-${String.fromCharCode(97 + index)}`;
    project = core.addSource(project, { id, name: `${String.fromCharCode(65 + index)} · ${criteria.topic}`, text, color: colors[index] });
    sources.push({ file, id, path: filename, sha256: sha256(bytes), bytes: bytes.length });
  }
  for (const selection of criteria.assembly) {
    const entry = sources.find(source => source.file === selection.file);
    if (!entry) throw new Error(`Unknown source in assembly: ${selection.file}`);
    const source = project.sources.find(item => item.id === entry.id);
    if (selection.scope === 'document') project = core.selectBlocks(project, source.id, source.blocks.map(block => block.id));
    else {
      const headings = source.blocks.filter(block => block.type === 'heading' && block.text === selection.heading);
      if (headings.length !== 1) throw new Error(`Expected one heading: ${selection.heading}`);
      project = core.selectSection(project, source.id, headings[0].id);
    }
  }
  project = core.setProtection(project, { numbers: true, quotes: true });
  const resolveAnchor = anchor => {
    const source = sources.find(item => item.file === anchor.file);
    const blocks = project.draft.filter(block => block.sourceId === source?.id && block.text.startsWith(anchor.startsWith));
    if (blocks.length !== 1) throw new Error(`Anchor must identify one selected paragraph: ${anchor.startsWith}`);
    return blocks[0];
  };
  for (const anchor of criteria.locks) project = core.toggleLock(project, resolveAnchor(anchor).id);
  const input = core.buildPolishInput(project);
  const resolved = {
    revision: project.revision,
    projectSchemaVersion: project.version,
    sourceIds: Object.fromEntries(sources.map(source => [source.file, source.id])),
    locks: criteria.locks.map(anchor => {
      const block = resolveAnchor(anchor);
      return { blockId: block.id, sourceId: block.sourceId, sourceBlockId: block.sourceBlockId, exactText: block.text, sha256: sha256(block.text) };
    }),
    conflicts: criteria.conflicts.map(conflict => ({ id: conflict.id, evidenceAvailable: conflict.evidenceAvailable,
      statements: conflict.statements.map(anchor => { const block = resolveAnchor(anchor); return { blockId: block.id, sourceId: block.sourceId, exactText: block.text }; }) })),
    protectedBlocks: input.blocks.map(block => ({ blockId: block.id, sourceId: block.sourceId, ...core.protectedTokens(block.text) }))
      .filter(block => block.numbers.length || block.quotes.length),
  };
  return { caseId, project, input, markdown: core.exportMarkdown(project), criteria: { ...criteria, resolved }, sources };
}

/** Every invocation creates an exclusive UTC batch. Existing prepared artifacts are never overwritten. */
export async function prepareModelCases() {
  const cases = await Promise.all(CASE_IDS.map(buildModelCase));
  const status = JSON.parse(await readFile(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
  await ensureDirectory(outputRoot);
  const batch = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const batchDirectory = path.join(outputRoot, batch);
  await mkdir(batchDirectory); // Deliberately no recursive/overwrite behavior for the unique batch.
  await ensureDirectory(batchDirectory);
  const manifest = { schemaVersion: 1, generatedAt: new Date().toISOString(), batch, productVersion: status.version,
    materialKind: 'fictional-input-only', liveModelRequestExecuted: false, hashAlgorithm: 'SHA-256',
    hashScope: 'Hashes identify these exact prepared files; later runs use a new batch and do not replace this baseline.', cases: [] };
  for (const entry of cases) {
    const directory = await ensureDirectory(path.join(batchDirectory, entry.caseId));
    const files = {};
    const artifacts = {
      prepared: ['prepared.json', core.serializeProject(entry.project)],
      markdown: ['manuscript.md', entry.markdown],
      input: ['input.json', JSON.stringify(entry.input, null, 2)],
      criteria: ['criteria.json', JSON.stringify(entry.criteria, null, 2)],
    };
    for (const [kind, [name, text]] of Object.entries(artifacts)) {
      const filename = path.join(directory, name);
      await writeFile(filename, text, { encoding: 'utf8', flag: 'wx' });
      const bytes = await readFile(filename);
      files[kind] = { path: await realpath(filename), sha256: sha256(bytes), bytes: bytes.length };
    }
    manifest.cases.push({ caseId: entry.caseId, files, sources: entry.sources, lockedBlocks: entry.criteria.resolved.locks.length });
  }
  const manifestPath = path.join(batchDirectory, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), { encoding: 'utf8', flag: 'wx' });
  return { manifestPath, manifestSha256: sha256(await readFile(manifestPath)), manifest };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const prepared = await prepareModelCases();
  console.log(JSON.stringify({ manifestPath: prepared.manifestPath, manifestSha256: prepared.manifestSha256,
    productVersion: prepared.manifest.productVersion, liveModelRequestExecuted: false,
    cases: prepared.manifest.cases.map(({ caseId, files }) => ({ caseId, files })) }, null, 2));
}
