import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { MongoDBStore } from '@mastra/mongodb';
import type { Config } from '../config';
import type { TurnSignals } from '../cache/cache-decisions';
import { getLLM } from './models';
import { getQueryEmbedder, getReranker, type VoyageEmbedder, type VoyageReranker } from './embed';
import { getMemoryEmbedder } from './memory-embedder';
import { createKnowledgeVector } from './vector';
import { buildKnowledgeSearchTool } from './tools/knowledge-search';
import { buildDataQueryTool } from './tools/data-agent';
import { buildCartTools } from './tools/cart';
import { buildCheckoutTool } from './tools/checkout';
import { MongoClient, Db } from 'mongodb';
import type { MongoDBVector } from '@mastra/mongodb';

export interface TurnContext {
  signals: TurnSignals;
  modelOverride?: string;
  userId?: string;
  threadId?: string;
  /** Set by the `checkout` tool when the shopper asks to buy; the /chat bridge
   *  reads it after the agent turn to start the order workflow (REQ-E-030). */
  checkoutRequested?: boolean;
}

const SHOPPER_PROFILE_TEMPLATE = `# Shopper Profile
- Preferences:
- Interests / categories:
- Notes:`;

const ROUTER_INSTRUCTIONS = `You are a retail shopping concierge.
Answer knowledge-base questions yourself with the knowledgeSearch tool: recipes, store policies,
the loyalty program, and the sale pamphlet. Always do this in the SAME turn: (1) call
knowledgeSearch, then (2) write the answer in your own words, grounded in the returned snippets.
When knowledgeSearch returns one or more hits, treat them as the source of truth and answer from
them. Do NOT say you are "having trouble retrieving" or "unable to find" anything when hits came
back — that phrasing is only appropriate when the tool genuinely returned zero hits.
Delegate to the "dealsAndCart" specialist for live prices, stock, orders, promotions, and
anything that reads or changes the shopping cart. When it returns a product or cart summary,
surface that content in your reply rather than re-deriving it; never claim you could not help
after the specialist has already returned usable data.
CHECKOUT — act, don't interrogate: the moment the shopper says anything that means they want to
buy, purchase, place an order, check out, or approve/confirm a pending order, call the checkout
tool YOURSELF in the SAME turn. This includes bare replies like "yes", "ok", "approved", or
"go ahead" when the recent conversation was about buying or checking out. Do NOT delegate this,
do NOT ask for confirmation first, and NEVER claim the order is placed or completed — the checkout
tool starts an approval flow that pauses for the shopper's explicit approval. Calling checkout IS
the correct response to a buy request; describing an approval or a completed order in prose is
always wrong.
Never invent product data; look it up. Reply with one concise, grounded answer.
Remember the shopper's preferences across sessions.
When the shopper states a durable preference or a stable fact about themselves (for
example a style, budget, or category they favor), record it in the shopper profile using
your working-memory tool and briefly confirm. When you recommend or personalize anything,
consult the remembered shopper profile first.`;

const DEALS_CART_INSTRUCTIONS = `You handle live retail data and the shopping cart.
Use dataQuery for live prices, stock, orders, and promotions. Never invent product data; look it up.
To add something to the cart: first find the product with dataQuery to get its _id and name, then call
cartAdd with a line { product_id (the _id, e.g. "prod_0061"), name, qty }. cartAdd looks up the live
price and savings itself — do NOT compute unit_price_usd, sale_price_usd, or line_savings, and always
pass the real _id from dataQuery as product_id (never a name-derived slug). If cartAdd returns
{ ok: false }, the product was not found — tell the shopper rather than claiming it was added. The cart
belongs to this conversation automatically — never pass user or thread IDs to the cart tools.
IMPORTANT — act, don't interrogate: when the shopper asks to add "an" on-sale item or a product by a
category/attribute without naming a specific one, DO NOT reply with a list of options and DO NOT ask them
to choose. In the SAME turn, pick the single best in-stock match from your dataQuery results (prefer one
that is on sale; if several tie on that, pick the one with the lowest _id so the choice is stable), call
cartAdd once to add it, then briefly say what you added, the savings, and that they can swap it for
another. Add only one line unless the shopper asked for several. Only ask a clarifying question if no
matching product exists at all.
Use cartRead to summarize the cart and its total savings.
You do NOT handle checkout: never claim an order was placed or completed. If the shopper wants to
buy or check out, the concierge owns that flow — just summarize the cart if asked.
Be concise.`;

/** Shared connection-holding deps created once per app (or once per test for buildConcierge's legacy path). */
export interface ConciergeDeps {
  client: MongoClient;
  db: Db;
  vector: MongoDBVector;
  memory: Memory;
  queryEmbedder: VoyageEmbedder;
  reranker: VoyageReranker;
}

/**
 * Build the shared connection-holding objects once per app scope.
 * No actual connection is opened until first use (MongoClient/MongoDBStore connect lazily).
 */
export function buildConciergeDeps(cfg: Config): ConciergeDeps {
  const vector = createKnowledgeVector(cfg);
  const client = new MongoClient(cfg.mongoUri, {
    maxPoolSize: cfg.mongoPool.maxPoolSize,
    minPoolSize: cfg.mongoPool.minPoolSize,
  });
  const db = client.db(cfg.mongoDb);

  const memory = new Memory({
    storage: new MongoDBStore({ id: 'concierge-store', uri: cfg.mongoUri, dbName: cfg.mongoDb }),
    vector,
    embedder: getMemoryEmbedder(cfg) as any,
    options: {
      semanticRecall: { topK: 5, messageRange: 2, scope: 'resource' },
      workingMemory: { enabled: true, scope: 'resource', template: SHOPPER_PROFILE_TEMPLATE },
    },
  });

  return { client, db, vector, memory, queryEmbedder: getQueryEmbedder(cfg), reranker: getReranker(cfg) };
}

/**
 * Bind an agent to a turn's signals using shared deps (connection reuse path).
 * If deps are not provided, builds them inline (legacy path for tests and src/mastra/index.ts).
 */
export function buildConcierge(cfg: Config, turn: TurnContext, deps?: ConciergeDeps) {
  const { client, db, vector, memory, queryEmbedder, reranker } = deps ?? buildConciergeDeps(cfg);

  const knowledgeSearch = buildKnowledgeSearchTool({
    vector,
    embed: q => queryEmbedder.embedQuery(q),
    reranker,
    rrfK: cfg.rrfK,
    onSignals: s => { turn.signals.knowledgeSearchRan = true; turn.signals.knowledgeSearchHadResults = s.hadResults; },
  });
  const dataQuery = buildDataQueryTool({
    db, allowList: cfg.dataAgentAllowList, limit: cfg.dataAgentLimit,
    onSignals: () => { turn.signals.dataQueryRan = true; },
  });
  const cart = buildCartTools({
    db,
    userId: turn.userId ?? cfg.defaultUserId,
    threadId: turn.threadId ?? `${turn.userId ?? cfg.defaultUserId}:default`,
    onMutate: () => { turn.signals.mutatingToolRan = true; },
  });
  const checkout = buildCheckoutTool({ onCheckout: () => { turn.checkoutRequested = true; } });

  // The router owns knowledgeSearch AND checkout DIRECTLY (not via a sub-agent). A sub-agent
  // that calls a tool and returns empty text leaves the supervisor with nothing to ground
  // on (Mastra returns only the sub-agent's *text* to the supervisor), which produced a
  // flaky "having trouble retrieving" hedge on the fast router model even though retrieval
  // succeeded. The same boundary broke checkout: when the specialist owned the checkout
  // trigger, a bare "yes"/"approved" confirmation carried no delegation keyword, so the
  // router answered conversationally and fabricated a completed order — the checkout tool
  // (and its `checkoutRequested` signal) never fired, so no approval card, no workflow, no
  // order, cart never cleared. checkout is a pure signal (no MQL guard, no cart identity),
  // so the router that converses with the shopper must own it. Live retail data and the
  // cart stay behind the dealsAndCart specialist (MQL safety guard + cart identity).
  const dealsAndCart = new Agent({
    id: 'dealsAndCart',
    name: 'dealsAndCart',
    description: 'Handles live prices, stock, promotions, and the shopping cart.',
    instructions: DEALS_CART_INSTRUCTIONS,
    model: getLLM(cfg, turn.modelOverride),
    tools: { dataQuery, ...cart },
  });

  const agent = new Agent({
    id: 'concierge',
    name: 'concierge',
    instructions: ROUTER_INSTRUCTIONS,
    model: getLLM(cfg, turn.modelOverride),
    tools: { knowledgeSearch, checkout },
    agents: { dealsAndCart },
    memory,
  });

  return { agent, memory, vector, client, db };
}
