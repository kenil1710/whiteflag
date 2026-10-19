// docs/SUBMISSION.md: the three submission texts, plain ASCII, each with its length checked against its limit.
//   node tools/submission.mjs [--tests=<n>]
import { readFileSync, writeFileSync } from "node:fs";
const root = new URL("..", import.meta.url).pathname;
const dep = JSON.parse(readFileSync(root + "deployments.json", "utf8")).contracts;
const tests = process.argv.find((a) => a.startsWith("--tests="))?.slice(8) ?? "?";
const R = dep.WhiteFlagRegistry.address, RD = dep.WhiteFlagRegistryDemo.address, G = dep.SafeHarborGate.address, GD = dep.SafeHarborGateDemo.address;

const one = "WhiteFlag: a hacked protocol locks a whitehat bounty; GenLayer validators verify each returned transfer on chain and code pays the bounty pro rata, refunding the rest.";
const desc = `After a hack, protocols offer bounties in on-chain messages that nobody can check or enforce. WhiteFlag makes the offer an escrow on GenLayer. The protocol locks GEN and freezes the terms: exploiter and recovery addresses, stolen tokens with value weights, deadline, claim window. Anyone submits return tx hashes; every validator reads each tx, receipt and finalized head from two RPCs per chain (Ethereum, Arbitrum) and counts only transfers from a listed exploiter to a recovery address. Returned fraction = weighted min(returned, stolen) / stolen; bounty x fraction goes to the exploiter (only an exploiter address can claim), the rest back to the protocol. No cancel, no admin, no model. Seeded with 6 real incidents (GMX 89.02%, Alchemix 100%, Seneca 83.67%, KyberSwap, Curve, UwU 0%). SafeHarborGate answers consumers; an hourly keeper settles and refunds.`;
const rev = `Live: whiteflag-ledger.vercel.app (/verify checks source byte for byte). Registry ${R}, demo ${RD}, gates ${G}, ${GD} on Studio Dev. Repo github.com/kenil1710/whiteflag: sh test/run_offline.sh (${tests} tests), node tools/verify_source.mjs, node tools/final_check.mjs. docs/SEEDS.md links every proof and payout.`;

const ascii = (s) => /^[\x20-\x7e]*$/.test(s);
const rows = [["One-liner", one, 180], ["Description", desc, 1000], ["Review verification", rev, 500]];
for (const [n, t, max] of rows) if (t.length > max || !ascii(t)) { console.error(`${n}: ${t.length}/${max} chars, ascii ${ascii(t)}`); process.exit(1); }
const md = ["# Submission", "", "Plain ASCII. Lengths checked by `node tools/submission.mjs`.", "",
  ...rows.flatMap(([n, t, max]) => [`## ${n} (${t.length}/${max} characters)`, "", t, ""]),
  "## Addresses", "", `- WhiteFlagRegistry: ${R}`, `- WhiteFlagRegistryDemo: ${RD}`, `- SafeHarborGate: ${G}`, `- SafeHarborGateDemo: ${GD}`, ""];
writeFileSync(root + "docs/SUBMISSION.md", md.join("\n"));
for (const [n, t, max] of rows) console.log(`${n}: ${t.length}/${max}`);
