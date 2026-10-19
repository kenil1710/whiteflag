// On-chain smoke of the DEMO registry in deployments.smoke.json: a Seneca-shaped
// offer with the demo exploiter listed, the three real Seneca returns, settle,
// claim to the payee, payout verified at the recipient.
import { client, deployments, balanceOf, finalized, payoutDelivered } from "../tools/lib/wf.mjs";
import { accounts } from "./harness.mjs";
const reg = deployments("smoke").contracts.WhiteFlagRegistryDemo.address;
const acc = accounts();
const P = client({ role: "protocol", address: reg }), X = client({ role: "exploiter", address: reg }), V = client({ role: "prover", address: reg }), K = client({ role: "keeper", address: reg });
const ex = ["0x94641c01a4937f2c8ef930580cf396142a2942dc", "0x5217c6923a4efc5bcf53d9a30ec4b0089f080ed0", "0xe83b072433f025ef06b73e0caa3095133e7c5bd0", acc.exploiter.address.toLowerCase()];
const now = Math.floor(Date.now() / 1000);
let r = await P.write("create_offer", ["smoke-seneca", "Smoke: Seneca shape", JSON.stringify(["ethereum"]), JSON.stringify(ex.map((a) => ({ chain: "ethereum", address: a }))),
  JSON.stringify([{ chain: "ethereum", address: "0xb7af0aa318706d94469d8d851015f9aa12d9c53a" }]),
  JSON.stringify([{ chain: "ethereum", token: "native", symbol: "ETH", decimals: 18, stolen: "1836993670758298535257", weight: "338000" }]),
  2000, Date.parse("2024-02-29T00:17:23Z") / 1000, now + 120, "EXPLOITER_OR_NAMED", "{}"], { value: 10n ** 17n });
console.log("create", r.status, r.reason, JSON.stringify(r.returned));
const stats = await P.view("get_stats"); const oid = stats.offers; console.log("offer", oid);
r = await V.write("submit_proofs", [oid, JSON.stringify([["ethereum", "0xab7f14e2b75e70c8b136c8facb7a94d1947b812749660d0cb961e1a0db7c2f64"], ["ethereum", "0xcf3f1f4d4db1782fa16d34e180c7c632a944e61f60ff7aae4e50bf145b0184f2"], ["ethereum", "0x8e19428c50722538b0a98690c3621d644543950e9d852adad956a5ee70dd7cd8"], ["ethereum", "0x775cc19c5c29deda98220cf3d244cb2f3f0e63e1c842060abeb26f84df2fb76d"]])]);
console.log("proofs", r.status, r.reason, r.seconds);
const pr = await P.view("get_proofs", [oid, 0, 10]); for (const p of pr.items) console.log(" ", p.tx_hash.slice(0, 10), p.status, p.reason);
let o = await P.view("get_offer", [oid]); console.log("fraction", o.fraction_ppm, "settle_at", o.settle_at, "now", Math.floor(Date.now() / 1000));
while (Math.floor(Date.now() / 1000) < o.settle_at + 5) await new Promise((r) => setTimeout(r, 5000));
const pb0 = await balanceOf(acc.protocol.address);
r = await K.write("settle", [oid], { payee: acc.protocol.address }); console.log("settle", r.status, r.reason, r.hash);
o = await P.view("get_offer", [oid]); console.log(o.status, "owed", o.owed, "refunded", o.refunded_at_settle);
const payee = acc.payee.address;
const b0 = await balanceOf(payee), c0 = await balanceOf(reg);
r = await X.write("claim", [oid, payee], { payee }); console.log("claim", r.status, r.reason, r.hash);
const tx = await finalized(X.read, r.hash); console.log("claim finalized", tx?.statusName, JSON.stringify(payoutDelivered(tx, payee, o.owed)));
console.log("payee Δ", (await balanceOf(payee)) - b0, "registry Δ", (await balanceOf(reg)) - c0, "registry balance", await balanceOf(reg));
