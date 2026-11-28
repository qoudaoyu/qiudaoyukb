// Service Worker：缓存外壳、接管安卓「分享到」、离线/未登录时把分享暂存起来
const SHELL_CACHE = 'kb-shell-v8';
const MEDIA_CACHE = 'kb-media-v1';
const PENDING_CACHE = 'kb-pending';
const SHELL = ['/', '/static/app.js', '/static/style.css', '/static/manifest.webmanifest', '/static/icon-192.png'];

self.addEventListener('install', e => {
  // cache: 'reload'：安装时绕过浏览器的 HTTP 缓存，确保存进来的是服务器上的最新文件
  e.waitUntil(caches.open(SHELL_CACHE)
    .then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys())
      if (![SHELL_CACHE, MEDIA_CACHE, PENDING_CACHE].includes(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

async function stash(fd) {
  const c = await caches.open(PENDING_CACHE);
  await c.put(new Request('/__pending/' + Date.now()), new Response(fd));
}

async function handleShare(req) {
  const fd = await req.formData();
  try {
    const r = await fetch('/api/capture', { method: 'POST', body: fd, credentials: 'same-origin' });
    if (r.ok) {
      const { id } = await r.json();
      return Response.redirect('/#/note/' + id, 303);
    }
    if (r.status === 401) { await stash(fd); return Response.redirect('/#/login?pending=1', 303); }
    await stash(fd);
    return Response.redirect('/#/?pending=1', 303);
  } catch (e) {
    await stash(fd); // 离线：先存着，下次打开应用时自动提交
    return Response.redirect('/#/?pending=1', 303);
  }
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  if (e.request.method === 'POST' && url.pathname === '/share') {
    e.respondWith(handleShare(e.request));
    return;
  }
  if (e.request.method !== 'GET') return;
  if (url.pathname.startsWith('/media/')) {
    e.respondWith(caches.open(MEDIA_CACHE).then(async c => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const r = await fetch(e.request);
      if (r.ok) c.put(e.request, r.clone());
      return r;
    }));
    return;
  }
  if (url.pathname === '/' || url.pathname.startsWith('/static/')) {
    // 网络优先，离线时用缓存。静态文件用 no-cache：每次向服务器确认，不吃浏览器里过期的旧副本
    // （页面导航请求不能改 cache 选项，'/' 本身已由服务器返回 no-cache）
    const req = url.pathname === '/' ? e.request : new Request(e.request, { cache: 'no-cache' });
    e.respondWith(fetch(req).then(r => {
      if (r.ok) { const copy = r.clone(); caches.open(SHELL_CACHE).then(c => c.put(e.request, copy)); }
      return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: true })));
  }
});
