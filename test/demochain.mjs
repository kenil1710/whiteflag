/**
 * Builds data/demochain.json: the content of the WhiteFlag demo chain
 * ("wfdemo", chain id 357357) that only DEMO registries read, served by the
 * site at /api/demochain/a and /b.
 *
 * Every transaction is a real EIP-155 legacy value transfer SIGNED by a
 * throwaway demo key (test/.accounts.json); its hash is keccak256 of the raw
 * signed bytes, and tools/verify_demochain.mjs recovers every sender from the
 * signature. Nothing here moves money anywhere; the chain exists so the demo
 * exploiter keys have real, signed returns they can claim on.
 *
 * Times are relative to T0, the planned start of the demo run:
 *   every return the demo and the browser flows use     block at T0 - 1800 s, final at once
 *   "late-final": a return whose block finalizes late    block at T0 - 900 s, final at T0 + 900 s
 *   "never-final": a return whose block never finalizes  block at T0 - 900 s, final in 30 days
 *   node b is down (HTTP 503) from T0 to T0 + 900 s: a scheduled outage
 *
 *   node demochain.mjs --t0=<epoch seconds>     (default: now + 20 min)
 * Writes data/demochain.json and docs/demochain.json (the plan: label -> hash, sender, value).
 */
import { writeFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256 } from "viem";
import { accounts, argOf } from "./harness.mjs";

const root = new URL("..", import.meta.url);
const CHAIN_ID = 357357;
const T0 = Number(argOf("t0", String(Math.floor(Date.now() / 1000) + 1200)));
const acc = accounts();
const E = 10n ** 18n;
const RECOVERY = "0x" + "5afe".repeat(10);        // the demo protocol's recovery address on wfdemo (receives nothing real)
const RECOVERY_E2E = "0x" + "e2e0".repeat(10);    // the browser flows' recovery address

// label, signer role, recipient, value, block group
const PLAN = [
  ["A-full", "exploiter", RECOVERY, 2n * E, "final"],
  ["B-exploiter", "exploiter", RECOVERY, 3n * E, "final"],
  ["B-exploiter2", "exploiter2", RECOVERY, 6n * E, "final"],
  ["B-stranger", "stranger", RECOVERY, 1n * E, "final"],                // SENDER_NOT_EXPLOITER
  ["F-outage", "exploiter", RECOVERY, 4n * E, "final"],                 // read during node b's outage: PENDING, then retried
  ["F-late-final", "exploiter2", RECOVERY, 2n * E, "late"],             // NOT_FINALIZED, then final: retried
  ["G-never-final", "exploiter", RECOVERY, 1n * E, "never"],            // stays PENDING: EXPIRED after the recovery window
  ["E2E-return", "e2e_exploiter", RECOVERY_E2E, 1n * E, "final"],       // the browser flows' partial return (1 of 2)
  ["E2E-return-2", "e2e_exploiter", RECOVERY_E2E, 1n * E, "final"],     // a second, for the unclaimed-refund flow
  ["E2E-stranger", "e2e_stranger", RECOVERY_E2E, 1n * E, "final"],      // the browser flows' rejected proof
];
const GROUP = { final: [T0 - 1800, T0 - 1800], late: [T0 - 900, T0 + 900], never: [T0 - 900, T0 + 30 * 86400] };

const blocks = [{ number: 0, time: T0 - 86400, final_at: T0 - 86400 }];
const blockOf = {};
for (const [g, [time, final_at]] of Object.entries(GROUP)) {
  const number = blocks.length;
  blocks.push({ number, time, final_at });
  blockOf[g] = number;
}
const nonces = {};
const txs = [];
const plan = {};
for (const [label, role, to, value, group] of PLAN) {
  const a = privateKeyToAccount(acc[role].key);
  const nonce = (nonces[role] = (nonces[role] ?? -1) + 1);
  const raw = await a.signTransaction({ type: "legacy", chainId: CHAIN_ID, nonce, to, value, gas: 21000n, gasPrice: 1n, data: "0x" });
  const hash = keccak256(raw);
  const block = blockOf[group];
  txs.push({ hash, raw, from: a.address.toLowerCase(), to, value: value.toString(), nonce, block,
    index: txs.filter((t) => t.block === block).length, status: 1, logs: [] });
  plan[label] = { hash, from: a.address.toLowerCase(), role, to, value: value.toString(), block, block_time: GROUP[group][0], final_at: GROUP[group][1] };
}
const doc = { chain_id: CHAIN_ID, t0: T0, blocks, txs, outages: [{ node: "b", from: T0, until: T0 + 900 }] };
writeFileSync(new URL("data/demochain.json", root), JSON.stringify(doc, null, 2) + "\n");
writeFileSync(new URL("docs/demochain.json", root), JSON.stringify({ chain: "wfdemo", chain_id: CHAIN_ID, t0: T0,
  t0_iso: new Date(T0 * 1000).toISOString(), recovery: RECOVERY, recovery_e2e: RECOVERY_E2E, outage_node_b: [T0, T0 + 900], txs: plan }, null, 2) + "\n");
console.log(`wfdemo: ${txs.length} signed transactions, T0 ${new Date(T0 * 1000).toISOString()}, node b down until ${new Date((T0 + 900) * 1000).toISOString()}`);
for (const [k, v] of Object.entries(plan)) console.log(`  ${k.padEnd(14)} ${v.hash}  from ${v.from}  ${Number(BigInt(v.value) / 10n ** 15n) / 1000} ETH`);
