import incidents from "./incidents.json";
import type { Offer, OfferSummary, Token } from "./types";

export const CHAIN_LABEL: Record<string, string> = { ethereum: "Ethereum", arbitrum: "Arbitrum One", wfdemo: "WhiteFlag demo chain" };
export const EXPLORERS: Record<string, string> = { ethereum: "https://etherscan.io", arbitrum: "https://arbiscan.io" };
export const txLink = (chain: string, h: string) => chain === "wfdemo" ? `/api/demochain/a?tx=${h}` : `${EXPLORERS[chain] ?? ""}/tx/${h}`;
export const addrLink = (chain: string, a: string) => chain === "wfdemo" ? `https://explorer-studio-dev.genlayer.com/address/${a}` : `${EXPLORERS[chain] ?? ""}/address/${a}`;
export const studioTx = (h: string) => `https://explorer-studio-dev.genlayer.com/tx/${h}`;
export const studioAddr = (a: string) => `https://explorer-studio-dev.genlayer.com/address/${a}`;

export const short = (a: string, n = 6) => (a && a.length > 2 * n + 2 ? `${a.slice(0, n + 2)}…${a.slice(-n)}` : a);

/** base units -> decimal string with up to `dp` decimals and thousands separators */
export function units(v: string | bigint, decimals = 18, dp = 4): string {
  const b = BigInt(v);
  const neg = b < 0n;
  const a = neg ? -b : b;
  const s = a.toString().padStart(decimals + 1, "0");
  const int = s.slice(0, s.length - decimals) || "0";
  let frac = decimals ? s.slice(s.length - decimals) : "";
  frac = frac.slice(0, dp).replace(/0+$/, "");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (neg ? "-" : "") + grouped + (frac ? "." + frac : "");
}
export const gen = (wei: string | bigint, dp = 4) => units(wei, 18, dp);
export const pct = (ppm: number, dp = 2) => (ppm / 10_000).toFixed(dp) + "%";

/** USD at the protocol's frozen weights (weight = cents per whole token). */
export function usd(tokens: Token[], amountOf: (t: Token) => bigint): number {
  let cents = 0;
  for (const t of tokens) cents += (Number(amountOf(t)) / 10 ** t.decimals) * Number(t.weight);
  return cents / 100;
}
export function money(n: number): string {
  if (n >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return "$" + (n / 1e3).toFixed(1) + "K";
  return "$" + n.toFixed(2);
}

export const iso = (t: number) => (t ? new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "—");
export const day = (t: number) => (t ? new Date(t * 1000).toISOString().slice(0, 10) : "—");
export function dur(s: number): string {
  s = Math.max(0, Math.floor(s));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

export const STATUS_LABEL: Record<string, string> = {
  OPEN: "Open", SETTLED_FULL: "Settled · full", SETTLED_PARTIAL: "Settled · partial", SETTLED_NONE: "Settled · none",
};

export type IncidentInfo = (typeof incidents.incidents)[number];
export function incidentInfo(o: Pick<OfferSummary, "incident">): IncidentInfo | undefined {
  return incidents.incidents.find((i) => i.id === o.incident);
}
export const caseNo = (o: OfferSummary) => {
  const n = Number((o.meta as { case_no?: number })?.case_no ?? o.offer_id);
  return String(n).padStart(2, "0");
};

/** What happens next, and when. */
export function nextEvent(o: OfferSummary, now: number): { label: string; at: number } | null {
  if (o.status === "OPEN") {
    if (o.fraction_ppm >= 1_000_000) return { label: "Settles on the next call", at: now };
    if (o.n_pending > 0 && now >= o.settle_at) return { label: `Recovery window: ${o.n_pending} PENDING proof(s) can be retried by anyone; settles at the latest`, at: o.recover_until };
    return { label: o.n_pending > 0 ? "Submissions close (settlement waits for PENDING proofs, at most until the recovery window ends)" : "Settles", at: o.settle_at };
  }
  if (BigInt(o.owed) > BigInt(o.claimed) && o.unclaimed_refunded === "0") {
    return now <= o.claim_deadline ? { label: "Claim window closes", at: o.claim_deadline } : { label: "Unclaimed bounty refundable", at: o.claim_deadline };
  }
  return null;
}

export function returnedOf(o: Offer, t: Token): bigint {
  return BigInt(o.returned[`${t.chain}:${t.token}`] ?? "0");
}
