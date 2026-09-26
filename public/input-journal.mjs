import { deserializeProject, editBlock, serializeProject } from './core.mjs';

export const COPY_PREFIX = 'draft-weave.window-copy.v1.';
export const INPUT_PREFIX = 'draft-weave.input-journal.v1.';
export const inputJournalKey = copyKey => INPUT_PREFIX + copyKey.slice(COPY_PREFIX.length);

// Browser recovery metadata; the exported project schema stays unchanged.
export function checkpointInfo(raw) {
  const project = JSON.parse(raw);
  if (project?.version !== 1 || typeof project.id !== 'string' || !Number.isSafeInteger(project.revision) || project.revision < 0 ||
      !Array.isArray(project.draft) || project.draft.some(block => typeof block.id !== 'string' || typeof block.text !== 'string')) {
    throw new Error('项目检查点无法读取');
  }
  return { project, summary: (project.draft.find(block => block.type !== 'heading') || project.draft[0])?.text.slice(0, 100) || '尚未选入成稿',
    size: new TextEncoder().encode(raw).byteLength };
}

export function parseInputJournal(raw, copyKey, record) {
  const journal = JSON.parse(raw);
  if (!record?.checkpointId || journal?.version !== 1 || journal.copyKey !== copyKey || journal.checkpointId !== record.checkpointId ||
      typeof journal.projectId !== 'string' || !Number.isSafeInteger(journal.revision) || journal.revision < 0 ||
      !Array.isArray(journal.entries) || journal.entries.length > 10_000) throw new Error('输入记录与窗口检查点不匹配');
  const seen = new Set();
  for (const entry of journal.entries) {
    if (!entry || typeof entry.blockId !== 'string' || seen.has(entry.blockId) || typeof entry.before !== 'string' ||
        typeof entry.text !== 'string' || entry.text.length > 2_000_000) throw new Error('输入记录格式损坏');
    seen.add(entry.blockId);
  }
  return journal;
}

export function recoverInput(record, copyKey, journalRaw) {
  const result = { raw: record.raw, inputRecovered: false, inputError: '', inputRecoveryRaw: null };
  if (journalRaw === null) return result;
  try {
    const journal = parseInputJournal(journalRaw, copyKey, record);
    const original = deserializeProject(record.raw);
    if (journal.projectId !== original.id || journal.revision !== original.revision) throw new Error('输入记录的项目或版本不匹配');
    for (const entry of journal.entries) {
      if (original.draft.find(block => block.id === entry.blockId)?.text !== entry.before) throw new Error('输入记录的段落原文不匹配');
    }
    let project = original, recoveryHistory;
    for (const entry of journal.entries) {
      const next = editBlock(project, entry.blockId, entry.text);
      if (next !== project && !recoveryHistory) recoveryHistory = next.history;
      project = next;
    }
    if (project !== original) {
      // One recovery action, one undo point, including edits spanning several blocks.
      project.history = recoveryHistory;
      result.raw = serializeProject(project, { compact: true });
      result.inputRecovered = true;
    }
  } catch (error) {
    result.inputError = `${error.message}；原稿与输入记录均已保留，请下载输入记录。`;
    result.inputRecoveryRaw = journalRaw;
  }
  return result;
}

// Used only after a failed full checkpoint, never for each keystroke.
export function sameProjectState(left, right) {
  const equal = (a, b) => {
    if (a === b) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equal(a[key], b[key]));
  };
  const { history: leftHistory, ...a } = left;
  const { history: rightHistory, ...b } = right;
  return equal(a, b);
}
