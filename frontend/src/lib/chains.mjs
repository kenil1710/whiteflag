// The chains WhiteFlag reads, the two RPCs per chain (run by different
// operators) and their explorers. contracts/shared/common.py holds the same
// table; test/test_static.py fails if the two drift apart.
export const CHAINS = {
  ethereum: { id: 1, rpcs: ["https://rpc.mevblocker.io", "https://eth-mainnet.public.blastapi.io"], explorer: "https://etherscan.io" },
  arbitrum: { id: 42161, rpcs: ["https://arb1.arbitrum.io/rpc", "https://arbitrum-one.public.blastapi.io"], explorer: "https://arbiscan.io" },
};

export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export const txUrl = (chain, hash) => `${CHAINS[chain].explorer}/tx/${hash}`;
export const addrUrl = (chain, a) => `${CHAINS[chain].explorer}/address/${a}`;

let rid = 0;
/** One JSON-RPC call against one URL, retried on transport errors and rate limits. Throws on anything else. */
export async function rpc(url, method, params, { tries = 8 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rid, method, params }), signal: AbortSignal.timeout(30000) });
      const text = await r.text();
      if (r.status === 429 || r.status >= 500) throw new Error(`http ${r.status}`);
      const j = JSON.parse(text);
      if (j.error) {
        if (/rate|limit|busy/i.test(j.error.message)) throw new Error(j.error.message);
        const e = new Error(`rpc error: ${j.error.message}`); e.final = true; throw e;
      }
      return j.result;
    } catch (e) {
      last = e;
      if (e.final) throw e;
      await new Promise((r) => setTimeout(r, 2500 * (i + 1)));
    }
  }
  throw last;
}
