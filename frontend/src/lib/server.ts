/**
 * Server-side reads from Studio Dev (pages and API routes). Every number on
 * the site comes from one of these views. Reads are bounded: lists are read one
 * page at a time (never "everything"), identical reads are cached for 15 s per
 * instance (a bounded LRU), and a read that hits Studio's per-IP rate limit is
 * retried with exponential backoff and jitter.
 */
import "server-only";
import { createClient } from "genlayer-js";
import { studioDevnet } from "genlayer-js/chains";
import type { Offer, OfferSummary, Page, Proof, GateState } from "./types";

const client = createClient({ chain: studioDevnet });

export function plain(v: unknown): unknown {
  if (v instanceof Map) return Object.fromEntries([...v.entries()].map(([k, x]) => [String(k), plain(x)]));
  if (Array.isArray(v)) return v.map(plain);
  if (typeof v === "bigint") return Number(v) <= Number.MAX_SAFE_INTEGER ? Number(v) : v.toString();
  return v;
}

/** Studio meters reads per IP per minute: identical reads within 15 s are served once per instance. */
const memo = new Map<string, { at: number; value: unknown }>();
const MEMO_MS = 15_000;
const MEMO_MAX = 2000;
/** offers per page on the board, proofs per page on an incident (the contract's own page cap is 50) */
export const OFFERS_PER_PAGE = 12;
export const PROOFS_PER_PAGE = 25;

export const isRateLimit = (e: unknown) => /rate limit|-32029|429|too many requests/i.test(String((e as Error)?.message ?? e));
/** Exponential backoff with jitter: 1.5 s, 3 s, 6 s, 12 s, 24 s (+ up to 30%) after a rate limit; short and linear otherwise. */
export const backoffMs = (attempt: number, limited: boolean) =>
  limited ? Math.round(1500 * 2 ** attempt * (1 + Math.random() * 0.3)) : 600 * (attempt + 1);

export async function view<T>(address: string, fn: string, args: unknown[] = []): Promise<T> {
  const key = `${address.toLowerCase()}|${fn}|${JSON.stringify(args)}`;
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < MEMO_MS) {
    memo.delete(key);
    memo.set(key, hit);                       // most recently used last
    return hit.value as T;
  }
  let last: unknown;
  for (let i = 0; i < 5; i++) {
    try {
      const r = await client.readContract({ address: address as `0x${string}`, functionName: fn, args: args as never });
      const value = (typeof r === "string" ? JSON.parse(r) : plain(r)) as T;
      while (memo.size >= MEMO_MAX) memo.delete(memo.keys().next().value as string);
      memo.set(key, { at: Date.now(), value });
      return value;
    } catch (e) {
      last = e;
      await new Promise((res) => setTimeout(res, backoffMs(i, isRateLimit(e))));
    }
  }
  throw last;
}

/** One page of the board, newest offers first: page 0 holds the latest OFFERS_PER_PAGE. */
export async function offersPage(reg: string, page: number): Promise<{ total: number; pages: number; page: number; items: OfferSummary[] }> {
  const head = await view<Page<OfferSummary>>(reg, "get_offers", [0, 1]);
  const total = head.total;
  const pages = Math.max(1, Math.ceil(total / OFFERS_PER_PAGE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const end = total - p * OFFERS_PER_PAGE;
  const start = Math.max(0, end - OFFERS_PER_PAGE);
  const items = end > 0 ? (await view<Page<OfferSummary>>(reg, "get_offers", [start, end - start])).items : [];
  return { total, pages, page: p, items: items.reverse() };
}

/** One page of an offer's proofs (offset, at most PROOFS_PER_PAGE). */
export const proofsPage = (reg: string, id: number, offset: number) =>
  view<Page<Proof> & { found: boolean }>(reg, "get_proofs", [id, Math.max(0, offset), PROOFS_PER_PAGE]);

/** At most `maxPages` pages of 50 proofs: bounded, for the live check's "already counted" advice. */
export async function proofsBounded(reg: string, id: number, maxPages = 10): Promise<{ items: Proof[]; complete: boolean }> {
  const items: Proof[] = [];
  for (let off = 0, n = 0; n < maxPages; n++) {
    const p = await view<Page<Proof> & { found: boolean }>(reg, "get_proofs", [id, off, 50]);
    items.push(...p.items);
    if (p.next_offset === -1 || !p.found) return { items, complete: true };
    off = p.next_offset;
  }
  return { items, complete: false };
}

export const offer = (reg: string, id: number) => view<Offer>(reg, "get_offer", [id]);
export const gateCheck = (gate: string, protocol: string, incident: string) => view<GateState>(gate, "check_for", [protocol, incident]);
export const stats = (reg: string) => view<Record<string, unknown>>(reg, "get_stats", []);
export const config = (reg: string) => view<Record<string, unknown>>(reg, "get_config", []);

/** eth_getBalance on Studio Dev, wei. */
export async function balanceOf(address: string): Promise<bigint> {
  const r = await fetch(studioDevnet.rpcUrls.default.http[0], { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [address, "latest"] }), cache: "no-store" });
  const j = await r.json();
  return BigInt(j.result ?? "0x0");
}
