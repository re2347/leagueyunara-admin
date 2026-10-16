export function shouldRefreshSupabaseHealth(now, lastCheckedAt, interval, force = false) {
  return force || !Number.isFinite(lastCheckedAt) || lastCheckedAt <= 0 || now - lastCheckedAt >= interval;
}

export function supabaseHealthPresentation(health) {
  const body = health?.body || {};
  const databaseReady = body.databaseReady === true;
  const catalogReady = body.catalogRefreshReady === true;
  const hasCatalogStatus = ["catalogRefreshReady", "privateSkinConfigured", "catalogLastError"]
    .some((key) => Object.prototype.hasOwnProperty.call(body, key));
  const databaseText = databaseReady
    ? "已连接 · PostgreSQL"
    : body.deployed === false ? "已配置，未上线" : "不可用";
  const catalogText = catalogReady
    ? "已同步"
    : !hasCatalogStatus ? "状态不可用"
    : body.privateSkinConfigured === false ? "未配置" : body.catalogLastError ? "需要恢复" : "检测中";
  const overallReady = health?.ok === true;
  return {
    databaseText,
    databaseClassName: databaseReady ? "service-online" : "service-offline",
    catalogText,
    catalogClassName: catalogReady ? "service-online" : "service-offline",
    overallText: overallReady ? "运行正常" : "部分可用",
    overallClassName: overallReady ? "state-ok" : "state-error",
  };
}
