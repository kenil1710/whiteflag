// The return-proof rule, in JavaScript, for reading from outside GenLayer
// (feasibility, the site's live check). It is the same rule as
// WhiteFlagRegistry's read_proof()/judge(): test/test_meaning.py runs both on
// the same fixtures. The contract's verdict is the one that counts.
import { CHAINS, TRANSFER_TOPIC, rpc } from "./chains.mjs";

const lc = (s) => String(s ?? "").toLowerCase();
const isHash = (h) => /^0x[0-9a-f]{64}$/.test(lc(h));

/** Only the fields the rule uses, so two honest RPCs compare equal. */
export function project(tx, rc, hdr) {
  if (!tx || !rc) return null;
  return {
    status: lc(rc.status) === "0x1" ? 1 : 0,
    block: parseInt(rc.blockNumber, 16),
    block_hash: lc(rc.blockHash),
    time: hdr ? parseInt(hdr.timestamp, 16) : null,
    from: lc(tx.from),
    to: tx.to ? lc(tx.to) : "",
    value: BigInt(tx.value).toString(),
    logs: (rc.logs ?? []).filter((l) => lc(l.topics?.[0]) === TRANSFER_TOPIC && l.topics.length === 3
      && lc(l.topics[1]).slice(2, 26) === "0".repeat(24) && lc(l.topics[2]).slice(2, 26) === "0".repeat(24))
      .map((l) => ({ i: parseInt(l.logIndex, 16), address: lc(l.address), from: "0x" + lc(l.topics[1]).slice(26),
        to: "0x" + lc(l.topics[2]).slice(26), amount: BigInt(l.data === "0x" ? 0 : l.data).toString() })),
  };
}

/** One RPC's view of (tx, receipt, its block header, finalized head, chain id). */
export async function readOne(url, hash) {
  const [tx, rc, fin, cid] = await Promise.all([
    rpc(url, "eth_getTransactionByHash", [hash]), rpc(url, "eth_getTransactionReceipt", [hash]),
    rpc(url, "eth_getBlockByNumber", ["finalized", false]), rpc(url, "eth_chainId", []),
  ]);
  const hdr = rc ? await rpc(url, "eth_getBlockByNumber", [rc.blockNumber, false]) : null;
  return { tx, rc, hdr, finalized: fin ? parseInt(fin.number, 16) : -1, chainId: parseInt(cid, 16) };
}

/** Both RPCs of `chain`; {reason} or {proj, finalized:[a,b], raw:[a,b]}. */
export async function readBoth(chain, hash) {
  const c = CHAINS[chain];
  if (!c) return { reason: "UNSUPPORTED_CHAIN" };
  if (!isHash(hash)) return { reason: "BAD_HASH" };
  let a, b;
  try { [a, b] = await Promise.all(c.rpcs.map((u) => readOne(u, lc(hash)))); } catch (e) { return { reason: "RPC_UNREADABLE", detail: String(e.message).slice(0, 120) }; }
  if (a.chainId !== c.id || b.chainId !== c.id) return { reason: "WRONG_CHAIN_ID" };
  const pa = project(a.tx, a.rc, a.hdr), pb = project(b.tx, b.rc, b.hdr);
  if (!a.tx && !b.tx) return { reason: "TX_NOT_FOUND" };
  if (a.tx && b.tx && (!a.rc || !b.rc) && !a.tx.blockNumber && !b.tx.blockNumber) return { reason: "TX_PENDING" };
  if (JSON.stringify(pa) !== JSON.stringify(pb)) return { reason: "RPC_DISAGREE", a: pa, b: pb };
  return { proj: pa, finalized: [a.finalized, b.finalized], urls: c.rpcs };
}

/**
 * The rule. offer: {start, deadline (epoch s), exploiters/recoveries: [{chain,address}], tokens: [{chain, token}]}.
 * -> {reason} | {credits: [{key, token, amount, from, to, log}]}
 */
export function judge(offer, chain, hash, proj, finalized, used = new Set()) {
  if (proj.status !== 1) return { reason: "TX_FAILED" };
  if (proj.block > Math.min(...finalized)) return { reason: "NOT_FINALIZED" };
  if (proj.time < offer.start) return { reason: "BEFORE_OFFER_START" };
  if (proj.time > offer.deadline) return { reason: "AFTER_DEADLINE" };
  const ex = new Set(offer.exploiters.filter((e) => e.chain === chain).map((e) => lc(e.address)));
  const rec = new Set(offer.recoveries.filter((e) => e.chain === chain).map((e) => lc(e.address)));
  const toks = new Set(offer.tokens.filter((t) => t.chain === chain).map((t) => lc(t.token)));
  if (!ex.has(proj.from)) return { reason: "SENDER_NOT_EXPLOITER" };
  const credits = [];
  if (toks.has("native") && BigInt(proj.value) > 0n && rec.has(proj.to)) {
    credits.push({ key: `${chain}:${lc(hash)}:native`, token: "native", amount: proj.value, from: proj.from, to: proj.to, log: -1 });
  }
  for (const l of proj.logs) {
    if (toks.has(l.address) && ex.has(l.from) && rec.has(l.to) && BigInt(l.amount) > 0n) {
      credits.push({ key: `${chain}:${lc(hash)}:${l.i}`, token: l.address, amount: l.amount, from: l.from, to: l.to, log: l.i });
    }
  }
  if (credits.length === 0) return { reason: "NO_RETURN_TO_RECOVERY" };
  const fresh = credits.filter((c) => !used.has(c.key));
  if (fresh.length === 0) return { reason: "ALREADY_COUNTED" };
  return { credits: fresh };
}

/** sum over tokens of min(returned, stolen) * weight / sum(stolen * weight), as parts per million (floor). */
export function fractionPpm(tokens, returnedByKey) {
  let num = 0n, den = 0n;
  for (const t of tokens) {
    const scale = 10n ** BigInt(18 - t.decimals);
    const stolen = BigInt(t.stolen) * scale, w = BigInt(t.weight);
    const got = BigInt(returnedByKey[`${t.chain}:${lc(t.token)}`] ?? 0) * scale;
    num += (got < stolen ? got : stolen) * w;
    den += stolen * w;
  }
  return den === 0n ? 0n : (num * 1_000_000n) / den;
}
