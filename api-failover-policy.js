/**
 * 决定这一次请求打哪个管理接口。
 *
 * 界面上的地址输入框**默认留空**：未登录的人不该在页面上（连源码里）看到这个接口地址，
 * 只有要换备用端点或连本机预览时才自己填。留空不等于没地址 —— 落到内置默认值，
 * 所以"什么都不填直接登录"这条路照旧走得通。
 * 优先级：刚输入的 > 本机存过的 > 内置默认。
 */
export function resolveApiUrl({ typedUrl = "", storedUrl = "", defaultUrl = "" } = {}) {
  const clean = (value) => (typeof value === "string" ? value.trim().replace(/\/+$/, "") : "");
  return clean(typedUrl) || clean(storedUrl) || clean(defaultUrl);
}

/**
 * 哪些失败允许换一条线再试一次。
 *
 * 429 刻意排除在外：它是管理台登录限流的返回码，而两条线各自独立计数。允许跨线重试就等于
 * 一条线锁定后自动领到另一条线的预算，而且管理员看到的是笼统的"登录失败"，
 * 不是"失败过多，请 15 分钟后再试"。
 */
export function shouldTryAdminApiFallback({ status = 0, networkError = false } = {}) {
  return networkError || status === 404 || status === 408 || status >= 500;
}
