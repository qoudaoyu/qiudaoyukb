'use strict';
const $view = document.getElementById('view');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let pollTimer = null;

function toast(msg, ms = 2500) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
}

async function api(path, opts = {}) {
  const o = { credentials: 'same-origin', ...opts };
  if (o.json !== undefined) {
    o.body = JSON.stringify(o.json); o.headers = { 'Content-Type': 'application/json' }; delete o.json;
  }
  const r = await fetch(path, o);
  if (r.status === 401 && !path.startsWith('/api/login')) { location.hash = '#/login'; throw new Error('请先登录'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.detail || ('请求失败 ' + r.status));
  return data;
}

function parseHash() {
  const [path, qs] = location.hash.slice(1).split('?');
  return { parts: (path || '/').split('/').filter(Boolean), params: new URLSearchParams(qs || '') };
}

async function route() {
  clearTimeout(pollTimer);
  const { parts, params } = parseHash();
  try {
    if (parts[0] === 'login') return viewLogin(params);
    if (parts[0] === 'note') return await viewNote(+parts[1]);
    if (parts[0] === 'edit') return await viewEdit(+parts[1]);
    if (parts[0] === 'new') return await viewEdit(0);
    if (parts[0] === 'capture') return viewCapture();
    return await viewList(params);
  } catch (e) {
    if (e.message !== '请先登录') $view.innerHTML = `<p class="err">${esc(e.message)}</p>`;
  }
}

// ------------------------------------------------------------ 暂存的分享（离线/未登录时）
async function flushPending() {
  if (!('caches' in window)) return 0;
  const c = await caches.open('kb-pending');
  let n = 0;
  for (const req of await c.keys()) {
    const res = await c.match(req);
    try {
      const fd = await res.formData();
      const r = await fetch('/api/capture', { method: 'POST', body: fd, credentials: 'same-origin' });
      if (r.ok) { await c.delete(req); n++; }
      else if (r.status === 400) await c.delete(req);
    } catch (e) { break; }
  }
  if (n) toast(`已提交 ${n} 条之前暂存的分享`);
  return n;
}

// ------------------------------------------------------------ 登录
function viewLogin(params) {
  $view.innerHTML = `
    <form class="login form" id="f">
      <h2>登录</h2>
      ${params.get('pending') ? '<p class="hint">分享内容已暂存，登录后会自动保存。</p>' : ''}
      <input type="password" name="password" placeholder="密码" autocomplete="current-password" required autofocus>
      <button class="btn">登录</button>
      <p class="err" id="e"></p>
    </form>`;
  document.getElementById('f').onsubmit = async ev => {
    ev.preventDefault();
    try {
      await api('/api/login', { method: 'POST', json: { password: ev.target.password.value } });
      await flushPending();
      location.hash = '#/';
    } catch (e) { document.getElementById('e').textContent = e.message; }
  };
}

// ------------------------------------------------------------ 列表 + 搜索
let listState = { q: '', tag: '', items: [], offset: 0 };

function itemHtml(n) {
  const status = n.status === 'processing' ? '<span class="badge"><span class="spinner"></span>整理中…</span>'
    : n.status === 'failed' ? '<span class="badge warn">处理失败</span>' : '';
  const host = n.source_url ? (() => { try { return new URL(n.source_url).hostname.replace(/^www\./, ''); } catch { return ''; } })() : '';
  return `<a class="item" href="#/note/${n.id}">
    <h3>${esc(n.title || '未命名')}</h3>
    <p>${esc(n.summary || n.excerpt.replace(/!\[[^\]]*\]\([^)]*\)|[#>*`]/g, ''))}</p>
    <div class="meta">${status}<span>${esc(n.updated_at.slice(0, 10))}</span>${host ? `<span>${esc(host)}</span>` : ''}
      ${n.tags ? n.tags.split(' ').map(t => `<span>#${esc(t)}</span>`).join('') : ''}</div></a>`;
}

async function viewList(params) {
  if (params.get('pending')) { await flushPending(); history.replaceState(null, '', '#/'); }
  listState.offset = 0;
  $view.innerHTML = `
    <div class="clipbar" id="clipbar" hidden></div>
    <button class="btn paste" id="paste">📋 粘贴链接收藏</button>
    <input class="search" id="q" type="search" placeholder="搜索标题、正文、标签（#标签）" value="${esc(listState.q)}">
    <div class="tags" id="tags"></div>
    <div class="list" id="list"></div>
    <button class="btn ghost more" id="more" hidden>加载更多</button>`;
  const q = document.getElementById('q');
  let deb;
  q.oninput = () => { clearTimeout(deb); deb = setTimeout(() => { listState.q = q.value.trim(); loadList(true); }, 250); };
  document.getElementById('more').onclick = () => loadList(false);
  document.getElementById('paste').onclick = pasteAndSave;
  checkClipboard();
  await loadList(true);
}

async function loadList(reset) {
  if (reset) listState.offset = 0;
  const p = new URLSearchParams({ q: listState.q, tag: listState.tag, offset: listState.offset });
  const data = await api('/api/notes?' + p);
  const list = document.getElementById('list');
  if (!list) return;
  if (reset) {
    listState.items = data.items;
    const tags = document.getElementById('tags');
    tags.innerHTML = data.tags.map(([t, c]) =>
      `<span class="tag ${t === listState.tag ? 'on' : ''}" data-t="${esc(t)}">${esc(t)} ${c}</span>`).join('');
    tags.querySelectorAll('.tag').forEach(el => el.onclick = () => {
      listState.tag = listState.tag === el.dataset.t ? '' : el.dataset.t; loadList(true);
    });
  } else listState.items = listState.items.concat(data.items);
  listState.offset += data.items.length;
  list.innerHTML = listState.items.length ? listState.items.map(itemHtml).join('')
    : `<div class="empty">${listState.q || listState.tag ? '没有找到相关笔记' : '还没有笔记。<br>在其他 App 里点「分享」→ 选择「知识库」，或者点右上角＋收藏。'}</div>`;
  document.getElementById('more').hidden = data.items.length < 30;
  if (reset && listState.items.some(n => n.status === 'processing'))
    pollTimer = setTimeout(() => loadList(true), 4000);
}

// ------------------------------------------------------------ 剪贴板收藏（小红书等不走系统分享的 App）
const LAST_CLIP = 'kb-last-clip';
const lsGet = k => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { } };
const hasUrl = t => /https?:\/\/\S+/.test(t || '');

// 按钮进入「提交中」状态，返回恢复函数
function busy(btn, label = '正在保存…') {
  if (!btn) return () => { };
  const old = btn.innerHTML; btn.disabled = true; btn.innerHTML = `<span class="spinner"></span>${label}`;
  return () => { btn.disabled = false; btn.innerHTML = old; };
}

async function saveText(text, btn) {
  const done = busy(btn);
  try {
    const fd = new FormData(); fd.append('text', text);
    const { id } = await api('/api/capture', { method: 'POST', body: fd });
    lsSet(LAST_CLIP, text.trim());
    toast('已收到，正在后台整理');
    location.hash = '#/note/' + id;
  } catch (e) { done(); throw e; }
}

async function pasteAndSave() {
  let text = '';
  try { text = (await navigator.clipboard.readText()).trim(); }
  catch { toast('无法读取剪贴板，请在输入框里长按粘贴'); location.hash = '#/capture'; return; }
  if (!text) { toast('剪贴板是空的，先去 App 里「复制链接」'); return; }
  if (text === lsGet(LAST_CLIP) && !confirm('这条已经收藏过了，再存一次？')) return;
  try { await saveText(text, document.getElementById('paste')); } catch (e) { toast(e.message); }
}

// 打开应用时：如果已授权读剪贴板且里面有新链接，顶部提示一键收藏
async function checkClipboard() {
  const bar = document.getElementById('clipbar');
  if (!bar || !navigator.clipboard || !navigator.permissions) return;
  try {
    const p = await navigator.permissions.query({ name: 'clipboard-read' });
    if (p.state !== 'granted') return;
    const text = (await navigator.clipboard.readText()).trim();
    if (!hasUrl(text) || text === lsGet(LAST_CLIP)) return;
    const url = text.match(/https?:\/\/\S+/)[0];
    bar.innerHTML = `<span>剪贴板里有链接：${esc(url.slice(0, 40))}${url.length > 40 ? '…' : ''}</span>
      <span class="row"><button class="btn" id="cb-save">收藏</button><button class="btn ghost" id="cb-no">忽略</button></span>`;
    bar.hidden = false;
    document.getElementById('cb-save').onclick = async ev => { try { await saveText(text, ev.currentTarget); } catch (e) { toast(e.message); } };
    document.getElementById('cb-no').onclick = () => { lsSet(LAST_CLIP, text); bar.hidden = true; };
  } catch { }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && document.getElementById('clipbar')) checkClipboard();
});

// ------------------------------------------------------------ 阅读
const procStart = {};  // 笔记 id -> 本页第一次看到「整理中」的时间
let elapsedTimer;

const STAGES = ['抓取正文', '识别图片文字', 'AI 整理'];

function processingBox(id, stage) {
  procStart[id] = procStart[id] || Date.now();
  const cur = STAGES.indexOf(stage);
  const steps = STAGES.map((s, i) => `<span class="${i === cur ? 'on' : i < cur ? 'done' : ''}">${s}</span>`).join(' → ');
  return `<div class="processing">
      <span class="spinner big"></span>
      <div>
        <b>正在整理，通常需要 10 秒到 1 分钟 · <span id="elapsed"></span></b>
        <div class="steps">${steps}</div>
        <div class="hint" id="proc-hint">完成后页面会自动刷新，也可以先返回去做别的。</div>
      </div>
    </div>`;
}

function tickElapsed(id) {
  clearInterval(elapsedTimer);
  const tick = () => {
    const el = document.getElementById('elapsed');
    if (!el) return clearInterval(elapsedTimer);
    const s = Math.round((Date.now() - procStart[id]) / 1000);
    el.textContent = `已用 ${s} 秒`;
    if (s > 90) document.getElementById('proc-hint').textContent =
      '比平时慢，可能是图片较多或网站响应慢，请再稍等；超过几分钟还没好，可以返回后点「重新整理」。';
  };
  tick(); elapsedTimer = setInterval(tick, 1000);
}

async function viewNote(id) {
  const n = await api('/api/notes/' + id);
  const processing = n.status === 'processing';
  if (!processing) delete procStart[id];
  $view.innerHTML = `
    <article class="note">
      ${processing ? processingBox(id, n.stage) : ''}
      <h1>${esc(n.title || '未命名')}</h1>
      <div class="meta">
        ${n.author ? `<span>${esc(n.author)}</span>` : ''}
        <span>${esc(n.created_at.slice(0, 16))}</span>
        ${n.source_url ? `<a href="${esc(n.source_url)}" target="_blank" rel="noopener">原文链接</a>` : ''}
      </div>
      ${n.tags ? `<div class="tags">${n.tags.split(' ').map(t => `<a class="tag" href="#/?">${esc(t)}</a>`).join('')}</div>` : ''}
      ${n.error ? `<p class="err">${esc(n.error)}</p>` : ''}
      ${n.summary ? `<div class="summary">${esc(n.summary)}</div>` : ''}
      <div class="md">${n.html}</div>
      <div class="actions">
        <a class="btn" href="#/edit/${n.id}">编辑</a>
        <button class="btn ghost" id="re" ${processing ? 'disabled' : ''}>重新整理</button>
        <button class="btn ghost" id="cp">复制 Markdown</button>
        <button class="btn danger" id="del">删除</button>
      </div>
    </article>`;
  document.querySelectorAll('.note .tag').forEach(el => el.onclick = ev => {
    ev.preventDefault(); listState.tag = el.textContent; listState.q = ''; location.hash = '#/';
  });
  document.getElementById('re').onclick = async () => {
    if (!confirm('重新抓取并用 AI 整理？当前内容会被覆盖。')) return;
    await api(`/api/notes/${id}/reprocess`, { method: 'POST' }); route();
  };
  document.getElementById('cp').onclick = async () => {
    try { await navigator.clipboard.writeText(`# ${n.title}\n\n${n.content}`); toast('已复制'); }
    catch { toast('复制失败'); }
  };
  document.getElementById('del').onclick = async () => {
    if (!confirm('确定删除这条笔记？')) return;
    await api('/api/notes/' + id, { method: 'DELETE' }); toast('已删除'); location.hash = '#/';
  };
  if (processing) { tickElapsed(id); pollTimer = setTimeout(route, 3000); }
}

// ------------------------------------------------------------ 编辑
async function viewEdit(id) {
  const n = id ? await api('/api/notes/' + id) : { title: '', tags: '', content: '' };
  $view.innerHTML = `
    <form class="form" id="f">
      <input name="title" placeholder="标题（留空则取第一行）" value="${esc(n.title)}">
      <input name="tags" placeholder="标签，用空格分隔" value="${esc(n.tags)}">
      <div class="row">
        <label class="btn ghost">插入图片<input type="file" accept="image/*" id="img" hidden multiple></label>
        <button type="button" class="btn ghost" id="pv">预览</button>
        <span class="hint">支持 Markdown</span>
      </div>
      <textarea class="editor" name="content" placeholder="开始写…">${esc(n.content)}</textarea>
      <div class="md" id="preview" hidden></div>
      <div class="row"><button class="btn">保存</button>
        <a class="btn ghost" href="${id ? '#/note/' + id : '#/'}">取消</a></div>
    </form>`;
  const f = document.getElementById('f');
  const ta = f.content, pv = document.getElementById('preview');
  document.getElementById('img').onchange = async ev => {
    for (const file of ev.target.files) {
      const fd = new FormData(); fd.append('file', file);
      try {
        const { url } = await api('/api/media', { method: 'POST', body: fd });
        const pos = ta.selectionStart, ins = `\n![](${url})\n`;
        ta.value = ta.value.slice(0, pos) + ins + ta.value.slice(pos);
      } catch (e) { toast(e.message); }
    }
    ev.target.value = '';
  };
  document.getElementById('pv').onclick = async ev => {
    if (pv.hidden) {
      pv.innerHTML = (await api('/api/render', { method: 'POST', json: { content: ta.value } })).html;
      pv.hidden = false; ta.hidden = true; ev.target.textContent = '继续编辑';
    } else { pv.hidden = true; ta.hidden = false; ev.target.textContent = '预览'; }
  };
  f.onsubmit = async ev => {
    ev.preventDefault();
    const body = { title: f.title.value, tags: f.tags.value, content: ta.value };
    const r = id ? await api('/api/notes/' + id, { method: 'PUT', json: body })
      : await api('/api/notes', { method: 'POST', json: body });
    toast('已保存'); location.hash = '#/note/' + r.id;
  };
}

// ------------------------------------------------------------ 收藏（手动粘贴）
function viewCapture() {
  $view.innerHTML = `
    <form class="form" id="f">
      <h2>收藏</h2>
      <label>粘贴链接或分享文字（小红书、公众号、网页都行）</label>
      <textarea name="text" rows="5" placeholder="例如：xxx 发布了一篇小红书笔记 http://xhslink.com/..."></textarea>
      <label>或者上传截图（抓不到正文时用这个，会自动识别文字）</label>
      <input type="file" name="files" accept="image/*" multiple>
      <div class="thumbs" id="th"></div>
      <button class="btn">保存并整理</button>
      <p class="hint">保存后会在后台抓取正文和图片，并用 AI 整理成 Markdown、生成摘要和标签。</p>
    </form>`;
  const f = document.getElementById('f');
  f.files.onchange = () => {
    document.getElementById('th').innerHTML = [...f.files.files].map(x => `<img src="${URL.createObjectURL(x)}">`).join('');
  };
  f.onsubmit = async ev => {
    ev.preventDefault();
    const done = busy(f.querySelector('button'), f.files.files.length ? '正在上传…' : '正在保存…');
    try {
      const { id } = await api('/api/capture', { method: 'POST', body: new FormData(f) });
      if (f.text.value.trim()) lsSet(LAST_CLIP, f.text.value.trim());
      toast('已收到，正在后台整理');
      location.hash = '#/note/' + id;
    } catch (e) { toast(e.message); done(); }
  };
}

// ------------------------------------------------------------ 启动
window.addEventListener('hashchange', route);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
(async () => {
  const me = await api('/api/me').catch(() => ({ logged_in: false }));
  if (!me.logged_in && !location.hash.startsWith('#/login')) location.hash = '#/login';
  else { if (me.logged_in) flushPending(); route(); }
})();
