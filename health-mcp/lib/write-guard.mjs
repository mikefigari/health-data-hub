function errorResult(code, message) {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code, message } }) }] };
}

// One guard per process: kill switch, token bucket, audit log line.
export function createWriteGuard(config) {
  const capacity = config.WRITE_RATE_LIMIT_PER_HOUR;
  const perMs = capacity / 3600000;
  let tokens = capacity;
  let last = Date.now();

  return {
    // Returns null when the write may proceed (consumes a token), else an isError result.
    check(_tool) {
      if (!config.WRITES_ENABLED) return errorResult('WRITES_DISABLED', 'Write tools are disabled.');
      const now = Date.now();
      tokens = Math.min(capacity, tokens + (now - last) * perMs);
      last = now;
      if (tokens < 1) return errorResult('RATE_LIMITED', 'Write rate limit reached; try again later.');
      tokens -= 1;
      return null;
    },
    // Whitelists fields so descriptions and tokens can never reach the log.
    audit({ tool, authInfo, ids, kcal_delta }) {
      console.log(
        JSON.stringify({
          evt: 'write',
          tool,
          client: (authInfo && authInfo.clientId) || 'unknown',
          ids: Array.isArray(ids) ? ids : [],
          kcal_delta: kcal_delta ?? 0,
        })
      );
    },
  };
}
