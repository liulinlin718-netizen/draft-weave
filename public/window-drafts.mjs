// One shared default, independently recoverable window copies. Never merge on events.
export const DEFAULT_DRAFT = 'draft-weave.project.v1';
const COPIES = 'draft-weave.window-copy.v1.';
const SESSION = 'draft-weave.window-copy.current.v1';
const LOCK = 'draft-weave.default-writer.v1';

export function windowDrafts(onStatus) {
  const key = COPIES + crypto.randomUUID();
  let expected, wanted = null, owner = false, release, controller, running = false;
  let error = '', copied = false, lastRecord = null;
  const supported = !!navigator.locks?.request;
  function status() {
    let divergent = false;
    try { divergent = localStorage.getItem(DEFAULT_DRAFT) !== expected; }
    catch { error = '浏览器存储不可用'; }
    onStatus({ owner, supported, divergent, copied, error });
  }
  function restore() {
    const shared = localStorage.getItem(DEFAULT_DRAFT);
    let recovery = null;
    try {
      const previous = sessionStorage.getItem(SESSION);
      if (previous?.startsWith(COPIES)) {
        const record = JSON.parse(localStorage.getItem(previous));
        if (typeof record?.raw === 'string') recovery = record.raw;
      }
    } catch { /* The shared default and independently listed copies remain available. */ }
    // A restored branch cannot silently become the default just because it reloaded.
    expected = recovery !== null && recovery !== shared ? Symbol('restored-branch') : shared;
    return { shared, recovery };
  }
  function copy(raw, title) {
    if (lastRecord?.raw !== raw || localStorage.getItem(key) === null) {
      const record = { raw, title, updatedAt: new Date().toISOString() };
      localStorage.setItem(key, JSON.stringify(record));
      lastRecord = record;
    }
    copied = true;
    try { sessionStorage.setItem(SESSION, key); }
    catch { error = '刷新恢复不可用，请从「窗口草稿」取回副本'; }
  }
  function save(raw, title) {
    wanted = { raw, title };
    error = '';
    try {
      copy(raw, title);
      if (owner && localStorage.getItem(DEFAULT_DRAFT) === expected) {
        localStorage.setItem(DEFAULT_DRAFT, raw);
        expected = raw;
      }
    } catch { error = '自动保存未成功，请立即下载项目'; }
    status();
  }
  function start() {
    if (running) return;
    running = true;
    if (!supported) { status(); return; }
    controller = new AbortController();
    const signal = controller.signal;
    navigator.locks.request(LOCK, { signal }, async () => {
      if (signal.aborted) return;
      owner = true;
      // Register release before callbacks, including pagehide, can run.
      const held = new Promise(resolve => { release = resolve; });
      if (wanted) save(wanted.raw, wanted.title); else status();
      await held;
      owner = false;
    }).catch(e => { if (e.name !== 'AbortError') { error = '写入锁不可用，本窗口只保留独立副本'; status(); } });
    status();
  }
  function stop() {
    running = false; owner = false;
    controller?.abort(); release?.(); release = null;
  }
  function promote(raw, title) {
    if (!owner) throw new Error('请先关闭正在保存默认草稿的窗口。本窗口仍可保存项目或导出。');
    // Archive BEFORE replacing. If storage is full, the default is untouched.
    const previous = localStorage.getItem(DEFAULT_DRAFT);
    if (previous !== null && previous !== raw) {
      archive(previous, '切换前的默认草稿');
    }
    copy(raw, title);
    localStorage.setItem(DEFAULT_DRAFT, raw);
    expected = raw; wanted = { raw, title }; error = ''; status();
  }
  function archive(raw, title) {
    localStorage.setItem(COPIES + crypto.randomUUID(), JSON.stringify({ raw, title, updatedAt: new Date().toISOString() }));
  }
  function backedUp(raw) {
    // The user authorized replacement of exactly this damaged, durably backed-up value.
    // A newer value written while export was in flight remains a separate branch.
    if (localStorage.getItem(DEFAULT_DRAFT) === raw) expected = raw;
  }
  function list() {
    const copies = [];
    for (let i = 0; i < localStorage.length; i++) {
      const item = localStorage.key(i);
      if (!item?.startsWith(COPIES)) continue;
      const value = localStorage.getItem(item);
      try {
        const record = JSON.parse(value);
        if (typeof record?.raw !== 'string') throw new Error('bad copy');
        copies.push({ ...record, key: item, current: item === key });
      } catch { copies.push({ key: item, raw: value, title: '无法读取的窗口副本', updatedAt: '', current: item === key }); }
    }
    return copies.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }
  function remove(item) {
    if (!item.startsWith(COPIES) || item === key) throw new Error('不能删除当前窗口的恢复副本');
    localStorage.removeItem(item);
  }
  window.addEventListener('storage', event => {
    // Re-read current storage: delayed events are notifications, never document data.
    if (event.key === DEFAULT_DRAFT || event.key === null) status();
  });
  return { restore, start, stop, save, promote, archive, backedUp, list, remove };
}
