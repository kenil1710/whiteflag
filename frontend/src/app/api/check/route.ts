/**
 * GET /api/check?r=<canonical|demo>&offer=<id>&items=<chain:hash,...>
 * The live pre-check behind "Prove a return": each transaction read from the
 * same two RPCs per chain the validators use, judged by the same rule
 * (lib/verify.mjs, copied from tools/lib/verify.mjs; test_meaning checks it
 * against the contract). Advisory only: the validators' reading is what counts.
 */
import { asReg, regAddr } from "@/lib/deployments";
import { allProofs, offer } from "@/lib/server";
// @ts-expect-error plain ES module shared with the repository's tools
import { readBoth, judge } from "@/lib/verify.mjs";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const u = new URL(req.url);
  const r = asReg(u.searchParams.get("r"));
  const id = Number(u.searchParams.get("offer"));
  const items = (u.searchParams.get("items") ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 5)
    .map((s) => { const [c, h] = s.split(":"); return { chain: (c ?? "").toLowerCase(), hash: (h ?? "").toLowerCase() }; });
  if (!Number.isInteger(id) || id <= 0 || items.length === 0) return Response.json({ error: "offer and items required" }, { status: 400 });
  const o = await offer(regAddr(r), id);
  if (!o.found) return Response.json({ error: "no such offer" }, { status: 404 });
  const used = new Set<string>();
  for (const p of await allProofs(regAddr(r), id)) for (const c of p.credits) used.add(c.key);
  const results = [];
  for (const it of items) {
    if (!o.chains.includes(it.chain)) { results.push({ ...it, verdict: "CHAIN_NOT_IN_OFFER" }); continue; }
    const b = await readBoth(it.chain, it.hash);
    if (b.reason) { results.push({ ...it, verdict: b.reason, detail: b.detail ?? "" }); continue; }
    const j = judge(o, it.chain, it.hash, b.proj, b.finalized, used);
    results.push({ ...it, verdict: j.reason ?? "WOULD_COUNT", credits: j.credits ?? [], block: b.proj.block, time: b.proj.time, from: b.proj.from, to: b.proj.to, status: b.proj.status, finalized: b.finalized });
  }
  return Response.json({ offer: id, status: o.status, results, read_at: Math.floor(Date.now() / 1000) }, { headers: { "cache-control": "no-store" } });
}
