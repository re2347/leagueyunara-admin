/**
 * 管理员密钥在界面上的呈现判据。
 *
 * 定这条规则的原因：`#admin-key` 是 `type=password`，看起来是遮住的，但浏览器（Edge/Chrome）
 * 自带"显示密码"的小眼睛，点一下就出明文。而 app.js 原来在加载时会把**已保存的密钥整个写回
 * 这个输入框**，于是本机预览（真 localStorage，密钥能存下来）等于把长期密钥摆在一次点击之外
 * 没有防护的地方。
 *
 * 判据是：**已保存的密钥永远不写回 DOM**。界面只说"有没有存"，不说它是什么；要换就输入新值，
 * 要撤就点清除。密钥本身继续只活在内存与存储里，请求照带不误。
 */

/** 连接时用哪把密钥：输入框里有新值就用新值，否则沿用已存的（不许把已存的清空）。 */
export function resolveConnectKey(typedKey, storedKey) {
  const typed = typeof typedKey === "string" ? typedKey.trim() : "";
  if (typed) return typed;
  return typeof storedKey === "string" ? storedKey : "";
}

/** 占位提示。刻意不含任何密钥字符——哪怕末几位也不给，避免"看着像提示其实是回显"。 */
export function adminKeyPlaceholder(storedKey) {
  return storedKey ? "已保存 · 输入新值可替换" : "输入 ADMIN_API_KEY";
}

/** 是否提供「清除已存密钥」：只有本机确实存了东西才该出现这个按钮。 */
export function shouldOfferClearAdminKey(storedKey) {
  return Boolean(storedKey);
}

/**
 * 连接成功后输入框该留什么。
 *
 * 留空。密钥已经在 state 里、请求头照带，没必要让明文继续躺在 DOM 里等着被读或被
 * 密码管理器提示"保存这个密码"。
 */
export function adminKeyFieldAfterConnect() {
  return "";
}
