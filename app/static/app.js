'use strict';
const $view = document.getElementById('view');
const $bar = document.getElementById('appbar');
const $fab = document.getElementById('fab');
const $overlay = document.getElementById('overlay');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let pollTimer = null;

// ------------------------------------------------------------ 图标（内联 SVG，不依赖外部资源）
const ICONS = {
  back: '<path d="M15 18l-6-6 6-6"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  more: '<circle cx="12" cy="5" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="19" r="1.3" fill="currentColor"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v5h-5"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1"/><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"/>',
  paste: '<rect x="8" y="3" width="8" height="4" rx="1"/><path d="M8 5H6a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>',
  pen: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  logout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l-5-5 5-5M5 12h11"/>',
  open: '<path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>',
  notes: '<rect x="4" y="3" width="16" height="18" rx="3"/><path d="M8 8h8M8 12h8M8 16h5"/>',
};
const icon = (n, cls = 'i') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[n] || ''}</svg>`;

// ------------------------------------------------------------ 通用：提示条、请求
function toast(msg, ms = 2600) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.hidden = true; void t.offsetWidth; t.hidden = false;
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

// ------------------------------------------------------------ 顶部栏
// opts: { title, home, back, close, actions: [{icon, label, onClick, primary, id, disabled}], menu: [...] }
function setBar(opts = {}) {
  const left = opts.home ? '' : `<button class="icon-btn" id="bar-back" aria-label="${opts.close ? '关闭' : '返回'}">${icon(opts.close ? 'close' : 'back')}</button>`;
  const acts = (opts.actions || []).map((a, i) =>
    `<button class="icon-btn ${a.primary ? 'primary' : ''}" data-a="${i}" ${a.id ? `id="${a.id}"` : ''} aria-label="${esc(a.label)}" title="${esc(a.label)}" ${a.disabled ? 'disabled' : ''}>${icon(a.icon)}</button>`).join('');
  const more = opts.menu ? `<button class="icon-btn" id="bar-more" aria-label="更多">${icon('more')}</button>` : '';
  $bar.innerHTML = `${left}<div class="title ${opts.home ? 'home' : ''} ${opts.fadeTitle ? 'fade' : ''}">${esc(opts.title || '')}</div>${acts}${more}`;
  $bar.hidden = !!opts.hidden;
  if (!opts.home) document.getElementById('bar-back').onclick = opts.onBack || goBack;
  $bar.querySelectorAll('[data-a]').forEach(b => b.onclick = ev => opts.actions[+b.dataset.a].onClick(ev));
  if (opts.menu) document.getElementById('bar-more').onclick = ev => openMenu(ev.currentTarget, opts.menu);
  document.title = opts.home ? '知识库' : `${opts.title || ''} · 知识库`;
}

// 应用内导航栈：有上一页就 history.back()，否则（比如从分享直接打开笔记）回首页
const navStack = [location.hash || '#/'];
window.addEventListener('hashchange', () => {
  const h = location.hash || '#/';
  if (navStack.length > 1 && navStack[navStack.length - 2] === h) navStack.pop();
  else if (navStack[navStack.length - 1] !== h) navStack.push(h);
});
function goBack() {
  if (navStack.length > 1) history.back();
  else location.replace('#/');
}

window.addEventListener('scroll', () => $bar.classList.toggle('scrolled', scrollY > 4), { passive: true });

function showFab(on) {
  $fab.hidden = !on; document.body.classList.toggle('no-fab', !on);
}

// ------------------------------------------------------------ 弹层：底部面板、对话框、菜单
let closeLayer = null;
function openLayer(el, onClose) {
  closeAnyLayer();
  $overlay.style.background = '';
  $overlay.hidden = false; document.body.appendChild(el);
  const close = () => { el.remove(); $overlay.hidden = true; closeLayer = null; onClose && onClose(); };
  closeLayer = close; $overlay.onclick = close;
  return close;
}
function closeAnyLayer() { if (closeLayer) closeLayer(); }
window.addEventListener('hashchange', closeAnyLayer);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAnyLayer(); });

function openSheet(title, options) {
  const el = document.createElement('div'); el.className = 'sheet'; el.setAttribute('role', 'dialog');
  el.innerHTML = `<div class="grip"></div>${title ? `<h4>${esc(title)}</h4>` : ''}` + options.map((o, i) =>
    `<button class="sheet-opt ${o.danger ? 'danger' : ''}" data-i="${i}"><span class="ico">${icon(o.icon)}</span>
      <span><b>${esc(o.label)}</b>${o.desc ? `<span>${esc(o.desc)}</span>` : ''}</span></button>`).join('');
  const close = openLayer(el);
  el.querySelectorAll('[data-i]').forEach(b => b.onclick = ev => { close(); options[+b.dataset.i].onClick(ev); });
  return close;
}

function confirmDialog({ title, text = '', ok = '确定', cancel = '取消', danger = false }) {
  return new Promise(resolve => {
    const el = document.createElement('div'); el.className = 'dialog'; el.setAttribute('role', 'alertdialog');
    el.innerHTML = `<h3>${esc(title)}</h3>${text ? `<p>${esc(text)}</p>` : ''}
      <div class="acts"><button class="btn text" data-r="0">${esc(cancel)}</button>
      <button class="btn text ${danger ? 'danger' : ''}" data-r="1">${esc(ok)}</button></div>`;
    let result = false;
    const close = openLayer(el, () => resolve(result));
    el.querySelectorAll('[data-r]').forEach(b => b.onclick = () => { result = b.dataset.r === '1'; close(); });
  });
}

function openMenu(anchor, items) {
  const el = document.createElement('div'); el.className = 'menu'; el.setAttribute('role', 'menu');
  el.innerHTML = items.map((m, i) => `<button data-i="${i}" class="${m.danger ? 'danger' : ''}" ${m.disabled ? 'disabled' : ''}>${icon(m.icon)}${esc(m.label)}</button>`).join('');
  const r = anchor.getBoundingClientRect();
  el.style.top = (r.bottom - 4) + 'px'; el.style.right = Math.max(8, innerWidth - r.right + 4) + 'px';
  const close = openLayer(el);
  $overlay.style.background = 'transparent';
  const restore = () => { $overlay.style.background = ''; };
  el.querySelectorAll('[data-i]').forEach(b => b.onclick = ev => { close(); restore(); items[+b.dataset.i].onClick(ev); });
  $overlay.onclick = () => { close(); restore(); };
}

// ------------------------------------------------------------ 路由
function parseHash() {
  const [path, qs] = location.hash.slice(1).split('?');
  return { parts: (path || '/').split('/').filter(Boolean), params: new URLSearchParams(qs || '') };
}

let lastRouteKey = null, listScroll = 0;
async function route() {
  clearTimeout(pollTimer);
  const { parts, params } = parseHash();
  const key = parts.join('/');
  if (key !== lastRouteKey) {  // 真正换页才做转场和滚动处理（轮询刷新不动）
    if (lastRouteKey === '') listScroll = scrollY;  // 离开首页时记住滚动位置
    lastRouteKey = key;
    $view.classList.remove('page-in'); void $view.offsetWidth; $view.classList.add('page-in');
    scrollTo(0, 0);
  }
  try {
    if (parts[0] === 'login') return viewLogin(params);
    if (parts[0] === 'note') return await viewNote(+parts[1]);
    if (parts[0] === 'edit') return await viewEdit(+parts[1]);
    if (parts[0] === 'new') return await viewEdit(0);
    if (parts[0] === 'capture') return viewCapture();
    return await viewList(params);
  } catch (e) {
    if (e.message !== '请先登录') {
      $view.innerHTML = `<div class="empty">${icon('notes')}${esc(e.message)}</div>`;
    }
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
  setBar({ hidden: true, home: true }); showFab(false);
  $view.innerHTML = `
    <form class="login" id="f">
      <img src="/static/icon-192.png" alt="">
      <h1>知识库</h1>
      <p class="hint">${params.get('pending') ? '分享内容已暂存，登录后会自动保存。' : '收藏、整理、搜索你的阅读'}</p>
      <input type="password" name="password" placeholder="输入密码" autocomplete="current-password" required autofocus>
      <button class="btn block">登录</button>
      <p class="err" id="e"></p>
    </form>`;
  const f = document.getElementById('f');
  f.onsubmit = async ev => {
    ev.preventDefault();
    const done = busy(f.querySelector('button'), '正在登录…');
    try {
      await api('/api/login', { method: 'POST', json: { password: f.password.value } });
      await flushPending();
      $bar.hidden = false; location.hash = '#/';
    } catch (e) { done(); document.getElementById('e').textContent = e.message; }
  };
}

// ------------------------------------------------------------ 列表 + 搜索
let listState = { q: '', tag: '', items: [], offset: 0, more: false, loading: false };

const SOURCES = [[/xiaohongshu|rednote|xhslink/, '小红书', 'xhs'], [/mp\.weixin|weixin\.qq/, '公众号', 'wx'],
  [/zhihu/, '知乎', 'zh'], [/weibo/, '微博', ''], [/bilibili|b23\.tv/, 'B站', ''], [/douyin/, '抖音', ''],
  [/douban/, '豆瓣', ''], [/github/, 'GitHub', '']];
function sourceOf(n) {
  if (!n.source_url) return ['手写', 'me'];
  let host = '';
  try { host = new URL(n.source_url).hostname.replace(/^www\./, ''); } catch { }
  for (const [re, name, cls] of SOURCES) if (re.test(host)) return [name, cls];
  return [host || '网页', ''];
}

function parseTime(s) { return new Date(String(s).replace(' ', 'T') + '+08:00'); }
function relTime(s) {
  const d = parseTime(s), now = new Date(), sec = (now - d) / 1000;
  if (isNaN(sec)) return String(s).slice(0, 10);
  if (sec < 60) return '刚刚';
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟前`;
  const day = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(now) - day(d)) / 86400000);
  if (days === 0) return `${Math.floor(sec / 3600)} 小时前`;
  if (days === 1) return '昨天';
  if (days < 7) return `${days} 天前`;
  return d.getFullYear() === now.getFullYear() ? `${d.getMonth() + 1}月${d.getDate()}日` : String(s).slice(0, 10);
}

function itemHtml(n) {
  const [src, cls] = sourceOf(n);
  const status = n.status === 'processing' ? '<span class="badge"><span class="spinner"></span>整理中</span>'
    : n.status === 'failed' ? '<span class="badge warn">处理失败</span>' : '';
  const thumb = (n.thumb || '').match(/^\/media\/[^)\s]+/);
  const text = n.summary || (n.excerpt || '').replace(/!\[[^\]]*\]\([^)]*\)|\[([^\]]*)\]\([^)]*\)|[#>*`_-]/g, '$1').trim();
  const tags = n.tags ? n.tags.split(' ').filter(Boolean).slice(0, 3).map(t => `<span class="t">#${esc(t)}</span>`).join('') : '';
  return `<a class="item" href="#/note/${n.id}">
    <div class="body">
      <h3>${esc(n.title || '未命名')}</h3>
      ${text ? `<p>${esc(text)}</p>` : ''}
      <div class="meta">${status}<span class="src ${cls}">${esc(src)}</span><span>${relTime(n.updated_at)}</span>${tags}</div>
    </div>
    ${thumb ? `<img class="thumb" src="${esc(thumb[0])}" alt="" loading="lazy">` : ''}
  </a>`;
}

const skeleton = () => Array(4).fill('<div class="skel"><i></i><i></i><i></i></div>').join('');

async function viewList(params) {
  setBar({
    home: true, title: '知识库',
    menu: [
      { icon: 'download', label: '导出备份', onClick: () => { toast('正在打包备份，稍候开始下载…'); location.href = '/api/export'; } },
      { icon: 'logout', label: '退出登录', onClick: logout },
    ],
  });
  showFab(true);
  if (params.get('pending')) { await flushPending(); history.replaceState(null, '', '#/'); }
  $view.innerHTML = `
    <div class="ptr" id="ptr"><span class="spinner"></span></div>
    <div class="searchwrap">
      <div class="search">${icon('search')}
        <input id="q" type="search" placeholder="搜索标题、正文、#标签" value="${esc(listState.q)}" enterkeyhint="search">
        <button class="icon-btn clear" id="qc" aria-label="清除" ${listState.q ? '' : 'hidden'}>${icon('close')}</button>
      </div>
      <div class="chips" id="tags"></div>
    </div>
    <div id="clipbar" hidden></div>
    <div class="list" id="list">${listState.items.length ? listState.items.map(itemHtml).join('') : skeleton()}</div>
    <div class="loadmore" id="more" hidden></div>`;
  const q = document.getElementById('q'), qc = document.getElementById('qc');
  let deb;
  q.oninput = () => {
    qc.hidden = !q.value;
    clearTimeout(deb); deb = setTimeout(() => { listState.q = q.value.trim(); loadList(true); }, 250);
  };
  q.onkeydown = e => { if (e.key === 'Enter') q.blur(); };
  qc.onclick = () => { q.value = ''; qc.hidden = true; listState.q = ''; loadList(true); };
  // 滚到底自动加载更多
  const io = new IntersectionObserver(es => { if (es[0].isIntersecting && listState.more) loadList(false); }, { rootMargin: '300px' });
  io.observe(document.getElementById('more'));
  setupPullToRefresh();
  checkClipboard();
  const restore = listScroll; listScroll = 0;
  if (restore) scrollTo(0, restore);
  await loadList(true);
  if (restore) scrollTo(0, restore);
}

async function loadList(reset) {
  if (listState.loading && !reset) return;
  listState.loading = true;
  try {
    if (reset) listState.offset = 0;
    const p = new URLSearchParams({ q: listState.q, tag: listState.tag, offset: listState.offset });
    const data = await api('/api/notes?' + p);
    const list = document.getElementById('list');
    if (!list) return;
    if (reset) {
      listState.items = data.items;
      const tags = document.getElementById('tags');
      tags.innerHTML = data.tags.length ? `<button class="chip ${listState.tag ? '' : 'on'}" data-t="">全部</button>` +
        data.tags.map(([t, c]) => `<button class="chip ${t === listState.tag ? 'on' : ''}" data-t="${esc(t)}">${esc(t)} <small>${c}</small></button>`).join('') : '';
      tags.querySelectorAll('.chip').forEach(el => el.onclick = () => {
        listState.tag = listState.tag === el.dataset.t ? '' : el.dataset.t; loadList(true);
      });
    } else listState.items = listState.items.concat(data.items);
    listState.offset += data.items.length;
    listState.more = data.items.length >= 30;
    list.innerHTML = listState.items.length ? listState.items.map(itemHtml).join('')
      : `<div class="empty">${icon('notes')}${listState.q || listState.tag ? '没有找到相关笔记'
        : '还没有笔记<br>点右下角 ＋ 粘贴链接、上传截图或写一篇'}</div>`;
    const more = document.getElementById('more');
    more.hidden = !listState.more; more.innerHTML = '<span class="spinner"></span>';
    clearTimeout(pollTimer);
    if (listState.items.some(n => n.status === 'processing')) pollTimer = setTimeout(() => loadList(true), 4000);
  } finally { listState.loading = false; }
}

function setupPullToRefresh() {
  const ptr = document.getElementById('ptr');
  let y0 = null, dy = 0;
  const start = e => { y0 = scrollY <= 0 && !closeLayer ? e.touches[0].clientY : null; dy = 0; };
  const move = e => {
    if (y0 === null) return;
    dy = Math.max(0, e.touches[0].clientY - y0);
    if (dy > 0 && ptr.isConnected) ptr.style.height = Math.min(70, dy * 0.45) + 'px';
  };
  const end = async () => {
    if (y0 === null || !ptr.isConnected) return;
    y0 = null;
    if (dy * 0.45 >= 56) {
      ptr.style.height = '48px';
      try { await loadList(true); } catch (e) { toast(e.message); }
    }
    ptr.style.transition = 'height .2s'; ptr.style.height = '0';
    setTimeout(() => { ptr.style.transition = ''; }, 220);
  };
  // 只绑一次：路由切换后 ptr 元素不存在时自动忽略
  if (!setupPullToRefresh.bound) {
    setupPullToRefresh.bound = true;
    addEventListener('touchstart', e => setupPullToRefresh.h?.start(e), { passive: true });
    addEventListener('touchmove', e => setupPullToRefresh.h?.move(e), { passive: true });
    addEventListener('touchend', () => setupPullToRefresh.h?.end());
  }
  setupPullToRefresh.h = { start, move, end };
}

async function logout() {
  if (!await confirmDialog({ title: '退出登录？', text: '退出后需要重新输入密码。', ok: '退出' })) return;
  await api('/api/logout', { method: 'POST' }).catch(() => { });
  location.hash = '#/login';
}

// ------------------------------------------------------------ 新建：悬浮按钮 + 底部面板
$fab.innerHTML = icon('plus');
$fab.onclick = () => openSheet('新建', [
  { icon: 'paste', label: '粘贴链接收藏', desc: '小红书、公众号等「复制链接」后点这里', onClick: pasteAndSave },
  { icon: 'image', label: '上传截图', desc: '抓不到正文时用，会自动识别文字', onClick: pickScreenshots },
  { icon: 'pen', label: '写笔记', desc: '支持 Markdown 和插图', onClick: () => { location.hash = '#/new'; } },
]);

function pickScreenshots() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/*'; inp.multiple = true;
  inp.onchange = async () => {
    if (!inp.files.length) return;
    const fd = new FormData();
    for (const f of inp.files) fd.append('files', f);
    toast(`正在上传 ${inp.files.length} 张截图…`, 10000);
    try {
      const { id } = await api('/api/capture', { method: 'POST', body: fd });
      toast('已收到，正在后台识别和整理');
      location.hash = '#/note/' + id;
    } catch (e) { toast(e.message); }
  };
  inp.click();
}

// ------------------------------------------------------------ 剪贴板收藏（小红书等不走系统分享的 App）
const LAST_CLIP = 'kb-last-clip';
const lsGet = k => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { } };
const hasUrl = t => /https?:\/\/\S+/.test(t || '');

// 按钮进入「正在保存」状态，返回恢复函数
function busy(btn, label = '正在保存…') {
  if (!btn) return () => { };
  const old = btn.innerHTML; btn.disabled = true; btn.innerHTML = `<span class="spinner"></span>${label}`;
  return () => { btn.disabled = false; btn.innerHTML = old; };
}

async function saveText(text, btn) {
  const done = busy(btn);
  if (!btn) toast('正在保存…', 10000);
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
  if (text === lsGet(LAST_CLIP) && !await confirmDialog({ title: '这条已经收藏过了', text: '要再保存一次吗？', ok: '再存一次' })) return;
  try { await saveText(text); } catch (e) { toast(e.message); }
}

// 打开应用时：如果已授权读剪贴板且里面有新链接，列表顶部提示一键收藏
async function checkClipboard() {
  const bar = document.getElementById('clipbar');
  if (!bar || !navigator.clipboard || !navigator.permissions) return;
  try {
    const p = await navigator.permissions.query({ name: 'clipboard-read' });
    if (p.state !== 'granted') return;
    const text = (await navigator.clipboard.readText()).trim();
    if (!hasUrl(text) || text === lsGet(LAST_CLIP)) return;
    const url = text.match(/https?:\/\/\S+/)[0];
    bar.className = 'clipcard';
    bar.innerHTML = `${icon('link')}<div class="txt"><b>剪贴板里有链接</b><span>${esc(url)}</span></div>
      <button class="btn" id="cb-save">收藏</button><button class="icon-btn" id="cb-no" aria-label="忽略">${icon('close')}</button>`;
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
      '比平时慢，可能是图片较多或网站响应慢，请再稍等；超过几分钟还没好，可以点右上角 ⋮ →「重新整理」。';
  };
  tick(); elapsedTimer = setInterval(tick, 1000);
}

async function viewNote(id) {
  const n = await api('/api/notes/' + id);
  const processing = n.status === 'processing';
  if (!processing) delete procStart[id];
  const [src, cls] = sourceOf(n);
  setBar({
    title: n.title || '未命名', fadeTitle: true,
    actions: [{ icon: 'edit', label: '编辑', onClick: () => { location.hash = '#/edit/' + id; } }],
    menu: [
      { icon: 'refresh', label: '重新整理', disabled: processing, onClick: async () => {
        if (!await confirmDialog({ title: '重新整理？', text: '会重新抓取原文并用 AI 整理，当前内容会被覆盖。', ok: '重新整理' })) return;
        await api(`/api/notes/${id}/reprocess`, { method: 'POST' }); route();
      } },
      { icon: 'copy', label: '复制 Markdown', onClick: async () => {
        try { await navigator.clipboard.writeText(`# ${n.title}\n\n${n.content}`); toast('已复制到剪贴板'); }
        catch { toast('复制失败'); }
      } },
      ...(n.source_url ? [{ icon: 'open', label: '打开原文', onClick: () => window.open(n.source_url, '_blank', 'noopener') }] : []),
      { icon: 'trash', label: '删除', danger: true, onClick: async () => {
        if (!await confirmDialog({ title: '删除这条笔记？', text: '删除后无法恢复。', ok: '删除', danger: true })) return;
        await api('/api/notes/' + id, { method: 'DELETE' }); toast('已删除'); location.hash = '#/';
      } },
    ],
  });
  showFab(false);
  $view.innerHTML = `
    <article class="note">
      ${processing ? processingBox(id, n.stage) : ''}
      <h1>${esc(n.title || '未命名')}</h1>
      <div class="meta">
        <span class="src ${cls}">${esc(src)}</span>
        ${n.author ? `<span>${esc(n.author)}</span>` : ''}
        <span>${relTime(n.created_at)}</span>
        ${n.source_url ? `<a href="${esc(n.source_url)}" target="_blank" rel="noopener">${icon('link')}原文链接</a>` : ''}
      </div>
      ${n.error ? `<p class="err">${esc(n.error)}</p>` : ''}
      ${n.summary ? `<div class="summary"><b>AI 摘要</b>${esc(n.summary)}</div>` : ''}
      <div class="md">${n.html}</div>
      ${n.tags ? `<div class="tagrow">${n.tags.split(' ').filter(Boolean).map(t => `<button class="chip" data-t="${esc(t)}">#${esc(t)}</button>`).join('')}</div>` : ''}
    </article>`;
  document.querySelectorAll('.tagrow .chip').forEach(el => el.onclick = () => {
    listState.tag = el.dataset.t; listState.q = ''; location.hash = '#/';
  });
  if (processing) { tickElapsed(id); pollTimer = setTimeout(route, 3000); }
}

// ------------------------------------------------------------ 编辑
async function viewEdit(id) {
  const n = id ? await api('/api/notes/' + id) : { title: '', tags: '', content: '' };
  showFab(false);
  $view.innerHTML = `
    <form class="editor-page" id="f">
      <input class="ttl" name="title" placeholder="标题" value="${esc(n.title)}" autocomplete="off">
      <input class="tags-in" name="tags" placeholder="# 标签，用空格分隔" value="${esc(n.tags)}" autocomplete="off">
      <textarea class="editor" name="content" placeholder="开始写…（支持 Markdown）">${esc(n.content)}</textarea>
      <div class="md" id="preview" hidden></div>
    </form>
    <div class="toolbar">
      <label class="icon-btn" title="插入图片" aria-label="插入图片">${icon('image')}<input type="file" accept="image/*" id="img" multiple></label>
      <button type="button" class="icon-btn" id="pv" title="预览" aria-label="预览">${icon('eye')}</button>
      <span class="hint" id="tbh">支持 Markdown</span>
    </div>`;
  const f = document.getElementById('f');
  const ta = f.content, pv = document.getElementById('preview');
  const original = JSON.stringify([n.title, n.tags, n.content]);
  const dirty = () => JSON.stringify([f.title.value, f.tags.value, ta.value]) !== original;
  const save = async ev => {
    const done = busy(ev?.currentTarget?.tagName === 'BUTTON' ? ev.currentTarget : null, '');
    try {
      const body = { title: f.title.value, tags: f.tags.value, content: ta.value };
      const r = id ? await api('/api/notes/' + id, { method: 'PUT', json: body })
        : await api('/api/notes', { method: 'POST', json: body });
      toast('已保存'); navStack.pop(); location.replace('#/note/' + r.id);
    } catch (e) { done(); toast(e.message); }
  };
  setBar({
    close: true, title: id ? '编辑笔记' : '写笔记',
    onBack: async () => {
      if (dirty() && !await confirmDialog({ title: '放弃修改？', text: '还没保存的内容会丢失。', ok: '放弃', danger: true })) return;
      goBack();
    },
    actions: [{ icon: 'check', label: '保存', primary: true, onClick: save }],
  });
  f.onsubmit = ev => { ev.preventDefault(); save(); };
  document.getElementById('img').onchange = async ev => {
    const hint = document.getElementById('tbh');
    for (const file of ev.target.files) {
      hint.innerHTML = '<span class="spinner"></span> 正在上传图片…';
      const fd = new FormData(); fd.append('file', file);
      try {
        const { url } = await api('/api/media', { method: 'POST', body: fd });
        const pos = ta.selectionStart, ins = `\n![](${url})\n`;
        ta.value = ta.value.slice(0, pos) + ins + ta.value.slice(pos);
      } catch (e) { toast(e.message); }
    }
    hint.textContent = '支持 Markdown';
    ev.target.value = '';
  };
  document.getElementById('pv').onclick = async ev => {
    const b = ev.currentTarget;
    if (pv.hidden) {
      pv.innerHTML = (await api('/api/render', { method: 'POST', json: { content: ta.value } })).html;
      pv.hidden = false; ta.hidden = true; b.classList.add('on');
    } else { pv.hidden = true; ta.hidden = false; b.classList.remove('on'); }
  };
  if (!id) f.title.focus();
}

// ------------------------------------------------------------ 收藏（手动粘贴 / 上传截图）
function viewCapture() {
  setBar({ title: '收藏' }); showFab(false);
  $view.innerHTML = `
    <form class="form" id="f">
      <div class="card">
        <h3>${icon('link')}粘贴链接</h3>
        <p class="hint">小红书、公众号、网页都行，带分享文字也没关系</p>
        <textarea name="text" rows="4" placeholder="长按这里粘贴，例如 http://xhslink.com/..."></textarea>
      </div>
      <div class="card">
        <h3>${icon('image')}或者上传截图</h3>
        <p class="hint">抓不到正文（比如知乎）时用这个，会自动识别图片里的文字</p>
        <label class="drop">${icon('image')}点这里选择图片<input type="file" name="files" accept="image/*" multiple></label>
        <div class="thumbs" id="th"></div>
      </div>
      <button class="btn block">保存并整理</button>
      <p class="hint" style="text-align:center">保存后会在后台抓取、识别并用 AI 整理成笔记</p>
    </form>`;
  const f = document.getElementById('f');
  f.files.onchange = () => {
    document.getElementById('th').innerHTML = [...f.files.files].map(x => `<img src="${URL.createObjectURL(x)}" alt="">`).join('');
  };
  f.onsubmit = async ev => {
    ev.preventDefault();
    if (!f.text.value.trim() && !f.files.files.length) { toast('先粘贴链接或选择截图'); return; }
    const done = busy(f.querySelector('.btn.block'), f.files.files.length ? '正在上传…' : '正在保存…');
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
