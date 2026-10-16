// 首屏绘制之前把主题落到 <html> 上。
//
// 为什么不能等 app.js：app.js 是 type="module"，按规范延迟到文档解析完之后才执行，
// 深色偏好的用户每次打开都会先被浅色闪一下。为什么不能写成内联脚本：
// server/admin/_headers 的 CSP 是 script-src 'self'，内联脚本会被直接拦掉。
(function () {
  var STORAGE_KEY = "yunara.admin.theme";
  var stored = null;
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch (error) {
    // 隐私模式 / 禁用存储：安静地用系统偏好，绝不能在这里抛错把后面的脚本带崩。
    return;
  }
  var theme = stored === "dark" || stored === "light"
    ? stored
    : (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  if (theme === "dark") document.documentElement.setAttribute("data-theme", "dark");
})();
