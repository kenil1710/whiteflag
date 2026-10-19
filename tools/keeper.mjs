/**
 * The keeper bot (GitHub Actions, hourly; runnable by hand). Settles every
 * offer whose settle time has passed (or that reached 100%) and refunds every
 * owed bounty left unclaimed after its claim window, on every registry in
 * deployments.json. Logic: tools/lib/keeper_core.mjs.
 *
 *   node tools/keeper.mjs --state=<dir> [--push] [--max=25] [--wait=600]
 *
 * State lives in <dir>/keeper-state.json: in CI <dir> is a worktree of the
 * `keeper-state` branch and every checkpoint is committed there (and pushed
 * with --push), so a run that dies resumes from its stored transaction hashes
 * and page cursors. The signer is WHITEFLAG_KEEPER_KEY (CI secret) or the
 * keeper role in test/.accounts.json.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { CHAINS, accounts, fundOnStudio, outcomeOf, retry, argOf, sleep } from "../test/harness.mjs";
import { payoutFees } from "./lib/payout.mjs";
import { runKeeper, emptyState, canonicalAddress } from "./lib/keeper_core.mjs";

const { createClient, createAccount } = createRequire(new URL("../test/package.json", import.meta.url))("genlayer-js");
const root = new URL("..", import.meta.url).pathname;
const dir = argOf("state", root + "state");
const push = process.argv.includes("--push");
const file = dir.replace(/\/$/, "") + "/keeper-state.json";
mkdirSync(dir, { recursive: true });
const dep = JSON.parse(readFileSync(root + "deployments.json", "utf8")).contracts;
const registries = ["WhiteFlagRegistry", "WhiteFlagRegistryDemo"].filter((n) => dep[n]).map((n) => dep[n].address);
// state keys are lowercase; Studio only finds a contract by its checksummed address
const canonical = (a) => canonicalAddress(registries, a);

const chainDef = CHAINS.studiodev;
const key = accounts().keeper?.key;
if (!key) { console.error("no keeper key (WHITEFLAG_KEEPER_KEY or test/.accounts.json)"); process.exit(1); }
const account = createAccount(key);
const wallet = createClient({ chain: chainDef, account });
const read = createClient({ chain: chainDef });
await fundOnStudio(chainDef, account.address, 50n * 10n ** 18n);
const plain = (v) => JSON.parse(JSON.stringify(v, (k, x) => (typeof x === "bigint" ? x.toString() : x instanceof Map ? Object.fromEntries(x) : x)));
const asObj = (v) => plain(typeof v === "string" ? JSON.parse(v) : v);
const view = async (address, fn, args) => asObj(await retry(() => read.readContract({ address: canonical(address), functionName: fn, args }), { label: fn }));

const git = (...a) => execFileSync("git", ["-C", dir, ...a], { stdio: ["ignore", "pipe", "pipe"] }).toString();
const isRepo = existsSync(dir + "/.git");
let lastPush = 0;
const store = {
  async load() { return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : emptyState(); },
  async save(state, why) {
    state.keeper = account.address;
    state.registries_watched = registries;
    state.saved_at = new Date().toISOString();
    writeFileSync(file, JSON.stringify(state, null, 2) + "\n");
    if (!isRepo) return;
    try {
      git("add", "keeper-state.json");
      if (git("status", "--porcelain").trim() === "") return;
      git("-c", "user.name=whiteflag-keeper", "-c", "user.email=keeper@users.noreply.github.com", "commit", "-qm", "keeper: " + why);
      if (push && (why.startsWith("submitted") || why === "run finished" || Date.now() - lastPush > 30_000)) {
        git("push", "-q", "origin", "HEAD:keeper-state");
        lastPush = Date.now();
      }
    } catch (e) { console.log("  state commit/push failed: " + String(e.message).slice(0, 160)); }
  },
};

async function getTx(hash) {
  const tx = await retry(() => read.getTransaction({ hash }), { attempts: 4, label: "poll" }).catch(() => null);
  if (!tx) return null;
  const o = outcomeOf(tx);
  return { statusName: o.status, ok: o.ok, reason: o.revertReason };
}

const chain = {
  now: () => Math.floor(Date.now() / 1000),
  getDue: (reg, offset, limit, now) => view(reg, "get_due", [now, offset, limit]),
  getOffer: (reg, id) => view(reg, "get_offer", [id]),
  async submit(reg, action, offer) {
    reg = canonical(reg);
    const fn = action === "SETTLE" ? "settle" : "refund_unclaimed";
    const args = [offer.offer_id];
    // settle sends the remainder to the protocol unless 100% came back; a refund always sends
    const sends = action !== "SETTLE" || offer.fraction_ppm < 1_000_000;
    const fees = sends ? await payoutFees(wallet, { address: reg, functionName: fn, args, payee: offer.protocol })
      : await (async () => { const e = await wallet.estimateTransactionFeesForWrite({ address: reg, functionName: fn, args, value: 0n }); return { distribution: e.distribution, feeValue: e.feeValue, ...(e.messageAllocations ? { messageAllocations: e.messageAllocations } : {}) }; })();
    return await retry(() => wallet.writeContract({ address: reg, functionName: fn, args, value: 0n, fees }), { label: fn });
  },
  getTx,
  async wait(hash, ms) {
    const t0 = Date.now();
    for (;;) {
      const tx = await getTx(hash);
      if (tx && ["FINALIZED", "UNDETERMINED", "CANCELED", "LEADER_TIMEOUT", "VALIDATORS_TIMEOUT"].includes(tx.statusName)) return tx;
      if (Date.now() - t0 > ms) return tx;
      await sleep(10_000);
    }
  },
};

console.log(`keeper ${account.address}  registries ${registries.join(", ")}  state ${file}${isRepo ? " (git)" : ""}`);
const { run, state } = await runKeeper({ chain, store, registries, log: (l) => console.log("  " + l),
  maxActions: Number(argOf("max", "25")), waitMs: Number(argOf("wait", "600")) * 1000 });
console.log(`run: resumed ${run.resumed}, scanned ${run.scanned}, due ${run.due}, submitted ${run.submitted}, done ${run.done}, pending ${run.pending}, failed ${run.failed}, errors ${run.errors.length}`);
for (const u of state.unprocessed) console.log(`  unprocessed ${u.key}: ${u.why}`);
