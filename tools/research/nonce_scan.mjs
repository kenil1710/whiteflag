// Research helper: every transaction SENT by an address between two blocks,
// found without an explorer: binary-search the blocks where the sender's
// nonce (eth_getTransactionCount at a block) steps up, then pick the sender's
// transaction out of that block. Needs an archive RPC.
//   node tools/research/nonce_scan.mjs <archive rpc> <address> <fromBlock> <toBlock> [rpc for full blocks]
const [rpc, addr, fromB, toB, blockRpc] = process.argv.slice(2);
let id = 0;
async function call(method, params, url = rpc) {
  for (let i = 0; i < 6; i++) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }), signal: AbortSignal.timeout(30000) });
      const j = await r.json();
      if (j.error) throw new Error(JSON.stringify(j.error));
      return j.result;
    } catch (e) { if (i === 5) throw e; await new Promise((r) => setTimeout(r, 1500 * (i + 1))); }
  }
}
const nonceAt = async (b) => parseInt(await call("eth_getTransactionCount", [addr, "0x" + b.toString(16)]), 16);
const lo0 = Number(fromB), hi0 = Number(toB);
const n0 = await nonceAt(lo0), n1 = await nonceAt(hi0);
console.error(`nonce ${n0} at ${lo0}, ${n1} at ${hi0}`);
// for each nonce k in [n0, n1): the first block where nonce > k
let start = lo0;
for (let k = n0; k < n1; k++) {
  let lo = start, hi = hi0;
  while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if ((await nonceAt(mid)) > k) hi = mid; else lo = mid; }
  start = hi - 1;
  const blk = await call("eth_getBlockByNumber", ["0x" + hi.toString(16), true], blockRpc || rpc);
  for (const t of blk.transactions) {
    if (t.from.toLowerCase() === addr.toLowerCase() && parseInt(t.nonce, 16) === k) {
      console.log([t.hash, hi, new Date(parseInt(blk.timestamp, 16) * 1000).toISOString().slice(0, 19), t.to, (Number(BigInt(t.value)) / 1e18).toString(), t.input.slice(0, 10)].join(" "));
    }
  }
}
