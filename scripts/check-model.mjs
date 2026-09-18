/** Real optional backend check. No fixture, automatic login, fallback, or automatic acceptance. */
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { createProject, addSource, selectBlocks, selectSection, toggleLock, buildPolishInput, attachReview, serializeProject, deserializeProject, exportMarkdown, analyzeStructure } from '../public/core.mjs';
import { polish, providerStatus } from '../server/model-bridge.mjs';
import { PROJECT_ROOT, runtimePaths, ensureDirectory, checkedPath } from '../server/paths.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const cancelled = () => Object.assign(new Error('已取消验证；已保存的准备稿未改动。'), { code: 'CANCELLED' });
const checkAbort = signal => { if (signal?.aborted) throw cancelled(); };

export async function prepareExampleProject(sourceFiles = []) {
  let project = createProject({ title: '社区图书馆服务改造 · 真实模型验证' });
  for (const key of ['a', 'b', 'c']) {
    const filename = path.join(PROJECT_ROOT, 'examples', `source-${key}.md`);
    const bytes = await readFile(filename);
    const text = bytes.toString('utf8');
    sourceFiles.push({ path: filename, sha256: sha256(bytes), bytes: bytes.length });
    project = addSource(project, { id: `validation_source_${key}`, name: `示例 ${key.toUpperCase()}`, text });
  }
  const [a, b, c] = project.sources;
  project = selectBlocks(project, a.id, [a.blocks[0].id]);
  const section = (source, title) => {
    const heading = source.blocks.find(block => block.type === 'heading' && block.text.replace(/^#+\s*/, '') === title);
    if (!heading) throw new Error(`示例 ${source.name} 缺少「${title}」章节。`);
    project = selectSection(project, source.id, heading.id);
  };
  section(a, '背景');
  section(b, '背景'); // Deliberately retains the repeated introduction for whole-document review.
  section(b, '服务方案');
  section(b, '评估');
  section(c, '结语');
  const quote = project.draft.find(block => block.sourceId === a.id && block.text.includes('“'));
  if (!quote) throw new Error('示例 A 的待锁定引文缺失。');
  project = toggleLock(project, quote.id);
  return project;
}

export function reviewStatistics(project) {
  const changes = project.review?.changes || [];
  const counts = { total: changes.length, pending: 0, blocked: 0, stale: 0, accepted: 0, rejected: 0 };
  const issueCounts = {};
  for (const change of changes) {
    counts[change.status]++;
    for (const issue of change.issues) issueCounts[issue.code] = (issueCounts[issue.code] || 0) + 1;
  }
  return { ...counts, issueCounts, lockedBlocks: project.draft.filter(block => block.locked).length, protection: project.protection, appliedAutomatically: false };
}

export function parseOptions(argv) {
  let provider; let projectFile; let timeoutMs; let statusOnly = false; let prepareOnly = false;
  const value = (flag, index) => {
    const item = argv[index];
    if (!item || item.startsWith('--')) throw new Error(`${flag} 缺少参数值。`);
    return item;
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--status') statusOnly = true;
    else if (argv[i] === '--prepare-only') prepareOnly = true;
    else if (argv[i] === '--provider') provider = value('--provider', ++i);
    else if (argv[i] === '--project') projectFile = value('--project', ++i);
    else if (argv[i] === '--timeout-ms') timeoutMs = Number(value('--timeout-ms', ++i));
    else throw new Error('用法：node scripts/check-model.mjs [--project <保存项目.json>] [--status | --prepare-only | --provider external-api|codex-cli] [--timeout-ms 120000]');
  }
  if (provider && !['external-api', 'codex-cli'].includes(provider)) throw new Error('--provider 仅支持 external-api 或 codex-cli。');
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 600000)) throw new Error('--timeout-ms 必须是 50–600000 之间的整数。');
  // Explicit non-generation modes always win, even when a provider is also named.
  return { provider, projectFile, timeoutMs, mode: prepareOnly ? 'prepare-only' : statusOnly || !provider ? 'status-only' : 'real-request' };
}

/** Dependency overrides are for explicitly marked contract tests, never a CLI fixture mode. */
export async function checkModel(argv = process.argv.slice(2), dependencies = {}) {
  const { env: parentEnv = process.env, statusImpl = providerStatus, polishImpl = polish, signal, logger = console } = dependencies;
  const contractFixture = statusImpl !== providerStatus || polishImpl !== polish;
  const totalStarted = performance.now();
  const options = parseOptions(argv);
  const env = { ...parentEnv };
  if (options.timeoutMs !== undefined) env.DW_MODEL_TIMEOUT_MS = String(options.timeoutMs);
  const paths = await runtimePaths(env);
  const directory = await ensureDirectory(path.join(paths.runtime, 'model-validation'), paths.dataRoot);
  const checkedOutput = candidate => checkedPath(candidate, paths.dataRoot);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const prefix = `${stamp}-${options.mode === 'real-request' ? options.provider : options.mode}-${randomUUID().slice(0, 8)}`;
  const preparedPath = await checkedOutput(path.join(directory, `${prefix}-prepared.draftweave.json`));
  const markdownPath = await checkedOutput(path.join(directory, `${prefix}-prepared.md`));
  const inputPath = await checkedOutput(path.join(directory, `${prefix}-input.json`));
  const reportPath = await checkedOutput(path.join(directory, `${prefix}-report.json`));
  const record = {
    version: 2, createdAt: new Date().toISOString(), mode: options.mode, evidence: contractFixture ? 'contract-fixture' : 'runtime',
    provider: options.provider || null, model: null, status: 'PREPARING', totalElapsedMs: 0, generationElapsedMs: null,
    usage: null, usageStatus: 'unknown', cost: { status: 'unknown', amount: null, currency: null },
    bridgeCallAttempted: false, validatedModelOutputReceived: false,
    validatedGenerationCompleted: false, liveValidatedGenerationCompleted: false, reviewArtifactSaved: false,
    generationTimingScope: 'bridge-call-including-auth-and-preparation',
    preparedProject: null, preparedMarkdown: null, modelInput: null, rawResult: null, reviewProject: null,
    hashAlgorithm: 'sha256', sourceFiles: [], sourceSnapshots: [], modelInputSha256: null, preparedProjectSha256: null,
    timeoutMs: options.timeoutMs ?? Number(env.DW_MODEL_TIMEOUT_MS || 120000),
    sourceDescription: options.projectFile ? '用户指定的已保存项目；保留原文、来源、锁和审阅决定。' : 'A 标题和背景 + B 背景、服务方案与评估 + C 结语；保留重复引言、术语差异和模糊指代。',
  };
  let exitCode = 0;
  try {
    let project;
    if (options.projectFile) {
      const filename = path.resolve(options.projectFile);
      if ((await stat(filename)).size > 50_000_000) throw Object.assign(new Error('项目文件超过 50 MB。'), { code: 'TOO_LARGE' });
      const bytes = await readFile(filename);
      record.sourceFiles.push({ path: filename, sha256: sha256(bytes), bytes: bytes.length });
      project = deserializeProject(bytes.toString('utf8'));
    } else project = await prepareExampleProject(record.sourceFiles);
    const input = buildPolishInput(project);
    const serialized = serializeProject(project);
    const inputJson = JSON.stringify(input);
    await writeFile(preparedPath, serialized, { encoding: 'utf8', flag: 'wx' });
    record.preparedProject = preparedPath;
    record.preparedProjectSha256 = sha256(serialized);
    await writeFile(markdownPath, exportMarkdown(project), { encoding: 'utf8', flag: 'wx' });
    record.preparedMarkdown = markdownPath;
    await writeFile(inputPath, inputJson, { encoding: 'utf8', flag: 'wx' });
    record.modelInput = inputPath;
    record.modelInputSha256 = sha256(inputJson);
    record.sourceSnapshots = project.sources.map(source => ({ id: source.id, name: source.name, sha256: sha256(source.text), bytes: Buffer.byteLength(source.text, 'utf8') }));
    record.review = reviewStatistics(project); record.structure = analyzeStructure(project);
    record.status = 'PREPARED'; record.draftUnchanged = true;
    checkAbort(signal);
    if (options.mode === 'prepare-only') {
      logger.log('仅保存准备稿和完整模型输入；未检查后端状态，未发送模型请求。');
    } else if (options.mode === 'status-only') {
      record.providers = await statusImpl({ env });
      checkAbort(signal);
      record.status = Object.values(record.providers).some(provider => provider.ready) ? 'STATUS_READY' : 'BACKENDS_UNAVAILABLE';
      if (record.status === 'BACKENDS_UNAVAILABLE') exitCode = 1;
      for (const [name, state] of Object.entries(record.providers)) logger.log(`${name}: ${state.code} — ${state.message}`);
      logger.log('仅检查状态，未发送模型请求。');
    } else {
      const states = await statusImpl({ env });
      checkAbort(signal);
      const state = states[options.provider];
      record.model = state.model || null;
      if (!state.ready) {
        record.status = state.code;
        record.error = { code: state.code, message: state.message };
        exitCode = 1;
        logger.error(`${state.code}: ${state.message}`);
      } else {
        record.bridgeCallAttempted = true;
        const generationStarted = performance.now();
        let outcome;
        try { outcome = await polishImpl(options.provider, input, { env, signal }); }
        finally { record.generationElapsedMs = performance.now() - generationStarted; }
        record.validatedModelOutputReceived = true;
        checkAbort(signal);
        record.validatedGenerationCompleted = true;
        record.liveValidatedGenerationCompleted = !contractFixture;
        record.provider = outcome.provider; record.model = outcome.model;
        record.usage = outcome.usage ?? null; record.usageStatus = record.usage === null ? 'unknown' : 'reported';
        const resultPath = await checkedOutput(path.join(directory, `${prefix}-result.json`));
        await writeFile(resultPath, JSON.stringify(outcome.result, null, 2), { encoding: 'utf8', flag: 'wx' });
        record.rawResult = resultPath;
        const reviewed = attachReview(project, outcome.result, project.revision, { provider: outcome.provider, model: outcome.model, realModelValidation: !contractFixture, contractFixture });
        const reviewPath = await checkedOutput(path.join(directory, `${prefix}-review.draftweave.json`));
        await writeFile(reviewPath, serializeProject(reviewed), { encoding: 'utf8', flag: 'wx' });
        record.status = 'COMPLETED_REQUIRES_REVIEW'; record.reviewArtifactSaved = true;
        record.review = reviewStatistics(reviewed); record.reviewProject = reviewPath;
        record.draftUnchanged = exportMarkdown(project) === exportMarkdown(reviewed);
        logger.log(`${contractFixture ? '合同 fixture' : '真实模型'}请求完成：${outcome.provider} / ${outcome.model}`);
        logger.log(`建议 ${record.review.total} 项，待审阅 ${record.review.pending} 项，保护拦截 ${record.review.blocked} 项。未自动应用。`);
        logger.log(`可在画布打开审阅项目：${reviewPath}`);
      }
    }
  } catch (error) {
    record.status = error.code || 'VALIDATION_FAILED';
    // Bridge errors contain sanitized user-facing messages, never raw upstream logs.
    const fileFailure = ['ENOENT', 'EACCES', 'EPERM', 'EISDIR', 'ENOTDIR', 'EIO'].includes(error.code);
    record.error = { code: record.status, message: fileFailure ? '无法读取指定项目或保存验证文件；请检查文件路径和访问权限。' : error.code ? error.message : '验证入口未完成；已保存的准备稿保持原样。' };
    logger.error(`${record.error.code}: ${record.error.message}`);
    exitCode = 1;
  } finally {
    record.totalElapsedMs = performance.now() - totalStarted;
    record.elapsedMs = record.totalElapsedMs; // Backward-compatible alias; never generation-only.
    await writeFile(reportPath, JSON.stringify(record, null, 2), { encoding: 'utf8', flag: 'wx' });
    logger.log(`${record.preparedProject ? `准备项目：${record.preparedProject}\n` : ''}验证记录：${reportPath}`);
  }
  return { exitCode, reportPath, record };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt);
  try { process.exitCode = (await checkModel(process.argv.slice(2), { signal: controller.signal })).exitCode; }
  catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { process.removeListener('SIGINT', interrupt); }
}
