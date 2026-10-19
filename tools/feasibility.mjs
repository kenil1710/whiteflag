/**
 * Step 0: can every real incident in data/incidents.json be verified from two
 * independent RPCs per chain? From this machine:
 *   - the protocol's offer message: sender, recipient, block time, text;
 *   - every return transaction (and every known non-return): tx, receipt,
 *     block header and finalized head from BOTH RPCs, projected and compared,
 *     then judged by the same rule the contract applies (tools/lib/verify.mjs).
 * Writes docs/feasibility.json; tools/feasibility_md.mjs renders FEASIBILITY.md.
 *   node tools/feasibility.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { CHAINS, rpc } from "./lib/chains.mjs";
import { readBoth, judge, fractionPpm } from "./lib/verify.mjs";

const root = new URL("..", import.meta.url);
const data = JSON.parse(readFileSync(new URL("data/incidents.json", root), "utf8"));
const epoch = (iso) => Math.floor(Date.parse(iso) / 1000);
const out = { at: new Date().toISOString(), rpcs: Object.fromEntries(Object.entries(CHAINS).map(([k, v]) => [k, v.rpcs])), incidents: [] };

for (const inc of data.incidents) {
  const offer = { start: epoch(inc.offer.start), deadline: epoch(inc.offer.deadline), exploiters: inc.exploiters, recoveries: inc.recoveries, tokens: inc.tokens };
  const rec = { id: inc.id, name: inc.name, message: null, returns: [], rejects: [], returned: {}, fraction_ppm: "0" };
  // the offer message, from both RPCs
  const m = inc.offer.message_tx;
  const views = [];
  for (const url of CHAINS[m.chain].rpcs) {
    try {
      const tx = await rpc(url, "eth_getTransactionByHash", [m.hash]);
      const hdr = await rpc(url, "eth_getBlockByNumber", [tx.blockNumber, false]);
      views.push({ url, from: tx.from.toLowerCase(), to: tx.to.toLowerCase(), time: parseInt(hdr.timestamp, 16),
        text: Buffer.from(tx.input.slice(2), "hex").toString("utf8") });
    } catch (e) { views.push({ url, error: String(e.message).slice(0, 100) }); }
  }
  const agree = views.length === 2 && !views[0].error && JSON.stringify(views[0]) .replace(views[0].url, "") === JSON.stringify(views[1]).replace(views[1].url, "");
  rec.message = { ...m, agree, from: views[0].from, to: views[0].to, time: views[0].time, iso: views[0].time ? new Date(views[0].time * 1000).toISOString() : null, text: views[0].text ?? null, errors: views.filter((v) => v.error) };
  console.log(`\n#${inc.case_no} ${inc.name}: offer ${m.hash.slice(0, 12)} ${agree ? "read identically from both RPCs" : "MISMATCH"} at ${rec.message.iso}`);

  const used = new Set();
  for (const [kind, list] of [["returns", inc.returns], ["rejects", inc.rejects]]) {
    for (const r of list) {
      const b = await readBoth(r.chain, r.hash);
      let row = { chain: r.chain, hash: r.hash, note: r.note };
      if (b.reason) row = { ...row, read: false, reason: b.reason, detail: b.detail };
      else {
        const j = judge(offer, r.chain, r.hash, b.proj, b.finalized, used);
        row = { ...row, read: true, block: b.proj.block, time: b.proj.time, iso: new Date(b.proj.time * 1000).toISOString(), from: b.proj.from, to: b.proj.to, status: b.proj.status, finalized: b.finalized, verdict: j.reason ?? "COUNTED", credits: j.credits ?? [] };
        for (const c of j.credits ?? []) { used.add(c.key); const k = `${r.chain}:${c.token}`; rec.returned[k] = (BigInt(rec.returned[k] ?? 0) + BigInt(c.amount)).toString(); }
      }
      if (kind === "rejects") row.expect = r.expect;
      rec[kind].push(row);
      console.log(`  ${kind === "returns" ? "return" : "reject"} ${r.chain.padEnd(8)} ${r.hash.slice(0, 12)} ${row.read ? `block ${row.block} ${row.iso} -> ${row.verdict}${row.credits.map((c) => ` +${c.amount} ${c.token === "native" ? "ETH" : c.token.slice(0, 8)}`).join("")}` : `UNREADABLE ${row.reason}`}`);
    }
  }
  rec.fraction_ppm = fractionPpm(inc.tokens, rec.returned).toString();
  console.log(`  returned fraction ${(Number(rec.fraction_ppm) / 1e4).toFixed(4)}%`);
  out.incidents.push(rec);
}

const ok = out.incidents.filter((r) => r.message.agree && [...r.returns, ...r.rejects].every((x) => x.read));
out.summary = {
  incidents: out.incidents.length,
  readable: ok.length,
  with_returns: ok.filter((r) => r.returns.length > 0 && Number(r.fraction_ppm) > 0).length,
  without_returns: ok.filter((r) => r.returns.length === 0).length,
  return_txs_read: out.incidents.reduce((s, r) => s + r.returns.filter((x) => x.read).length, 0),
  return_txs: out.incidents.reduce((s, r) => s + r.returns.length, 0),
  rejects_as_expected: out.incidents.reduce((s, r) => s + r.rejects.filter((x) => x.verdict === x.expect).length, 0),
  rejects: out.incidents.reduce((s, r) => s + r.rejects.length, 0),
};
out.summary.feasible = out.summary.readable >= 5 && out.summary.with_returns >= 2 && out.summary.without_returns >= 1;
writeFileSync(new URL("docs/feasibility.json", root), JSON.stringify(out, null, 2) + "\n");
console.log("\n", out.summary);
process.exit(out.summary.feasible ? 0 : 1);
