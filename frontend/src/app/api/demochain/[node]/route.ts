/**
 * POST /api/demochain/a and /api/demochain/b: the JSON-RPC of the WhiteFlag demo chain ("wfdemo", chain id 357357),
 * which only DEMO registries read. Its content is data/demochain.json, copied into the site at build time
 * (lib/demochain.json): transactions EIP-155 signed by the throwaway demo keys, blocks with the time each becomes
 * final, and scheduled outages of one endpoint. Both endpoints are run by the same operator; that is disclosed.
 * Answers eth_chainId, eth_blockNumber, eth_getBlockByNumber (number, "latest", "finalized"),
 * eth_getTransactionByHash and eth_getTransactionReceipt, single or batched.
 * GET ?tx=<hash> returns one transaction with its raw signed bytes, for the site's links.
 */
import { keccak256, toHex } from "viem";
import chain from "@/lib/demochain.json";

export const dynamic = "force-dynamic";

type Tx = { hash: string; raw: string; from: string; to: string; value: string; nonce: number; block: number | null; index: number; status: number; logs: { address: string; topics: string[]; data: string }[] };
type Block = { number: number; time: number; final_at: number };
type Chain = { chain_id: number; blocks: Block[]; txs: Tx[]; outages: { node: string; from: number; until: number }[] };
const C = chain as Chain;

const hex = (n: number | bigint) => toHex(n);
const blockHash = (n: number) => keccak256(toHex(`wfdemo:block:${n}`));
const now = () => Math.floor(Date.now() / 1000);
const visible = (b: Block) => b.time <= now();
const latest = () => C.blocks.filter(visible).reduce((m, b) => Math.max(m, b.number), 0);
const finalized = () => C.blocks.filter((b) => visible(b) && b.final_at <= now()).reduce((m, b) => Math.max(m, b.number), 0);
const blockOf = (n: number) => C.blocks.find((b) => b.number === n && visible(b)) ?? null;
const txOf = (h: unknown) => {
  const t = C.txs.find((x) => x.hash === String(h).toLowerCase());
  if (!t) return null;
  if (t.block !== null && !blockOf(t.block)) return null;     // not broadcast yet
  return t;
};

function header(n: number) {
  const b = blockOf(n);
  if (!b) return null;
  return { number: hex(n), hash: blockHash(n), parentHash: n > 0 ? blockHash(n - 1) : "0x" + "0".repeat(64), timestamp: hex(b.time),
    transactions: C.txs.filter((t) => t.block === n).map((t) => t.hash) };
}

function call(method: string, params: unknown[]): unknown {
  switch (method) {
    case "eth_chainId": return hex(C.chain_id);
    case "eth_blockNumber": return hex(latest());
    case "eth_getBlockByNumber": {
      const tag = String(params[0]);
      const n = tag === "finalized" || tag === "safe" ? finalized() : tag === "latest" ? latest() : parseInt(tag, 16);
      return Number.isFinite(n) ? header(n) : null;
    }
    case "eth_getTransactionByHash": {
      const t = txOf(params[0]);
      if (!t) return null;
      return { hash: t.hash, from: t.from, to: t.to, value: hex(BigInt(t.value)), nonce: hex(t.nonce), input: "0x",
        blockNumber: t.block === null ? null : hex(t.block), blockHash: t.block === null ? null : blockHash(t.block),
        transactionIndex: t.block === null ? null : hex(t.index), chainId: hex(C.chain_id) };
    }
    case "eth_getTransactionReceipt": {
      const t = txOf(params[0]);
      if (!t || t.block === null) return null;
      return { transactionHash: t.hash, transactionIndex: hex(t.index), blockNumber: hex(t.block), blockHash: blockHash(t.block),
        from: t.from, to: t.to, status: hex(t.status), gasUsed: "0x5208", cumulativeGasUsed: "0x5208", effectiveGasPrice: "0x0", type: "0x0",
        logs: t.logs.map((l, i) => ({ ...l, logIndex: hex(i), blockNumber: hex(t.block!), blockHash: blockHash(t.block!), transactionHash: t.hash, transactionIndex: hex(t.index) })) };
    }
    default: throw Object.assign(new Error("method not supported"), { code: -32601 });
  }
}

const down = (node: string) => C.outages.some((o) => o.node === node && now() >= o.from && now() < o.until);
type Req = { id?: unknown; method?: unknown; params?: unknown };
const one = (r: Req) => {
  try { return { jsonrpc: "2.0", id: r.id ?? null, result: call(String(r.method), Array.isArray(r.params) ? r.params : []) }; }
  catch (e) { return { jsonrpc: "2.0", id: r.id ?? null, error: { code: (e as { code?: number }).code ?? -32000, message: (e as Error).message } }; }
};
const NO_STORE = { "cache-control": "no-store" };

export async function POST(req: Request, ctx: { params: Promise<{ node: string }> }) {
  const { node } = await ctx.params;
  if (node !== "a" && node !== "b") return Response.json({ error: "no such node" }, { status: 404, headers: NO_STORE });
  if (down(node)) return new Response("scheduled outage of demo node " + node, { status: 503, headers: NO_STORE });
  let body: unknown;
  try { body = await req.json(); } catch { return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, { headers: NO_STORE }); }
  const out = Array.isArray(body) ? body.slice(0, 100).map((r) => one(r as Req)) : one(body as Req);
  return Response.json(out, { headers: NO_STORE });
}

export async function GET(req: Request, ctx: { params: Promise<{ node: string }> }) {
  const { node } = await ctx.params;
  const h = new URL(req.url).searchParams.get("tx");
  if (h) {
    const t = C.txs.find((x) => x.hash === h.toLowerCase());
    return Response.json(t ? { ...t, broadcast: txOf(h) !== null, block_final: t.block !== null && t.block <= finalized() } : { found: false }, { status: t ? 200 : 404, headers: NO_STORE });
  }
  return Response.json({ chain: "wfdemo", chain_id: C.chain_id, node, latest: latest(), finalized: finalized(), down: down(node),
    txs: C.txs.length, outages: C.outages }, { headers: NO_STORE });
}
