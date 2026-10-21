/**
 * Server-side reads from Studio Dev (pages and API routes). Every number on
 * the site comes from one of these views; nothing is cached longer than the
 * page's revalidate window.
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

export async function view<T>(address: string, fn: string, args: unknown[] = []): Promise<T> {
  const key = `${address.toLowerCase()}|${fn}|${JSON.stringify(args)}`;
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < MEMO_MS) return hit.value as T;
  let last: unknown;
  for (let i = 0; i < 5; i++) {
    try {
      const r = await client.readContract({ address: address as `0x${string}`, functionName: fn, args: args as never });
      const value = (typeof r === "string" ? JSON.parse(r) : plain(r)) as T;
      if (memo.size > 2000) memo.clear();
      memo.set(key, { at: Date.now(), value });
      return value;
    } catch (e) {
      last = e;
      // a per-minute rate limit needs the minute to roll over; other noise does not
      const limited = /rate limit|-32029|429/i.test(String((e as Error)?.message ?? e));
      await new Promise((res) => setTimeout(res, limited ? 12_000 : 900 * (i + 1)));
    }
  }
  throw last;
}

/** Every offer, all pages. */
export async function allOffers(reg: string): Promise<OfferSummary[]> {
  const out: OfferSummary[] = [];
  for (let off = 0; ; ) {
    const p = await view<Page<OfferSummary>>(reg, "get_offers", [off, 50]);
    out.push(...p.items);
    if (p.next_offset === -1) return out;
    off = p.next_offset;
  }
}

export async function allProofs(reg: string, id: number): Promise<Proof[]> {
  const out: Proof[] = [];
  for (let off = 0; ; ) {
    const p = await view<Page<Proof> & { found: boolean }>(reg, "get_proofs", [id, off, 50]);
    out.push(...p.items);
    if (p.next_offset === -1 || !p.found) return out;
    off = p.next_offset;
  }
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
