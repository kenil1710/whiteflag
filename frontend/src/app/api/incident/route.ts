/**
 * GET /api/incident?id=<offer id>[&r=demo][&format=svg]
 * One incident read from chain: the registry's offer and the SafeHarborGate's
 * answer. JSON by default, an SVG badge with format=svg. Nothing is filled in
 * when the chain does not answer: the response is an error.
 */
import { asReg, gateAddr, regAddr } from "@/lib/deployments";
import { gateCheck, offer } from "@/lib/server";
import { incidentInfo } from "@/lib/format";

export const dynamic = "force-dynamic";

const esc = (s: string) => s.replace(/[<>&"']/g, "");
function badge(label: string, value: string, color: string, ink: string) {
  const lw = 10 + label.length * 6.4, vw = 12 + value.length * 6.9, w = Math.round(lw + vw);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="22" role="img" aria-label="${esc(label)}: ${esc(value)}">
<rect width="${w}" height="22" fill="#f4f1ea" stroke="#15130f" stroke-width="1"/><rect x="${Math.round(lw)}" y="0.5" width="${Math.round(vw) - 0.5}" height="21" fill="${color}"/>
<g font-family="IBM Plex Mono,Menlo,monospace" font-size="11"><text x="7" y="15" fill="#15130f">${esc(label)}</text>
<text x="${Math.round(lw) + 6}" y="15" fill="${ink}">${esc(value)}</text></g></svg>`;
}
const COLORS: Record<string, [string, string]> = {
  OPEN: ["#ff4f00", "#15130f"], SETTLED_FULL: ["#3f7550", "#f4f1ea"], SETTLED_PARTIAL: ["#3f7550", "#f4f1ea"],
  SETTLED_NONE: ["#a39d90", "#15130f"], NO_OFFER: ["#a39d90", "#15130f"], UNREADABLE: ["#a39d90", "#15130f"],
};

export async function GET(req: Request) {
  const u = new URL(req.url);
  const id = Number(u.searchParams.get("id"));
  const r = asReg(u.searchParams.get("r"));
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "id must be a positive integer" }, { status: 400 });
  try {
    const [o, g] = await Promise.all([offer(regAddr(r), id), gateCheck(gateAddr(r), id)]);
    if (u.searchParams.get("format") === "svg") {
      const state = o.found ? o.status : "NO_OFFER";
      const value = !o.found ? "no offer" : o.status === "OPEN" ? `open · ${(o.fraction_ppm / 1e4).toFixed(1)}% back` : `${state.slice(8).toLowerCase()} · ${(o.fraction_ppm / 1e4).toFixed(1)}% back`;
      const [c, ink] = COLORS[state] ?? COLORS.UNREADABLE;
      return new Response(badge("whiteflag #" + id, value, c, ink), { headers: { "content-type": "image/svg+xml", "cache-control": "public, s-maxage=60" } });
    }
    if (!o.found) return Response.json({ id, registry: regAddr(r), found: false, gate: g }, { status: 404 });
    const info = incidentInfo(o);
    return Response.json({
      id, registry: regAddr(r), incident: o.incident, name: o.name, status: o.status, fraction_ppm: o.fraction_ppm,
      bounty: o.bounty, owed: o.owed, paid: o.claimed, shares: o.shares, claims: o.claims, refunded: (BigInt(o.refunded_at_settle) + BigInt(o.unclaimed_refunded)).toString(),
      window: { start: o.start, deadline: o.deadline, settle_at: o.settle_at, settled_at: o.settled_at, claim_deadline: o.claim_deadline },
      bounty_share_bps: o.bounty_share_bps, payout_rule: o.payout_rule, chains: o.chains, exploiters: o.exploiters, recoveries: o.recoveries,
      tokens: o.tokens, returned: o.returned, proofs: { total: o.n_proofs, counted: o.n_counted, rejected: o.n_rejected },
      gate: g, offer_message: info?.offer.message_tx ?? null, read_at: Math.floor(Date.now() / 1000), page: `${u.origin}/incident/${id}${r === "demo" ? "?r=demo" : ""}`,
    }, { headers: { "cache-control": "public, s-maxage=30" } });
  } catch (e) {
    return Response.json({ error: "chain unreadable: " + String((e as Error).message).slice(0, 200) }, { status: 502 });
  }
}
