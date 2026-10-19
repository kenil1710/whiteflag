// Copies into frontend/src what the site must show exactly as the repository has it:
// deployments.json -> lib/deployments.json, data/incidents.json -> lib/incidents.json,
// tools/lib/{chains,verify}.mjs -> lib/ (the same rule the contract applies, for the live check),
// docs/RULES.md -> content/RULES.md (rendered at /docs). tools/final_check.mjs fails if a copy drifts.
//   node tools/sync_frontend.mjs [--check]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
const root = new URL("..", import.meta.url).pathname;
const dep = JSON.parse(readFileSync(root + "deployments.json", "utf8"));
const c = dep.contracts;
const commit = c.WhiteFlagRegistry.commit;
const deployments = JSON.stringify({ commit, network: dep.network, chain_id: dep.chain_id, explorer: dep.explorer,
  registry: c.WhiteFlagRegistry.address, registryDemo: c.WhiteFlagRegistryDemo.address, gate: c.SafeHarborGate.address, gateDemo: c.SafeHarborGateDemo.address,
  contracts: Object.fromEntries(Object.entries(c).map(([k, v]) => [k, { address: v.address, file: v.file, sha256: v.sha256, bytes: v.bytes, commit: v.commit, deploy_tx: v.deploy_tx, constructor_args: v.constructor_args }])) }, null, 2) + "\n";
const files = [
  ["frontend/src/lib/deployments.json", deployments],
  ["frontend/src/lib/incidents.json", readFileSync(root + "data/incidents.json", "utf8")],
  ["frontend/src/lib/chains.mjs", readFileSync(root + "tools/lib/chains.mjs", "utf8")],
  ["frontend/src/lib/verify.mjs", readFileSync(root + "tools/lib/verify.mjs", "utf8")],
  ["frontend/src/content/RULES.md", readFileSync(root + "docs/RULES.md", "utf8")],
];
let stale = 0;
for (const [p, body] of files) {
  if (process.argv.includes("--check")) {
    if (!existsSync(root + p) || readFileSync(root + p, "utf8") !== body) { console.log("STALE " + p); stale++; }
    continue;
  }
  mkdirSync(root + p.slice(0, p.lastIndexOf("/")), { recursive: true });
  writeFileSync(root + p, body);
  console.log("wrote " + p);
}
process.exit(stale ? 1 : 0);
