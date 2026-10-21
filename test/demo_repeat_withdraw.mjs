/**
 * demo_close.mjs: the last refunds and the end-state checks of the demo run,
 * after a refund transaction was canceled. demo_finish.mjs: the second half of demo_run.mjs, resumed from
 * docs/demo-run.json after a claim landed past its window. Same helpers.
 *
 * Every path on the DEMO registry under the steward-review rules, with real
 * signed returns on the demo chain (wfdemo, data/demochain.json) sent by the
 * throwaway demo exploiter keys, and real mainnet returns where a path does
 * not need a claim:
 *
 *   refused  a refused create_offer credited back and withdrawn
 *   F  evidence recovery on Ethereum mainnet: a transaction from the latest
 *      block, its sender listed as the exploiter and its recipient as the
 *      recovery address, is proved at once (PENDING, NOT_FINALIZED); after
 *      Ethereum finalizes its block it is retried (COUNTED); settled; the
 *      share belongs to a real address nobody here controls, so it is
 *      refunded after the claim window. (RPC outages and provider
 *      disagreement are exercised in test/direct and the offline suite.)
 *   G  expiry: a return whose block never finalizes stays PENDING; settle is
 *      refused until the recovery window ends, then settles; the proof is EXPIRED
 *   A  full return by the demo exploiter, settled at 100%; it commits a
 *      beneficiary (a stranger cannot); an affiliated listed address that
 *      returned nothing is refused; the claim pays the committed beneficiary
 *   B  two exploiter addresses return 3 and 6 of 12; a stranger's transfer is
 *      REJECTED; the remainder is refunded at settlement; a stranger's claim is
 *      refused; each address claims exactly its own share
 *   C  nothing returned (UwU Lend, mainnet addresses): the whole bounty refunded
 *   D  real Seneca returns (mainnet) with the demo exploiter listed beside the
 *      real addresses: it is refused (returned nothing); nobody can claim the
 *      real addresses' shares, so they are refunded after the claim window
 *   E  the rejection catalogue on mainnet transactions; a not-yet-final
 *      Arbitrum transaction stays PENDING and EXPIRES; amendments on this
 *      historic offer are refused (past its deadline)
 *   H  amendments: a deadline extension and a recovery address before the
 *      lock, each recorded; a stranger's, one past the cap and one inside the
 *      final window refused
 *   copy a stranger opens a copy of A's incident, settles it at 100%; the gate
 *      still answers the protocol's own offer
 *   plus the gate's check_for(protocol, incident) in every state.
 *
 * Every payout is checked at its recipient: the finalized transaction's value
 * message delivered (not skipped) and eth_getBalance deltas of the registry
 * and the recipient. At the end the registry's eth_getBalance must be 0.
 *   node demo_run.mjs        writes docs/demo-run.json, docs/payouts.json, docs/demo-run.log
 */
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { client, deployments, balanceOf, finalized, payoutDelivered } from "../tools/lib/wf.mjs";
import { checkBalances } from "../tools/lib/payout.mjs";
import { accounts, sleep } from "./harness.mjs";

const root = new URL("..", import.meta.url);
const dep = deployments().contracts;
const reg = dep.WhiteFlagRegistryDemo.address, gate = dep.SafeHarborGateDemo.address;
const chainPlan = JSON.parse(readFileSync(new URL("docs/demochain.json", root), "utf8"));
const W = (label) => chainPlan.txs[label].hash;
const T0 = chainPlan.t0, OUTAGE_END = chainPlan.outage_node_b[1];
const acc = accounts();
const A = (role) => acc[role].address.toLowerCase();
const P = client({ role: "protocol", address: reg }), X = client({ role: "exploiter", address: reg }), X2 = client({ role: "exploiter2", address: reg });
const V = client({ role: "prover", address: reg }), S = client({ role: "stranger", address: reg }), K = client({ role: "keeper", address: reg });
const G = client({ role: "stranger", address: gate });
const logPath = new URL("docs/demo-run.log", root);
appendFileSync(logPath, `\n# withdraw-refund repeated by demo_repeat_withdraw.mjs at ${new Date().toISOString()} (the first measurement overlapped the browser flows' bounty locks)\n`);
const log = (s) => { console.log(s); appendFileSync(logPath, s + "\n"); };
const run = JSON.parse(readFileSync(new URL("docs/demo-run.json", root), "utf8"));
const save = () => {
  writeFileSync(new URL("docs/demo-run.json", root), JSON.stringify(run, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
  writeFileSync(new URL("docs/payouts.json", root), JSON.stringify({ registry: reg, payouts: run.payouts }, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
};
const iso = (s) => Math.floor(Date.parse(s) / 1000);
const now = () => Math.floor(Date.now() / 1000);
const ETH = (wei, chain = "ethereum") => ({ chain, token: "native", symbol: "ETH", decimals: 18, stolen: String(wei), weight: "300000" });
const E18 = 10n ** 18n;
const B = 10n ** 17n; // 0.1 GEN per demo bounty

/** An expectation, recorded in the run and the log; the run goes on either way. */
function check(label, ok, detail = "") {
  run.checks.push({ label, ok: Boolean(ok), detail });
  log(`  CHECK ${ok ? "ok  " : "FAIL"} ${label}${detail ? ": " + detail : ""}`);
  save();
}

const sent = [];   // every transaction this run sent; payouts are measured only once all of them are final
async function step(label, who, fn, args, opts = {}) {
  const r = await who.write(fn, args, opts);
  if (r.hash) sent.push(r.hash);
  log(`${label}: ${fn} ${r.status}${r.reason ? " " + r.reason.slice(0, 160) : ""} ${r.hash ?? ""}`);
  run.steps.push({ label, fn, args, status: r.status, ok: r.ok, reason: r.reason, hash: r.hash });
  save();
  return r;
}
const refused = async (label, who, fn, args, want, opts = {}) => {
  const r = await step(label, who, fn, args, opts);
  check(`${label} refused with ${want}`, !r.ok && String(r.reason).includes(want), r.ok ? "ACCEPTED" : r.reason.slice(0, 120));
  return r;
};
async function create(label, args, value, who = P) {
  // other clients may open offers at the same time: find this one by its creator and incident
  const before = await P.view("get_offer_by", [who.me.toLowerCase(), args[0]]);
  const r = await step(label, who, "create_offer", args, { value });
  const o = await P.view("get_offer_by", [who.me.toLowerCase(), args[0]]);
  if (!o.found || (before.found && o.offer_id === before.offer_id)) throw new Error(label + ": offer not created: " + r.reason);
  run.offers[label] = o.offer_id;
  return o.offer_id;
}
const offer = (id) => P.view("get_offer", [id]);
const proofsOf = async (id) => (await P.view("get_proofs", [id, 0, 50])).items;
async function waitUntil(t, why) { while (now() < t) { log(`  waiting ${t - now()} s ${why}`); await sleep(Math.min(30, t - now() + 2) * 1000); } }

/** A payout transaction: final, delivered, balances moved by exactly the amount. */
async function payout(label, r, payee, amount, payeeSent) {
  const tx = await finalized(K.read, r.hash);
  const d = payoutDelivered(tx, payee, amount);
  const regAfter = await balanceOf(reg), payeeAfter = await balanceOf(payee);
  const bal = checkBalances({ contractBefore: r.regBefore, contractAfter: regAfter, payeeBefore: r.payeeBefore, payeeAfter, amount, netFee: d.netFee ?? 0n, payeeSent });
  const rec = { label, tx: r.hash, status: tx?.statusName, payee, amount: String(amount), delivered: d.ok, why: d.why, registry_delta: String(regAfter - r.regBefore),
    payee_delta: String(payeeAfter - r.payeeBefore), payee_paid_fee: payeeSent, net_fee: String(d.netFee ?? 0n), balances_ok: bal === "", balances_why: bal };
  run.payouts.push(rec); save();
  log(`  PAYOUT ${label}: ${amount} wei to ${payee}: ${tx?.statusName}, delivered=${d.ok}${d.why ? " (" + d.why + ")" : ""}, registry Δ ${rec.registry_delta}, payee Δ ${rec.payee_delta} ${bal === "" ? "BALANCES OK" : "BALANCES: " + bal}`);
  return rec;
}
async function allFinal() { for (const h of sent) await finalized(K.read, h); sent.splice(0, sent.length); }
async function paying(label, who, fn, args, payee, amount, payeeSent) {
  await allFinal();   // fee refunds of earlier transactions must not land inside the measurement
  const regBefore = await balanceOf(reg), payeeBefore = await balanceOf(payee);
  const r = await step(label, who, fn, args, { payee });
  if (!r.ok) throw new Error(`${label} failed: ${r.reason}`);
  return payout(label, { ...r, regBefore, payeeBefore }, payee, BigInt(amount), payeeSent);
}
const rest = (o) => BigInt(o.bounty) - BigInt(o.owed);
/** Settle when allowed; pays the remainder to the protocol when there is one. */
async function settle(label, id) {
  let o = await offer(id);
  if (o.status !== "OPEN") {
    log(`  ${label}: already ${o.status} (settled by ${o.settled_by}, the keeper's schedule covers the demo registry)`);
    return o;
  }
  const owedIfNow = BigInt(o.den) > 0n ? (BigInt(o.bounty) * BigInt(o.num)) / BigInt(o.den) : 0n;
  if (o.fraction_ppm < 1_000_000) await waitUntil(o.n_pending > 0 ? o.recover_until : o.settle_at, `for ${label}'s settle time`);
  const remainder = BigInt(o.bounty) - owedIfNow;   // shares add up to bounty * num / den exactly
  if (remainder > 0n) await paying(label, K, "settle", [id], A("protocol"), remainder, false);
  else await step(label, K, "settle", [id]);
  o = await offer(id);
  log(`  ${label}: ${o.status} ${o.fraction_ppm / 1e4}% owed ${o.owed} shares ${JSON.stringify(o.shares)} expired ${o.n_expired}`);
  check(`${label} refunded the remainder at settlement`, BigInt(o.refunded_at_settle) === rest(o), `${o.refunded_at_settle}`);
  return o;
}
async function claimOwn(label, who, role, id) {
  const o = await offer(id);
  const me = A(role), share = o.shares[me];
  const to = o.beneficiaries[me] || me;
  const rec = await paying(label, who, "claim", [id], to, share, to === me);
  check(`${label} paid exactly the address's own share`, rec.delivered && rec.balances_ok && rec.amount === share, `${share} to ${to}`);
}

// real mainnet transactions (as on the canonical registry)
const SENECA_EX = ["0x94641c01a4937f2c8ef930580cf396142a2942dc", "0x5217c6923a4efc5bcf53d9a30ec4b0089f080ed0", "0xe83b072433f025ef06b73e0caa3095133e7c5bd0"];
const SENECA_SAFE = "0xb7af0aa318706d94469d8d851015f9aa12d9c53a";
const SENECA_TX = ["0xab7f14e2b75e70c8b136c8facb7a94d1947b812749660d0cb961e1a0db7c2f64", "0xcf3f1f4d4db1782fa16d34e180c7c632a944e61f60ff7aae4e50bf145b0184f2", "0x8e19428c50722538b0a98690c3621d644543950e9d852adad956a5ee70dd7cd8"];
const ALX_EX = "0xdce5d6b41c32f578f875efffc0d422c57a75d7d8", ALX_MS = "0x9e2b6378ee8ad2a4a95fe481d63caba8fb0ebbf9", CURVE = "0xbabe61887f1de2713c6f97e567623453d3c79f67";
const ALX = { eth2000late: "0xdbf1d8dca9858119e3852d52f18821754640013d9914d692589b13f8181a08e8", failed: "0x7ad3111bb69abd88f4095e2cec8e8c058ad3e17e8ba7fbd538a4828658d564ff",
  alethToCurve: "0xd83072cfc1126e23f18d13529c8fa832015a06f0a6988c65f53b4a8a0c403665", aleth1: "0x4197ed0ef9b60ab1cacdc31d6d3ce06413b333b14b8947be5c0cfe29cb88b088",
  beforeStart: "0x431103213d34873abb561fdd7cc66574af5dc77698ce9515533df3e0d7d3d2cb", eth1test: "0x25bc0a257301b4168e2e1862669c68dacb46aace6921f9efc6dd152c040a45c2" };
const pairs = (chain, list) => JSON.stringify(list.map((address) => ({ chain, address })));
const DEMO = (wei) => JSON.stringify([ETH(wei, "wfdemo")]);
const WF = JSON.stringify(["wfdemo"]);
const RECOV = pairs("wfdemo", [chainPlan.recovery]);

{
  const c0 = (await P.view("get_credit", [A("protocol")])).credit;
  await step("refused-create-repeat", P, "create_offer", ["bad", "Refused on purpose", JSON.stringify(["ethereum"]), pairs("ethereum", [A("exploiter")]), pairs("ethereum", [A("exploiter")]),
    JSON.stringify([ETH(1)]), 1000, iso("2024-01-01T00:00:00Z"), iso("2024-02-01T00:00:00Z"), "EXPLOITER_OR_NAMED", "{}"], { value: 5n * 10n ** 16n });
  const c1 = (await P.view("get_credit", [A("protocol")])).credit;
  check("refused create credited the value back (repeat)", BigInt(c1) - BigInt(c0) === 5n * 10n ** 16n, `${BigInt(c1) - BigInt(c0)} wei`);
  const rec = await paying("withdraw-refund-repeat", P, "withdraw_refund", [], A("protocol"), c1, true);
  const first = run.payouts.find((p) => p.label === "withdraw-refund");
  if (first && rec.delivered && rec.balances_ok) {
    first.superseded_by = "withdraw-refund-repeat";
    first.superseded_why = "delivered, but the registry's balance delta included bounties the browser flows locked during the measurement; repeated with nothing else running";
  }
  await allFinal();
  await sleep(20000);
  const bal = await balanceOf(reg);
  run.final = { ...run.final, registry_balance: String(bal), stats: await P.view("get_stats"), finished_at: new Date().toISOString() };
  check("registry eth_getBalance is 0 after the repeat", bal === 0n, String(bal));
  save();
}
