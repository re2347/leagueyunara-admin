// 换名 = 强制换缓存：静态资产是"缓存优先"送出的，名字不换就会一直把旧壳递给用户。
// ⚠️ 改完任何一个资产（含 styles.css 的颜色）都必须把这个号往上加一位。
// 2026-10-16 就是漏了这一步：色板从绿改成图标紫之后，用户刷到的仍是缓存里的绿色 CSS，
// 而 HTML 已经是新的，两者一错开就表现为"按钮没反应 + 颜色没变"。
// v23：app.js 开始区分 ADMIN_SESSION_SUPERSEDED（被顶号要显示原因），旧壳会把被踢
// 当成普通掉线，管理员对着一个没有说明的登录框不知道发生了什么。
const CACHE_NAME = "yunara-admin-static-v23";
const PRIMARY_HOST = "wind-xber.upma.site";
const FALLBACK_PAGE = "https://re2347.github.io/leagueyunara-admin/";
const STATIC_ASSETS = [
  "./",
  "./index.html",
  "./app.js",
  "./bootstrap-failover.js",
  "./api-failover-policy.js",
  "./admin-key-policy.js",
  "./health-policy.js",
  "./host-failover-policy.js",
  "./note-refresh-policy.js",
  "./nav.js",
  "./series.js",
  "./mask.js",
  "./theme.js",
  "./icon.png",
  "./styles.css",
  "./sw.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)),
    )),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  if (new URL(request.url).origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok) return response;
        if (self.location.host === PRIMARY_HOST) return Response.redirect(FALLBACK_PAGE, 302);
      } catch {
        if (self.location.host === PRIMARY_HOST) return Response.redirect(FALLBACK_PAGE, 302);
      }
      return caches.match("./index.html");
    })());
    return;
  }

  if (new URL(request.url).searchParams.has("__upma_probe")) {
    event.respondWith(fetch(request));
    return;
  }

  // 静态资产：缓存优先 + 后台刷新。
  //
  // 原先是"必须先联网，失败才回缓存"，而这条链路每个资产都要吃一次高 RTT
  // （实测二次打开 11 个请求全部走网络、缓存命中 0），等于缓存形同虚设。
  event.respondWith((async () => {
    const cached = await caches.match(request);
    const refreshed = fetch(request)
      .then(async (response) => {
        if (response?.ok) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(request, response.clone());
        }
        return response;
      })
      .catch(() => null);

    if (cached) {
      refreshed.catch(() => {});
      return cached;
    }

    return (await refreshed) || Response.error();
  })());
});
