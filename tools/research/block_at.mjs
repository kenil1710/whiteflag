// Research helper: the first block at or after a UTC time.  node block_at.mjs <rpc> <iso>
const [rpc, iso] = process.argv.slice(2);
const want = Date.parse(iso) / 1000;
const call = async (m, p) => (await (await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }) })).json()).result;
const ts = async (b) => parseInt((await call("eth_getBlockByNumber", ["0x" + b.toString(16), false])).timestamp, 16);
let hi = parseInt(await call("eth_blockNumber", []), 16), lo = 1;
while (hi - lo > 1) { const m = Math.floor((lo + hi) / 2); if ((await ts(m)) >= want) hi = m; else lo = m; }
console.log(hi);
