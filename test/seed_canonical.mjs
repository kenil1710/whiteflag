/**
 * Seeds the CANONICAL registry with every incident in data/incidents.json:
 * one offer per incident with its real exploiter and recovery addresses, real
 * stolen amounts, the real public bounty share and window, and a symbolic
 * 1 GEN bounty; then every real return transaction and every known
 * non-return as proofs. Alchemix: the alETH sent to Curve's address is
 * submitted first (rejected), Curve's address is added (the protocol's power),
 * and the same transaction is submitted again (counted) - 100% returned, so
 * it is settled at once. Everything else is settled by the keeper after the
 * offer's settle time; owed bounties nobody claims are refunded by the
 * keeper after the 1 h claim window.
 *
 *   node seed_canonical.mjs            idempotent: re-running skips what is done
 * Record: docs/seed-canonical.json
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { client, deployments } from "../tools/lib/wf.mjs";
import { accounts } from "./harness.mjs";

const root = new URL("..", import.meta.url);
const data = JSON.parse(readFileSync(new URL("data/incidents.json", root), "utf8"));
const reg = deployments().contracts.WhiteFlagRegistry.address;
const acc = accounts();
const P = client({ role: "protocol", address: reg });
const V = client({ role: "prover", address: reg });
const recPath = new URL("docs/seed-canonical.json", root);
const rec = existsSync(recPath) ? JSON.parse(readFileSync(recPath, "utf8")) : { registry: reg, protocol: acc.protocol.address, incidents: {} };
if (rec.registry !== reg) throw new Error("docs/seed-canonical.json belongs to another registry");
const save = () => writeFileSync(recPath, JSON.stringify(rec, null, 2) + "\n");
const epoch = (iso) => Math.floor(Date.parse(iso) / 1000);
const BOUNTY = 10n ** 18n;

async function findOffer(incident) {
  for (let off = 0; ; ) {
    const p = await P.view("get_offers", [off, 50]);
    const hit = p.items.find((o) => o.incident === incident && o.protocol === acc.protocol.address.toLowerCase());
    if (hit) return hit.offer_id;
    if (p.next_offset === -1) return 0;
    off = p.next_offset;
  }
}

async function proofs(oid, items, label, { again = false } = {}) {
  // skip what is already recorded (counted, or rejected unless `again`)
  const done = new Set((await allProofs(oid)).filter((p) => !again || p.status === "COUNTED").map((p) => p.chain + ":" + p.tx_hash));
  const todo = items.filter((x) => !done.has(x[0] + ":" + x[1]));
  for (let i = 0; i < todo.length; i += 5) {
    const batch = todo.slice(i, i + 5);
    const r = await V.write("submit_proofs", [oid, JSON.stringify(batch)]);
    console.log(`  ${label} batch ${i / 5 + 1}: ${r.status} ${r.reason ? r.reason.slice(0, 120) : ""} ${r.hash}`);
    (rec.incidents[label].txs ??= []).push({ fn: "submit_proofs", hash: r.hash, status: r.status, items: batch });
    save();
  }
}

async function allProofs(oid) {
  const out = [];
  for (let off = 0; ; ) {
    const p = await P.view("get_proofs", [oid, off, 50]);
    out.push(...p.items);
    if (p.next_offset === -1) return out;
    off = p.next_offset;
  }
}

for (const inc of data.incidents) {
  const r = (rec.incidents[inc.id] ??= { case_no: inc.case_no, name: inc.name });
  let oid = r.offer_id || (await findOffer(inc.id));
  if (!oid) {
    const recov = inc.recoveries.filter((x) => !x.added_later).map(({ chain, address }) => ({ chain, address }));
    const meta = { case_no: inc.case_no, hack_date: inc.hack_date, message_tx: inc.offer.message_tx, source: inc.offer.sources[0], deadline_basis: inc.offer.deadline_basis };
    const res = await P.write("create_offer", [inc.id, inc.name, JSON.stringify(inc.chains),
      JSON.stringify(inc.exploiters.map(({ chain, address }) => ({ chain, address }))), JSON.stringify(recov),
      JSON.stringify(inc.tokens.map(({ chain, token, symbol, decimals, stolen, weight }) => ({ chain, token, symbol, decimals, stolen, weight: String(weight) }))),
      inc.bounty_share_bps, epoch(inc.offer.start), epoch(inc.offer.deadline), "EXPLOITER_OR_NAMED", JSON.stringify(meta)], { value: BOUNTY });
    console.log(`#${inc.case_no} ${inc.name}: create ${res.status} ${res.hash}`);
    (r.txs ??= []).push({ fn: "create_offer", hash: res.hash, status: res.status });
    oid = await findOffer(inc.id);
    if (!oid) throw new Error("offer not found after create: " + inc.id);
  }
  r.offer_id = oid;
  save();
  const o = await P.view("get_offer", [oid]);
  console.log(`#${inc.case_no} ${inc.name}: offer ${oid} ${o.status} settle_at ${new Date(o.settle_at * 1000).toISOString()}`);
  if (o.status !== "OPEN") continue;

  const late = inc.recoveries.filter((x) => x.added_later);
  const lateTx = inc.id === "alchemix-aleth-2023" ? "0xd83072cfc1126e23f18d13529c8fa832015a06f0a6988c65f53b4a8a0c403665" : null;
  const items = [...inc.returns, ...inc.rejects].map((x) => [x.chain, x.hash]).filter((x) => x[1] !== lateTx);
  if (items.length) await proofs(oid, items, inc.id);
  if (late.length) {
    const have = (await P.view("get_offer", [oid])).recoveries.map((x) => x.chain + ":" + x.address);
    // the return to Curve's address, before Curve's address is on the offer: rejected
    if (!(await allProofs(oid)).some((p) => p.tx_hash === lateTx)) await proofs(oid, [["ethereum", lateTx]], inc.id);
    for (const a of late) {
      if (have.includes(a.chain + ":" + a.address)) continue;
      const res = await P.write("add_recovery", [oid, a.chain, a.address]);
      console.log(`  add_recovery ${a.address}: ${res.status} ${res.hash}`);
      r.txs.push({ fn: "add_recovery", hash: res.hash, status: res.status });
      save();
    }
    await proofs(oid, [["ethereum", lateTx]], inc.id, { again: true });
  }
  const after = await P.view("get_offer", [oid]);
  console.log(`  returned ${after.fraction_ppm / 1e4}%  counted ${after.n_counted}  rejected ${after.n_rejected}`);
  if (after.fraction_ppm >= 1_000_000 && after.status === "OPEN") {
    const res = await P.write("settle", [oid]);  // 100%: no refund, nothing to send
    console.log(`  settle (100%) ${res.status} ${res.reason} ${res.hash}`);
    r.txs.push({ fn: "settle", hash: res.hash, status: res.status });
    save();
  }
}
console.log("\nseeded; the keeper settles the rest after their settle times and refunds unclaimed bounties after the claim window");
