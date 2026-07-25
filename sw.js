// Service Worker：只為了讓網頁能「加到主畫面」成為 PWA。
//
// 刻意「不做任何快取」——直接把請求交給網路。
// 原因：這個專案更新很頻繁，快取一旦介入，手機就會載到舊版程式（開發過程中已為此吃過好幾次苦頭）。
// 寧可每次都連網拿最新版，也不要為了離線功能冒著跑舊程式的風險。
// （這支 App 本來就必須連網才能跟 Gemini 對話，離線也無法上課。）

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => e.respondWith(fetch(e.request)));
