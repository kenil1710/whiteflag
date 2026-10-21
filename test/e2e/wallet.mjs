// A throwaway browser wallet for the Playwright flows: an EIP-1193 provider
// injected as window.ethereum whose requests are answered in Node. It holds
// one local key (a test/.accounts.json e2e role, created by test/accounts.mjs
// and funded from the Studio Dev faucet), signs each transaction the site asks
// for exactly as MetaMask would (legacy, chain id 61997) and sends the raw
// bytes to Studio Dev. It signs nothing it is not asked to and never shows
// the key to the page.
import { privateKeyToAccount } from "viem/accounts";

const STUDIO = "https://studio-dev.genlayer.com/api";
const CHAIN_ID = 61997;

async function studio(method, params) {
  for (let i = 0; ; i++) {
    const r = await fetch(STUDIO, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }) });
    const j = await r.json().catch(() => ({ error: { message: "http " + r.status } }));
    if (!j.error) return j.result;
    if (i < 4 && /rate|429|limit/i.test(j.error.message)) { await new Promise((res) => setTimeout(res, 3000 * (i + 1))); continue; }
    throw new Error(j.error.message);
  }
}

/** Installs the wallet in `context`; returns its address. log(line) records every request it answers. */
export async function installWallet(context, key, log = () => {}) {
  const account = privateKeyToAccount(key);
  await context.exposeFunction("__wfWallet", async (method, params) => {
    log(`${account.address.slice(0, 8)} ${method}`);
    switch (method) {
      case "eth_requestAccounts":
      case "eth_accounts": return [account.address];
      case "eth_chainId": return "0x" + CHAIN_ID.toString(16);
      case "wallet_switchEthereumChain":
      case "wallet_addEthereumChain": return null;
      case "eth_sendTransaction": {
        const t = params[0];
        const raw = await account.signTransaction({ type: "legacy", chainId: CHAIN_ID, to: t.to, data: t.data,
          value: t.value ? BigInt(t.value) : 0n, gas: BigInt(t.gas), gasPrice: BigInt(t.gasPrice), nonce: Number(BigInt(t.nonce)) });
        return await studio("eth_sendRawTransaction", [raw]);
      }
      case "personal_sign": return await account.signMessage({ message: { raw: params[0] } });
      default: return await studio(method, params ?? []);
    }
  });
  await context.addInitScript(() => {
    window.ethereum = {
      isWhiteFlagE2E: true,
      request: ({ method, params }) => window.__wfWallet(method, params ?? []),
      on() {}, removeListener() {},
    };
  });
  return account.address;
}
