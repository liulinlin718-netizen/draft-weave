import * as core from './core.mjs';
import { sampleSources } from './samples.mjs';
import { windowDrafts } from './window-drafts.mjs';
import { preflightPolishRequest, preparePolishRequest, canReusePolishReview } from './polish-request.mjs';

const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
let project = core.createProject();
let visibleSources = [], replaceTarget = null, reviewTab = false, dragging = null;
let provider = 'codex-cli', connection = null, activeRequest = null, toastTimer;
let unreadableAutosave = null;
let copiesShown = [];
let inputRecoveryRaw = null, composing = false, deferredRender = false;
let idleCheckpoint, maxCheckpoint, editSession = null, replaceInputPending = false;
const sourcePositions = new Map();
const drafts = windowDrafts(state => {
  if (state.inputError) showInputRecovery(state.inputError, state.inputRecoveryRaw);
  if (unreadableAutosave !== null) { $('#save-state').textContent = '自动保存已暂停 · 原始草稿保留'; return; }
  const isolated = !state.owner || state.divergent;
  $('#save-state').textContent = state.error || (state.copied ? isolated ? '已另存本窗口草稿' : '已自动保存 · 本地' : '本地草稿');
  $('#window-banner').hidden = !isolated && !state.error;
  $('#window-message').textContent = state.error || (!state.supported ? '此浏览器不支持写入锁。本窗口保存独立副本，可从「窗口草稿」恢复或下载项目。' : state.owner ? '默认草稿已在别处改变。本窗口单独保存；设为默认会先保留旧稿。' : '另一窗口正在保存默认草稿。本窗口单独保存，可分别导出或从「窗口草稿」恢复。');
  $('#use-window-draft').hidden = !state.owner || !state.divergent || !!state.error;
});

function makeSamples() {
  let result = core.createProject({ title: '社区图书馆服务改造' });
  for (const source of sampleSources) result = core.addSource(result, core.parseSource(source));
  result.history = [];
  return result;
}
function toast(message, error = false) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').classList.toggle('error', error);
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, error ? 7500 : 4200);
}
function persist({ replaceInput = false } = {}) {
  if (replaceInput) replaceInputPending = true;
  // A failed restore must never be replaced by the sample document on unload.
  if (unreadableAutosave !== null) { $('#save-state').textContent = '自动保存已暂停 · 原始草稿保留'; return; }
  try {
    const result = drafts.save(core.serializeProject(project, { compact: true }), project.title, { replaceInput: replaceInputPending });
    if (result.copied) replaceInputPending = false;
    $('#save-error-banner').hidden = !result.error;
    if (result.error) $('#save-error-message').textContent = `${result.error} 可应急保存当前项目。`;
    return result;
  }
  catch (error) {
    $('#save-state').textContent = '自动保存未完成 · 可应急保存';
    $('#save-error-banner').hidden = false;
    $('#save-error-message').textContent = `${error.message} 应急保存会保留当前来源、成稿、锁定和审阅，省略撤销历史。`;
    return { copied: false, error: error.message };
  }
}
function checkpointInput() {
  if (unreadableAutosave !== null) return;
  const editor = document.activeElement;
  try {
    if (!editor?.matches('textarea[data-edit-id]')) return;
    const block = project.draft.find(item => item.id === editor.dataset.editId);
    if (block && !block.locked) drafts.recordInput({ projectId: project.id, revision: project.revision, blockId: block.id, before: block.text, text: editor.value });
  } catch { $('#save-state').textContent = '此输入尚未保存 · 请检查内容'; }
}
function showInputRecovery(message, raw) {
  if (raw) inputRecoveryRaw = raw;
  $('#input-recovery-banner').hidden = false;
  $('#input-recovery-message').textContent = message;
}
function clearCheckpoints() { clearTimeout(idleCheckpoint); clearTimeout(maxCheckpoint); idleCheckpoint = maxCheckpoint = null; }
function flushInput() {
  clearCheckpoints();
  if (composing) return;
  commitActiveEditor();
  renderNotices(); renderReview();
  $('#undo').disabled = !project.history.length;
  $('#draft-count').textContent = `${project.draft.length} 块 · ${core.exportMarkdown(project).replace(/\s/g, '').length.toLocaleString()} 字`;
}
function scheduleCheckpoint() {
  clearTimeout(idleCheckpoint);
  idleCheckpoint = setTimeout(flushInput, 800);
  if (!maxCheckpoint) maxCheckpoint = setTimeout(flushInput, 4000);
}
function commitEditor(editor) {
  if (composing || !editor?.matches('textarea[data-edit-id]')) return;
  const id = editor.dataset.editId;
  const block = project.draft.find(item => item.id === id);
  if (!block || block.text === editor.value) return;
  if (!editSession || editSession.id !== id || editSession.project !== project) editSession = { id, project, history: null };
  const next = core.editBlock(project, id, editor.value);
  // Idle checkpoints within one uninterrupted edit keep the same undo boundary.
  if (editSession.history) next.history = editSession.history;
  else editSession.history = next.history;
  project = next; editSession.project = project;
  drafts.advanceInput(project);
  persist();
}
function downloadRaw(raw, filename) {
  const url = URL.createObjectURL(new Blob([raw], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
function showWindowDrafts() {
  copiesShown = drafts.list();
  $('#window-copies').innerHTML = copiesShown.length ? copiesShown.map((copy, i) => {
    const preview = copy.summary || '可恢复到本窗口，或下载后检查。';
    return `<article class="window-copy"><strong>${escape(copy.title || '未命名草稿')}${copy.current ? ' · 当前窗口' : ''}</strong><small>${escape(copy.updatedAt ? new Date(copy.updatedAt).toLocaleString() : '原始数据保留')} · ${escape(copy.key.slice(-6))} · ${Number.isFinite(copy.size) ? `${(copy.size / 1024).toFixed(1)} KB` : '大小未知'}</small><p>${escape(preview)}</p><div><button data-action="restore-window" data-id="${i}">恢复到本窗口</button><button data-action="download-window" data-id="${i}">下载副本</button>${copy.current ? '' : `<button data-action="delete-window" data-id="${i}">删除副本</button>`}</div></article>`;
  }).join('') : '<p class="muted">编辑后会在这里保留窗口副本。</p>';
  $('#window-dialog').showModal();
}
function commitActiveEditor() {
  const editor = document.activeElement;
  if (!editor?.matches('textarea[data-edit-id]')) return null;
  const id = editor.dataset.editId;
  const block = project.draft.find(item => item.id === id);
  if (!block) return null;
  const selection = { id, start: editor.selectionStart, end: editor.selectionEnd };
  commitEditor(editor);
  return selection;
}
function change(action, message) {
  try {
    if (composing) throw new Error('请先完成当前输入，再执行此操作。');
    commitActiveEditor();
    clearCheckpoints(); editSession = null;
    const next = action(project);
    if (next === project) return false;
    project = next;
    if (replaceTarget && !project.draft.some(b => b.id === replaceTarget)) replaceTarget = null;
    persist({ replaceInput: true }); render();
    if (message) toast(message);
    return true;
  } catch (error) { toast(error.message || '操作未完成', true); return false; }
}
function sourceFor(id) { return project.sources.find(source => source.id === id); }
function originalFor(block) { return sourceFor(block.sourceId)?.blocks.find(item => item.id === block.sourceBlockId); }
function selectedFor(sourceId, blockId) { return project.draft.find(block => block.sourceId === sourceId && block.sourceBlockId === blockId); }
function sourceLabel(source) { return source?.name || '原稿'; }
function textLabel(block) { return block.text.replace(/^\s*#{1,6}\s*/, '').slice(0, 36); }
function flash(element) {
  if (!element) return;
  element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  element.classList.remove('highlight');
  requestAnimationFrame(() => element.classList.add('highlight'));
}
function focusDraft(id) {
  reviewTab = false; renderTabs();
  flash(document.getElementById(`draft-${id}`));
}
function scrollPositions() {
  return [...document.querySelectorAll('.draft-scroll')].map(el => [el.id, el.scrollTop]);
}
function render() {
  if (composing) { deferredRender = true; return; }
  const editing = commitActiveEditor();
  const positions = scrollPositions();
  renderSources(); renderDraft(); renderReview(); renderTabs(); renderNotices();
  for (const [id, position] of positions) { const element = document.getElementById(id); if (element) element.scrollTop = position; }
  $('#undo').disabled = !project.history.length;
  $('#draft-count').textContent = `${project.draft.length} 块 · ${core.exportMarkdown(project).replace(/\s/g, '').length.toLocaleString()} 字`;
  $('#protect-numbers').checked = project.protection.numbers;
  $('#protect-quotes').checked = project.protection.quotes;
  $('#preview-button').disabled = !project.draft.length;
  $('#export-button').disabled = !project.draft.length;
  $('#polish-button').disabled = !project.draft.length || !!activeRequest;
  $('#cancel-button').hidden = !activeRequest;
  $('#polish-button').classList.toggle('busy', !!activeRequest);
  $('#polish-button').textContent = activeRequest ? '正在阅读整份成稿…' : '整体连接性润色 →';
  $('#replace-banner').hidden = !replaceTarget;
  if (replaceTarget) $('#replace-banner').innerHTML = '<span>替换已就绪 · 点击左侧任意原文段落</span><button data-action="cancel-replace">取消 ×</button>';
  requestAnimationFrame(() => {
    resizeTextareas();
    if (editing && !reviewTab) {
      const editor = document.querySelector(`textarea[data-edit-id="${editing.id}"]`);
      if (editor) { editor.focus({ preventScroll: true }); editor.setSelectionRange(editing.start, editing.end); }
    }
  });
}
function renderSources() {
  document.querySelectorAll('.source-column[data-source]').forEach(el => {
    const body = el.querySelector('.source-body'); if (body) sourcePositions.set(`${body.id}:${el.dataset.source}`, body.scrollTop);
  });
  visibleSources = visibleSources.filter(id => sourceFor(id));
  for (const source of project.sources) { if (visibleSources.length >= 2) break; if (!visibleSources.includes(source.id)) visibleSources.push(source.id); }
  $('#source-columns').innerHTML = [0, 1].map(slot => {
    const source = sourceFor(visibleSources[slot]);
    if (!source) return `<article class="source-column" style="--source-color:#a4ad96"><div class="source-header">候选稿 ${slot ? 'B' : 'A'}</div><div class="empty-source">放入想比较的文稿<br><button data-action="import">＋ 导入 Markdown / 文本</button></div></article>`;
    const sourceIndex = project.sources.indexOf(source);
    return `<article class="source-column" style="--source-color:${source.color}" data-source="${source.id}"><div class="source-header"><span class="source-letter">${String.fromCharCode(65 + sourceIndex)}</span><select aria-label="候选稿 ${slot + 1}" data-slot="${slot}">${project.sources.map(s => `<option value="${s.id}" ${s.id === source.id ? 'selected' : ''}>${escape(s.name)}</option>`).join('')}</select></div><div class="source-body" id="source-body-${slot}">${source.blocks.map(block => {
      const selected = selectedFor(source.id, block.id);
      const order = selected ? project.draft.indexOf(selected) + 1 : null;
      const scope = block.type === 'heading' ? core.getSectionBlockIds(source, block.id) : [];
      const picked = scope.filter(id => selectedFor(source.id, id)).length;
      return `<div id="source-${slot}-${block.id}" class="source-block type-${block.type} level-${block.level} ${selected ? 'is-selected' : ''}" data-source-block="${block.id}">${block.type === 'heading' ? `<div class="scope-actions"><span>H${block.level}</span><button data-action="section" data-source-id="${source.id}" data-block-id="${block.id}" title="选入本标题及所有下级内容">${block.level === 1 ? '选整稿' : block.level === 2 ? '选本章' : '选本节'} ↗</button>${picked ? `<button data-action="complete-section" data-source-id="${source.id}" data-block-id="${block.id}" title="按原稿顺序补齐，在首个已选块处合并；保留改文和锁定">按原序补齐 ${picked}/${scope.length}</button>` : ''}</div>` : ''}<button class="source-text" data-action="select" data-source-id="${source.id}" data-block-id="${block.id}" aria-pressed="${!!selected}" aria-label="${replaceTarget ? '替换为' : selected ? '取消' : '选入'}：${escape(textLabel(block))}">${escape(block.type === 'heading' ? block.text.replace(/^\s*#{1,6}\s*/, '') : block.text)}</button><div class="selection-indicator"><span>${replaceTarget ? '点击替换成稿段落' : selected ? '✓ 已选' : '＋ 点选加入'}</span>${selected ? `<button data-action="locate-draft" data-id="${selected.id}" title="定位成稿" class="selected-number">${String(order).padStart(2, '0')} ↗</button>` : `<span>L${block.startLine}</span>`}</div></div>`;
    }).join('')}</div></article>`;
  }).join('');
  document.querySelectorAll('.source-column[data-source]').forEach(el => { el.querySelector('.source-body').scrollTop = sourcePositions.get(`${el.querySelector('.source-body').id}:${el.dataset.source}`) || 0; });
}
function renderDraft() {
  if (!project.draft.length) {
    $('#draft').innerHTML = '<div class="empty-draft"><div class="empty-symbol" aria-hidden="true">Aa</div><h2>让喜欢的段落，在这里相遇</h2><p>从左侧点选一段，或选入一整章。<br>随后拖动排序，拼成你的版本。</p><button data-action="first-chapter">从 A 稿「背景」开始 ↗</button></div>';
    return;
  }
  $('#draft').innerHTML = project.draft.map((block, index) => {
    const source = sourceFor(block.sourceId);
    const origin = originalFor(block);
    return `<article id="draft-${block.id}" data-draft-id="${block.id}" class="draft-block type-${block.type} level-${block.level} ${block.locked ? 'is-locked' : ''} ${replaceTarget === block.id ? 'replacing' : ''}" style="--source-color:${source.color}"><div class="block-meta"><button class="origin-link" data-action="origin" data-id="${block.id}" title="定位原文">${String(index + 1).padStart(2, '0')} · ${escape(sourceLabel(source))} · L${origin?.startLine || '?'} ↗</button><div class="block-controls"><button data-action="move-up" data-id="${block.id}" aria-label="上移第 ${index + 1} 块" ${index === 0 ? 'disabled' : ''}>↑</button><button data-action="move-down" data-id="${block.id}" aria-label="下移第 ${index + 1} 块" ${index === project.draft.length - 1 ? 'disabled' : ''}>↓</button><button data-action="replace" data-id="${block.id}" ${block.locked ? 'disabled' : ''}>替换</button><button data-action="lock" data-id="${block.id}" aria-pressed="${block.locked}" title="锁定后不允许模型修改">${block.locked ? '已锁' : '锁定'}</button><button class="danger" data-action="remove" data-id="${block.id}" aria-label="移除第 ${index + 1} 块">×</button><span class="drag-handle" draggable="true" data-drag-id="${block.id}" title="拖动排序" aria-label="拖动第 ${index + 1} 块">⠿</span></div></div><textarea data-edit-id="${block.id}" aria-label="成稿第 ${index + 1} 块" spellcheck="false" ${block.locked ? 'readonly' : ''}>${escape(block.text)}</textarea>${block.locked ? '<span class="locked-label">已锁定整段 · 解锁后可编辑</span>' : ''}</article>`;
  }).join('');
}
function resizeTextareas() {
  document.querySelectorAll('textarea[data-edit-id]').forEach(el => { el.style.height = '0px'; el.style.height = `${el.scrollHeight + 2}px`; });
}
function diffHtml(before, after, side) {
  const diff = core.diffText(before, after);
  return escape(diff.prefix) + '<mark>' + escape(side === 'before' ? diff.removed : diff.added) + '</mark>' + escape(diff.suffix);
}
function renderReview() {
  const review = project.review;
  $('#review-count').textContent = review ? review.changes.filter(change => change.status === 'pending').length || '' : '';
  if (!review) {
    $('#review').innerHTML = '<div class="empty-draft"><div class="empty-symbol" aria-hidden="true">↝</div><h2>先拼好，再连成一稿</h2><p>整体检查转承、指代、术语与重复。<br>所有修改都会在这里等待你逐条审阅。</p><button data-action="settings">选择润色连接</button></div>';
    return;
  }
  const metadata = review.metadata;
  const providerLabel = metadata.provider === 'imported' ? '离线导入的修改集 · 非本次实时模型生成' : `${metadata.provider || '模型'} · ${metadata.model || '模型未记录'}`;
  const usage = metadata.usage;
  const usageText = usage && typeof usage === 'object' ? Object.entries(usage).map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`).join(' · ') : '后端未返回用量，无法据此估算费用';
  const statuses = { pending: '待审阅', accepted: '已接受', rejected: '已拒绝', blocked: '保护拦截', stale: '已过期' };
  $('#review').innerHTML = `<p class="review-intro"><span class="review-provider">${escape(providerLabel)}</span>${escape(review.summary)}<br>已接受 ${review.changes.filter(c => c.status === 'accepted').length} / ${review.changes.length} 处 · 其余不会改写成稿</p><details class="review-usage"><summary>本次请求记录</summary><p>${escape(usageText)}</p>${Number.isFinite(metadata.elapsedMs) ? `<p>请求耗时 ${(metadata.elapsedMs / 1000).toFixed(2)} 秒</p>` : ''}${metadata.inputSignature ? `<p>请求 ${Number(metadata.requestBytes).toLocaleString()} 字节 · 输入 ${Number(metadata.inputCharacters).toLocaleString()} 字符</p><code>${escape(metadata.inputSignature)}</code>` : '<p>此修改集未记录输入签名。</p>'}</details>${review.changes.length ? review.changes.map((item, index) => {
    const block = project.draft.find(b => b.id === item.blockId);
    const source = block && sourceFor(block.sourceId);
    const at = project.draft.findIndex(b => b.id === item.blockId);
    const context = at < 0 ? [] : [['前一段', project.draft[at - 1]?.text], ['当前段', block.text], ['后一段', project.draft[at + 1]?.text], [`来源原文 · ${sourceLabel(source)} · L${originalFor(block)?.startLine || '?'}`, originalFor(block)?.text]];
    return `<article class="change status-${item.status}" data-change-id="${item.id}" style="--source-color:${source?.color || '#748468'}"><div class="change-head"><span>${String(index + 1).padStart(2, '0')} · ${escape(sourceLabel(source))}</span><strong>${statuses[item.status]}</strong></div><p class="change-reason">${escape(item.reason)}</p><div class="diff-line diff-before" aria-label="修改前">${diffHtml(item.before, item.after, 'before')}</div><div class="diff-line diff-after" aria-label="建议修改后">${item.after ? diffHtml(item.before, item.after, 'after') : '<em>删除重复内容</em>'}</div>${item.issues?.length ? `<div class="change-issues">${item.issues.map(issue => escape(issue.message)).join('<br>')}</div>` : ''}<details class="review-context"><summary>查看相邻段落与来源</summary>${context.length ? context.filter(([, text]) => text !== undefined).map(([label, text]) => `<div><strong>${escape(label)}</strong><p>${escape(text)}</p></div>`).join('') : '<p>该段已不在当前成稿中。</p>'}</details><div class="change-actions"><button data-action="locate-draft" data-id="${item.blockId}">定位成稿</button>${!['accepted', 'rejected'].includes(item.status) ? `<button data-action="reject" data-id="${item.id}">拒绝</button><button class="accept" data-action="accept" data-id="${item.id}" ${item.status !== 'pending' ? 'disabled' : ''}>接受修改 ✓</button><button data-action="reject-next" data-id="${item.id}">拒绝并下一条</button><button class="accept" data-action="accept-next" data-id="${item.id}" ${item.status !== 'pending' ? 'disabled' : ''}>接受并下一条</button>` : ''}</div></article>`;
  }).join('') : '<p class="muted">模型没有提出修改，成稿保持原样。</p>'}`;
}
function renderTabs() {
  $('#draft').hidden = reviewTab; $('#review').hidden = !reviewTab;
  $('#tab-draft').classList.toggle('active', !reviewTab); $('#tab-review').classList.toggle('active', reviewTab);
}
function renderNotices() {
  const issues = core.analyzeStructure(project);
  $('#structure-notices').innerHTML = issues.length ? `<details><summary>拼接检查 · ${issues.length} 处需要留意</summary><ul>${issues.map(issue => `<li><button data-action="locate-draft" data-id="${issue.blockIds.at(-1)}">↗ ${escape(issue.message)}</button></li>`).join('')}</ul></details>` : '';
}
async function api(url, payload, options = {}) {
  let response;
  try { response = await fetch(url, payload === undefined ? options : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), ...options }); }
  catch (error) { if (error.name === 'AbortError') throw error; throw new Error('本地服务未连接。成稿仍保留，请重新启动服务后重试。'); }
  const data = await response.json();
  if (!response.ok || data.error) { const error = new Error(data.error?.message || '请求失败'); error.code = data.error?.code; throw error; }
  return data;
}
async function refreshStatus(options = {}) {
  try {
    connection = await api('/api/status', undefined, options);
    $('#model-status .status-dot').classList.toggle('ready', Object.values(connection.providers).some(p => p.ready));
  } catch (error) { connection = { error: error.message }; }
  renderProvider();
  return connection;
}
function renderProvider() {
  const status = connection?.providers?.[provider];
  $('#provider').value = provider;
  $('#provider-details').innerHTML = status ? `<strong>${status.ready ? (provider === 'external-api' ? '● 已配置 · 待请求验证' : '● 已核验登录') : '○ 尚不可用'} · ${escape(status.code || provider)}</strong>${escape(status.message || '可以发起请求')}<br><code>${escape(status.model || '')}${status.apiStyle ? ` · ${escape(status.apiStyle)}` : ''}</code>${provider === 'codex-cli' && !status.ready ? '<p>在项目目录运行 <code>node scripts/login-codex.mjs</code>，使用所选数据目录的独立 profile 正常登录后重新检查。</p>' : ''}${provider === 'external-api' && !status.ready ? '<p>配置项目服务端环境后重新启动。具体变量见 docs/MODELS.md；密钥只由服务端读取。</p>' : ''}` : escape(connection?.error || '正在检查本地连接…');
}
async function polish({ force = false } = {}) {
  if (!project.draft.length || activeRequest || composing) return;
  document.activeElement?.blur();
  const basis = project, revision = project.revision, projectId = project.id, selectedProvider = provider;
  const controller = new AbortController(), requestId = crypto.randomUUID();
  try { preflightPolishRequest(basis, { requestId, provider: selectedProvider }); }
  catch (error) { $('#request-state').textContent = '请求未发送 · 原成稿保留'; toast(error.requestBytes ? `${error.message} 当前请求 ${(error.requestBytes / 1_000_000).toFixed(2)} MB。` : error.message, true); return; }
  activeRequest = { requestId, controller, projectId };
  $('#request-state').textContent = '正在检查整稿的转承、指代、术语与重复';
  render();
  try {
    const status = await refreshStatus({ signal: controller.signal });
    if (controller.signal.aborted || activeRequest?.requestId !== requestId) return;
    const settings = status?.providers?.[selectedProvider];
    if (!settings?.configurationId) { const error = new Error(settings?.message || status?.error || '请先配置润色连接。'); error.code = settings?.code || 'PROVIDER_UNCONFIGURED'; throw error; }
    const prepared = await preparePolishRequest(basis, { requestId, provider: selectedProvider, configurationId: settings.configurationId, instructionVersion: settings.instructionVersion });
    if (controller.signal.aborted || activeRequest?.requestId !== requestId) return;
    commitActiveEditor();
    if (!force && !composing && project === basis && canReusePolishReview(project, prepared)) {
      $('#request-state').textContent = '已有同稿审阅 · 可直接继续，或重新请求';
      $('#reuse-dialog').showModal(); return;
    }
    const response = await api('/api/polish', prepared.payload, { signal: controller.signal, body: prepared.serializedBody });
    if (composing) await new Promise(resolve => document.addEventListener('compositionend', resolve, { once: true }));
    if (controller.signal.aborted || activeRequest?.requestId !== requestId) return;
    if (project.id !== projectId) throw new Error('项目已切换，旧项目的润色结果未应用。');
    const configurationMatches = response.configurationId === prepared.configurationId && response.instructionVersion === prepared.instructionVersion;
    const metadata = { provider: response.provider, model: response.model, elapsedMs: response.elapsedMs, requestId,
      usage: response.usage ?? null, requestBytes: prepared.requestBytes, inputCharacters: prepared.inputCharacters,
      configurationId: response.configurationId || null, instructionVersion: response.instructionVersion || null,
      inputSignature: configurationMatches ? prepared.inputSignature : null };
    const applied = change(p => core.attachReview(p, response.result, revision, metadata));
    if (applied) { reviewTab = true; renderTabs(); $('#request-state').textContent = '修改集已就绪 · 接受后才进入成稿'; toast('整体润色完成，成稿尚未改变'); }
  } catch (error) {
    if (activeRequest?.requestId !== requestId) return;
    if (error.name === 'AbortError') $('#request-state').textContent = '已取消 · 原成稿保留';
    else {
      $('#request-state').textContent = '润色未完成 · 原成稿保留'; toast(error.message, true);
      if (/NOT_CONFIGURED|UNCONFIGURED|NOT_LOGGED|AUTH|KEY|NOT_INSTALLED|PROVIDER/.test(error.code || '')) $('#settings-dialog').showModal();
    }
  } finally { if (activeRequest?.requestId === requestId) { activeRequest = null; render(); } }
}
async function cancelPolish() {
  if (!activeRequest) return;
  const request = activeRequest;
  request.controller.abort();
  activeRequest = null;
  $('#request-state').textContent = '已取消 · 原成稿保留'; render();
  try { await api('/api/cancel', { requestId: request.requestId }); } catch { /* HTTP disconnect also aborts the server request. */ }
}
async function saveFile(kind) {
  document.activeElement?.blur();
  try {
  const title = project.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').slice(0, 80).replace(/[. ]+$/g, '') || 'draft-weave';
  const safeTitle = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(title) ? `draft-${title}` : title;
  const filename = kind === 'recovery' ? 'draft-weave-recovery.json' : `${safeTitle}${kind === 'project' ? '.draftweave.json' : kind === 'current' ? '.current.draftweave.json' : '.md'}`;
  const content = kind === 'recovery' ? unreadableAutosave : kind === 'project' ? core.serializeProject(project) : kind === 'current' ? core.serializeProject(project, { includeHistory: false, compact: true }) : core.exportMarkdown(project);
  if (!content || (kind === 'markdown' && !project.draft.length)) return;
  if (kind === 'current') { downloadRaw(content, filename); toast('应急项目已下载：来源、锁定和审阅已保留，不含撤销历史'); return; }
    const result = await api('/api/export', { filename, content });
    document.querySelectorAll('dialog[open]').forEach(d => d.close());
    $('#export-title').textContent = kind === 'recovery' ? '原始草稿已备份' : kind === 'project' ? '项目已保存' : 'Markdown 已导出';
    $('#export-message').textContent = kind === 'recovery' ? '未做解析或改写。请保留此文件，用于检查和恢复。' : kind === 'project' ? '选择、来源、锁定与审阅记录已一起保存。' : '已按成稿画布顺序写入，未接受的建议不会导出。';
    $('#export-path').textContent = result.path;
    $('#export-download').href = result.downloadUrl;
    $('#export-download').download = filename;
    $('#export-download').textContent = kind === 'recovery' ? '下载原始草稿' : kind === 'project' ? '下载项目文件' : '下载 Markdown';
    $('#export-dialog details').open = false;
    $('#export-dialog').showModal();
    if (kind === 'recovery') {
      // Resume only after a durable file copy exists; failed export keeps the original untouched.
      drafts.backedUp(content);
      unreadableAutosave = null; $('#recovery-banner').hidden = true; persist();
    } else $('#save-state').textContent = kind === 'project' ? '项目文件已保存' : '成稿已导出';
  } catch (error) { toast(error.message, true); }
}
function locateOrigin(id) {
  const block = project.draft.find(b => b.id === id); if (!block) return;
  let slot = visibleSources.indexOf(block.sourceId);
  if (slot < 0) { slot = 1; visibleSources[slot] = block.sourceId; renderSources(); }
  flash(document.getElementById(`source-${slot}-${block.sourceBlockId}`));
}
async function dispatch(action, el) {
  const id = el?.dataset.id, sourceId = el?.dataset.sourceId, blockId = el?.dataset.blockId;
  switch (action) {
    case 'import': $('#source-files').click(); break;
    case 'paste': $('#paste-dialog').showModal(); break;
    case 'open-project': $('#project-file').click(); break;
    case 'save-project': await saveFile('project'); break;
    case 'save-current': await saveFile('current'); break;
    case 'download-input': if (inputRecoveryRaw) downloadRaw(inputRecoveryRaw, 'draft-weave-input-recovery.json'); break;
    case 'export': await saveFile('markdown'); break;
    case 'recover-local': await saveFile('recovery'); break;
    case 'window-drafts': showWindowDrafts(); break;
    case 'promote-window':
      commitActiveEditor();
      if (unreadableAutosave !== null) throw new Error('请先备份无法读取的原始草稿。');
      drafts.promote(core.serializeProject(project), project.title); toast('本稿已设为默认，旧默认稿可从「窗口草稿」恢复'); break;
    case 'restore-window': {
      const copy = drafts.read(copiesShown[Number(id)]?.key);
      if (copy.inputError) showInputRecovery(copy.inputError, copy.inputRecoveryRaw);
      const next = core.deserializeProject(copy.raw);
      commitActiveEditor();
      drafts.archive(core.serializeProject(project), '恢复前的本窗口草稿');
      await cancelPolish();
      project = next; replaceTarget = null; visibleSources = []; reviewTab = false; persist({ replaceInput: true }); render();
      $('#window-dialog').close(); toast('已恢复到本窗口，其他窗口不受影响'); break;
    }
    case 'download-window': {
      const copy = drafts.read(copiesShown[Number(id)]?.key);
      downloadRaw(copy.raw, 'window-draft.draftweave.json');
      if (copy.inputError) showInputRecovery(copy.inputError, copy.inputRecoveryRaw);
      break;
    }
    case 'delete-window': drafts.remove(copiesShown[Number(id)].key); showWindowDrafts(); break;
    case 'undo': change(core.undo, '已撤销上一步'); break;
    case 'samples': {
      change(p => sampleSources.reduce((next, source) => core.addSource(next, core.parseSource(source)), p), '示例稿已放入候选区'); break;
    }
    case 'new': {
      await cancelPolish();
      // Keep a single reversible snapshot so starting a blank project never silently loses work.
      const previous = { ...project }; delete previous.history;
      const next = core.createProject(); next.id = project.id; next.revision = project.revision + 1; next.history = [...project.history, previous].slice(-80);
      project = next; visibleSources = []; replaceTarget = null; reviewTab = false; persist({ replaceInput: true }); render(); toast('已新建空白项目，可撤销恢复'); break;
    }
    case 'select': {
      if (replaceTarget) {
        const target = replaceTarget;
        if (change(p => core.replaceBlock(p, target, sourceId, blockId), '已替换，位置保持不变')) { replaceTarget = null; render(); focusDraft(target); }
      } else {
        const selected = selectedFor(sourceId, blockId);
        const changed = change(p => selected ? core.removeBlock(p, selected.id) : core.selectBlocks(p, sourceId, [blockId]));
        if (changed && !selected) focusDraft(selectedFor(sourceId, blockId)?.id);
      } break;
    }
    case 'complete-section': {
      change(p => core.completeSection(p, sourceId, blockId), '已按原稿顺序补齐，改文与锁定保留；可一次撤销');
      const first = selectedFor(sourceId, blockId); if (first) focusDraft(first.id); break;
    }
    case 'section': {
      change(p => core.selectSection(p, sourceId, blockId), '章节已选入，子段可独立取消');
      const first = selectedFor(sourceId, blockId); if (first) focusDraft(first.id); break;
    }
    case 'first-chapter': {
      const source = project.sources[0];
      const block = source?.blocks.find(b => b.type === 'heading' && b.level === 2) || source?.blocks[0];
      if (block) { change(p => core.selectSection(p, source.id, block.id)); focusDraft(selectedFor(source.id, block.id)?.id); } else $('#source-files').click(); break;
    }
    case 'remove': change(p => core.removeBlock(p, id)); break;
    case 'replace': replaceTarget = replaceTarget === id ? null : id; reviewTab = false; render(); break;
    case 'cancel-replace': replaceTarget = null; render(); break;
    case 'lock': change(p => core.toggleLock(p, id)); break;
    case 'move-up': case 'move-down': {
      const index = project.draft.findIndex(b => b.id === id);
      change(p => core.moveBlock(p, id, index + (action === 'move-up' ? -1 : 1))); focusDraft(id); break;
    }
    case 'origin': locateOrigin(id); break;
    case 'locate-draft': focusDraft(id); break;
    case 'tab-draft': reviewTab = false; renderTabs(); requestAnimationFrame(resizeTextareas); break;
    case 'tab-review': reviewTab = true; renderTabs(); break;
    case 'settings': $('#settings-dialog').showModal(); await refreshStatus(); break;
    case 'refresh-status': await refreshStatus(); break;
    case 'preview': $('#markdown-preview').value = core.exportMarkdown(project); $('#preview-issues').textContent = core.analyzeStructure(project).length ? '结构提示可回画布定位处理' : '按当前画布顺序原样拼接'; $('#preview-dialog').showModal(); break;
    case 'polish': await polish(); break;
    case 'reuse-review': $('#reuse-dialog').close(); reviewTab = true; renderTabs(); break;
    case 'force-polish': $('#reuse-dialog').close(); await polish({ force: true }); break;
    case 'cancel': await cancelPolish(); break;
    case 'accept-next': case 'reject-next': {
      const at = project.review.changes.findIndex(item => item.id === id);
      if (change(p => core.decideChange(p, id, action === 'accept-next' ? 'accept' : 'reject'))) {
        const pending = project.review.changes.slice(at + 1).concat(project.review.changes.slice(0, at)).find(item => item.status === 'pending');
        const card = pending && document.querySelector(`[data-change-id="${pending.id}"]`);
        if (card) { flash(card); card.querySelector('[data-action="accept-next"]')?.focus({ preventScroll: true }); }
        else toast('没有待审阅的建议；保护拦截和过期建议保持原状');
      } break;
    }
    case 'accept': change(p => core.decideChange(p, id, 'accept'), '已接受这一处修改'); break;
    case 'reject': change(p => core.decideChange(p, id, 'reject'), '已拒绝，原文保留'); break;
    case 'import-review': $('#review-file').click(); break;
    case 'close-dialog': el.closest('dialog').close(); break;
  }
}
document.addEventListener('click', event => {
  const button = event.target.closest('[data-action]');
  if (button && !button.disabled) dispatch(button.dataset.action, button).catch(error => toast(error.message, true));
});
document.addEventListener('change', event => {
  const el = event.target;
  if (el.matches('select[data-slot]')) { visibleSources[Number(el.dataset.slot)] = el.value; renderSources(); }
  if (el.id === 'protect-numbers') change(p => core.setProtection(p, { numbers: el.checked }));
  if (el.id === 'protect-quotes') change(p => core.setProtection(p, { quotes: el.checked }));
  if (el.id === 'provider') { provider = el.value; renderProvider(); }
});
// A small per-block journal is synchronous; full checkpoints wait for a pause or a bound.
document.addEventListener('focusout', event => {
  if (!event.target.matches('textarea[data-edit-id]') || composing) return;
  try { commitEditor(event.target); clearCheckpoints(); editSession = null; renderNotices(); renderReview(); $('#undo').disabled = !project.history.length; }
  catch (error) { toast(error.message, true); }
});
document.addEventListener('input', event => {
  if (!event.target.matches('textarea[data-edit-id]')) return;
  event.target.style.height = '0px'; event.target.style.height = `${event.target.scrollHeight + 2}px`;
  checkpointInput(); scheduleCheckpoint();
});
document.addEventListener('compositionstart', event => { if (event.target.matches('textarea[data-edit-id]')) composing = true; });
document.addEventListener('compositionend', event => {
  if (!event.target.matches('textarea[data-edit-id]')) return;
  composing = false; checkpointInput(); scheduleCheckpoint();
  if (deferredRender) { deferredRender = false; render(); }
});
document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !event.target.matches('textarea,input')) { event.preventDefault(); change(core.undo); }
  if (event.key === 'Escape' && replaceTarget) { replaceTarget = null; render(); }
  if (event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key) && event.target.matches('textarea[data-edit-id]')) {
    event.preventDefault(); const id = event.target.dataset.editId; event.target.blur();
    const to = project.draft.findIndex(b => b.id === id) + (event.key === 'ArrowUp' ? -1 : 1);
    if (to >= 0 && to < project.draft.length) { change(p => core.moveBlock(p, id, to)); focusDraft(id); }
  }
});
document.addEventListener('dragstart', event => {
  const handle = event.target.closest('[data-drag-id]');
  if (!handle) return;
  document.activeElement?.blur(); dragging = handle.dataset.dragId;
  event.dataTransfer.setData('text/plain', dragging); event.dataTransfer.effectAllowed = 'move';
  document.getElementById(`draft-${dragging}`)?.classList.add('dragging');
});
document.addEventListener('dragover', event => {
  const target = event.target.closest('[data-draft-id]');
  if (!dragging || !target) return;
  event.preventDefault(); event.dataTransfer.dropEffect = 'move';
  document.querySelectorAll('.drop-before,.drop-after').forEach(el => el.classList.remove('drop-before', 'drop-after'));
  target.classList.add(event.clientY < target.getBoundingClientRect().top + target.clientHeight / 2 ? 'drop-before' : 'drop-after');
});
document.addEventListener('drop', event => {
  const target = event.target.closest('[data-draft-id]');
  if (!dragging || !target) return;
  event.preventDefault();
  const from = project.draft.findIndex(b => b.id === dragging), to = project.draft.findIndex(b => b.id === target.dataset.draftId);
  let insert = to + (target.classList.contains('drop-after') ? 1 : 0);
  if (from < insert) insert--;
  const id = dragging; dragging = null;
  change(p => core.moveBlock(p, id, Math.max(0, Math.min(project.draft.length - 1, insert)))); render(); focusDraft(id);
});
document.addEventListener('dragend', () => { dragging = null; document.querySelectorAll('.drop-before,.drop-after,.dragging').forEach(el => el.classList.remove('drop-before', 'drop-after', 'dragging')); });
$('#paste-form').addEventListener('submit', event => {
  event.preventDefault(); const data = new FormData(event.target);
  if (change(p => core.addSource(p, core.parseSource({ name: data.get('name'), text: data.get('text') })), '文稿已导入')) {
    visibleSources[visibleSources.length ? 1 : 0] = project.sources.at(-1).id; $('#paste-dialog').close(); event.target.reset(); render();
  }
});
$('#source-files').addEventListener('change', async event => {
  const files = [...event.target.files];
  try {
    // Parse every file before mutation: a bad file cannot silently leave a partial import.
    const sources = await Promise.all(files.map(async file => { if (file.size > 2_000_000) throw new Error(`${file.name} 超过 2 MB 导入上限。`); return core.parseSource({ name: file.name, text: await file.text() }); }));
    if (change(p => sources.reduce((next, source) => core.addSource(next, source), p), `已导入 ${sources.length} 份文稿`)) { visibleSources = sources.slice(0, 2).map(s => s.id); render(); }
  } catch (error) { toast(error.message, true); }
  event.target.value = '';
});
$('#project-file').addEventListener('change', async event => {
  const file = event.target.files[0]; if (!file) return;
  try {
    if (file.size > 50_000_000) throw new Error('项目文件超过 50 MB 上限。');
    const next = core.deserializeProject(await file.text());
    await cancelPolish(); project = next; replaceTarget = null; visibleSources = []; reviewTab = false; persist({ replaceInput: true }); render(); toast(/\.current\.draftweave\.json$/i.test(file.name) && !next.history.length ? '项目已恢复：来源、锁定和审阅保留，不含撤销历史' : '项目已恢复，来源和审阅记录完整保留');
  } catch (error) { toast(`打开失败：${error.message} 当前项目未改变。`, true); }
  event.target.value = '';
});
$('#review-file').addEventListener('change', async event => {
  const file = event.target.files[0]; if (!file) return;
  try {
    if (file.size > 2_000_000) throw new Error('修改集超过 2 MB 上限。');
    const result = JSON.parse(await file.text());
    const output = result.result || result;
    core.validatePolishOutput(output);
    await cancelPolish();
    if (change(p => core.attachReview(p, output, p.revision, { provider: 'imported', filename: file.name }), '离线修改集已载入，未经接受的内容不会应用')) { $('#settings-dialog').close(); reviewTab = true; renderTabs(); $('#request-state').textContent = '离线修改集 · 接受后才进入成稿'; }
  } catch (error) { toast(`修改集未载入：${error.message}`, true); }
  event.target.value = '';
});
window.addEventListener('resize', resizeTextareas);
window.addEventListener('beforeunload', () => { checkpointInput(); if (!composing) { commitActiveEditor(); persist(); } });
window.addEventListener('pagehide', () => { checkpointInput(); drafts.stop(); });
window.addEventListener('pageshow', () => drafts.start());
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') { checkpointInput(); if (!composing) flushInput(); } });
let saved = null;
try {
  const stored = drafts.restore();
  saved = stored.shared;
  if (stored.inputError) showInputRecovery(stored.inputError, stored.inputRecoveryRaw);
  project = saved ? core.deserializeProject(saved) : makeSamples();
  if (stored.recovery) {
    try { project = core.deserializeProject(stored.recovery); }
    catch { toast('本窗口副本无法读取，已打开默认稿；原始副本仍可从「窗口草稿」下载。', true); }
  }
  if (saved) $('#save-state').textContent = '已恢复本地草稿';
} catch {
  project = makeSamples();
  unreadableAutosave = saved;
  if (saved !== null) { $('#recovery-banner').hidden = false; $('#save-state').textContent = '自动保存已暂停 · 原始草稿保留'; }
  toast('本地草稿无法读取，原始数据未改动。可先备份原稿，或打开已保存的项目。', true);
}
render(); drafts.start(); if (!inputRecoveryRaw) persist(); refreshStatus();
