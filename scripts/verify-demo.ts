/**
 * Pre-demo smoke check: run every demo beat against a LIVE running app and fail loudly on
 * any hedge / error / empty answer. Run this right before going on stage — it catches the
 * failure modes unit tests can't (cache poisoning, model regressions, retrieval gaps, a
 * broken checkout) because it drives the real HTTP + SSE + agent + Atlas path end to end.
 *
 *   pnpm verify:demo                 # against http://localhost:8000
 *   BASE_URL=https://host pnpm verify:demo
 *
 * Exit code 0 = all beats healthy; 1 = at least one beat failed (details printed).
 * This is a check, not a mutation — the only writes are the cart add + checkout it drives
 * on a throwaway `verify-*` user, then it cancels/leaves that cart.
 */
const BASE = process.env.BASE_URL || 'http://localhost:8000';
const API = `${BASE}/api`;

// A reply is a "hedge" when the assistant apologizes or says it couldn't retrieve — the
// signature of a poisoned cache or a retrieval miss. Kept in sync with cache-decisions.isHedge.
function isHedge(text: string): boolean {
  const h = text.slice(0, 400).toLowerCase();
  return (
    /\bi(?:'m| am)?\s+(?:sorry|apologi[sz]e)/.test(h) ||
    /\bi(?:'m| am)?\s+(?:can(?:'|no)t|couldn'?t|was(?:n'?t| not)?\s+able|unable|not able|having trouble|not finding)\b/.test(h) ||
    /(?:^|\W)(?:unable to (?:find|locate|retrieve)|couldn'?t (?:find|locate|retrieve))\b/.test(h)
  );
}

interface Frames { tokens: string; events: Set<string>; interrupt: any | null; }

async function chat(body: Record<string, unknown>, path = '/chat'): Promise<Frames> {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const out: Frames = { tokens: '', events: new Set(), interrupt: null };
  if (!res.ok || !res.body) { out.events.add(`http_${res.status}`); return out; }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const chunks = buf.split('\n\n');
    buf = chunks.pop() ?? '';
    for (const chunk of chunks) {
      let event = 'message';
      const data: string[] = [];
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      out.events.add(event);
      const payload = data.join('\n');
      if (event === 'token') out.tokens += payload;
      else if (event === 'interrupt') { try { out.interrupt = JSON.parse(payload); } catch { /* ignore */ } }
    }
  }
  return out;
}

interface Result { name: string; ok: boolean; detail: string; }

async function main() {
  const results: Result[] = [];
  const uid = `verify-${process.env.VERIFY_RUN_ID || 'demo'}`;
  const record = (name: string, ok: boolean, detail: string) => {
    results.push({ name, ok, detail });
    process.stdout.write(`${ok ? '✓' : '✗'} ${name}${ok ? '' : `  — ${detail}`}\n`);
  };

  // Health first — nothing else matters if the app is down.
  try {
    const h = await fetch(`${API}/health`);
    record('health', h.ok, `HTTP ${h.status}`);
    if (!h.ok) throw new Error('health failed');
  } catch (err) {
    record('health', false, String(err));
    finish(results); return;
  }

  // Knowledge / retrieval beats: must answer without hedging, on a FRESH thread each.
  const knowledgeBeats: { name: string; message: string }[] = [
    { name: 'multimodal-pamphlet (HERO)', message: 'Show me the summer sale pamphlet and tell me what it is promoting.' },
    { name: 'hybrid-recipe', message: 'Share a quick pasta recipe I can make tonight.' },
    { name: 'hybrid-recipe-chicken', message: 'Find a quick weeknight chicken recipe I can make tonight.' },
    { name: 'hybrid-loyalty', message: 'How does your loyalty program work, and how do points convert to rewards?' },
    { name: 'semantic-cache (shipping)', message: 'How long does shipping take?' },
    { name: 'nl2mql-deals', message: 'Show me a few products that are on sale, with their sale prices.' },
  ];
  for (const b of knowledgeBeats) {
    const r = await chat({ user_id: uid, thread_id: `${uid}:${b.name}:${Date.now()}`, message: b.message });
    const bad = r.events.has('error') ? 'error frame' : !r.tokens.trim() ? 'empty answer' : isHedge(r.tokens) ? `hedged: "${r.tokens.trim().slice(0, 80)}"` : '';
    record(b.name, !bad, bad);
  }

  // Model-coverage beat: the UI picker offers several models; send a trivial message to EACH
  // and require a non-error, non-empty reply. This catches per-model failures the single-model
  // beats above miss — e.g. a Bedrock inference profile the instance-role policy doesn't
  // authorize (a 403 surfaced as AI_APICallError: Forbidden) that only fires when a shopper
  // switches the picker to that model. Regression guard for the Haiku-403 IAM scope bug.
  {
    let models: { id: string; label: string }[] = [];
    try {
      const mr = await fetch(`${API}/models`);
      const body = await mr.json() as { models?: { id: string; label: string }[] };
      models = body.models ?? [];
    } catch (err) { record('model-coverage', false, `could not fetch /models: ${String(err)}`); }
    for (const m of models) {
      const r = await chat({ user_id: uid, thread_id: `${uid}:model:${m.id}:${Date.now()}`, message: 'hi', model: m.id });
      const httpErr = [...r.events].find(e => e.startsWith('http_'));
      const bad = httpErr ? httpErr : r.events.has('error') ? 'error frame (model not invocable — check Bedrock access + IAM)' : !r.tokens.trim() ? 'empty answer' : '';
      record(`model: ${m.id}`, !bad, bad);
    }
  }

  // Memory beat: store a preference, then confirm recall references it (same thread).
  {
    const tid = `${uid}:mem:${Date.now()}`;
    await chat({ user_id: uid, thread_id: tid, message: 'Remember that I prefer eco-friendly kitchen products.' });
    const r = await chat({ user_id: uid, thread_id: tid, message: 'Based on what you know about me, what kitchen items would you recommend?' });
    const bad = r.events.has('error') ? 'error frame' : isHedge(r.tokens) ? 'hedged' : !/eco|kitchen|recommend/i.test(r.tokens) ? 'no personalized recommendation' : '';
    record('memory (store+recall)', !bad, bad);
  }

  // Cart beat: add one on-sale kitchen item; verify exactly one line, on sale, in the cart.
  const cartTid = `${uid}:cart:${Date.now()}`;
  {
    await chat({ user_id: uid, thread_id: cartTid, message: 'Add the on-sale kitchen product with the biggest savings to my cart and show my total savings.' });
    const cartRes = await fetch(`${API}/cart?user_id=${encodeURIComponent(uid)}&thread_id=${encodeURIComponent(cartTid)}`);
    const cart = await cartRes.json() as { lines: { product_id: string; sale_price_usd: number | null }[]; subtotal: number };
    const lines = cart.lines ?? [];
    const bad = lines.length === 0 ? 'nothing added'
      : lines.length > 1 ? `added ${lines.length} lines (expected 1)`
      : lines[0].sale_price_usd == null ? 'added item is not on sale'
      : cart.subtotal <= 0 ? 'subtotal is 0' : '';
    record('cart (single on-sale add)', !bad, bad || `added ${lines[0]?.product_id}, subtotal ${cart.subtotal}`);
  }

  // Coupon beat: on a fresh thread, add an on-sale kitchen item then apply SAVE5 (5% off
  // kitchen). Verify the coupon actually lowered the total — guards the bug where the agent
  // promised "applied at checkout" but nothing discounted the order. Own thread so it does
  // not disturb the checkout beat's cart.
  {
    const couponTid = `${uid}:coupon:${Date.now()}`;
    await chat({ user_id: uid, thread_id: couponTid, message: 'Add an on-sale kitchen item to my cart.' });
    await chat({ user_id: uid, thread_id: couponTid, message: 'Apply coupon SAVE5 to my cart.' });
    const cartRes = await fetch(`${API}/cart?user_id=${encodeURIComponent(uid)}&thread_id=${encodeURIComponent(couponTid)}`);
    const cart = await cartRes.json() as {
      lines: { applied_coupons?: string[] }[]; subtotal: number; coupon_savings?: number; total?: number;
    };
    const lines = cart.lines ?? [];
    const couponSavings = cart.coupon_savings ?? 0;
    const total = cart.total ?? cart.subtotal;
    const codeStamped = lines.some(l => (l.applied_coupons ?? []).includes('SAVE5'));
    const bad = lines.length === 0 ? 'nothing added (cannot test coupon)'
      : couponSavings <= 0 ? 'coupon_savings is 0 (SAVE5 not applied)'
      : !(total < cart.subtotal) ? `total ${total} not below subtotal ${cart.subtotal}`
      : !codeStamped ? 'SAVE5 not stamped on any line'
      : '';
    record('coupon (apply SAVE5)', !bad, bad || `saved ${couponSavings.toFixed(2)}, total ${total.toFixed(2)}`);
  }

  // Bulk-add + checkout-clears beat (regression guard for the split-cart bug): a bulk "add one
  // of every discounted item" fires many cartAdd calls concurrently. Without the unique
  // {userId,threadId} index, racing upserts split the cart across several docs, so checkout (a
  // single findOne/deleteOne on the key) only quotes/clears ONE — the rest survive as phantom
  // cart items after the order (the "1 item still in cart after checkout" symptom). Here we bulk
  // add, check out, approve, and REQUIRE the cart to be empty afterwards. On a healthy box the
  // whole cart is one doc, so it clears completely.
  {
    const bulkTid = `${uid}:bulk:${Date.now()}`;
    await chat({ user_id: uid, thread_id: bulkTid, message: 'Add one of every discounted item to my cart, then tell me the real cart total.' });
    const beforeRes = await fetch(`${API}/cart?user_id=${encodeURIComponent(uid)}&thread_id=${encodeURIComponent(bulkTid)}`);
    const before = await beforeRes.json() as { lines: unknown[] };
    const added = before.lines?.length ?? 0;
    if (added < 2) {
      record('bulk-add + checkout clears cart', false, `bulk add produced ${added} line(s) (expected several)`);
    } else {
      const co = await chat({ user_id: uid, thread_id: bulkTid, message: 'check out' });
      if (!co.interrupt) {
        record('bulk-add + checkout clears cart', false, 'no interrupt frame on bulk checkout');
      } else {
        const resume = await chat({ thread_id: bulkTid, decision: 'approve', cart_version: co.interrupt.action?.args?.cart_version }, '/interrupts/resume');
        const placed = /placed/i.test(resume.tokens);
        const afterRes = await fetch(`${API}/cart?user_id=${encodeURIComponent(uid)}&thread_id=${encodeURIComponent(bulkTid)}`);
        const after = await afterRes.json() as { lines: unknown[] };
        const leftover = after.lines?.length ?? 0;
        const bad = !placed ? `resume did not place: "${resume.tokens.trim().slice(0, 80)}"`
          : leftover > 0 ? `${leftover} item(s) survived after checkout (split-cart regression — carts unique index missing?)`
          : '';
        record('bulk-add + checkout clears cart', !bad, bad || `added ${added}, cart empty after order`);
      }
    }
  }

  // Checkout HITL: check out the cart, expect an interrupt, then approve → order placed → cart cleared.
  {
    const r = await chat({ user_id: uid, thread_id: cartTid, message: 'check out' });
    if (!r.interrupt) {
      record('checkout (interrupt + approve)', false, 'no interrupt frame');
    } else {
      const resume = await chat({ thread_id: cartTid, decision: 'approve', cart_version: r.interrupt.action?.args?.cart_version }, '/interrupts/resume');
      const placed = /placed/i.test(resume.tokens);
      const cartRes = await fetch(`${API}/cart?user_id=${encodeURIComponent(uid)}&thread_id=${encodeURIComponent(cartTid)}`);
      const cart = await cartRes.json() as { lines: unknown[] };
      const bad = !placed ? `resume did not place: "${resume.tokens.trim().slice(0, 80)}"` : (cart.lines?.length ?? 0) > 0 ? 'cart not cleared after order' : '';
      record('checkout (interrupt + approve)', !bad, bad);
    }
  }

  finish(results);
}

function finish(results: Result[]) {
  const failed = results.filter(r => !r.ok);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} beats healthy.\n`);
  if (failed.length) {
    process.stdout.write(`\n❌ NOT DEMO-READY — ${failed.length} beat(s) failed:\n`);
    for (const f of failed) process.stdout.write(`   • ${f.name}: ${f.detail}\n`);
    process.stdout.write('\nTip: a hedge on a knowledge beat usually means a poisoned cache — flush\n');
    process.stdout.write('semantic_response_cache and re-run `pnpm prewarm`, then verify again.\n');
    process.exit(1);
  }
  process.stdout.write('\n✅ All demo beats healthy — good to go.\n');
  process.exit(0);
}

main().catch(err => { process.stderr.write(`verify-demo crashed: ${String(err)}\n`); process.exit(1); });
