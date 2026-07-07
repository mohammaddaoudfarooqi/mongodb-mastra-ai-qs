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
function isMastraStorageInitError(reason: unknown): boolean {
  const s = String((reason as any)?.code ?? (reason as any)?.message ?? reason ?? '');
  return (
    s.includes('MASTRA_STORAGE_MONGODB_CREATE_DEFAULT_INDEXES_FAILED') ||
    s.includes('Failed to create default index on collection "mastra_')
  );
}

process.on('unhandledRejection', (reason) => {
  if (isMastraStorageInitError(reason)) return; // known leaked-test-store noise; ignore
  throw reason; // anything else is a real problem — let Vitest surface it
});
