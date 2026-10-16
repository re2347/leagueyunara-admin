const PRIMARY_STATIC_HOST = "wind-xber.upma.site";
const DEFAULT_FAILURE_THRESHOLD = 2;

export function shouldRedirectToStaticFallback({
  host,
  consecutiveFailures = 0,
  primaryHost = PRIMARY_STATIC_HOST,
  threshold = DEFAULT_FAILURE_THRESHOLD,
} = {}) {
  return host === primaryHost && Number(consecutiveFailures) >= threshold;
}
