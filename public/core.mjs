/** Deterministic document assembly and explicitly accepted whole-document revisions. */
export const PROJECT_VERSION = 1;
const MAX_HISTORY = 80;
const MAX_TEXT = 2_000_000;
const MAX_BLOCKS = 10_000;
const COLORS = ['#b66c44', '#568171', '#7c75a9', '#5484a2', '#ad7388'];

export class CoreError extends Error {
  constructor(code, message) { super(message); this.name = 'CoreError'; this.code = code; }
}
const fail = (code, message) => { throw new CoreError(code, message); };
const clone = value => JSON.parse(JSON.stringify(value));
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = (value, label, max = MAX_TEXT, empty = true) => {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) fail('INVALID_DATA', `${label}格式无效。`);
  return value;
};
const identifier = (value, label) => {
  string(value, label, 160, false);
  if (!/^[A-Za-z0-9_-]+$/.test(value)) fail('INVALID_DATA', `${label}只能包含字母、数字、短横线和下划线。`);
  return value;
};
const hash = value => {
  let result = 2166136261;
  for (let i = 0; i < value.length; i++) { result ^= value.charCodeAt(i); result = Math.imul(result, 16777619); }
  return (result >>> 0).toString(36);
};
const randomId = prefix => `${prefix}_${globalThis.crypto?.randomUUID?.().replaceAll('-', '') || `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`}`;
const heading = line => /^ {0,3}(#{1,6})(?:[ \t]+|$)/.exec(line);
const fence = line => /^ {0,3}(`{3,}|~{3,})/.exec(line);
const classify = text => {
  const match = heading(text.split('\n')[0]);
  if (match && !text.includes('\n')) return { type: 'heading', level: match[1].length };
  return { type: fence(text.split('\n')[0]) ? 'code' : 'paragraph', level: 0 };
};
const sourceBlockKeys = ['id', 'sourceId', 'text', 'type', 'level', 'index', 'startLine', 'endLine'];
const sameParsedBlocks = (left, right) => Array.isArray(left) && left.length === right.length
  && left.every((block, index) => plain(block) && Object.keys(block).length === sourceBlockKeys.length
    && sourceBlockKeys.every(key => block[key] === right[index][key]));

/** Preserves source text and each block's content; export normalizes block separators to blank lines. */
export function parseSource({ id, name = '未命名稿', text, color } = {}) {
  string(text, '文稿', MAX_TEXT);
  string(name, '文稿名称', 200, false);
  id = identifier(id || `source_${hash(`${name}\u0000${text}`)}`, '来源 ID');
  if (color !== undefined && !/^#[0-9a-f]{6}$/i.test(color)) fail('INVALID_DATA', '来源颜色须为六位十六进制色值。');
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].trim()) { i++; continue; }
    const start = i;
    const openFence = fence(lines[i]);
    const title = heading(lines[i]);
    let type = 'paragraph';
    let level = 0;
    if (openFence) {
      type = 'code';
      i++;
      const closer = new RegExp(`^ {0,3}${openFence[1][0] === '`' ? '`' : '~'}{${openFence[1].length},}[ \\t]*$`);
      while (i < lines.length) { const isClose = closer.test(lines[i]); i++; if (isClose) break; }
    } else if (title) {
      type = 'heading'; level = title[1].length; i++;
    } else {
      i++;
      while (i < lines.length && lines[i].trim() && !heading(lines[i]) && !fence(lines[i])) i++;
    }
    const blockText = lines.slice(start, i).join('\n');
    const index = blocks.length;
    blocks.push({ id: `${id}_b${index}_${hash(blockText)}`, sourceId: id, text: blockText, type, level, index, startLine: start + 1, endLine: i });
    if (blocks.length > MAX_BLOCKS) fail('TOO_LARGE', '文稿块数超过上限。');
  }
  return { id, name, text, color: color || COLORS[parseInt(hash(id), 36) % COLORS.length], blocks };
}

export function createProject({ title = '未命名成稿' } = {}) {
  string(title, '成稿名称', 200, false);
  return { version: PROJECT_VERSION, id: randomId('project'), title, sources: [], draft: [], revision: 0,
    protection: { numbers: true, quotes: true }, review: null, history: [] };
}

const withoutHistory = ({ history, ...state }) => state;
const snapshot = project => clone(withoutHistory(project));
function mutate(project, transform, { document = true, keepReview = false } = {}) {
  const next = snapshot(project);
  if (transform(next) === false) return project;
  next.history = [...project.history, snapshot(project)].slice(-MAX_HISTORY);
  if (document) {
    next.revision = project.revision + 1;
    if (!keepReview && next.review) {
      for (const change of next.review.changes) {
        if (change.status === 'pending') {
          change.status = 'stale';
          change.issues = [...change.issues, { code: 'STALE_REVISION', message: '成稿已改变，请重新请求整体润色。' }];
        }
      }
    }
  }
  return next;
}
const sourceById = (project, id) => project.sources.find(source => source.id === id) || fail('SOURCE_NOT_FOUND', '找不到候选稿。');
const blockById = (source, id) => source.blocks.find(block => block.id === id) || fail('SOURCE_BLOCK_NOT_FOUND', '找不到原文块。');
const draftIndex = (project, id) => {
  const index = project.draft.findIndex(block => block.id === id);
  if (index < 0) fail('BLOCK_NOT_FOUND', '找不到成稿段落。');
  return index;
};
const originKey = block => `${block.sourceId}\u0000${block.sourceBlockId}`;
function selectedBlock(source, block, id = randomId('draft')) {
  return { id, sourceId: source.id, sourceBlockId: block.id, text: block.text, type: block.type, level: block.level, locked: false };
}

export function addSource(project, source) {
  const parsed = parseSource(source);
  const existing = project.sources.find(item => item.id === parsed.id);
  if (existing) {
    if (existing.name === parsed.name && existing.text === parsed.text) return project;
    fail('DUPLICATE_SOURCE_ID', '来源 ID 已属于另一份文稿。');
  }
  return mutate(project, next => { next.sources.push(parsed); }, { document: false });
}

/** A heading scope contains its descendants, stopping at the next heading of equal or higher rank. */
export function getSectionBlockIds(source, headingId) {
  const index = source.blocks.findIndex(block => block.id === headingId);
  if (index < 0) fail('SOURCE_BLOCK_NOT_FOUND', '找不到章节。');
  const first = source.blocks[index];
  if (first.type !== 'heading') return [first.id];
  const result = [first.id];
  for (let i = index + 1; i < source.blocks.length; i++) {
    const block = source.blocks[i];
    if (block.type === 'heading' && block.level <= first.level) break;
    result.push(block.id);
  }
  return result;
}

export function selectBlocks(project, sourceId, blockIds) {
  const source = sourceById(project, sourceId);
  if (!Array.isArray(blockIds)) fail('INVALID_SELECTION', '请选择有效的原文块。');
  const wanted = new Set(blockIds);
  for (const id of wanted) blockById(source, id);
  const selected = new Set(project.draft.map(originKey));
  const added = source.blocks.filter(block => wanted.has(block.id) && !selected.has(`${sourceId}\u0000${block.id}`));
  if (!added.length) return project;
  if (project.draft.length + added.length > MAX_BLOCKS) fail('TOO_LARGE', '成稿块数超过上限。');
  return mutate(project, next => { next.draft.push(...added.map(block => selectedBlock(source, block))); });
}
export function selectSection(project, sourceId, headingId) {
  return selectBlocks(project, sourceId, getSectionBlockIds(sourceById(project, sourceId), headingId));
}
/** Explicitly regroup a source section at its first selected block, retaining manual edits and locks. */
export function completeSection(project, sourceId, headingId) {
  const source = sourceById(project, sourceId);
  const scopeIds = new Set(getSectionBlockIds(source, headingId));
  const scope = source.blocks.filter(block => scopeIds.has(block.id));
  const inScope = block => block.sourceId === sourceId && scopeIds.has(block.sourceBlockId);
  const selected = new Map(project.draft.filter(inScope).map(block => [block.sourceBlockId, block]));
  const first = project.draft.findIndex(inScope);
  const anchor = first < 0 ? project.draft.length : first;
  if (project.draft.length + scope.length - selected.size > MAX_BLOCKS) fail('TOO_LARGE', '成稿块数超过上限。');
  if (selected.size === scope.length && scope.every((block, index) => project.draft[anchor + index]?.id === selected.get(block.id).id)) return project;
  return mutate(project, next => {
    const existing = new Map(next.draft.filter(inScope).map(block => [block.sourceBlockId, block]));
    const remaining = next.draft.filter(block => !inScope(block));
    remaining.splice(anchor, 0, ...scope.map(block => existing.get(block.id) || selectedBlock(source, block)));
    next.draft = remaining;
  });
}
export function removeBlock(project, id) {
  const index = draftIndex(project, id);
  return mutate(project, next => { next.draft.splice(index, 1); });
}
export function replaceBlock(project, draftId, sourceId, sourceBlockId) {
  const index = draftIndex(project, draftId);
  const source = sourceById(project, sourceId);
  const sourceBlock = blockById(source, sourceBlockId);
  if (project.draft.some((block, i) => i !== index && block.sourceId === sourceId && block.sourceBlockId === sourceBlockId)) {
    fail('DUPLICATE_SELECTION', '该原文块已在成稿中，请先移除已有块再替换。');
  }
  const current = project.draft[index];
  if (current.sourceId === sourceId && current.sourceBlockId === sourceBlockId && current.text === sourceBlock.text) return project;
  return mutate(project, next => { next.draft[index] = { ...selectedBlock(source, sourceBlock, draftId), locked: current.locked }; });
}
/** toIndex is the final zero-based position, including after downward moves. */
export function moveBlock(project, id, toIndex) {
  const fromIndex = draftIndex(project, id);
  if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex >= project.draft.length) fail('INVALID_POSITION', '排序位置无效。');
  if (fromIndex === toIndex) return project;
  return mutate(project, next => { const [block] = next.draft.splice(fromIndex, 1); next.draft.splice(toIndex, 0, block); });
}
export function editBlock(project, id, text) {
  string(text, '段落');
  const index = draftIndex(project, id);
  const normalized = text.replace(/\r\n?/g, '\n');
  if (project.draft[index].text === normalized) return project;
  return mutate(project, next => { next.draft[index].text = normalized; Object.assign(next.draft[index], classify(normalized)); });
}
/** Locks constrain model edits; direct user edits remain explicitly authorized. */
export function toggleLock(project, id) {
  const index = draftIndex(project, id);
  return mutate(project, next => { next.draft[index].locked = !next.draft[index].locked; });
}
export function setProtection(project, update) {
  if (!plain(update) || Object.keys(update).some(key => !['numbers', 'quotes'].includes(key)) || Object.values(update).some(value => typeof value !== 'boolean')) fail('INVALID_DATA', '保护设置无效。');
  if (Object.entries(update).every(([key, value]) => project.protection[key] === value)) return project;
  return mutate(project, next => { Object.assign(next.protection, update); });
}
export function undo(project) {
  if (!project.history.length) return project;
  validateProject(project);
  const previous = clone(project.history.at(-1));
  const previousRevision = previous.revision;
  previous.revision = project.revision + 1;
  previous.history = clone(project.history.slice(0, -1));
  if (previous.review && previous.review.expectedRevision === previousRevision) previous.review.expectedRevision = previous.revision;
  return previous;
}

export function exportMarkdown(project) {
  const joined = project.draft.map(block => block.text).filter(text => text.trim()).join('\n\n');
  return joined ? `${joined}\n` : '';
}

/** One changed character span, with Unicode code points kept intact; not an HTML renderer. */
export function diffText(before, after) {
  string(before, '修改前文本'); string(after, '修改后文本');
  const a = Array.from(before); const b = Array.from(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  return { prefix: a.slice(0, start).join(''), removed: a.slice(start, a.length - end).join(''),
    added: b.slice(start, b.length - end).join(''), suffix: end ? a.slice(a.length - end).join('') : '' };
}

export function analyzeStructure(project) {
  const issues = [];
  const seen = new Map();
  let lastHeadingLevel = 0;
  for (let i = 0; i < project.draft.length; i++) {
    const block = project.draft[i];
    const normalized = block.text.trim().replace(/\s+/g, ' ');
    if (normalized) {
      const prior = seen.get(normalized);
      if (prior) issues.push({ id: `duplicate_${block.id}`, type: 'duplicate', severity: 'warning', message: '这段内容与成稿中的另一块重复。', blockIds: [prior, block.id] });
      else seen.set(normalized, block.id);
    }
    if (block.type !== 'heading') continue;
    if (block.level > lastHeadingLevel + 1) issues.push({ id: `hierarchy_${block.id}`, type: 'heading-level', severity: 'warning', message: `标题从 ${lastHeadingLevel || '正文'} 级跳到 ${block.level} 级。`, blockIds: [block.id] });
    lastHeadingLevel = block.level;
    let hasBody = false;
    for (let j = i + 1; j < project.draft.length; j++) {
      const child = project.draft[j];
      if (child.type === 'heading' && child.level <= block.level) break;
      if (child.type !== 'heading' && child.text.trim()) { hasBody = true; break; }
    }
    if (!hasBody) issues.push({ id: `empty_${block.id}`, type: 'empty-section', severity: 'warning', message: '这个章节没有正文。', blockIds: [block.id] });
  }
  return issues;
}

export const POLISH_OUTPUT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['summary', 'changes'],
  properties: {
    summary: { type: 'string' },
    changes: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['blockId', 'before', 'after', 'reason'],
      properties: { blockId: { type: 'string' }, before: { type: 'string' }, after: { type: 'string' }, reason: { type: 'string' } } } }
  }
};
const exactKeys = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
export function validatePolishOutput(output) {
  const invalid = message => fail('INVALID_MODEL_OUTPUT', message);
  if (!exactKeys(output, ['summary', 'changes']) || typeof output.summary !== 'string' || output.summary.length > 20_000 || !Array.isArray(output.changes) || output.changes.length > MAX_BLOCKS) invalid('润色输出不符合 {summary, changes} 结构。');
  const ids = new Set();
  for (const change of output.changes) {
    if (!exactKeys(change, ['blockId', 'before', 'after', 'reason']) || ['blockId', 'before', 'after', 'reason'].some(key => typeof change[key] !== 'string' || change[key].length > MAX_TEXT) || !change.blockId || !change.reason.trim()) invalid('每项润色必须包含 blockId、before、after 和 reason 文本。');
    if (ids.has(change.blockId)) invalid('同一段落不能包含多条重叠修改。');
    ids.add(change.blockId);
  }
  return clone(output);
}

export function buildPolishInput(project) {
  if (!project.draft.length) fail('EMPTY_DRAFT', '请先选入内容，再请求整体润色。');
  return { version: PROJECT_VERSION, revision: project.revision, document: exportMarkdown(project),
    blocks: clone(project.draft), sources: clone(project.sources), protection: clone(project.protection) };
}

/** Conservative lexical protection, not a factuality claim. Includes units and quoted spans. */
export function protectedTokens(text) {
  const numbers = text.match(/[+−-]?(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:[.．]\d+)?)(?:[eE][+−-]?\d+)?(?:\s*(?:[%％‰℃°]|万亿|亿元|万元|亿美元|万美元|人民币|美元|欧元|公里|千米|厘米|毫米|毫秒|分钟|小时|千克|公斤|毫克|MB|GB|TB|KB|ms|km|kg|cm|mm|元|亿|万|人|次|个|年|月|日|周|季|位|户|天|秒|米|吨|克|倍))?|[零〇一二两三四五六七八九十百千万亿]+(?:分之[零〇一二两三四五六七八九十百千万亿]+)?\s*(?:元|人|次|个|年|月|日|周|季|位|户|天|秒|米|倍|%|％)/g) || [];
  const quotes = text.match(/“[^”]*”|「[^」]*」|『[^』]*』|«[^»]*»|"(?:[^"\\]|\\.)*"|‘[^’]*’|(?<!\p{L})'(?:[^'\\\n]|\\.)*'(?!\p{L})|^ {0,3}>[^\n]*(?:\n {0,3}>[^\n]*)*/gmu) || [];
  return { numbers, quotes };
}
export function validateChange(project, change) {
  const block = project.draft.find(item => item.id === change.blockId);
  const issues = [];
  if (!block) return [{ code: 'UNKNOWN_BLOCK', message: '建议引用了不存在的成稿块。' }];
  if (block.text !== change.before) issues.push({ code: 'BEFORE_MISMATCH', message: '建议的原文与当前成稿不一致。' });
  if (block.locked && change.before !== change.after) issues.push({ code: 'LOCKED_BLOCK', message: '该段已锁定，模型修改被阻止。' });
  const before = protectedTokens(block.text);
  const after = protectedTokens(change.after);
  if (project.protection.numbers && JSON.stringify(before.numbers) !== JSON.stringify(after.numbers)) issues.push({ code: 'PROTECTED_NUMBERS', message: '建议改变了受保护的数字、数量或单位。' });
  if (project.protection.quotes && JSON.stringify(before.quotes) !== JSON.stringify(after.quotes)) issues.push({ code: 'PROTECTED_QUOTES', message: '建议改变了受保护的引文。' });
  return issues;
}

const contextBlock = ({ id, sourceId, sourceBlockId, text, type, level, locked }) => ({ id, sourceId, sourceBlockId, text, type, level, locked });
/** Reconstruct only accepted changes; forged revision counters alone cannot reactivate stale advice. */
function reviewContextMatches(project, review) {
  if (!plain(review.basis) || !Array.isArray(review.basis.draft) || !plain(review.basis.protection)) return false;
  const expected = review.basis.draft.map(block => contextBlock(block));
  const expectedById = new Map(expected.map(block => [block.id, block]));
  for (const change of review.changes) {
    if (change.status !== 'accepted') continue;
    const block = expectedById.get(change.blockId);
    if (!block || block.text !== change.before) return false;
    const guarded = { draft: [block], protection: review.basis.protection };
    if (validateChange(guarded, change).length) return false;
    block.text = change.after;
    Object.assign(block, classify(change.after));
  }
  return JSON.stringify(expected) === JSON.stringify(project.draft.map(contextBlock))
    && review.basis.protection.numbers === project.protection.numbers
    && review.basis.protection.quotes === project.protection.quotes;
}

/** Keep every structurally valid diff, including blocked ones, visible for review. */
export function attachReview(project, output, requestRevision = project.revision, metadata = {}) {
  const parsed = validatePolishOutput(output);
  if (!Number.isSafeInteger(requestRevision) || requestRevision < 0) fail('INVALID_DATA', '润色绑定版本无效。');
  if (!plain(metadata)) fail('INVALID_DATA', '润色元数据无效。');
  return mutate(project, next => {
    const stale = requestRevision !== project.revision;
    next.review = { id: randomId('review'), summary: parsed.summary, baseRevision: requestRevision, expectedRevision: project.revision,
      staleAtCreation: stale, basis: { draft: clone(project.draft), protection: clone(project.protection) },
      metadata: clone(metadata), changes: parsed.changes.map((change, index) => {
        const issues = validateChange(project, change);
        if (stale) issues.push({ code: 'STALE_REVISION', message: '请求后成稿已改变，请重新请求整体润色。' });
        return { ...change, id: `change_${index}_${hash(change.blockId)}`, status: stale ? 'stale' : issues.length ? 'blocked' : 'pending', issues };
      }) };
  }, { document: false, keepReview: true });
}

export function decideChange(project, changeId, decision) {
  if (!['accept', 'reject'].includes(decision)) fail('INVALID_DECISION', '审阅操作须为 accept 或 reject。');
  if (!project.review) fail('NO_REVIEW', '没有可审阅的修改。');
  const index = project.review.changes.findIndex(change => change.id === changeId);
  if (index < 0) fail('CHANGE_NOT_FOUND', '找不到润色修改。');
  const change = project.review.changes[index];
  if (['accepted', 'rejected'].includes(change.status)) fail('ALREADY_DECIDED', '这项修改已经处理。');
  if (decision === 'accept') {
    if (change.status !== 'pending' || project.review.expectedRevision !== project.revision || project.review.staleAtCreation || !reviewContextMatches(project, project.review)) fail('CHANGE_BLOCKED', '修改已失效或违反保护规则，不能接受。');
    const issues = validateChange(project, change);
    if (issues.length) fail('CHANGE_BLOCKED', issues.map(issue => issue.message).join(' '));
  }
  return mutate(project, next => {
    next.review.changes[index].status = decision === 'accept' ? 'accepted' : 'rejected';
    if (decision === 'accept') {
      const block = next.draft.find(item => item.id === change.blockId);
      block.text = change.after;
      Object.assign(block, classify(change.after));
      next.review.expectedRevision = project.revision + 1;
    }
  }, { document: decision === 'accept', keepReview: true });
}

function validateState(state, label = '项目') {
  if (!plain(state) || state.version !== PROJECT_VERSION) fail('UNSUPPORTED_VERSION', '不支持这个项目版本；需要 version: 1。');
  identifier(state.id, `${label} ID`);
  string(state.title, '成稿名称', 200, false);
  if (!Number.isSafeInteger(state.revision) || state.revision < 0 || !Array.isArray(state.sources) || !Array.isArray(state.draft) || state.draft.length > MAX_BLOCKS || !exactKeys(state.protection, ['numbers', 'quotes']) || typeof state.protection.numbers !== 'boolean' || typeof state.protection.quotes !== 'boolean') fail('INVALID_PROJECT', `${label}结构损坏。`);
  const sourceIds = new Set();
  const sourceMap = new Map();
  for (const source of state.sources) {
    if (!exactKeys(source, ['id', 'name', 'text', 'color', 'blocks']) || sourceIds.has(source.id)) fail('INVALID_PROJECT', '来源缺失或来源 ID 重复。');
    sourceIds.add(source.id);
    const expected = parseSource(source);
    if (!sameParsedBlocks(source.blocks, expected.blocks)) fail('INVALID_PROJECT', '原稿快照与来源块不一致。');
    sourceMap.set(source.id, source);
  }
  const ids = new Set();
  const origins = new Set();
  for (const block of state.draft) {
    if (!plain(block)) fail('INVALID_PROJECT', '成稿块损坏。');
    identifier(block.id, '成稿块 ID');
    const source = sourceMap.get(block.sourceId);
    if (!source || !source.blocks.some(item => item.id === block.sourceBlockId) || ids.has(block.id) || origins.has(originKey(block))) fail('INVALID_PROJECT', '成稿来源丢失或块重复。');
    ids.add(block.id); origins.add(originKey(block));
    string(block.text, '成稿块文本');
    const expected = classify(block.text);
    if (typeof block.locked !== 'boolean' || block.type !== expected.type || block.level !== expected.level) fail('INVALID_PROJECT', '成稿块类型或锁定状态无效。');
  }
  if (state.review !== null) {
    const review = state.review;
    if (!plain(review) || typeof review.id !== 'string' || typeof review.summary !== 'string' || !Number.isSafeInteger(review.baseRevision) || review.baseRevision < 0 || !Number.isSafeInteger(review.expectedRevision) || review.expectedRevision < 0 || !Array.isArray(review.changes) || review.changes.some(change => !plain(change)) || !plain(review.metadata) || typeof review.staleAtCreation !== 'boolean' || !plain(review.basis) || !Array.isArray(review.basis.draft)) fail('INVALID_PROJECT', '润色审阅记录损坏。');
    // The basis is a complete source-bound document, without another nested review/history.
    validateState({ version: state.version, id: state.id, title: state.title, revision: review.baseRevision,
      sources: state.sources, draft: review.basis.draft, protection: review.basis.protection, review: null }, '润色原稿');
    validatePolishOutput({ summary: review.summary, changes: review.changes.map(({ blockId, before, after, reason }) => ({ blockId, before, after, reason })) });
    const contextMatches = reviewContextMatches(state, review);
    const changeIds = new Set();
    for (const change of review.changes) {
      if (typeof change.id !== 'string' || changeIds.has(change.id) || !['pending', 'blocked', 'stale', 'accepted', 'rejected'].includes(change.status) || !Array.isArray(change.issues) || change.issues.some(issue => !plain(issue) || typeof issue.code !== 'string' || typeof issue.message !== 'string')) fail('INVALID_PROJECT', '润色决策记录无效。');
      changeIds.add(change.id);
      if (change.status === 'pending' && (review.expectedRevision !== state.revision || review.staleAtCreation || !contextMatches || validateChange(state, change).length)) fail('INVALID_PROJECT', '项目包含无效的待接受修改。');
    }
    if (review.expectedRevision === state.revision && !contextMatches) fail('INVALID_PROJECT', '润色决策与绑定的成稿不一致。');
  }
}

function sameSource(left, right) {
  return left.id === right.id && left.name === right.name && left.text === right.text && left.color === right.color
    && sameParsedBlocks(left.blocks, right.blocks);
}
function validateProject(project) {
  validateState(project);
  if (!Array.isArray(project.history) || project.history.length > MAX_HISTORY) fail('INVALID_PROJECT', '撤销历史损坏或超出上限。');
  const allSources = new Map(project.sources.map(source => [source.id, source]));
  let lastRevision = -1;
  for (const state of project.history) {
    if (!plain(state) || Object.hasOwn(state, 'history')) fail('INVALID_PROJECT', '撤销历史损坏或包含嵌套历史。');
    validateState(state, '撤销历史');
    if (state.id !== project.id || state.revision < lastRevision || state.revision > project.revision) fail('INVALID_PROJECT', '撤销历史的项目或版本顺序不一致。');
    for (const source of state.sources) {
      if (allSources.has(source.id) && !sameSource(source, allSources.get(source.id))) fail('INVALID_PROJECT', '撤销历史中的同一来源存在不同原稿快照。');
      allSources.set(source.id, source);
    }
    lastRevision = state.revision;
  }
}

export function serializeProject(project, { includeHistory = true, compact = false } = {}) {
  if (typeof includeHistory !== 'boolean' || typeof compact !== 'boolean') fail('INVALID_DATA', '项目保存选项无效。');
  if (includeHistory) validateProject(project);
  else validateState(project);
  const saved = includeHistory ? project : { ...withoutHistory(project), history: [] };
  const serialized = JSON.stringify(saved, null, compact ? undefined : 2);
  if (new TextEncoder().encode(serialized).byteLength > 50_000_000) fail('TOO_LARGE', includeHistory ? '项目与撤销历史合计超过 50 MB，请减少导入内容。' : '项目内容超过 50 MB，请减少导入内容。');
  return serialized;
}
export function deserializeProject(serialized) {
  let project;
  try {
    if (typeof serialized === 'string') {
      if (new TextEncoder().encode(serialized).byteLength > 50_000_000) fail('TOO_LARGE', '项目文件超过 50 MB。');
      project = JSON.parse(serialized);
    } else project = clone(serialized);
  } catch (error) {
    if (error instanceof CoreError) throw error;
    fail('INVALID_PROJECT_JSON', '项目文件不是有效 JSON，当前成稿未被改变。');
  }
  validateProject(project);
  return project;
}
