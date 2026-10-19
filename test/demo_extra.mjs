/**
 * Two rejection reasons the main demo's catalogue could not show, because the
 * rule checks finality and the time window first:
 *   F  NOT_FINALIZED: a transaction from Ethereum's latest block, proved at
 *      once (Ethereum finalizes about 13 minutes later), on an offer whose
 *      window covers it;
 *   G  SENDER_NOT_EXPLOITER: a real return to Seneca's Safe, inside the
 *      window, on an offer that lists a different exploiter address.
 * Both offers then settle with nothing counted; the bounties are refunded and
 * checked at the recipient, so the registry's balance returns to 0.
 * Appends to docs/demo-run.json, docs/payouts.json, docs/demo-run.log.
 */
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { client, deployments, balanceOf, finalized, payoutDelivered } from "../tools/lib/wf.mjs";
import { checkBalances } from "../tools/lib/payout.mjs";
import { accounts, sleep } from "./harness.mjs";

const root = new URL("..", import.meta.url);
const reg = deployments().contracts.WhiteFlagRegistryDemo.address;
const acc = accounts();
const prot = acc.protocol.address.toLowerCase();
const P = client({ role: "protocol", address: reg }), V = client({ role: "prover", address: reg }), K = client({ role: "keeper", address: reg });
const run = JSON.parse(readFileSync(new URL("docs/demo-run.json", root), "utf8"));
const log = (s) => { console.log(s); appendFileSync(new URL("docs/demo-run.log", root), s + "\n"); };
const save = () => {
  writeFileSync(new URL("docs/demo-run.json", root), JSON.stringify(run, null, 2) + "\n");
  writeFileSync(new URL("docs/payouts.json", root), JSON.stringify({ registry: reg, payouts: run.payouts }, null, 2) + "\n");
};
const now = () => Math.floor(Date.now() / 1000);
const B = 10n ** 17n;
const sent = [];
async function step(label, who, fn, args, opts = {}) {
  const r = await who.write(fn, args, opts);
  if (r.hash) sent.push(r.hash);
  log(`${label}: ${fn} ${r.status}${r.reason ? " " + r.reason.slice(0, 160) : ""} ${r.hash ?? ""}`);
  run.steps.push({ label, fn, args, status: r.status, ok: r.ok, reason: r.reason, hash: r.hash });
  save();
  return r;
}
async function create(label, args) {
  const n0 = (await P.view("get_stats")).offers;
  await step(label, P, "create_offer", args, { value: B });
  const n1 = (await P.view("get_stats")).offers;
  if (n1 !== n0 + 1) throw new Error(label + " not created");
  run.offers[label] = n1;
  save();
  return n1;
}
async function paid(label, who, fn, args, payee, amount, payeeSent) {
  for (const h of sent.splice(0)) await finalized(K.read, h);
  const rb = await balanceOf(reg), pb = await balanceOf(payee);
  const r = await step(label, who, fn, args, { payee });
  const tx = await finalized(K.read, r.hash);
  const d = payoutDelivered(tx, payee, amount);
  const ra = await balanceOf(reg), pa = await balanceOf(payee);
  const bal = checkBalances({ contractBefore: rb, contractAfter: ra, payeeBefore: pb, payeeAfter: pa, amount, netFee: d.netFee ?? 0n, payeeSent });
  run.payouts.push({ label, tx: r.hash, status: tx?.statusName, payee, amount: String(amount), delivered: d.ok, why: d.why, registry_delta: String(ra - rb),
    payee_delta: String(pa - pb), payee_paid_fee: payeeSent, net_fee: String(d.netFee ?? 0n), balances_ok: bal === "", balances_why: bal });
  save();
  log(`  PAYOUT ${label}: ${amount} wei to ${payee}: ${tx?.statusName}, delivered=${d.ok}, registry Δ ${ra - rb}, payee Δ ${pa - pb} ${bal === "" ? "BALANCES OK" : bal}`);
}
async function refundAt(label, id) {
  let o = await P.view("get_offer", [id]);
  while (now() < o.settle_at + 3) { log(`  waiting ${o.settle_at + 3 - now()} s for ${label}'s settle time`); await sleep(Math.min(30, o.settle_at + 5 - now()) * 1000); }
  await paid(`${label}-settle-refund-all`, K, "settle", [id], prot, BigInt(o.bounty), false);
}

// ---- finish the main run: the gate in every state, then close E ----------------------
const gate = deployments().contracts.SafeHarborGateDemo.address;
const G = client({ role: "stranger", address: gate });
const X = client({ role: "exploiter", address: reg });
const { a, b, c } = { a: run.offers["A-full"], b: run.offers["B-partial"], c: run.offers["C-none"] };
const e = run.offers["E-rejections"];
run.gate_states = [];
for (const [label, id] of [["NO_OFFER", 999], ["OPEN", e], ["SETTLED_FULL", a], ["SETTLED_PARTIAL", b], ["SETTLED_NONE", c]]) {
  const s = await G.view("check", [id]);
  log(`gate check(${id}) expected ${label}: ${s.state}, favorable ${s.favorable}, ${s.fraction_ppm / 1e4}%, why: ${s.why}`);
  run.gate_states.push({ expected: label, offer: id, state: s.state, favorable: s.favorable, fraction_ppm: s.fraction_ppm, why: s.why });
  await step(`gate-attest-${label}`, G, "attest", [id]);
}
const wrongProto = await G.view("check_for", [a, acc.stranger.address]);
const rightProto = await G.view("check_for", [a, acc.protocol.address]);
log(`gate check_for(A, stranger) favorable ${wrongProto.favorable} (${wrongProto.why}); check_for(A, protocol) favorable ${rightProto.favorable}`);
run.gate_states.push({ expected: "check_for wrong protocol", offer: a, state: wrongProto.state, favorable: wrongProto.favorable }, { expected: "check_for right protocol", offer: a, state: rightProto.state, favorable: rightProto.favorable });
save();
{
  let o = await P.view("get_offer", [e]);
  while (now() < o.settle_at + 3) { log(`  waiting ${o.settle_at + 3 - now()} s for E's settle time`); await sleep(Math.min(30, o.settle_at + 5 - now()) * 1000); }
  for (const h of sent.splice(0)) await finalized(K.read, h);
  const rest = BigInt(o.bounty) - (BigInt(o.bounty) * BigInt(o.num)) / BigInt(o.den);
  await paid("E-settle-refund", K, "settle", [e], prot, rest, false);
  o = await P.view("get_offer", [e]);
  if (BigInt(o.owed) > 0n) await paid("E-claim-to-payee", X, "claim", [e, acc.payee.address.toLowerCase()], acc.payee.address.toLowerCase(), BigInt(o.owed), false);
}

// F: NOT_FINALIZED
const ethRpc = "https://eth-mainnet.public.blastapi.io";
const call = async (m, p) => (await (await fetch(ethRpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }) })).json()).result;
const head = await call("eth_getBlockByNumber", ["latest", true]);
const fresh = head.transactions.find((t) => t.to && BigInt(t.value) > 0n && t.from.toLowerCase() !== t.to.toLowerCase()) ?? head.transactions.find((t) => t.to);
log(`F: Ethereum tx ${fresh.hash} in block ${parseInt(head.number, 16)} (latest, not finalized) from ${fresh.from} to ${fresh.to}`);
const f = await create("F-not-finalized", ["demo-not-finalized", "Unfinalized block (demo)", JSON.stringify(["ethereum"]),
  JSON.stringify([{ chain: "ethereum", address: fresh.from.toLowerCase() }]), JSON.stringify([{ chain: "ethereum", address: fresh.to.toLowerCase() }]),
  JSON.stringify([{ chain: "ethereum", token: "native", symbol: "ETH", decimals: 18, stolen: "1000000000000000000000000", weight: "300000" }]),
  1000, now() - 3600, now() + 240, "EXPLOITER_OR_NAMED", JSON.stringify({ demo: true })]);
await step("F-proof", V, "submit_proofs", [f, JSON.stringify([["ethereum", fresh.hash.toLowerCase()]])]);

// G: SENDER_NOT_EXPLOITER
const g = await create("G-sender-not-exploiter", ["demo-sender-not-exploiter", "Sender not listed (demo)", JSON.stringify(["ethereum"]),
  JSON.stringify([{ chain: "ethereum", address: "0xdce5d6b41c32f578f875efffc0d422c57a75d7d8" }]), JSON.stringify([{ chain: "ethereum", address: "0xb7af0aa318706d94469d8d851015f9aa12d9c53a" }]),
  JSON.stringify([{ chain: "ethereum", token: "native", symbol: "ETH", decimals: 18, stolen: "1836993670758298535257", weight: "338000" }]),
  2000, Math.floor(Date.parse("2024-02-29T00:17:23Z") / 1000), Math.floor(Date.parse("2024-03-07T00:17:23Z") / 1000), "EXPLOITER_OR_NAMED", JSON.stringify({ demo: true })]);
await step("G-proof", V, "submit_proofs", [g, JSON.stringify([["ethereum", "0xab7f14e2b75e70c8b136c8facb7a94d1947b812749660d0cb961e1a0db7c2f64"]])]);

for (const id of [f, g]) {
  const p = (await P.view("get_proofs", [id, 0, 10])).items;
  for (const x of p) { log(`  offer ${id} proof #${x.proof_id} ${x.tx_hash.slice(0, 12)}: ${x.status} ${x.reason}`); run.rejections.push({ proof_id: x.proof_id, chain: x.chain, tx: x.tx_hash, status: x.status, reason: x.reason, detail: x.detail }); }
}
save();
await refundAt("F", f);
await refundAt("G", g);
await sleep(20000);
const bal = await balanceOf(reg), st = await P.view("get_stats");
run.final = { registry_balance: String(bal), stats: st, finished_at: new Date().toISOString() };
save();
log(`\nregistry eth_getBalance ${bal} wei; held ${st.held}; payouts ${run.payouts.length}, delivered ${run.payouts.filter((p) => p.delivered).length}, balances ok ${run.payouts.filter((p) => p.balances_ok).length}`);
