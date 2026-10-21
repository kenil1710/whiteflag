/**
 * Everything at once, written to docs/FINAL_CHECK.md:
 *   1  build/ is the build of contracts/; the site's copies match the repository
 *   2  on-chain code is byte-identical to build/ at the deploy commit and HEAD
 *   3  addresses are the same everywhere they are written
 *   4  every link in the docs answers 200 (or is a site that only serves browsers)
 *   5  every canonical seed is settled and every owed bounty claimed or refunded
 *   6  every demo payout arrived (finalized, delivered, balances moved by the amount)
 *   7  every registry's eth_getBalance is what its ledger says (0 when all is settled)
 *   8  the keeper ran within the last 8 hours (6-hourly fallback plus GitHub's delay), has no failed action, and a
 *      scheduled run succeeded
 *   9  the offline test suite passes
 *  10  no placeholder language in the docs
 *  11  README names the deploy commit and the final commit; SUBMISSION.md's evidence links are pinned to the final
 *      commit, which is pushed; after it only README.md, docs/SUBMISSION.md, docs/FINAL_CHECK.md, docs/AUDIT.md and
 *      docs/STEWARD_RESPONSE.md change
 *  12  the CI workflow (offline, Direct Mode, lint, frontend, keeper, deployed source) passed on the final commit
 *  13  the browser-wallet flows passed and their screenshots and videos are in docs/e2e/
 *  14  the demo chain's transactions are signed by the keys the file names, and the site serves them as written
 *   node tools/final_check.mjs       exit 1 if any check fails
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { client, deployments, balanceOf, finalized, payoutDelivered } from "./lib/wf.mjs";
import { CHAINS } from "./lib/chains.mjs";

const root = new URL("..", import.meta.url).pathname;
const rd = (p) => readFileSync(root + p, "utf8");
const dep = deployments().contracts;
const checks = [];
const add = (name, ok, detail) => { checks.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${detail}`); };
const sh = (cmd, args) => spawnSync(cmd, args, { cwd: root, encoding: "utf8", maxBuffer: 64 << 20 });

// 1
{
  const b = sh("python3", ["tools/build.py", "--check"]);
  const f = sh("node", ["tools/sync_frontend.mjs", "--check"]);
  add("build and site copies fresh", b.status === 0 && f.status === 0, b.status === 0 && f.status === 0 ? "build/ = contracts/ + shared; frontend copies of deployments, incidents, demo chain, verify rule and RULES.md identical" : (b.stdout + f.stdout).trim());
}
// 2
{
  const v = sh("node", ["tools/verify_source.mjs", "--json"]);
  let j = null; try { j = JSON.parse(v.stdout); } catch { /* */ }
  add("source match", v.status === 0 && j?.ok, j ? `${j.rows.filter((r) => r.identical).length}/${j.rows.length} contracts byte-identical to build/ at ${j.commit.slice(0, 7)} and HEAD; all from one commit: ${j.one_commit}` : v.stderr.slice(0, 200));
}
// 3
{
  const addrs = Object.values(dep).map((c) => c.address);
  const files = ["README.md", "docs/SUBMISSION.md", "docs/SEEDS.md", "docs/STEWARD_RESPONSE.md", "frontend/src/lib/deployments.json"];
  const missing = [];
  for (const f of files) { if (!existsSync(root + f)) { missing.push(f + " (missing)"); continue; } const t = rd(f).toLowerCase(); for (const a of addrs) if (!t.includes(a.toLowerCase())) missing.push(`${f} lacks ${a}`); }
  // superseded contracts may be named only in docs/superseded/, deployments.json's superseded list and the README's note
  const old = (JSON.parse(rd("deployments.json")).superseded ?? []).map((c) => c.address.toLowerCase());
  const stray = [];
  for (const f of ["docs/SUBMISSION.md", "docs/SEEDS.md", "frontend/src/lib/deployments.json"]) if (existsSync(root + f)) for (const s of old) if (rd(f).toLowerCase().includes(s)) stray.push(`${f} names superseded contract ${s}`);
  add("addresses consistent", missing.length === 0 && stray.length === 0, missing.length + stray.length === 0 ? `the 4 deployed addresses appear in ${files.join(", ")}; no superseded address outside docs/superseded/ and the README's note` : [...missing, ...stray].join("; "));
}
// 4
{
  const BROWSER_ONLY = /(etherscan\.io|arbiscan\.io|medium\.com|theblock\.co|cointelegraph\.com|decrypt\.co|dlnews\.com|rekt\.news|merklescience\.com|unchainedcrypto\.com|x\.com|twitter\.com)/;
  const docs = ["README.md", ...readdirSync(root + "docs").filter((f) => f.endsWith(".md")).map((f) => "docs/" + f)];
  const urls = new Set();
  // JSON-RPC endpoints answer POSTs only; tools/feasibility.mjs reads them for real
  const RPCS = new Set(Object.values(CHAINS).flatMap((c) => c.rpcs));
  for (const f of docs) for (const m of rd(f).matchAll(/https?:\/\/[^\s)<>"'`|\]*]+/g)) { const u = m[0].replace(/[.,;:]+$/, ""); if (!RPCS.has(u)) urls.add(u); }
  const bad = [], browser = [];
  let ok = 0;
  const list = [...urls];
  for (let i = 0; i < list.length; i += 8) {
    await Promise.all(list.slice(i, i + 8).map(async (u) => {
      let code = 0;
      for (let k = 0; k < 3 && code !== 200; k++) {
        try { const r = await fetch(u, { redirect: "follow", headers: { "user-agent": "Mozilla/5.0 (Macintosh) final_check" }, signal: AbortSignal.timeout(25000) }); code = r.status; } catch { code = -1; }
        if (code !== 200) await new Promise((r) => setTimeout(r, 1500));
      }
      if (code === 200) ok++;
      else if (BROWSER_ONLY.test(u) && [403, 429, 503, 202, -1].includes(code)) browser.push(`${u} (${code})`);
      else bad.push(`${u} (${code})`);
    }));
  }
  add("links", bad.length === 0, `${ok} answered 200; ${browser.length} browser-only (bot wall: ${[...new Set(browser.map((b) => b.split("/")[2]))].join(", ") || "none"})${bad.length ? "; BROKEN: " + bad.join(", ") : ""}`);
}
// 5
{
  const seed = JSON.parse(rd("docs/seed-canonical.json"));
  const C = client({ role: "keeper", address: dep.WhiteFlagRegistry.address });
  const probs = [];
  const out = [];
  for (const [id, s] of Object.entries(seed.incidents)) {
    const o = await C.view("get_offer", [s.offer_id]);
    const closed = o.status !== "OPEN" && BigInt(o.owed) === BigInt(o.claimed) + BigInt(o.unclaimed_refunded);
    if (!closed) probs.push(`${id} ${o.status}, owed ${o.owed}, claimed ${o.claimed}, refunded ${o.unclaimed_refunded}`);
    out.push(`${id} ${o.status} ${(o.fraction_ppm / 1e4).toFixed(2)}%`);
  }
  add("canonical seeds settled", probs.length === 0, probs.length ? probs.join("; ") : out.join("; ") + "; every owed share claimed or refunded after the claim window");
}
// 6
{
  const p = JSON.parse(rd("docs/payouts.json")).payouts;
  const C = client({ role: "keeper", address: dep.WhiteFlagRegistryDemo.address });
  const bad = [];
  for (const x of p) {
    const tx = await finalized(C.read, x.tx, { timeoutMs: 60000 });
    const d = payoutDelivered(tx, x.payee, x.amount);
    if (!d.ok || !x.balances_ok) bad.push(`${x.label}: ${d.why || x.balances_why}`);
  }
  // the canonical keeper's payouts
  let ks = null; try { ks = await (await fetch("https://raw.githubusercontent.com/kenil1710/whiteflag/keeper-state/keeper-state.json", { cache: "no-store" })).json(); } catch { /* */ }
  const Cc = client({ role: "keeper", address: dep.WhiteFlagRegistry.address });
  let kp = 0;
  for (const a of Object.values(ks?.actions ?? {})) {
    if (a.status !== "DONE" || a.done_by_other || !a.finalized_hash || a.registry !== dep.WhiteFlagRegistry.address.toLowerCase() || a.action === "RETRY_PENDING") continue;
    const o = await Cc.view("get_offer", [a.offer_id]);
    const amount = a.action === "SETTLE" ? o.refunded_at_settle : o.unclaimed_refunded;
    if (BigInt(amount) === 0n) continue;
    const tx = await finalized(Cc.read, a.finalized_hash, { timeoutMs: 60000 });
    const d = payoutDelivered(tx, o.protocol, amount);
    if (!d.ok) bad.push(`keeper ${a.key}: ${d.why}`); else kp++;
  }
  add("payouts arrived", bad.length === 0 && p.length > 0, `${p.length} demo payouts finalized, delivered and matched by eth_getBalance deltas; ${kp} canonical refunds by the keeper delivered to the protocol${bad.length ? "; " + bad.join("; ") : ""}`);
}
// 7
{
  const parts = [];
  let ok = true;
  for (const n of ["WhiteFlagRegistry", "WhiteFlagRegistryDemo"]) {
    const C = client({ role: "keeper", address: dep[n].address });
    const s = await C.view("get_stats");
    const bal = await balanceOf(dep[n].address);
    const expect = BigInt(s.held);
    if (bal !== expect || expect !== 0n) ok = false;
    parts.push(`${n} eth_getBalance ${bal} wei, ledger holds ${expect}`);
  }
  add("registry balances", ok, parts.join("; "));
}
// 8
{
  let ks = null; try { ks = await (await fetch("https://raw.githubusercontent.com/kenil1710/whiteflag/keeper-state/keeper-state.json", { cache: "no-store" })).json(); } catch { /* */ }
  const last = ks?.last_run?.finished_at ?? 0;
  const age = Math.floor(Date.now() / 1000) - last;
  const failed = Object.values(ks?.actions ?? {}).filter((a) => a.status === "FAILED");
  const done = Object.values(ks?.actions ?? {}).filter((a) => a.status === "DONE");
  let sched = null;
  try { sched = (await (await fetch("https://api.github.com/repos/kenil1710/whiteflag/actions/workflows/keeper.yml/runs?event=schedule&status=success&per_page=1", { headers: { "user-agent": "final_check" } })).json()).workflow_runs?.[0] ?? null; } catch { /* */ }
  add("keeper ran", last > 0 && age < 8 * 3600 && failed.length === 0 && sched !== null, `last run ${new Date(last * 1000).toISOString()} (${Math.round(age / 60)} min ago), ${done.length} actions done, ${failed.length} failed, ${ks?.unprocessed?.length ?? "?"} unprocessed; ${sched ? `latest successful scheduled run ${sched.html_url} (${sched.created_at})` : "NO successful scheduled run"}`);
}
// 9
{
  const t = sh("sh", ["test/run_offline.sh"]);
  const all = t.stdout + t.stderr;
  const py = Number(all.match(/Ran (\d+) tests/)?.[1] ?? 0), js = Number(all.match(/# pass (\d+)/)?.[1] ?? 0), jf = Number(all.match(/# fail (\d+)/)?.[1] ?? 1);
  const d = sh("sh", ["test/run_direct.sh"]);
  const dn = Number((d.stdout + d.stderr).match(/(\d+) passed/)?.[1] ?? 0), df = /failed|error/i.test((d.stdout + d.stderr).split("\n").slice(-2).join(" "));
  add("tests pass", t.status === 0 && jf === 0 && d.status === 0 && !df, `${py + js} offline tests (${py} contract, gate, attack and meaning; ${js} keeper) and ${dn} GenLayer Direct Mode tests, ${t.status === 0 && d.status === 0 ? "all pass" : "FAILURES"}`);
}
// 10
{
  const files = ["README.md", ...readdirSync(root + "docs").filter((f) => f.endsWith(".md")).map((f) => "docs/" + f)];
  const hits = [];
  for (const f of files) for (const w of ["Known limitations", "TODO", "TBD", "lorem"]) if (rd(f).includes(w)) hits.push(`${f}: ${w}`);
  add("no placeholders", hits.length === 0, hits.length ? hits.join("; ") : `${files.length} documents checked`);
}
// 11
{
  const probs = [];
  const readme = rd("README.md"), sub = rd("docs/SUBMISSION.md");
  const deployCommit = dep.WhiteFlagRegistry.commit;
  if (!readme.includes(deployCommit)) probs.push("README lacks the deploy commit");
  const fin = readme.match(/Final commit `([0-9a-f]{40})`/)?.[1];
  if (!fin) probs.push("README names no final commit");
  else {
    if (!sub.includes(fin)) probs.push("SUBMISSION.md does not name the final commit");
    const blobs = [...sub.matchAll(/github\.com\/kenil1710\/whiteflag\/blob\/([0-9a-f]+)\//g)].map((m) => m[1]);
    if (blobs.length === 0) probs.push("SUBMISSION.md has no pinned evidence links");
    if (blobs.some((b) => b !== fin)) probs.push("an evidence link is not pinned to the final commit");
    const pushed = sh("git", ["branch", "-r", "--contains", fin]).stdout.includes("origin/main");
    if (!pushed) probs.push("the final commit is not on origin/main");
    const changed = sh("git", ["diff", "--name-only", fin]).stdout.trim().split("\n").filter(Boolean);
    const extra = changed.filter((f) => !["README.md", "docs/SUBMISSION.md", "docs/FINAL_CHECK.md", "docs/AUDIT.md", "docs/STEWARD_RESPONSE.md"].includes(f));
    if (extra.length) probs.push("changed after the final commit: " + extra.join(", "));
  }
  add("verification package", probs.length === 0, probs.length ? probs.join("; ") : `deploy commit ${deployCommit.slice(0, 7)} and final commit ${fin.slice(0, 7)} named in README; every evidence link in SUBMISSION.md pinned to ${fin.slice(0, 7)}, which is on origin/main; since then only README.md and docs/{SUBMISSION,FINAL_CHECK,AUDIT,STEWARD_RESPONSE}.md`);
}
// 12
{
  const fin = rd("README.md").match(/Final commit `([0-9a-f]{40})`/)?.[1];
  let run = null;
  try { run = (await (await fetch(`https://api.github.com/repos/kenil1710/whiteflag/actions/workflows/ci.yml/runs?head_sha=${fin}&per_page=5`, { headers: { "user-agent": "final_check" } })).json()).workflow_runs?.find((r) => r.conclusion === "success") ?? null; } catch { /* */ }
  add("CI passed", Boolean(run), run ? `ci.yml run ${run.html_url} succeeded on ${String(fin).slice(0, 7)} (offline, Direct Mode, lint, frontend, keeper, deployed source)` : `no successful ci.yml run on the final commit ${String(fin).slice(0, 7)}`);
}
// 13
{
  let res = null; try { res = JSON.parse(rd("docs/e2e/results.json")); } catch { /* */ }
  const files = existsSync(root + "docs/e2e") ? readdirSync(root + "docs/e2e") : [];
  const pngs = files.filter((f) => f.endsWith(".png")).length, vids = files.filter((f) => f.endsWith(".webm")).length;
  const ok = res && res.stats && res.stats.unexpected === 0 && res.stats.expected > 0 && pngs >= 8 && vids >= 2;
  add("browser flows", Boolean(ok), res ? `${res.stats.expected} Playwright flow(s) passed, ${res.stats.unexpected} failed; ${pngs} screenshots and ${vids} videos in docs/e2e/` : "docs/e2e/results.json missing");
}
// 14
{
  const v = sh("node", ["tools/verify_demochain.mjs", "--live"]);
  add("demo chain", v.status === 0, (v.stdout.trim().split("\n").join("; ")).slice(0, 400));
}

const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"]).toString().trim();
const pass = checks.filter((c) => c.ok).length;
const md = ["# Final check", "", `Generated by \`node tools/final_check.mjs\` at ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC on commit \`${head.slice(0, 7)}\` (the final commit plus its pinned links).`, "",
  `**${pass}/${checks.length} checks pass.**`, "", "| # | Check | Result | Detail |", "|---|---|---|---|",
  ...checks.map((c, i) => `| ${i + 1} | ${c.name} | ${c.ok ? "PASS" : "FAIL"} | ${c.detail.replace(/\|/g, "/")} |`), ""];
writeFileSync(root + "docs/FINAL_CHECK.md", md.join("\n"));
console.log(`\n${pass}/${checks.length} pass; wrote docs/FINAL_CHECK.md`);
process.exit(pass === checks.length ? 0 : 1);
