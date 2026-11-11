// This function is serialized into the verified app shell. Keep it self-contained.
export function watchNativeLimits(token) {
  const send = window.__sprBarRefreshBinding;
  if (window !== window.top || location.protocol !== 'app:' || location.host !== '-'
      || location.pathname !== '/index.html' || location.search.includes('avatar-overlay')
      || typeof send !== 'function') return;
  try { window.__sprBarStopNative?.(); } catch {}

  let unsubscribe;
  let retry;
  let stopped = false;
  let unsupported = false;
  let queued = false;
  let lastQuery = null;
  let lastAt = 0;

  function findCache() {
    const stack = [window.__codexRoot?._internalRoot?.current];
    const own = (value, key) => value == null ? undefined : Object.getOwnPropertyDescriptor(value, key)?.value;
    for (let scanned = 0; stack.length && scanned < 25000; scanned++) {
      const node = stack.pop();
      if (!node) continue;
      if (node.tag === 10) {
        const value = own(node.memoizedProps, 'value');
        for (const candidate of [value, own(value, 'queryClient'), own(own(value, 'scope'), 'queryClient')]) {
          if (typeof candidate?.getQueryCache !== 'function') continue;
          const cache = candidate.getQueryCache();
          if (typeof cache?.getAll === 'function' && typeof cache.subscribe === 'function') return cache;
        }
      }
      if (node.sibling) stack.push(node.sibling);
      if (node.child) stack.push(node.child);
    }
  }

  function projectWindow(value) {
    if (!Number.isFinite(value?.used_percent) || value.used_percent < 0
        || !Number.isFinite(value.limit_window_seconds) || value.limit_window_seconds <= 0) return null;
    return {
      usedPercent: value.used_percent,
      windowDurationMins: value.limit_window_seconds / 60,
      resetsAt: Number.isFinite(value.reset_at) && value.reset_at > 0 ? value.reset_at : null,
    };
  }

  function project(data) {
    const limit = data.rate_limit;
    const primary = projectWindow(limit?.primary_window);
    const secondary = projectWindow(limit?.secondary_window);
    if (!primary && !secondary) return null;
    const code = value => typeof value === 'string' && /^[a-z0-9_-]{1,64}$/i.test(value) ? value : null;
    const credits = data.rate_limit_reset_credits;
    return {
      rateLimits: {
        primary,
        secondary,
        planType: code(data.plan_type),
        rateLimitReachedType: code(data.rate_limit_reached_type?.type)
          ?? (limit.limit_reached === true ? 'rate_limit_reached' : null),
        spendControlReached: data.spend_control?.reached === true,
      },
      ordinaryUsageAllowed: data.ordinary_usage_allowed ?? limit.allowed,
      rateLimitResetCredits: Number.isSafeInteger(credits?.available_count) ? {
        availableCount: credits.available_count,
        credits: Array.isArray(credits.credits) ? credits.credits
          .filter(credit => credit?.status === 'available' && Number.isFinite(credit.expires_at))
          .sort((a, b) => a.expires_at - b.expires_at).slice(0, 20)
          .map(credit => ({
            status: 'available',
            expiresAt: credit.expires_at,
            title: typeof credit.title === 'string' ? credit.title.slice(0, 80) : null,
          })) : null,
      } : null,
    };
  }

  function publish(cache) {
    // An old account's query can still be cached. Require a single observed query
    // with the exact scoped key and a matching response before using its data.
    const queries = cache.getAll().filter(query => query.queryKey?.[0] === 'rate-limit-status'
      && query.queryKey.length === 3 && query.getObserversCount?.() > 0);
    const query = queries.length === 1 ? queries[0] : null;
    const data = query?.state?.data;
    const at = query?.state?.dataUpdatedAt;
    const key = query?.queryKey;
    const accountId = typeof key?.[2] === 'string' && key[2] ? key[2] : null;
    const result = data && accountId && typeof key[1] === 'string'
      && data.user_id === key[1] && data.account_id === accountId && Number.isSafeInteger(at) && at > 0
      ? project(data) : null;
    const updatedAtMs = result ? at : 0;
    if (query === lastQuery && updatedAtMs === lastAt) return;
    send(JSON.stringify({ token, updatedAtMs, accountId, result }));
    lastQuery = query;
    lastAt = updatedAtMs;
  }

  function connect(attempt = 0) {
    if (stopped || unsupported || unsubscribe) return;
    clearTimeout(retry);
    try {
      const cache = findCache();
      if (cache) {
        const release = cache.subscribe(event => {
          if (stopped || unsupported || queued || event?.query?.queryKey?.[0] !== 'rate-limit-status') return;
          queued = true;
          queueMicrotask(() => {
            queued = false;
            if (!stopped && !unsupported) { try { publish(cache); } catch {} }
          });
        });
        if (typeof release !== 'function') { unsupported = true; return; }
        unsubscribe = release;
        publish(cache);
        return;
      }
    } catch {}
    if (attempt < 5) retry = setTimeout(() => connect(attempt + 1), 1000 * 2 ** attempt);
  }

  function onForeground() {
    if (document.visibilityState !== 'visible') return;
    connect();
    try { send('foreground'); } catch {}
  }

  window.addEventListener('focus', onForeground);
  document.addEventListener('visibilitychange', onForeground);
  window.__sprBarStopNative = () => {
    stopped = true;
    clearTimeout(retry);
    try { unsubscribe?.(); } catch {}
    window.removeEventListener('focus', onForeground);
    document.removeEventListener('visibilitychange', onForeground);
    delete window.__sprBarStopNative;
  };
  connect();
}
