// Continues smoke.mjs on an existing offer: settle (refund to the protocol), claim to the payee, payouts checked at the recipients.
import { client, deployments, balanceOf, finalized, payoutDelivered } from "../tools/lib/wf.mjs";
import { accounts, argOf } from "./harness.mjs";
const reg = deployments("smoke").contracts.WhiteFlagRegistryDemo.address;
const acc = accounts(); const oid = Number(argOf("offer", "1"));
const X = client({ role: "exploiter", address: reg }), K = client({ role: "keeper", address: reg });
let o = await K.view("get_offer", [oid]);
if (o.status === "OPEN") {
  const p0 = await balanceOf(acc.protocol.address), c0 = await balanceOf(reg);
  const r = await K.write("settle", [oid], { payee: o.protocol }); console.log("settle", r.status, r.reason, r.hash);
  const tx = await finalized(K.read, r.hash); o = await K.view("get_offer", [oid]);
  console.log("settle finalized", tx?.statusName, o.status, "refund", o.refunded_at_settle, JSON.stringify(payoutDelivered(tx, o.protocol, o.refunded_at_settle), (k, v) => (typeof v === "bigint" ? v.toString() : v)));
  console.log("protocol Δ", (await balanceOf(acc.protocol.address)) - p0, "registry Δ", (await balanceOf(reg)) - c0);
}
const payee = acc.payee.address;
const b0 = await balanceOf(payee), c0 = await balanceOf(reg);
const r = await X.write("claim", [oid, payee], { payee }); console.log("claim", r.status, r.reason, r.hash);
const tx = await finalized(X.read, r.hash); console.log("claim finalized", tx?.statusName, JSON.stringify(payoutDelivered(tx, payee, o.owed), (k, v) => (typeof v === "bigint" ? v.toString() : v)));
console.log("payee Δ", (await balanceOf(payee)) - b0, "owed", o.owed, "registry Δ", (await balanceOf(reg)) - c0, "registry balance", await balanceOf(reg));
