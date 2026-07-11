/**
 * Vitest setup: swallow the ONE unhandled rejection Mastra emits from a leaked test store.
 *
 * Several unit tests build a real Mastra / `MongoDBStore` (e.g. index.test.ts asserts the
 * durable store is configured; agent.test.ts asserts our recall/working-memory config).
 * The store is never connected — its URI is a placeholder Atlas host. Mastra lazily kicks
 * off `createDefaultIndexes()` on a background microtask; the DNS lookup for the fake host
 * fails and the promise rejects as MASTRA_STORAGE_MONGODB_CREATE_DEFAULT_INDEXES_FAILED.
 * That rejection settles after the creating test has finished, so Vitest reports it as an
 * "unhandled error" only in the full run (~12 of them), never in isolation. No test depends
 * on the store connecting, and production is unaffected (Atlas resolves there).
 *
 * We intercept process-level unhandled rejections and drop ONLY this specific Mastra
 * storage-init error. Every other unhandled rejection is re-thrown, so real defects still
 * fail the suite. Test-only (setupFile); no production code changed, console untouched.
 */
// The rejection can surface in several shapes, and Mastra's `MastraError` WRAPS the underlying
// driver error — Node may report the wrapper OR the cause. So we inspect the whole error and its
// `.cause` chain, matching on any of: the Mastra storage error id, the "create default index"
// text, or the MongoDB connection/DNS failure the fake Atlas host produces (the actual root
// cause: server-selection / SRV lookup against a host that doesn't resolve). This stays narrow
// enough that a real defect (a rejection from OUR code, or a different subsystem) still throws.
function textOf(reason: unknown): string {
  const parts: string[] = [];
  let cur: any = reason;
  for (let depth = 0; cur && depth < 5; depth++) {
    parts.push(String(cur?.id ?? ''), String(cur?.code ?? ''), String(cur?.name ?? ''), String(cur?.message ?? ''));
    cur = cur?.cause;
  }
  parts.push(String(reason ?? ''));
  return parts.join(' | ');
}

export function isMastraStorageInitError(reason: unknown): boolean {
  const s = textOf(reason);
  return (
    s.includes('MASTRA_STORAGE_MONGODB_CREATE_DEFAULT_INDEXES_FAILED') ||
    s.includes('Failed to create default index on collection "mastra_') ||
    // The wrapped root cause: the placeholder Atlas host never resolves, so index creation
    // fails on server selection / SRV DNS lookup. Only ever fires from the leaked test store
    // (production resolves), so it is safe leaked-store noise, not a real defect.
    (/MongoServerSelectionError|ServerSelectionError|querySrv|getaddrinfo|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED/.test(s)
      && /mongodb|atlas|srv|_mongodb\._tcp|createDefaultIndexes|c\.mongodb\.net/i.test(s))
  );
}

process.on('unhandledRejection', (reason) => {
  if (isMastraStorageInitError(reason)) return; // known leaked-test-store noise; ignore
  throw reason; // anything else is a real problem — let Vitest surface it
});
