export function shouldRefreshSupabaseHealth(now, lastCheckedAt, interval, force = false) {
  return force || !Number.isFinite(lastCheckedAt) || lastCheckedAt <= 0 || now - lastCheckedAt >= interval;
}

export function supabaseHealthPresentation(health) {
  // 「还没探到」和「探到了但不好」必须是两件事：连接流程不再等这个探针，所以它回来之前
  // 这一屏会先亮着。那种时候写「不可用 / 部分可用」是假警报，只会让人以为授权服务坏了。
  const probed = Boolean(health && (health.ok === true || health.body));
  const body = health?.body || {};
  const databaseReady = probed && body.databaseReady === true;
  const catalogReady = probed && body.catalogRefreshReady === true;
  const hasCatalogStatus = ["catalogRefreshReady", "privateSkinConfigured", "catalogLastError"]
    .some((key) => Object.prototype.hasOwnProperty.call(body, key));
  const databaseText = !probed
    ? "检测中"
    : databaseReady
      ? "已连接 · PostgreSQL"
      : body.deployed === false ? "已配置，未上线" : "不可用";
  const catalogText = !probed
    ? "检测中"
    : catalogReady
      ? "已同步"
      : !hasCatalogStatus ? "状态不可用"
      : body.privateSkinConfigured === false ? "未配置" : body.catalogLastError ? "需要恢复" : "检测中";
  const overallReady = probed && health?.ok === true;
  return {
    databaseText,
    databaseClassName: !probed ? "" : databaseReady ? "service-online" : "service-offline",
    catalogText,
    catalogClassName: !probed ? "" : catalogReady ? "service-online" : "service-offline",
    overallText: !probed ? "检测中" : overallReady ? "运行正常" : "部分可用",
    overallClassName: !probed ? "state-muted" : overallReady ? "state-ok" : "state-error",
  };
}
