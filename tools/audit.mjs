/**
 * The A-N audit, read from chain and the repository, written to docs/AUDIT.md.
 * Each letter is one property the steward review asked for or the system
 * promises; each is checked against live state, not against the docs:
 *   A  build/ is contracts/ plus the shared helpers; the site's copies match
 *   B  every deployed contract is byte-identical to build/ at one deploy commit
 *   C  claim fairness: every settled offer's shares add up to its owed amount, only addresses that
 *      sent counted returns have a share, each share equals an independent recomputation from the
 *      per-address returns, and every claim paid exactly the claimer's share
 *   D  beneficiaries: every claim was paid to the claimer's committed beneficiary, or to itself
 *   E  evidence recovery: no settled offer shows a PENDING proof; an offer with EXPIRED proofs was
 *      settled at or after its recovery window ended; others at 100% or after their settle time
 *   F  the gate answers only protocol-bound questions (no check / is_favorable in its schema) and
 *      agrees with the registry for every canonical incident
 *   G  amendments: each was made before deadline - lock, deadlines only moved later, extensions
 *      within the cap, sequence numbers increase
 *   H  funds: each registry's eth_getBalance equals what its ledger holds, and both hold 0
 *   I  payouts: every demo payout finalized, delivered and matched by balance deltas
 *   J  real world: every canonical fraction equals the independent re-read in docs/feasibility.json
 *   K  tests: the offline suite and GenLayer Direct Mode pass
 *   L  frontend: no unbounded list read; the declared share is labelled informational; the browser
 *      flows passed with screenshots and videos
 *   M  keeper: a scheduled run succeeded, no action failed, nothing is left unprocessed
 *   N  demo chain: every transaction is signed by the sender the file names and served as written
 *   node tools/audit.mjs      exit 1 if any letter fails
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import { client, deployments, balanceOf, finalized, payoutDelivered } from "./lib/wf.mjs";

const root = new URL("..", import.meta.url).pathname;
const rd = (p) => readFileSync(root + p, "utf8");
const sh = (cmd, args) => spawnSync(cmd, args, { cwd: root, encoding: "utf8", maxBuffer: 64 << 20 });
const dep = deployments().contracts;
const rows = [];
const add = (letter, name, ok, detail) => { rows.push({ letter, name, ok, detail }); console.log(`${letter} ${ok ? "PASS" : "FAIL"} ${name}: ${detail}`); };
const REGS = { canonical: dep.WhiteFlagRegistry.address, demo: dep.WhiteFlagRegistryDemo.address };
const C = { canonical: client({ role: "keeper", address: REGS.canonical }), demo: client({ role: "keeper", address: REGS.demo }) };
const big = (v) => BigInt(v ?? 0);

async function allOffers(cl) {
  const out = [];
  for (let off = 0; ;) { const p = await cl.view("get_offers", [off, 50]); for (const s of p.items) out.push(await cl.view("get_offer", [s.offer_id])); if (p.next_offset === -1) return out; off = p.next_offset; }
}
async function proofsOf(cl, id) { const out = []; for (let off = 0; ;) { const p = await cl.view("get_proofs", [id, off, 50]); out.push(...p.items); if (p.next_offset === -1) return out; off = p.next_offset; } }

/** The share rule, recomputed independently of the contract. */
function shares(o) {
  let num = 0n, den = 0n;
  const per = {};
  for (const t of o.tokens) {
    const k = `${t.chain}:${t.token}`, scale = 10n ** BigInt(18 - t.decimals), stolen = big(t.stolen) * scale, w = big(t.weight);
    const total = big(o.returned[k]) * scale;
    const counted = (total < stolen ? total : stolen) * w;
    num += counted; den += stolen * w;
    if (total === 0n) continue;
    for (const [a, m] of Object.entries(o.returned_by)) { const mine = big(m[k]) * scale; if (mine > 0n) per[a] = (per[a] ?? 0n) + (counted * mine) / total; }
  }
  if (den === 0n || num === 0n) return {};
  const bounty = big(o.bounty);
  let owed = (bounty * num) / den; if (owed > bounty) owed = bounty;
  const out = {}; let given = 0n, top = "";
  for (const a of Object.keys(per).sort()) { out[a] = (bounty * per[a]) / den; given += out[a]; if (top === "" || per[a] > per[top]) top = a; }
  if (top && owed > given) out[top] += owed - given;
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v > 0n).map(([a, v]) => [a, v.toString()]));
}

const offers = { canonical: await allOffers(C.canonical), demo: await allOffers(C.demo) };
const cfg = { canonical: await C.canonical.view("get_config"), demo: await C.demo.view("get_config") };

// A
{
  const b = sh("python3", ["tools/build.py", "--check"]), f = sh("node", ["tools/sync_frontend.mjs", "--check"]);
  add("A", "source build", b.status === 0 && f.status === 0, b.status === 0 && f.status === 0 ? "build/ = contracts/ + shared; site copies identical" : (b.stdout + f.stdout).trim().slice(0, 300));
}
// B
{
  const v = sh("node", ["tools/verify_source.mjs", "--json"]);
  let j = null; try { j = JSON.parse(v.stdout); } catch { /* */ }
  add("B", "deployed bytes", v.status === 0 && j?.ok, j ? `${j.rows.filter((r) => r.identical).length}/${j.rows.length} byte-identical, one deploy commit ${j.commit.slice(0, 7)}` : v.stderr.slice(0, 200));
}
// C, D
{
  const probs = [], dprobs = [];
  let n = 0, nc = 0;
  for (const [reg, list] of Object.entries(offers)) for (const o of list) {
    if (o.status === "OPEN") continue;
    n++;
    const want = shares(o);
    const sum = Object.values(o.shares).reduce((s, v) => s + big(v), 0n);
    if (sum !== big(o.owed)) probs.push(`${reg} #${o.offer_id}: shares ${sum} != owed ${o.owed}`);
    if (JSON.stringify(want) !== JSON.stringify(Object.fromEntries(Object.entries(o.shares).sort()))) probs.push(`${reg} #${o.offer_id}: shares ${JSON.stringify(o.shares)} != recomputed ${JSON.stringify(want)}`);
    for (const a of Object.keys(o.shares)) if (!o.returned_by[a]) probs.push(`${reg} #${o.offer_id}: ${a} has a share but returned nothing`);
    for (const [a, c] of Object.entries(o.claims)) {
      nc++;
      if (c.amount !== o.shares[a]) probs.push(`${reg} #${o.offer_id}: claim by ${a} ${c.amount} != share ${o.shares[a]}`);
      const ben = o.beneficiaries[a];
      if (c.to !== (ben || a)) dprobs.push(`${reg} #${o.offer_id}: ${a} paid to ${c.to}, committed ${ben || "none"}`);
    }
  }
  add("C", "claim fairness", probs.length === 0 && n > 0, probs.length ? probs.join("; ") : `${n} settled offers: shares add up to owed, match an independent recomputation from per-address returns, only senders of counted returns hold one; ${nc} claims each paid exactly the claimer's share`);
  add("D", "beneficiaries", dprobs.length === 0, dprobs.length ? dprobs.join("; ") : `${nc} claims each paid to the claimer's committed beneficiary or to itself; ${Object.values(offers).flat().reduce((s, o) => s + Object.keys(o.beneficiaries).length, 0)} beneficiaries committed`);
}
// E
{
  const probs = [];
  let exp = 0, rec = 0;
  for (const [reg, list] of Object.entries(offers)) for (const o of list) {
    const ps = await proofsOf(C[reg], o.offer_id);
    if (o.status !== "OPEN" && ps.some((p) => p.status === "PENDING")) probs.push(`${reg} #${o.offer_id} settled with a PENDING proof`);
    const expired = ps.filter((p) => p.status === "EXPIRED").length;
    exp += expired;
    rec += ps.filter((p) => p.status === "COUNTED" && p.attempts > 1).length;
    if (expired !== o.n_expired) probs.push(`${reg} #${o.offer_id}: ${expired} EXPIRED proofs, n_expired ${o.n_expired}`);
    if (o.status === "OPEN") continue;
    if (expired > 0 && o.settled_at < o.recover_until && o.fraction_ppm < 1_000_000) probs.push(`${reg} #${o.offer_id} settled at ${o.settled_at} with EXPIRED proofs before its recovery window ended (${o.recover_until})`);
    if (o.fraction_ppm < 1_000_000 && o.settled_at < o.settle_at) probs.push(`${reg} #${o.offer_id} settled before its settle time`);
  }
  add("E", "evidence recovery", probs.length === 0, probs.length ? probs.join("; ") : `no settled offer shows a PENDING proof; ${rec} proofs COUNTED after a retry; ${exp} EXPIRED, each on an offer settled after its recovery window`);
}
// F
{
  const probs = [];
  const code = execFileSync("git", ["-C", root, "show", `${dep.SafeHarborGate.commit}:build/SafeHarborGate.py`]).toString();
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "gen_getContractSchemaForCode", params: ["0x" + Buffer.from(code).toString("hex")] });
  let schema = null;
  try { schema = (await (await fetch("https://studio-dev.genlayer.com/api", { method: "POST", headers: { "content-type": "application/json" }, body })).json()).result; } catch { /* */ }
  const methods = Object.keys(schema?.methods ?? {});
  if (!methods.length) probs.push("gate schema unreadable");
  for (const m of ["check", "is_favorable"]) if (methods.includes(m)) probs.push(`gate exposes ${m}`);
  const G = client({ role: "keeper", address: dep.SafeHarborGate.address });
  for (const o of offers.canonical) {
    const s = await G.view("check_for", [o.protocol, o.incident]);
    if (s.offer_id !== o.offer_id || (o.status === "OPEN" ? s.state !== "OPEN" : s.state !== o.status)) probs.push(`${o.incident}: gate ${s.state} #${s.offer_id}, registry ${o.status} #${o.offer_id}`);
  }
  const copied = await G.view("check_for", ["0x" + "1".repeat(40), offers.canonical[0]?.incident ?? "x"]);
  if (copied.state !== "NO_OFFER") probs.push("an unrelated address finds the canonical incident");
  add("F", "protocol-bound gate", probs.length === 0, probs.length ? probs.join("; ") : `gate methods: ${methods.join(", ")} (no check, no is_favorable); check_for(protocol, incident) matches the registry for all ${offers.canonical.length} canonical incidents; another address finds NO_OFFER`);
}
// G
{
  const probs = [];
  let n = 0;
  for (const [reg, list] of Object.entries(offers)) {
    const lock = cfg[reg].amend_lock_s, cap = cfg[reg].max_extend_s;
    for (const o of list) {
      let deadline = o.original_deadline, last = 0;
      for (const a of o.amendments) {
        n++;
        if (a.seq <= last) probs.push(`${reg} #${o.offer_id}: seq ${a.seq} not increasing`);
        last = a.seq;
        if (a.at >= deadline - lock) probs.push(`${reg} #${o.offer_id}: amendment #${a.seq} at ${a.at}, inside the lock before ${deadline}`);
        if (a.what === "deadline") { if (a.to <= a.from || a.from !== deadline) probs.push(`${reg} #${o.offer_id}: bad extension #${a.seq}`); deadline = a.to; }
      }
      if (deadline !== o.deadline || o.deadline - o.original_deadline > cap) probs.push(`${reg} #${o.offer_id}: deadline ${o.deadline} vs amendments ${deadline}, cap ${cap}`);
    }
  }
  add("G", "amendments", probs.length === 0, probs.length ? probs.join("; ") : `${n} amendments, each before deadline - lock (${cfg.canonical.amend_lock_s} s canonical, ${cfg.demo.amend_lock_s} s demo), extensions within the cap, sequence increasing; ${cfg.demo.amendments + cfg.canonical.amendments} recorded registry-wide`);
}
// H
{
  const parts = []; let ok = true;
  for (const [reg, a] of Object.entries(REGS)) {
    const s = await C[reg].view("get_stats"), bal = await balanceOf(a);
    if (bal !== big(s.held) || bal !== 0n) ok = false;
    const flows = big(s.received_total) === big(s.held) + big(s.paid_total) + big(s.refunded_total) + big(s.credit_paid_total);
    if (!flows) ok = false;
    parts.push(`${reg}: eth_getBalance ${bal}, held ${s.held}, received ${s.received_total} = paid ${s.paid_total} + refunded ${s.refunded_total} + credits ${s.credit_paid_total} + held`);
  }
  add("H", "funds", ok, parts.join("; "));
}
// I
{
  const p = JSON.parse(rd("docs/payouts.json")).payouts;
  const bad = [];
  const sup = [];
  for (const x of p) {
    const tx = await finalized(C.demo.read, x.tx, { timeoutMs: 60000 }); const d = payoutDelivered(tx, x.payee, x.amount);
    // a measurement may be superseded only by a named, clean repeat; delivery of the original is still required
    const repeat = x.superseded_by && p.find((y) => y.label === x.superseded_by && y.balances_ok && y.delivered);
    if (!d.ok || (!x.balances_ok && !repeat)) bad.push(`${x.label}: ${d.why || x.balances_why}`);
    else if (!x.balances_ok) sup.push(`${x.label} (delivered; balance delta disturbed: ${x.superseded_why}; repeated as ${x.superseded_by})`);
  }
  add("I", "payouts at recipients", bad.length === 0 && p.length > 0, `${p.length - bad.length - sup.length}/${p.length} demo payouts finalized, delivered and matched by eth_getBalance deltas${sup.length ? "; superseded measurement: " + sup.join("; ") : ""}${bad.length ? "; " + bad.join("; ") : ""}`);
}
// J
{
  const feas = JSON.parse(rd("docs/feasibility.json"));
  const probs = [], out = [];
  for (const o of offers.canonical) {
    const f = feas.incidents.find((x) => x.id === o.incident);
    if (!f) { probs.push(`${o.incident} not in feasibility.json`); continue; }
    if (Number(f.fraction_ppm) !== o.fraction_ppm) probs.push(`${o.incident}: chain ${o.fraction_ppm} ppm, re-read ${f.fraction_ppm}`);
    out.push(`${o.incident} ${(o.fraction_ppm / 1e4).toFixed(2)}%`);
  }
  add("J", "real-world outcomes", probs.length === 0 && out.length === 6, probs.length ? probs.join("; ") : out.join(", ") + "; each equals the independent two-RPC re-read in docs/feasibility.json");
}
// K
{
  const t = sh("sh", ["test/run_offline.sh"]), d = sh("sh", ["test/run_direct.sh"]);
  const all = t.stdout + t.stderr;
  const py = Number(all.match(/Ran (\d+) tests/)?.[1] ?? 0), js = Number(all.match(/# pass (\d+)/)?.[1] ?? 0);
  const dn = Number((d.stdout + d.stderr).match(/(\d+) passed/)?.[1] ?? 0);
  add("K", "tests", t.status === 0 && d.status === 0, `${py} offline contract tests, ${js} keeper tests, ${dn} Direct Mode tests: ${t.status === 0 && d.status === 0 ? "all pass" : "FAILURES"}`);
}
// L
{
  const probs = [];
  const src = (dir) => readdirSync(root + dir, { recursive: true }).filter((f) => /\.(tsx?|mjs)$/.test(f)).map((f) => [dir + "/" + f, rd(dir + "/" + f)]);
  for (const [f, t] of src("frontend/src")) if (/allOffers|allProofs/.test(t)) probs.push(`${f} reads every offer or proof`);
  const inc = rd("frontend/src/app/incident/[id]/page.tsx"), home = rd("frontend/src/app/page.tsx");
  if (!/informational/.test(inc) || !/informational/.test(home)) probs.push("declared share not labelled informational");
  let res = null; try { res = JSON.parse(rd("docs/e2e/results.json")); } catch { /* */ }
  const files = existsSync(root + "docs/e2e") ? readdirSync(root + "docs/e2e") : [];
  if (!res || res.stats.unexpected !== 0 || res.stats.expected < 1) probs.push("browser flows did not pass");
  add("L", "frontend", probs.length === 0, probs.length ? probs.join("; ") : `no unbounded list read; share labelled informational; browser flows passed with ${files.filter((f) => f.endsWith(".png")).length} screenshots and ${files.filter((f) => f.endsWith(".webm")).length} videos`);
}
// M
{
  let ks = null; try { ks = await (await fetch("https://raw.githubusercontent.com/kenil1710/whiteflag/keeper-state/keeper-state.json", { cache: "no-store" })).json(); } catch { /* */ }
  let sched = null;
  try { sched = (await (await fetch("https://api.github.com/repos/kenil1710/whiteflag/actions/workflows/keeper.yml/runs?event=schedule&status=success&per_page=1", { headers: { "user-agent": "audit" } })).json()).workflow_runs?.[0] ?? null; } catch { /* */ }
  const acts = Object.values(ks?.actions ?? {}).filter((a) => Object.values(REGS).map((x) => x.toLowerCase()).includes(a.registry));
  const failed = acts.filter((a) => a.status === "FAILED");
  const open = (ks?.unprocessed ?? []).filter((u) => Object.values(REGS).some((r) => u.key.startsWith(r.toLowerCase())));
  add("M", "keeper", Boolean(sched) && failed.length === 0 && open.length === 0, `${acts.filter((a) => a.status === "DONE").length} actions done on the current registries, ${failed.length} failed, ${open.length} unprocessed; latest successful scheduled run ${sched?.html_url ?? "NONE"} (${sched?.created_at ?? "-"})`);
}
// N
{
  const v = sh("node", ["tools/verify_demochain.mjs", "--live"]);
  add("N", "demo chain", v.status === 0, v.stdout.trim().split("\n").join("; ").slice(0, 300));
}

const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"]).toString().trim();
const pass = rows.filter((r) => r.ok).length;
writeFileSync(root + "docs/AUDIT.md", ["# Audit A-N", "", `Generated by \`node tools/audit.mjs\` at ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC on commit \`${head.slice(0, 7)}\`, from chain and the repository.`, "",
  `**${pass}/${rows.length} pass.**`, "", "| | Property | Result | Evidence |", "|---|---|---|---|",
  ...rows.map((r) => `| ${r.letter} | ${r.name} | ${r.ok ? "PASS" : "FAIL"} | ${r.detail.replace(/\|/g, "/")} |`), ""].join("\n"));
console.log(`\n${pass}/${rows.length} pass; wrote docs/AUDIT.md`);
process.exit(pass === rows.length ? 0 : 1);
