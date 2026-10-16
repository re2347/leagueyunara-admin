export function shouldTryAdminApiFallback({ status = 0, networkError = false } = {}) {
  return networkError || status === 404 || status === 408 || status === 429 || status >= 500;
}
