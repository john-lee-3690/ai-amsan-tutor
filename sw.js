// ============================================================
// AI암산튜터 sw.js — 서비스 워커 (알림관리 6a, 2026-10-29)
// 역할
//   1) 홈 화면 "설치" 가능 조건 충족 (크롬은 서비스 워커가 있어야 앱으로 설치해 줌)
//   2) 푸시 알림 받기 → 알림 표시
//   3) 알림 누르면 앱 열기 → app.html?today=1 (오늘 할 일 팝업)
// 캐시는 하지 않음 — 화면 파일은 항상 서버(GitHub Pages)에서 새로 받음 → 빌드 반영 방식 그대로
// ============================================================
const SW_VERSION = '2026-10-29a';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

// 네트워크 그대로 통과. 인터넷이 끊겨서 앱 화면을 못 받을 때만 짧은 안내
self.addEventListener('fetch', e => {
  if (e.request.mode !== 'navigate') return;          // 화면 이동 요청만 다룸 (나머지는 브라우저 기본)
  e.respondWith(fetch(e.request).catch(() => new Response(
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<body style="margin:0;background:#2A1608;color:#FFD98A;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;text-align:center">'
    + '<div><div style="font-size:22px;font-weight:700">인터넷 연결을 확인해 주세요</div>'
    + '<div style="margin-top:8px;opacity:.8">연결되면 다시 열어 주세요</div></div></body>',
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } })));
});

// 푸시 받기 — 서버가 보내는 내용: { title, body, url, tag, nid }
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch(err){ d = { body: e.data ? e.data.text() : '' }; }
  const title = d.title || 'AI암산튜터';
  const opts = {
    body: d.body || '오늘 할 일을 확인해 봐!',
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    tag: d.tag || 'ai-amsan-today',          // 같은 tag는 새 알림이 이전 알림을 대신함 (쌓이지 않게)
    renotify: true,
    data: { url: d.url || 'app.html?today=1', nid: d.nid || null }
  };
  e.waitUntil(self.registration.showNotification(title, opts));
});

// 알림 누르기 → 이미 열린 앱이 있으면 그 창으로, 없으면 새로 열기
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const data = e.notification.data || {};
  let url = new URL(data.url || 'app.html?today=1', self.registration.scope);
  if (data.nid) url.searchParams.set('n', data.nid);   // 어느 알림을 눌렀는지 (열람률 기록용)
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of list){
      if (c.url.includes('app.html') && 'focus' in c){
        try { await c.navigate(url.href); } catch(err){}
        return c.focus();
      }
    }
    return self.clients.openWindow(url.href);
  })());
});
