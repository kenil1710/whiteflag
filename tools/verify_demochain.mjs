/**
 * Checks the demo chain (data/demochain.json): every transaction's hash is
 * keccak256 of its raw signed bytes, its sender is recovered from the
 * signature, and its recipient, value, nonce and chain id are the signed ones.
 * With --live it also asks both demo endpoints for every transaction and
 * compares their answers with the file.
 *   node tools/verify_demochain.mjs [--live]      exit 1 on any mismatch
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../test/package.json", import.meta.url));
const { keccak256, parseTransaction, recoverTransactionAddress } = require("viem");
import { DEMO_CHAINS, rpc } from "./lib/chains.mjs";

const doc = JSON.parse(readFileSync(new URL("../data/demochain.json", import.meta.url), "utf8"));
let bad = 0;
const fail = (m) => { bad++; console.log("FAIL " + m); };
for (const t of doc.txs) {
  if (keccak256(t.raw) !== t.hash) fail(`${t.hash}: hash is not keccak256(raw)`);
  const p = parseTransaction(t.raw);
  const from = (await recoverTransactionAddress({ serializedTransaction: t.raw })).toLowerCase();
  if (from !== t.from) fail(`${t.hash}: signed by ${from}, file says ${t.from}`);
  if (p.chainId !== doc.chain_id) fail(`${t.hash}: chain id ${p.chainId}`);
  if (p.to.toLowerCase() !== t.to.toLowerCase() || p.value.toString() !== t.value || p.nonce !== t.nonce) fail(`${t.hash}: to/value/nonce differ from the signature`);
}
console.log(`${doc.txs.length} demo-chain transactions: hashes and signatures ${bad ? "MISMATCH" : "ok"}`);
if (process.argv.includes("--live")) {
  const now = Math.floor(Date.now() / 1000);
  for (const url of DEMO_CHAINS.wfdemo.rpcs) {
    const down = doc.outages.some((o) => url.endsWith("/" + o.node) && now >= o.from && now < o.until);
    if (down) { console.log(`${url}: in a scheduled outage, skipped`); continue; }
    if (parseInt(await rpc(url, "eth_chainId", []), 16) !== doc.chain_id) fail(`${url}: chain id`);
    for (const t of doc.txs) {
      const blk = doc.blocks.find((b) => b.number === t.block);
      if (blk.time > now) continue;
      const got = await rpc(url, "eth_getTransactionByHash", [t.hash]);
      if (!got || got.from.toLowerCase() !== t.from || BigInt(got.value).toString() !== t.value) fail(`${url}: ${t.hash} answered differently`);
    }
    console.log(`${url}: served as in the file`);
  }
}
process.exit(bad ? 1 : 0);
