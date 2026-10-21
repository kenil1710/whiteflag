// End-to-end browser-wallet flows on the DEMO registry, through the live site,
// signed by throwaway wallets (wallet.mjs), recorded as screenshots and video
// in docs/e2e/:
//   1. create an offer (the protocol wallet locks a bounty)          01-03
//   2. submit proofs: one COUNTED, one REJECTED (SENDER_NOT_EXPLOITER) 04-05
//   3. successful finalization of a transaction                        06
//   4. settle: the remainder refunded to the protocol                 07
//   5. claim: the exploiter wallet claims its own share                08-09
//   6. refund: an unclaimed share refunded after the claim window      10
//   plus the incident page with per-address shares and amendments      11
//   E2E_BASE=https://whiteflag-ledger.vercel.app npx playwright test
import { test, expect } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, rmSync } from "node:fs";
import { accounts, fundOnStudio, CHAINS } from "../harness.mjs";
import { installWallet } from "./wallet.mjs";

const root = new URL("../../", import.meta.url);
const OUT = new URL("docs/e2e/", root).pathname;
const VIDEO_TMP = new URL("test/e2e/test-results/video/", root).pathname;
const plan = JSON.parse(readFileSync(new URL("docs/demochain.json", root), "utf8"));
const deployments = JSON.parse(readFileSync(new URL("deployments.json", root), "utf8")).contracts;
const REG = deployments.WhiteFlagRegistryDemo.address;
const lines = [];
const note = (s) => { const l = `${new Date().toISOString()} ${s}`; lines.push(l); console.log(l); };
let shotNo = 0;
async function shot(page, name) {
  const file = `${String(++shotNo).padStart(2, "0")}-${name}.png`;
  await page.screenshot({ path: OUT + file, fullPage: true });
  note(`screenshot ${file}`);
}
const now = () => Math.floor(Date.now() / 1000);
const local = (epoch) => new Date(epoch * 1000).toISOString().slice(0, 16);   // datetime-local, UTC
const status = (page) => page.getByRole("status");

/** Waits for the transaction progress line to reach `want`, failing fast on FAILED unless `allowFail`. */
async function waitPhase(page, want, ms = 20 * 60_000) {
  await expect(status(page)).toContainText(want, { timeout: ms });
  const text = await status(page).innerText();
  note(`progress: ${text.slice(0, 160)}`);
  return text;
}

async function connect(page) {
  // the site remembers a connection, so after the first page the wallet may reconnect by itself
  const signed = page.getByText("Signed in as").first();
  for (let i = 0; i < 20 && !(await signed.isVisible().catch(() => false)); i++) {
    const btn = page.getByRole("button", { name: "Connect wallet" });
    if (await btn.isVisible().catch(() => false)) await btn.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1500);
  }
  await expect(signed).toBeVisible({ timeout: 60_000 });
}

async function view(fn, args) {
  const r = await fetch(`https://whiteflag-ledger.vercel.app/api/view?${new URLSearchParams({ a: REG, f: fn, args: JSON.stringify(args), fresh: String(Date.now()) })}`);
  const j = await r.json();
  return typeof j.value === "string" ? JSON.parse(j.value) : j.value;
}

test("browser-wallet flows on the demo registry", async ({ browser }) => {
  mkdirSync(OUT, { recursive: true });
  rmSync(VIDEO_TMP, { recursive: true, force: true });
  const acc = accounts();
  for (const role of ["e2e_protocol", "e2e_exploiter", "e2e_stranger"]) await fundOnStudio(CHAINS.studiodev, acc[role].address, 20n * 10n ** 18n);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
  const ctx = async (role) => {
    const c = await browser.newContext({ recordVideo: { dir: VIDEO_TMP + role, size: { width: 1280, height: 900 } } });
    const address = await installWallet(c, acc[role].key, (l) => note(`wallet ${l}`));
    note(`${role} wallet ${address}`);
    return { c, page: await c.newPage(), address: address.toLowerCase() };
  };
  const P = await ctx("e2e_protocol");
  const X = await ctx("e2e_exploiter");
  const ids = {};

  // ---- 1. create two offers from the protocol wallet -----------------------------------------
  async function create(label, incident) {
    const page = P.page;
    await page.goto("/create?r=demo");
    await connect(page);
    await page.getByLabel("Incident id").fill(incident);
    await page.getByLabel("Name").fill(`E2E ${label} (browser wallet)`);
    await page.getByLabel(/^Chains/).fill("wfdemo");
    await page.getByLabel("Exploiter addresses (JSON)").fill(JSON.stringify([{ chain: "wfdemo", address: X.address }]));
    await page.getByLabel("Recovery addresses (JSON)").fill(JSON.stringify([{ chain: "wfdemo", address: plan.recovery_e2e }]));
    await page.getByLabel("Stolen tokens (JSON)").fill(JSON.stringify([{ chain: "wfdemo", token: "native", symbol: "ETH", decimals: 18, stolen: String(2n * 10n ** 18n), weight: "1" }]));
    await page.getByLabel("Return window start (UTC)").fill(local(plan.t0 - 7200));
    await page.getByLabel("Deadline (UTC)").fill(local(now() + 9 * 60));
    await page.getByLabel(/^Bounty locked/).fill("0.5");
    if (label === "claim") await shot(page, "create-offer-form");
    await page.getByRole("button", { name: "Lock the bounty and open the offer" }).click();
    await waitPhase(page, "ACCEPTED");
    await expect(page.getByText("Offer opened.")).toBeVisible({ timeout: 120_000 });
    await page.waitForTimeout(3000);
    // the offer this wallet opened under this incident (others may open offers at the same time)
    const mine = await view("get_offer_by", [P.address, incident]);
    expect(mine.found).toBe(true);
    ids[label] = mine.offer_id;
    note(`offer ${label}: #${ids[label]} (${incident})`);
    if (label === "claim") await shot(page, "create-offer-accepted");
  }
  await create("claim", `e2e-claim-${stamp}`);
  await create("refund", `e2e-refund-${stamp}`);
  await P.page.goto(`/incident/${ids.claim}?r=demo`);
  await shot(P.page, "offer-case-file-open");

  // ---- 2. proofs from the exploiter wallet: one counted, one rejected --------------------------
  async function prove(id, hashes, name) {
    const page = X.page;
    await page.goto(`/prove?r=demo&offer=${id}`);
    await connect(page);
    await page.getByLabel(/^Transaction hashes/).fill(hashes.map((h) => `wfdemo:${h}`).join("\n"));
    if (name) await shot(page, name + "-form");
    await page.getByRole("button", { name: "Send to the validators" }).click();
    await waitPhase(page, "ACCEPTED");
    await expect(page.getByText("Recorded by the registry")).toBeVisible({ timeout: 180_000 });
    if (name) await shot(page, name + "-recorded");
    return page;
  }
  const proofPage = await prove(ids.claim, [plan.txs["E2E-return"].hash, plan.txs["E2E-stranger"].hash], "proofs-counted-and-rejected");
  const claimProofs = await view("get_proofs", [ids.claim, 0, 10]);
  note(`proofs of #${ids.claim}: ${claimProofs.items.map((p) => `${p.status}${p.reason ? " " + p.reason : ""}`).join(", ")}`);
  expect(claimProofs.items.map((p) => p.status).sort()).toEqual(["COUNTED", "REJECTED"]);
  expect(claimProofs.items.find((p) => p.status === "REJECTED").reason).toBe("SENDER_NOT_EXPLOITER");

  // ---- 3. successful finalization ----------------------------------------------------------------
  await waitPhase(proofPage, "FINALIZED", 30 * 60_000);
  await shot(proofPage, "transaction-finalized");
  await prove(ids.refund, [plan.txs["E2E-return-2"].hash], null);

  // ---- 4. settle both: the remainder goes back to the protocol ------------------------------------
  const o1 = await view("get_offer", [ids.claim]);
  while (now() < o1.settle_at + 5) { note(`waiting ${o1.settle_at + 5 - now()} s for the settle time`); await P.page.waitForTimeout(Math.min(30, o1.settle_at + 6 - now()) * 1000); }
  for (const label of ["claim", "refund"]) {
    await P.page.goto("/claim?r=demo");
    await connect(P.page);
    const row = P.page.locator("tr", { hasText: `#${ids[label]} ` });
    await expect(row.getByRole("button", { name: "Settle" })).toBeVisible({ timeout: 180_000 });
    if (label === "claim") await shot(P.page, "settle-due");
    await row.getByRole("button", { name: "Settle" }).click();
    await waitPhase(P.page, "ACCEPTED");
    note(`settled #${ids[label]}: ${JSON.stringify((({ status, owed, refunded_at_settle, shares }) => ({ status, owed, refunded_at_settle, shares }))(await view("get_offer", [ids[label]])))}`);
  }

  // ---- 5. claim: the exploiter wallet claims its own share ------------------------------------------
  await X.page.goto("/claim?r=demo");
  await connect(X.page);
  const claimBtn = X.page.getByRole("button", { name: /^Claim .* GEN$/ }).first();
  await expect(claimBtn).toBeVisible({ timeout: 180_000 });
  await shot(X.page, "claim-own-share");
  await claimBtn.click();
  await waitPhase(X.page, "ACCEPTED");
  await shot(X.page, "claim-accepted");
  const after = await view("get_offer", [ids.claim]);
  note(`claim: ${JSON.stringify(after.claims)}`);
  expect(after.claims[X.address].amount).toBe(after.shares[X.address]);

  // ---- 6. refund: the unclaimed share after the claim window ---------------------------------------
  const o2 = await view("get_offer", [ids.refund]);
  while (now() <= o2.claim_deadline + 5) { note(`waiting ${o2.claim_deadline + 5 - now()} s for the claim window`); await P.page.waitForTimeout(Math.min(30, o2.claim_deadline + 6 - now()) * 1000); }
  await P.page.goto("/claim?r=demo");
  await connect(P.page);
  const row = P.page.locator("tr", { hasText: `#${ids.refund} ` });
  await expect(row.getByRole("button", { name: "Refund" })).toBeVisible({ timeout: 180_000 });
  await row.getByRole("button", { name: "Refund" }).click();
  await waitPhase(P.page, "ACCEPTED");
  await shot(P.page, "refund-unclaimed-accepted");
  const r2 = await view("get_offer", [ids.refund]);
  note(`refund: unclaimed_refunded ${r2.unclaimed_refunded} of owed ${r2.owed}`);
  expect(r2.unclaimed_refunded).toBe(r2.owed);

  await P.page.goto(`/incident/${ids.claim}?r=demo`);
  await shot(P.page, "case-file-settled-and-claimed");

  for (const c of [P, X]) await c.c.close();
  for (const role of ["e2e_protocol", "e2e_exploiter"]) {
    const dir = VIDEO_TMP + role + "/";
    const vids = readdirSync(dir).filter((f) => f.endsWith(".webm"));
    vids.forEach((f, i) => renameSync(dir + f, OUT + `${role.replace("e2e_", "")}${vids.length > 1 ? "-" + (i + 1) : ""}.webm`));
  }
  writeFileSync(OUT + "run.log", lines.join("\n") + "\n");
  writeFileSync(OUT + "run.json", JSON.stringify({ base: "https://whiteflag-ledger.vercel.app", registry: REG, offers: ids, finished_at: new Date().toISOString() }, null, 2) + "\n");
});
