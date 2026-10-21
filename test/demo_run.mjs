/**
 * Every path on the DEMO registry (claim window 3 min), with real return
 * transactions and the demo exploiter key listed next to the real exploiter
 * addresses so claims can be signed:
 *
 *   A  full return, settled early at 100%, claimed to a named payout address
 *   B  partial return (Arbitrum FRAX), remainder refunded at settlement, a
 *      stranger's claim refused, claimed by the second exploiter address to itself
 *   C  nothing returned: the whole bounty refunded at settlement
 *   D  partial return, nobody claims, refunded after the claim window
 *   E  the rejection catalogue: every rejection reason that can be produced
 *      live, the protocol's two powers, then settled with nothing counted
 *   plus a refused create_offer credited back and withdrawn, and the gate in
 *   every state (NO_OFFER, OPEN, SETTLED_FULL, SETTLED_PARTIAL, SETTLED_NONE).
 *
 * Every payout is checked at its recipient: the finalized transaction's value
 * message delivered (not skipped) and eth_getBalance deltas of the registry
 * and the recipient. At the end the registry's eth_getBalance must be 0.
 *   node demo_run.mjs        writes docs/demo-run.json, docs/payouts.json, docs/demo-run.log
 */
import { writeFileSync, appendFileSync } from "node:fs";
import { client, deployments, balanceOf, finalized, payoutDelivered } from "../tools/lib/wf.mjs";
import { checkBalances } from "../tools/lib/payout.mjs";
import { accounts, sleep } from "./harness.mjs";

const root = new URL("..", import.meta.url);
const dep = deployments().contracts;
const reg = dep.WhiteFlagRegistryDemo.address, gate = dep.SafeHarborGateDemo.address;
const acc = accounts();
const A = (role) => acc[role].address.toLowerCase();
const P = client({ role: "protocol", address: reg }), X = client({ role: "exploiter", address: reg }), X2 = client({ role: "exploiter2", address: reg });
const V = client({ role: "prover", address: reg }), S = client({ role: "stranger", address: reg }), K = client({ role: "keeper", address: reg });
const G = client({ role: "stranger", address: gate });
const logPath = new URL("docs/demo-run.log", root);
writeFileSync(logPath, `# demo run on ${reg} (gate ${gate}), started ${new Date().toISOString()}\n`);
const log = (s) => { console.log(s); appendFileSync(logPath, s + "\n"); };
const run = { registry: reg, gate_contract: gate, started_at: new Date().toISOString(), offers: {}, steps: [], payouts: [] };
const save = () => {
  writeFileSync(new URL("docs/demo-run.json", root), JSON.stringify(run, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
  writeFileSync(new URL("docs/payouts.json", root), JSON.stringify({ registry: reg, payouts: run.payouts }, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
};
const iso = (s) => Math.floor(Date.parse(s) / 1000);
const now = () => Math.floor(Date.now() / 1000);
const ETH = (wei) => ({ chain: "ethereum", token: "native", symbol: "ETH", decimals: 18, stolen: String(wei), weight: "300000" });

const sent = [];   // every transaction this run sent; payouts are measured only once all of them are final
async function step(label, who, fn, args, opts = {}) {
  const r = await who.write(fn, args, opts);
  if (r.hash) sent.push(r.hash);
  log(`${label}: ${fn} ${r.status}${r.reason ? " " + r.reason.slice(0, 160) : ""} ${r.hash ?? ""}`);
  run.steps.push({ label, fn, args, status: r.status, ok: r.ok, reason: r.reason, hash: r.hash });
  save();
  return r;
}
const offerCount = async () => (await P.view("get_stats")).offers;
async function create(label, args, value) {
  // an offer this script opened before (a rerun) is reused, never duplicated
  for (let off = 0; ;) {
    const pg = await P.view("get_offers", [off, 50]);
    const hit = pg.items.find((x) => x.incident === args[0] && x.status === "OPEN");
    if (hit) { run.offers[label] = hit.offer_id; log(`${label}: reusing open offer ${hit.offer_id}`); return hit.offer_id; }
    if (pg.next_offset === -1) break;
    off = pg.next_offset;
  }
  const n0 = await offerCount();
  const r = await step(label, P, "create_offer", args, { value });
  const n1 = await offerCount();
  if (n1 !== n0 + 1) throw new Error(label + ": offer not created: " + r.reason);
  run.offers[label] = n1;
  return n1;
}
const offer = (id) => P.view("get_offer", [id]);
async function waitUntil(t, why) { while (now() < t) { log(`  waiting ${t - now()} s ${why}`); await sleep(Math.min(30, t - now() + 2) * 1000); } }

/** A payout transaction: final, delivered, balances moved by exactly the amount. */
async function payout(label, r, payee, amount, payeeSent) {
  const regBefore = r.regBefore, payeeBefore = r.payeeBefore;
  const tx = await finalized(K.read, r.hash);
  const d = payoutDelivered(tx, payee, amount);
  const regAfter = await balanceOf(reg), payeeAfter = await balanceOf(payee);
  const bal = checkBalances({ contractBefore: regBefore, contractAfter: regAfter, payeeBefore, payeeAfter, amount, netFee: d.netFee ?? 0n, payeeSent });
  const rec = { label, tx: r.hash, status: tx?.statusName, payee, amount: String(amount), delivered: d.ok, why: d.why, registry_delta: String(regAfter - regBefore),
    payee_delta: String(payeeAfter - payeeBefore), payee_paid_fee: payeeSent, net_fee: String(d.netFee ?? 0n), balances_ok: bal === "", balances_why: bal };
  run.payouts.push(rec); save();
  log(`  PAYOUT ${label}: ${amount} wei to ${payee}: ${tx?.statusName}, delivered=${d.ok}${d.why ? " (" + d.why + ")" : ""}, registry Δ ${rec.registry_delta}, payee Δ ${rec.payee_delta} ${bal === "" ? "BALANCES OK" : "BALANCES: " + bal}`);
  return rec;
}
async function allFinal() {
  for (const h of sent) await finalized(K.read, h);
  sent.splice(0, sent.length);
}
async function paying(label, who, fn, args, payee, amount, payeeSent) {
  await allFinal();   // fee refunds of earlier transactions must not land inside the measurement
  const regBefore = await balanceOf(reg), payeeBefore = await balanceOf(payee);
  const r = await step(label, who, fn, args, { payee });
  if (!r.ok) throw new Error(`${label} failed: ${r.reason}`);
  return payout(label, { ...r, regBefore, payeeBefore }, payee, BigInt(amount), payeeSent);
}

// real transactions
const SENECA_EX = ["0x94641c01a4937f2c8ef930580cf396142a2942dc", "0x5217c6923a4efc5bcf53d9a30ec4b0089f080ed0", "0xe83b072433f025ef06b73e0caa3095133e7c5bd0"];
const SENECA_SAFE = "0xb7af0aa318706d94469d8d851015f9aa12d9c53a";
const SENECA_TX = ["0xab7f14e2b75e70c8b136c8facb7a94d1947b812749660d0cb961e1a0db7c2f64", "0xcf3f1f4d4db1782fa16d34e180c7c632a944e61f60ff7aae4e50bf145b0184f2", "0x8e19428c50722538b0a98690c3621d644543950e9d852adad956a5ee70dd7cd8"];
const SENECA_SUM = 537000000000000000000n + 499996758239285385644n + 499996912519013149613n;
const GMX_EX = "0xdf3340a436c27655ba62f8281565c9925c3a5221", GMX_DEPLOYER = "0x5f799f365fa8a2b60ac0429c48b153ca5a6f0cf8", FRAX = "0x17fc002b466eec40dae837fc4be5c67993ddbd6f";
const GMX_FRAX_TX = "0x62b8450259ee85838c7be3335e659a65be66268a1a5c6792ca731df199211841"; // 5,494,796.17 FRAX
const ALX_EX = "0xdce5d6b41c32f578f875efffc0d422c57a75d7d8", ALX_MS = "0x9e2b6378ee8ad2a4a95fe481d63caba8fb0ebbf9", CURVE = "0xbabe61887f1de2713c6f97e567623453d3c79f67";
const ALX = { eth1000: "0x4ab8367b391ad733ab98433f51f2c4d56cec93941d31c9d19b0e3ff6e8771639", eth1258: "0xfa8560f76f1f4ac1a4ed5bb0bded5afc0e9d7aee8b2e098e3fe92c28088aadec",
  eth2000late: "0xdbf1d8dca9858119e3852d52f18821754640013d9914d692589b13f8181a08e8", failed: "0x7ad3111bb69abd88f4095e2cec8e8c058ad3e17e8ba7fbd538a4828658d564ff",
  alethToCurve: "0xd83072cfc1126e23f18d13529c8fa832015a06f0a6988c65f53b4a8a0c403665", aleth1: "0x4197ed0ef9b60ab1cacdc31d6d3ce06413b333b14b8947be5c0cfe29cb88b088",
  beforeStart: "0x431103213d34873abb561fdd7cc66574af5dc77698ce9515533df3e0d7d3d2cb", eth1test: "0x25bc0a257301b4168e2e1862669c68dacb46aace6921f9efc6dd152c040a45c2" };

const pairs = (chain, list) => JSON.stringify(list.map((address) => ({ chain, address })));
const B = 10n ** 17n; // 0.1 GEN per demo bounty

// ---- a refused create_offer: credited back, withdrawn --------------------------------
{
  const c0 = (await P.view("get_credit", [A("protocol")])).credit;
  await step("refused-create", P, "create_offer", ["bad", "Refused on purpose", JSON.stringify(["ethereum"]), pairs("ethereum", [A("exploiter")]), pairs("ethereum", [A("exploiter")]),
    JSON.stringify([ETH(1)]), 1000, iso("2024-01-01T00:00:00Z"), iso("2024-02-01T00:00:00Z"), "EXPLOITER_OR_NAMED", "{}"], { value: 5n * 10n ** 16n });
  const c1 = (await P.view("get_credit", [A("protocol")])).credit;
  log(`  credited back ${BigInt(c1) - BigInt(c0)} wei (RECOVERY_IS_EXPLOITER)`);
  await paying("withdraw-refund", P, "withdraw_refund", [], A("protocol"), c1, true);
}

// ---- A: full, early settle, claim to a payout address -------------------------------
const a = await create("A-full", ["demo-seneca-full", "Seneca (demo: full return)", JSON.stringify(["ethereum"]), pairs("ethereum", [...SENECA_EX, A("exploiter")]),
  pairs("ethereum", [SENECA_SAFE]), JSON.stringify([ETH(SENECA_SUM)]), 2000, iso("2024-02-29T00:17:23Z"), now() + 86400, "EXPLOITER_OR_NAMED",
  JSON.stringify({ demo: true, note: "stolen set to exactly what came back, so 100% settles early" })], B);
await step("A-proofs", V, "submit_proofs", [a, JSON.stringify(SENECA_TX.map((h) => ["ethereum", h]))]);
let o = await offer(a); log(`  A returned ${o.fraction_ppm / 1e4}% (settle_at ${o.settle_at}, a day away)`);
await step("A-settle-early", S, "settle", [a]);   // 100%: nothing to refund, no payout
o = await offer(a); log(`  A ${o.status} owed ${o.owed}`);
await paying("A-claim-to-payee", X, "claim", [a, A("payee")], A("payee"), o.owed, false);

// ---- B: partial on Arbitrum, refund at settle, stranger refused, claim to self -------
const b = await create("B-partial", ["demo-gmx-partial", "GMX V1 (demo: partial, Arbitrum FRAX)", JSON.stringify(["arbitrum"]), pairs("arbitrum", [GMX_EX, A("exploiter2")]),
  pairs("arbitrum", [GMX_DEPLOYER]), JSON.stringify([{ chain: "arbitrum", token: FRAX, symbol: "FRAX", decimals: 18, stolen: "10494796166294325551571952", weight: "100" }]),
  1000, iso("2025-07-09T14:04:19Z"), iso("2025-07-11T14:04:19Z"), "EXPLOITER_ONLY", JSON.stringify({ demo: true })], B);
await step("B-proof", V, "submit_proofs", [b, JSON.stringify([["arbitrum", GMX_FRAX_TX]])]);
o = await offer(b); await waitUntil(o.settle_at + 3, "for B's settle time");
const bRest = BigInt(o.bounty) - (BigInt(o.bounty) * BigInt(o.num)) / BigInt(o.den);
await paying("B-settle-refund", K, "settle", [b], A("protocol"), bRest, false);
o = await offer(b); log(`  B ${o.status} ${o.fraction_ppm / 1e4}% owed ${o.owed}`);
const refused = await step("B-claim-by-stranger", S, "claim", [b, ""], { payee: A("stranger") });
log(`  stranger's claim: ${refused.ok ? "ACCEPTED (unexpected)" : "refused: " + refused.reason}`);
const refused2 = await step("B-claim-named-under-EXPLOITER_ONLY", X2, "claim", [b, A("payee")], { payee: A("payee") });
log(`  named payout under EXPLOITER_ONLY: ${refused2.ok ? "ACCEPTED (unexpected)" : "refused: " + refused2.reason}`);
await paying("B-claim-to-self", X2, "claim", [b, ""], A("exploiter2"), o.owed, true);

// ---- C: nothing returned, whole bounty back at settlement --------------------------
const c = await create("C-none", ["demo-uwu-none", "UwU Lend (demo: nothing returned)", JSON.stringify(["ethereum"]), pairs("ethereum", ["0x841ddf093f5188989fa1524e7b893de64b421f47", A("exploiter")]),
  pairs("ethereum", ["0xc671a6b1415de6549b05775ee4156074731190c6"]), JSON.stringify([ETH("5292986878286905142739")]), 2000, iso("2024-06-10T17:19:59Z"), iso("2024-06-12T17:00:00Z"), "EXPLOITER_OR_NAMED", JSON.stringify({ demo: true })], B);
o = await offer(c); await waitUntil(o.settle_at + 3, "for C's settle time");
await paying("C-settle-refund-all", K, "settle", [c], A("protocol"), o.bounty, false);
const refusedC = await step("C-claim-nothing-owed", X, "claim", [c, ""], { payee: A("exploiter") });
log(`  claim on SETTLED_NONE: refused: ${refusedC.reason}`);

// ---- D: partial, unclaimed, refunded after the window --------------------------------
const d = await create("D-refund-after-window", ["demo-alchemix-unclaimed", "Alchemix (demo: unclaimed bounty)", JSON.stringify(["ethereum"]), pairs("ethereum", [ALX_EX, A("exploiter")]),
  pairs("ethereum", [ALX_MS]), JSON.stringify([ETH("7258000000000000000000")]), 1000, iso("2023-08-03T19:21:59Z"), iso("2023-08-06T08:00:00Z"), "EXPLOITER_OR_NAMED", JSON.stringify({ demo: true })], B);
await step("D-proofs", V, "submit_proofs", [d, JSON.stringify([["ethereum", ALX.eth1000], ["ethereum", ALX.eth1258]])]);
o = await offer(d); await waitUntil(o.settle_at + 3, "for D's settle time");
const dRest = BigInt(o.bounty) - (BigInt(o.bounty) * BigInt(o.num)) / BigInt(o.den);
await paying("D-settle-refund-remainder", K, "settle", [d], A("protocol"), dRest, false);
o = await offer(d);
const early = await step("D-refund-inside-window", S, "refund_unclaimed", [d], { payee: A("protocol") });
log(`  refund inside the window: ${early.ok ? "ACCEPTED (unexpected)" : "refused: " + early.reason}`);
await waitUntil(o.claim_deadline + 5, "for D's claim window to close");
const late = await step("D-claim-after-window", X, "claim", [d, ""], { payee: A("exploiter") });
log(`  claim after the window: ${late.ok ? "ACCEPTED (unexpected)" : "refused: " + late.reason}`);
await paying("D-refund-unclaimed", S, "refund_unclaimed", [d], A("protocol"), o.owed, false);

// ---- E: the rejection catalogue -------------------------------------------------------
// an Arbitrum transaction from the last few blocks: its block is not finalized yet
const arbRpc = "https://arb1.arbitrum.io/rpc";
const rpcCall = async (m, p) => (await (await fetch(arbRpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }) })).json()).result;
const head = await rpcCall("eth_getBlockByNumber", ["latest", true]);
const fresh = head.transactions.find((t) => t.to && BigInt(t.value) > 0n && t.from.toLowerCase() !== t.to.toLowerCase()) ?? head.transactions.find((t) => t.to);
log(`E: fresh Arbitrum tx ${fresh.hash} in block ${parseInt(head.number, 16)} from ${fresh.from} to ${fresh.to}`);
const e = await create("E-rejections", ["demo-rejections", "Rejection catalogue (demo)", JSON.stringify(["arbitrum", "ethereum"]),
  JSON.stringify([{ chain: "ethereum", address: ALX_EX }, { chain: "ethereum", address: A("exploiter") }, { chain: "arbitrum", address: fresh.from.toLowerCase() }]),
  JSON.stringify([{ chain: "ethereum", address: ALX_MS }, { chain: "arbitrum", address: fresh.to.toLowerCase() }]),
  JSON.stringify([ETH("1000000000000000000000000"), { chain: "arbitrum", token: "native", symbol: "ETH", decimals: 18, stolen: "1000000000000000000000000", weight: "300000" }]),
  1000, iso("2023-08-04T00:00:00Z"), iso("2023-08-05T19:00:00Z"), "EXPLOITER_OR_NAMED", JSON.stringify({ demo: true, note: "every rejection that can be produced live" })], B);
await step("E-batch-1", V, "submit_proofs", [e, JSON.stringify([
  ["arbitrum", fresh.hash.toLowerCase()],   // NOT_FINALIZED
  ["ethereum", ALX.failed],                 // TX_FAILED
  ["ethereum", ALX.beforeStart],            // BEFORE_OFFER_START
  ["ethereum", ALX.eth2000late],            // AFTER_DEADLINE
  ["ethereum", SENECA_TX[0]],               // SENDER_NOT_EXPLOITER
])]);
await step("E-batch-2", V, "submit_proofs", [e, JSON.stringify([
  ["ethereum", ALX.alethToCurve],           // NO_RETURN_TO_RECOVERY: recipient is not a recovery address
  ["ethereum", ALX.aleth1],                 // NO_RETURN_TO_RECOVERY: alETH is not a listed token here
  ["ethereum", "0x" + "ab".repeat(32)],     // TX_NOT_FOUND
  ["ethereum", ALX.eth1test],               // COUNTED: one real return, so the next step has a duplicate to refuse
])]);
const dup = await step("E-duplicate", V, "submit_proofs", [e, JSON.stringify([["ethereum", ALX.eth1test]])]);
log(`  resubmitting a counted transaction: ${dup.ok ? "ACCEPTED (unexpected)" : "refused before reading: " + dup.reason}`);
const badChain = await step("E-chain-not-in-offer", V, "submit_proofs", [e, JSON.stringify([["polygon", ALX.eth1test]])]);
log(`  unsupported chain: refused: ${badChain.reason}`);
// the protocol's two powers
o = await offer(e);
await step("E-extend-deadline", P, "extend_deadline", [e, o.deadline + 3600]);
const notProto = await step("E-extend-by-stranger", S, "extend_deadline", [e, o.deadline + 7200]);
log(`  extension by a stranger: refused: ${notProto.reason}`);
await step("E-add-recovery", P, "add_recovery", [e, "ethereum", CURVE]);
const proofs = await P.view("get_proofs", [e, 0, 50]);
for (const p of proofs.items) log(`  E proof #${p.proof_id} ${p.chain} ${p.tx_hash.slice(0, 12)}: ${p.status}${p.reason ? " " + p.reason : ""}${p.detail ? " (" + p.detail + ")" : ""}`);
run.rejections = proofs.items.map((p) => ({ proof_id: p.proof_id, chain: p.chain, tx: p.tx_hash, status: p.status, reason: p.reason, detail: p.detail }));
save();

// ---- the gate in every state ---------------------------------------------------------
o = await offer(e);
const INC = { OPEN: "demo-rejections", SETTLED_FULL: "demo-seneca-full", SETTLED_PARTIAL: "demo-gmx-partial", SETTLED_NONE: "demo-uwu-none", NO_OFFER: "demo-never-opened" };
for (const [label, inc] of Object.entries(INC)) {
  const s = await G.view("check_for", [A("protocol"), inc]);
  log(`gate check_for(protocol, ${inc}) expected ${label}: ${s.state}, favorable ${s.favorable}, offer ${s.offer_id}, ${s.fraction_ppm / 1e4}%, why: ${s.why}`);
  (run.gate ??= []).push({ expected: label, incident: inc, offer: s.offer_id, state: s.state, favorable: s.favorable, fraction_ppm: s.fraction_ppm, why: s.why });
  await step(`gate-attest-${label}`, G, "attest", [A("protocol"), inc]);
}
const copied = await G.view("check_for", [A("stranger"), INC.SETTLED_FULL]);
log(`gate check_for(stranger, ${INC.SETTLED_FULL}) favorable ${copied.favorable} (${copied.state}: ${copied.why})`);
run.gate.push({ expected: "check_for by an address that did not open it", state: copied.state, favorable: copied.favorable });
save();

// ---- close E (nothing but the one test ETH counted) ---------------------------------------
await waitUntil(o.settle_at + 3, "for E's settle time");
o = await offer(e);
const eRest = BigInt(o.bounty) - (BigInt(o.den) > 0n ? (BigInt(o.bounty) * BigInt(o.num)) / BigInt(o.den) : 0n);
await paying("E-settle", K, "settle", [e], A("protocol"), eRest, false);
o = await offer(e);
if (BigInt(o.owed) > 0n) await paying("E-claim", X, "claim", [e, A("payee")], A("payee"), o.owed, false);

// ---- end state ------------------------------------------------------------------------
await sleep(20000);
const bal = await balanceOf(reg), st = await P.view("get_stats");
run.final = { registry_balance: String(bal), stats: st, finished_at: new Date().toISOString() };
save();
log(`\nregistry eth_getBalance ${bal} wei; held ${st.held}; received ${st.received_total}, paid ${st.paid_total}, refunded ${st.refunded_total}, credits paid ${st.credit_paid_total}`);
log(`payouts: ${run.payouts.length}, delivered ${run.payouts.filter((p) => p.delivered).length}, balances ok ${run.payouts.filter((p) => p.balances_ok).length}`);
