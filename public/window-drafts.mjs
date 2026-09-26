import { editBlock } from './core.mjs';
import { COPY_PREFIX as COPIES, inputJournalKey, checkpointInfo, recoverInput, sameProjectState } from './input-journal.mjs';

// One shared default, independently recoverable window copies. Never merge on events.
export const DEFAULT_DRAFT = 'draft-weave.project.v1';
const SESSION = 'draft-weave.window-copy.current.v1';
const LOCK = 'draft-weave.default-writer.v1';

export function windowDrafts(onStatus = () => {}, environment = {}) {
  const storage = environment.localStorage ?? globalThis.localStorage;
  const session = environment.sessionStorage ?? globalThis.sessionStorage;
  const locks = environment.locks ?? globalThis.navigator?.locks;
  const events = environment.window ?? globalThis.window;
  const uuid = environment.randomUUID ?? (() => crypto.randomUUID());
  const now = environment.now ?? (() => new Date().toISOString());
  const key = COPIES + uuid(), journalKey = inputJournalKey(key);
  let expected, wanted = null, owner = false, release, controller, running = false;
  let error = '', copied = false, lastRecord = null, baseProject = null, inputBasis = null;
  let journal = null, pendingInput = null, inputError = '', inputRecoveryRaw = null, divergent = false;
  const supported = !!locks?.request;
  function status(readDefault = true) {
    if (readDefault) {
      try { divergent = storage.getItem(DEFAULT_DRAFT) !== expected; }
      catch { error = '浏览器存储不可用'; }
    }
    const state = { owner, supported, divergent, copied, error, inputError, inputRecoveryRaw, checkpointId: lastRecord?.checkpointId ?? null };
    onStatus(state);
    return state;
  }
  function read(item, { recover = true } = {}) {
    if (typeof item !== 'string' || !item.startsWith(COPIES)) throw new Error('窗口副本标识无效');
    const value = storage.getItem(item);
    if (value === null) throw new Error('窗口副本已不存在');
    let record;
    try {
      record = JSON.parse(value);
      if (typeof record?.raw !== 'string') throw new Error('bad copy');
    } catch { record = { raw: value, title: '无法读取的窗口副本', updatedAt: '' }; }
    if (typeof record.summary !== 'string' || !Number.isFinite(record.size)) {
      record.summary = '旧版副本，恢复或下载时读取。';
      record.size = new TextEncoder().encode(record.raw).byteLength;
      if (recover) {
        try { const info = checkpointInfo(record.raw); record.summary = info.summary; record.size = info.size; }
        catch { record.summary = '无法解析，可下载原始内容。'; }
      }
    }
    const journalRaw = storage.getItem(inputJournalKey(item));
    const recovery = recover ? recoverInput(record, item, journalRaw) : { raw: record.raw, inputRecovered: false, inputError: '', inputRecoveryRaw: journalRaw };
    if (recovery.inputRecovered) {
      const info = checkpointInfo(recovery.raw); record.summary = info.summary; record.size = info.size;
    }
    return { ...record, ...recovery, key: item, current: item === key, hasInput: journalRaw !== null };
  }
  function restore() {
    const shared = storage.getItem(DEFAULT_DRAFT);
    let recovery = null, inputRecovered = false, restoreError = '', recoveryRaw = null;
    try {
      const previous = session.getItem(SESSION);
      if (previous?.startsWith(COPIES) && storage.getItem(previous) !== null) {
        const record = read(previous);
        recovery = record.raw; inputRecovered = record.inputRecovered;
        restoreError = record.inputError; recoveryRaw = record.inputRecoveryRaw;
      }
    } catch (failure) { restoreError = `窗口输入恢复未完成：${failure.message}；请从「窗口草稿」取回副本。`; }
    expected = recovery !== null && recovery !== shared ? Symbol('restored-branch') : shared;
    inputError = restoreError; inputRecoveryRaw = recoveryRaw;
    return { shared, recovery, inputRecovered, inputError: restoreError, inputRecoveryRaw: recoveryRaw };
  }
  function clearJournal() {
    const hadInput = journal !== null;
    journal = null; pendingInput = null;
    if (hadInput || storage.getItem(journalKey) !== null) storage.removeItem(journalKey);
    inputError = ''; inputRecoveryRaw = null;
  }
  function archiveInput() {
    const archivedKey = COPIES + uuid(), checkpointId = uuid();
    const record = { ...lastRecord, title: `${lastRecord.title || '窗口草稿'} · 操作前输入`, updatedAt: now(), checkpointId };
    // Both writes must succeed before the current copy may be replaced. A partial
    // archive never deletes or changes the original checkpoint and journal.
    storage.setItem(archivedKey, JSON.stringify(record));
    storage.setItem(inputJournalKey(archivedKey), JSON.stringify({ ...journal, copyKey: archivedKey, checkpointId }));
  }
  function copy(raw, title, { replaceInput = false } = {}) {
    if (typeof replaceInput !== 'boolean') throw new Error('输入替换选项无效');
    const info = checkpointInfo(raw);
    if (journal && (info.project.id !== journal.projectId || journal.entries.some(entry => info.project.draft.find(block => block.id === entry.blockId)?.text !== entry.text))) {
      if (!replaceInput) throw new Error('完整草稿尚未包含待保存输入，输入记录已保留');
      archiveInput();
    }
    if (lastRecord?.raw !== raw || storage.getItem(key) === null) {
      const record = { raw, title, updatedAt: now(), checkpointId: uuid(), summary: info.summary, size: info.size };
      storage.setItem(key, JSON.stringify(record));
      lastRecord = record;
    }
    baseProject = info.project; inputBasis = info.project; copied = true;
    // A durable copy exists before the journal or the shared default changes.
    try { session.setItem(SESSION, key); }
    catch { error = '刷新恢复不可用，请从「窗口草稿」取回副本'; }
    try { clearJournal(); }
    catch { inputError = '草稿已保存，但旧输入记录清理失败；原始记录仍可下载。'; inputRecoveryRaw = storage.getItem(journalKey); }
  }
  function save(raw, title, options = {}) {
    wanted = { raw, title, options }; error = '';
    let savedCopy = false;
    try {
      copy(raw, title, options); savedCopy = true;
      if (owner && storage.getItem(DEFAULT_DRAFT) === expected) {
        storage.setItem(DEFAULT_DRAFT, raw); expected = raw;
      }
    } catch (failure) {
      error = `自动保存未成功，请立即下载项目。${failure.message || ''}`;
      // A failed copy may advance the input basis only for the exact recorded edit.
      if (!savedCopy && pendingInput && inputBasis) {
        try {
          const next = editBlock(inputBasis, pendingInput.blockId, pendingInput.text);
          const candidate = checkpointInfo(raw).project;
          if (sameProjectState(next, candidate)) { inputBasis = candidate; pendingInput = null; }
        } catch { /* Keep the last proven basis and durable journal. */ }
      }
    }
    return { ...status(), copied: savedCopy };
  }
  function advanceInput(project) {
    try {
      if (!inputBasis) throw new Error('尚无已保存的输入基准');
      if (sameProjectState(inputBasis, project)) return true;
      if (!pendingInput || !sameProjectState(editBlock(inputBasis, pendingInput.blockId, pendingInput.text), project)) {
        throw new Error('输入提交不对应已记录的段落编辑');
      }
      // The journal remains bound to baseProject, even if serialization or the
      // following full write fails. Only the next input event's before advances.
      inputBasis = project; pendingInput = null;
      return true;
    } catch (failure) {
      inputError = `${failure.message}；已保存的输入记录仍保留，请下载当前项目。`;
      inputRecoveryRaw = journal ? JSON.stringify(journal) : inputRecoveryRaw;
      status(false);
      return false;
    }
  }
  function recordInput(input) {
    let attemptedRaw = null;
    try {
      if (!lastRecord || !baseProject || !inputBasis) throw new Error('尚无可绑定的已保存窗口副本');
      if (input?.projectId !== inputBasis.id || input.revision !== inputBasis.revision || typeof input.blockId !== 'string' ||
          typeof input.before !== 'string' || typeof input.text !== 'string' || input.text.length > 2_000_000 ||
          inputBasis.draft.find(block => block.id === input.blockId)?.text !== input.before) throw new Error('输入记录的项目、版本或段落原文不匹配');
      const base = baseProject.draft.find(block => block.id === input.blockId);
      if (!base) throw new Error('输入段落不属于最后成功保存的副本');
      const next = journal ? { ...journal, entries: journal.entries.map(entry => ({ ...entry })) } : {
        version: 1, copyKey: key, checkpointId: lastRecord.checkpointId, projectId: baseProject.id, revision: baseProject.revision, entries: []
      };
      const entry = next.entries.find(item => item.blockId === input.blockId);
      const text = input.text.replace(/\r\n?/g, '\n');
      if (entry) entry.text = text; else next.entries.push({ blockId: input.blockId, before: base.text, text });
      next.updatedAt = now();
      journal = next; pendingInput = { ...input, text };
      const raw = JSON.stringify(next);
      attemptedRaw = raw;
      inputRecoveryRaw = raw;
      storage.setItem(journalKey, raw);
      inputError = ''; inputRecoveryRaw = null;
      status(false);
      return true;
    } catch (failure) {
      inputError = `此输入尚未安全保存：${failure.message}；请下载当前项目或输入记录。`;
      inputRecoveryRaw = attemptedRaw ?? JSON.stringify({ version: 1, unappliedInput: input, journal });
      status(false);
      return false;
    }
  }
  function start() {
    if (running) return;
    running = true;
    if (!supported) { status(); return; }
    controller = new AbortController();
    const signal = controller.signal;
    locks.request(LOCK, { signal }, async () => {
      if (signal.aborted) return;
      owner = true;
      const held = new Promise(resolve => { release = resolve; });
      if (wanted) save(wanted.raw, wanted.title, wanted.options); else status();
      await held;
      owner = false;
    }).catch(failure => { if (failure.name !== 'AbortError') { error = '写入锁不可用，本窗口只保留独立副本'; status(); } });
    status();
  }
  function stop() { running = false; owner = false; controller?.abort(); release?.(); release = null; }
  function promote(raw, title) {
    if (!owner) throw new Error('请先关闭正在保存默认草稿的窗口。本窗口仍可保存项目或导出。');
    const previous = storage.getItem(DEFAULT_DRAFT);
    if (previous !== null && previous !== raw) archive(previous, '切换前的默认草稿');
    copy(raw, title);
    storage.setItem(DEFAULT_DRAFT, raw);
    expected = raw; wanted = { raw, title }; error = ''; status();
  }
  function archive(raw, title) {
    let metadata = {};
    try { const info = checkpointInfo(raw); metadata = { summary: info.summary, size: info.size }; } catch { /* Keep damaged raw bytes. */ }
    storage.setItem(COPIES + uuid(), JSON.stringify({ raw, title, updatedAt: now(), checkpointId: uuid(), ...metadata }));
  }
  function backedUp(raw) { if (storage.getItem(DEFAULT_DRAFT) === raw) expected = raw; }
  function list({ recover = false } = {}) {
    const copies = [];
    for (let i = 0; i < storage.length; i++) {
      const item = storage.key(i);
      if (item?.startsWith(COPIES)) copies.push(read(item, { recover }));
    }
    return copies.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }
  function remove(item) {
    if (!item.startsWith(COPIES) || item === key) throw new Error('不能删除当前窗口的恢复副本');
    storage.removeItem(item);
    storage.removeItem(inputJournalKey(item));
  }
  events?.addEventListener('storage', event => { if (event.key === DEFAULT_DRAFT || event.key === null) status(); });
  return { restore, start, stop, save, recordInput, advanceInput, promote, archive, backedUp, list, read, remove };
}
