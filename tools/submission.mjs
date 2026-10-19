// docs/SUBMISSION.md: the three submission texts, plain ASCII, each with its length checked against its limit.
// Evidence links are pinned to one commit (the final commit; later commits only pin these links and the final check).
//   node tools/submission.mjs --tests=<n> --commit=<final commit> [--schedule-run=<url>]
import { readFileSync, writeFileSync } from "node:fs";
const root = new URL("..", import.meta.url).pathname;
const dep = JSON.parse(readFileSync(root + "deployments.json", "utf8")).contracts;
const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const tests = arg("tests") ?? "?";
const commit = arg("commit");
if (!/^[0-9a-f]{40}$/.test(commit ?? "")) { console.error("--commit=<40-hex final commit> required"); process.exit(1); }
const deployCommit = dep.WhiteFlagRegistry.commit;
const scheduleRun = arg("schedule-run");
const REPO = "https://github.com/kenil1710/whiteflag";
const pin = (p) => `${REPO}/blob/${commit}/${p}`;
const R = dep.WhiteFlagRegistry.address, RD = dep.WhiteFlagRegistryDemo.address, G = dep.SafeHarborGate.address, GD = dep.SafeHarborGateDemo.address;

const one = "WhiteFlag: a hacked protocol locks a whitehat bounty; GenLayer validators verify each returned transfer on chain and code pays the bounty pro rata, refunding the rest.";
const desc = `After a hack, protocols offer bounties in on-chain messages that nobody can check or enforce. WhiteFlag makes the offer an escrow on GenLayer. The protocol locks GEN and freezes the terms: exploiter and recovery addresses, stolen tokens with value weights, deadline, claim window. Anyone submits return tx hashes; every validator reads each tx, receipt and finalized head from two RPCs per chain (Ethereum, Arbitrum) and counts only transfers from a listed exploiter to a recovery address. Returned fraction = weighted min(returned, stolen) / stolen; bounty x fraction goes to the exploiter (only an exploiter address can claim), the rest back to the protocol. No cancel, no admin, no model. Seeded with 6 real incidents (GMX 89.02%, Alchemix 100%, Seneca 83.67%, KyberSwap, Curve, UwU 0%). SafeHarborGate answers consumers; a scheduled keeper settles and refunds.`;
const rev = `Live: whiteflag-ledger.vercel.app (/verify checks source byte for byte). Registry ${R}, demo ${RD}, gates ${G}, ${GD} on Studio Dev. Repo github.com/kenil1710/whiteflag: sh test/run_offline.sh (${tests} tests), node tools/verify_source.mjs, node tools/final_check.mjs. Deploy commit ${deployCommit.slice(0, 7)}, final ${commit.slice(0, 7)}. docs/SEEDS.md links every proof and payout.`;

const ascii = (s) => /^[\x20-\x7e]*$/.test(s);
const rows = [["One-liner", one, 180], ["Description", desc, 1000], ["Review verification", rev, 500]];
for (const [n, t, max] of rows) if (t.length > max || !ascii(t)) { console.error(`${n}: ${t.length}/${max} chars, ascii ${ascii(t)}`); process.exit(1); }
const md = ["# Submission", "", "Plain ASCII. Lengths checked by `node tools/submission.mjs`.", "",
  ...rows.flatMap(([n, t, max]) => [`## ${n} (${t.length}/${max} characters)`, "", t, ""]),
  "## Evidence (pinned to the final commit)", "",
  `Final commit \`${commit}\`; contracts deployed from \`${deployCommit}\`.`, "",
  `- Seeds, every proof and payout, read from chain: ${pin("docs/SEEDS.md")}`,
  `- Final check: ${pin("docs/FINAL_CHECK.md")}`,
  `- Real-world check of every canonical outcome: ${pin("docs/REAL_WORLD_CHECK.md")}`,
  `- Rules: ${pin("docs/RULES.md")}`,
  `- Attack round: ${pin("docs/ATTACK_REPORT.md")}`,
  `- Demo log and payouts: ${pin("docs/demo-run.log")}, ${pin("docs/payouts.json")}`,
  `- Deployed source: ${pin("build/WhiteFlagRegistry.py")}, ${pin("build/SafeHarborGate.py")}, ${pin("deployments.json")}`,
  `- Feasibility (real incidents read from two RPCs and from GenVM): ${pin("docs/FEASIBILITY.md")}`,
  ...(scheduleRun ? [`- Keeper, a scheduled run: ${scheduleRun}`] : []),
  `- Live source check: https://whiteflag-ledger.vercel.app/verify`, "",
  "## Addresses", "", `- WhiteFlagRegistry: ${R}`, `- WhiteFlagRegistryDemo: ${RD}`, `- SafeHarborGate: ${G}`, `- SafeHarborGateDemo: ${GD}`, ""];
writeFileSync(root + "docs/SUBMISSION.md", md.join("\n"));
for (const [n, t, max] of rows) console.log(`${n}: ${t.length}/${max}`);
