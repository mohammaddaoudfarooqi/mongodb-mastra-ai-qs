import { Mastra } from '@mastra/core';
import { MongoDBStore } from '@mastra/mongodb';
import { ObjectId } from 'mongodb';
import type { Config } from '../config';
import { buildPlaceOrderWorkflow } from '../mastra/workflows/place-order';
import type { OrderRunner, RouteContext } from './routes';

/**
 * Mastra's workflow-level `suspendPayload` is KEYED BY the suspended step id
 * (e.g. `{ 'approve-order': { action, allowed_decisions } }`), and `suspended`
 * names the step path(s). Unwrap to the suspended step's own payload so the SSE
 * bridge receives `{ action, allowed_decisions }`. Exported + pure so a unit test
 * pins it against the real shape (mock parity — a flat-shape stub hid this once).
 */
export function unwrapSuspendPayload(result: { suspended?: any; suspendPayload?: any }): any {
  const stepId = result?.suspended?.[0]?.[0] as string | undefined;
  const raw = result?.suspendPayload;
  return stepId && raw && typeof raw === 'object' && stepId in raw ? raw[stepId] : raw;
}

/**
 * Production OrderRunner: a storage-bound Mastra instance owning the place-order
 * workflow. Run snapshots persist in MongoDB (`mastra_workflow_snapshot`, a fixed
 * collection name — the store `id` does not namespace it), so a run suspended
 * during the /chat request is recoverable during the SEPARATE
 * /interrupts/resume request — even on a different process or Cloud replica,
 * because the runId is DETERMINISTIC from the composite threadId (REQ-E-035).
 *
 * runId = `checkout:<threadId>` (one in-flight checkout per thread). Before each
 * new checkout we delete any prior run for that id, so a completed run's snapshot
 * is never rehydrated by a fresh checkout. Resume recomputes the same id from the
 * thread — no in-memory state — so it works across process restarts / replicas.
 *
 * The orderId is a fresh ObjectId (collision-free even under Docker PID 1 with a
 * reset counter); the timestamp is an ISO string here because it must ride through
 * the JSON-serialized workflow snapshot across suspend→resume — the place-order step
 * converts it to a BSON Date at the `orders` insert boundary. Both are generated here,
 * not in the workflow steps, keeping the steps deterministic + unit-testable.
 */
export function buildOrderRunner(cfg: Config, rc: RouteContext): OrderRunner {
  // A dedicated storage-bound Mastra whose only job is to own the workflow with a
  // durable snapshot store. Built lazily on first checkout (no connection at
  // construction — preserves the connection-free RouteContext contract).
  let mastra: Mastra | null = null;
  const getWorkflow = () => {
    if (!mastra) {
      mastra = new Mastra({
        storage: new MongoDBStore({ id: 'order-store', uri: cfg.mongoUri, dbName: cfg.mongoDb }),
        workflows: { 'place-order': buildPlaceOrderWorkflow(rc.db) },
      });
    }
    return mastra.getWorkflow('place-order');
  };

  const runIdFor = (threadId: string) => `checkout:${threadId}`;

  return {
    start: async (threadId, userId) => {
      const wf = getWorkflow();
      const runId = runIdFor(threadId);
      // Clear any prior run under this deterministic id so a completed/stale
      // snapshot from an earlier checkout in the same thread is never rehydrated.
      try { await (wf as any).deleteWorkflowRunById?.(runId); } catch { /* none to delete */ }
      const run = await (wf as any).createRun({ runId });
      const result = await run.start({
        inputData: { userId, threadId, now: new Date().toISOString(), orderId: new ObjectId().toHexString() },
      });
      return { status: result.status, suspendPayload: unwrapSuspendPayload(result as any) };
    },
    resume: async (threadId, decision, editedAction, cartVersion) => {
      const wf = getWorkflow();
      // Recompute the same deterministic runId — recovers the suspended run from the
      // durable snapshot with no in-process state (works across restarts/replicas).
      // A double-resume finds a non-suspended snapshot and `_resume` throws, which
      // the caller surfaces as a clean error frame (no second order).
      const run = await (wf as any).createRun({ runId: runIdFor(threadId) });
      const result = await run.resume({
        resumeData: {
          decision,
          ...(editedAction ? { edited_action: editedAction } : {}),
          ...(cartVersion ? { cart_version: cartVersion } : {}),
        },
      });
      const out = (result as any).result ?? result;
      return { status: out?.status ?? result.status, message: out?.message };
    },
  };
}
