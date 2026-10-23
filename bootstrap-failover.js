const PRIMARY_STATIC_HOST = "wind-xber.upma.site";
const FALLBACK_PAGE = "https://re2347.github.io/leagueyunara-admin/";
const PROBE_TIMEOUT_MS = 5000;

if (location.hostname === PRIMARY_STATIC_HOST) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  fetch(`./app.js?__upma_asset_probe=${Date.now()}`, {
    cache: "no-store",
    signal: controller.signal,
  })
    .then((response) => {
      const contentType = response.headers.get("content-type") || "";
      if (!response.ok || !/javascript/i.test(contentType)) location.replace(FALLBACK_PAGE);
    })
    .catch(() => location.replace(FALLBACK_PAGE))
    .finally(() => clearTimeout(timeout));
}
