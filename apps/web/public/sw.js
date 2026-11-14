/**
 * 网页被系统挂起后，页面里的定时器和 Notification 构造器都不会再跑；只有这里收到的
 * push 事件能把提醒放进通知中心，所以「谁该提醒」全部由 Bridge 判定。
 */
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = typeof data.title === "string" && data.title ? data.title : "Agent Bridge";
  const body = typeof data.body === "string" ? data.body : "";
  const url = typeof data.url === "string" && data.url ? data.url : "/";
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      ...(typeof data.tag === "string" && data.tag ? { tag: data.tag } : {}),
      data: { url },
      icon: "/icon.svg",
      badge: "/icon.svg",
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  let target = new URL(typeof data.url === "string" ? data.url : "/", self.registration.scope).href;
  // 通知里的 url 来自 push 数据，不可信；只允许跳回本站，否则 `//evil.com` 会开出外站。
  if (new URL(target).origin !== self.location.origin) target = self.registration.scope;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        if (!("focus" in client)) continue;
        // 已经开着的页面自己换路由，比新开一个窗口更接近用户预期。
        client.postMessage({ type: "ab.navigate", url: target });
        return client.focus();
      }
      return self.clients.openWindow(target);
    })(),
  );
});
