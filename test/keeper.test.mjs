// The keeper, offline: a fake registry with the contract's due rules, a
// scripted transaction lifecycle, outages and crashes.   node --test test/keeper.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { runKeeper, emptyState, keyOf, stillDue, effectVisible, backoffS, canonicalAddress, MAX_ATTEMPTS, PAGE } from "../tools/lib/keeper_core.mjs";

const REG = "0x" + "aa".repeat(20);
const REG2 = "0x" + "bb".repeat(20);

class Fake {
  constructor(n = 0, { now = 1_000_000 } = {}) {
    this.t = now;
    this.regs = { [REG]: [], [REG2]: [] };
    for (let i = 0; i < n; i++) this.add(REG, {});
    this.txs = {};
    this.n = 0;
    this.submits = [];
    this.lifecycle = () => ["ACCEPTED", "FINALIZED"];   // statuses a new tx walks through, one per poll
    this.failPages = new Set();
    this.failOffer = false;
    this.failSubmit = 0;
    this.applyOnFinal = true;
    this.visible = true;
    this.waitPolls = 5;    // how many polls one run's wait budget allows
  }
  add(reg, o) {
    const id = this.regs[reg].length + 1;
    this.regs[reg].push({ offer_id: id, found: true, status: "OPEN", settle_at: this.t - 10, fraction_ppm: 0, owed: "0",
      claimed: "0", unclaimed_refunded: "0", claim_deadline: 0, protocol: "0xp", ...o });
    return id;
  }
  due(o, now) {
    if (o.status === "OPEN") {
      const pend = o.n_pending ?? 0, until = o.recover_until ?? o.settle_at;
      if (o.fraction_ppm >= 1e6 || now >= until || (now >= o.settle_at && pend === 0)) return "SETTLE";
      return pend > 0 && now >= o.settle_at ? "RETRY_PENDING" : "";
    }
    if (BigInt(o.owed) > 0n && o.claimed === "0" && o.unclaimed_refunded === "0" && now > o.claim_deadline) return "REFUND_UNCLAIMED";
    return "";
  }
  apply(reg, action, id) {
    const o = this.regs[reg][id - 1];
    if (action === "RETRY_PENDING") {
      if (o.status !== "OPEN") return false;
      o.retries = (o.retries ?? 0) + 1;
      if (this.retryClears) o.n_pending = 0;
      return true;
    }
    if (action === "SETTLE") {
      if (o.status !== "OPEN") return false;
      o.status = o.fraction_ppm >= 1e6 ? "SETTLED_FULL" : o.fraction_ppm > 0 ? "SETTLED_PARTIAL" : "SETTLED_NONE";
      o.owed = o.fraction_ppm > 0 ? "100" : "0";
      o.claim_deadline = this.t + 3600;
      return true;
    }
    if (o.unclaimed_refunded !== "0" || o.claimed !== "0") return false;
    o.unclaimed_refunded = o.owed;
    return true;
  }
  chain() {
    const f = this;
    return {
      now: () => f.t,
      async getDue(reg, offset, limit, now) {
        if (f.failPages.has(offset)) throw new Error("rpc down");
        const all = f.regs[reg];
        const slice = all.slice(offset, offset + limit);
        const items = slice.map((o) => ({ ...o, due: f.due(o, now) })).filter((o) => o.due);
        const nxt = offset + slice.length;
        return { total: all.length, items, scanned: slice.length, next_offset: nxt < all.length ? nxt : -1 };
      },
      async getOffer(reg, id) {
        if (f.failOffer) throw new Error("read down");
        const o = f.regs[reg][id - 1];
        return f.visible ? JSON.parse(JSON.stringify(o)) : { ...JSON.parse(JSON.stringify(o)), status: "OPEN", unclaimed_refunded: "0" };
      },
      async submit(reg, action, offer) {
        if (f.failSubmit > 0) { f.failSubmit--; throw new Error("submit refused"); }
        const hash = "0x" + (++f.n).toString(16).padStart(64, "0");
        f.submits.push({ reg, action, id: offer.offer_id, hash });
        f.txs[hash] = { reg, action, id: offer.offer_id, steps: f.lifecycle(offer), i: -1, applied: false, ok: true };
        return hash;
      },
      async getTx(hash) {
        const tx = f.txs[hash];
        if (!tx) return null;
        tx.i = Math.min(tx.i + 1, tx.steps.length - 1);
        const s = tx.steps[tx.i];
        if (s === "FINALIZED" && !tx.applied) {
          tx.applied = true;
          tx.ok = f.applyOnFinal ? f.apply(tx.reg, tx.action, tx.id) : true;
        }
        if (s === "NOT_VISIBLE") return null;
        return { statusName: s, ok: s === "FINALIZED" ? tx.ok : s === "ACCEPTED" };
      },
      async wait(hash) {
        let tx = null;
        for (let i = 0; i < f.waitPolls; i++) {
          tx = await this.getTx(hash);
          if (tx && tx.statusName !== "ACCEPTED") return tx;
        }
        return tx;
      },
    };
  }
}

function memStore(initial = null) {
  const s = { state: initial, saves: 0, notes: [], crashAfter: Infinity };
  s.load = async () => (s.state ? JSON.parse(JSON.stringify(s.state)) : null);
  s.save = async (state, why) => {
    s.state = JSON.parse(JSON.stringify(state)); s.saves++; s.notes.push(why);
    if (s.saves >= s.crashAfter) { s.crashAfter = Infinity; throw new Error("CRASH"); }
  };
  return s;
}

const run = (f, store, extra = {}) => runKeeper({ chain: f.chain(), store, registries: [REG], ...extra });

test("settles an expired offer and verifies it", async () => {
  const f = new Fake(1), s = memStore();
  const { run: r } = await run(f, s);
  assert.equal(f.regs[REG][0].status, "SETTLED_NONE");
  assert.equal(r.done, 1);
  const a = s.state.actions[keyOf(REG, 1, "SETTLE")];
  assert.equal(a.status, "DONE");
  assert.equal(a.finalized_hash, a.hashes[0]);
});

test("does nothing when nothing is due", async () => {
  const f = new Fake(0), s = memStore();
  f.add(REG, { settle_at: f.t + 1000 });
  const { run: r } = await run(f, s);
  assert.equal(r.submitted, 0);
  assert.deepEqual(s.state.unprocessed, []);
});

test("refunds an owed bounty after the claim window", async () => {
  const f = new Fake(0), s = memStore();
  f.add(REG, { status: "SETTLED_PARTIAL", owed: "100", claim_deadline: f.t - 1 });
  await run(f, s);
  assert.equal(f.regs[REG][0].unclaimed_refunded, "100");
  assert.equal(s.state.actions[keyOf(REG, 1, "REFUND_UNCLAIMED")].status, "DONE");
});

test("does not refund inside the claim window", async () => {
  const f = new Fake(0), s = memStore();
  f.add(REG, { status: "SETTLED_PARTIAL", owed: "100", claim_deadline: f.t });
  await run(f, s);
  assert.equal(f.submits.length, 0);
});

test("does not refund a claimed bounty", async () => {
  const f = new Fake(0), s = memStore();
  f.add(REG, { status: "SETTLED_PARTIAL", owed: "100", claimed: "100", claim_deadline: f.t - 10 });
  await run(f, s);
  assert.equal(f.submits.length, 0);
});

test("settle then refund across runs", async () => {
  const f = new Fake(0), s = memStore();
  f.add(REG, { fraction_ppm: 500000 });
  await run(f, s);
  assert.equal(f.regs[REG][0].status, "SETTLED_PARTIAL");
  f.t += 3601;
  await run(f, s);
  assert.equal(f.regs[REG][0].unclaimed_refunded, "100");
  assert.deepEqual(f.submits.map((x) => x.action), ["SETTLE", "REFUND_UNCLAIMED"]);
});

test("early settle at 100% before the settle time", async () => {
  const f = new Fake(0), s = memStore();
  f.add(REG, { settle_at: f.t + 10_000, fraction_ppm: 1_000_000 });
  await run(f, s);
  assert.equal(f.regs[REG][0].status, "SETTLED_FULL");
});

test("idempotent: a second run submits nothing", async () => {
  const f = new Fake(5), s = memStore();
  await run(f, s);
  const n = f.submits.length;
  await run(f, s);
  await run(f, s);
  assert.equal(f.submits.length, n);
  assert.equal(n, 5);
});

test("more than 50 offers: every page is scanned", async () => {
  const f = new Fake(137), s = memStore();
  const { run: r } = await run(f, s, { maxActions: 1000 });
  assert.equal(r.scanned, 137);
  assert.equal(f.submits.length, 137);
  assert.ok(f.regs[REG].every((o) => o.status !== "OPEN"));
  assert.equal(s.state.registries[REG].scans_completed, 1);
});

test(">50 offers with a budget: later runs continue from the cursor", async () => {
  const f = new Fake(60), s = memStore();
  await run(f, s, { maxActions: 25 });
  assert.equal(f.submits.length, 25);
  assert.equal(s.state.unprocessed.filter((u) => u.why.includes("budget")).length, 35);
  await run(f, s, { maxActions: 25 });
  await run(f, s, { maxActions: 25 });
  assert.equal(f.submits.length, 60);
  assert.equal(new Set(f.submits.map((x) => x.id)).size, 60);
  assert.deepEqual(s.state.unprocessed, []);
});

test("cursor is persisted after every page", async () => {
  const f = new Fake(70), s = memStore();
  f.regs[REG].forEach((o) => { o.settle_at = f.t + 999; });
  await run(f, s);
  const cursorNotes = s.notes.filter((n) => n.startsWith("cursor"));
  assert.equal(cursorNotes.length, Math.ceil(70 / PAGE));
});

test("outage on one page: cursor stays there and the page is listed", async () => {
  const f = new Fake(50), s = memStore();
  f.failPages.add(20);
  const { run: r } = await run(f, s, { maxActions: 1000 });
  assert.equal(f.submits.length, 20);
  assert.equal(s.state.registries[REG].cursor, 20);
  assert.ok(s.state.unprocessed.some((u) => u.key.includes(":page:20")));
  assert.equal(r.errors.length, 1);
});

test("backfill after an outage: the next run picks up from the cursor and covers everything", async () => {
  const f = new Fake(50), s = memStore();
  f.failPages.add(20);
  await run(f, s, { maxActions: 1000 });
  f.failPages.clear();
  f.t += 7200;
  await run(f, s, { maxActions: 1000 });
  assert.equal(f.submits.length, 50);
  assert.ok(f.regs[REG].every((o) => o.status !== "OPEN"));
});

test("full outage: nothing submitted, nothing marked, error recorded", async () => {
  const f = new Fake(10), s = memStore();
  f.failPages.add(0);
  const { run: r } = await run(f, s);
  assert.equal(f.submits.length, 0);
  assert.equal(r.errors.length, 1);
  assert.equal(Object.keys(s.state.actions).length, 0);
});

test("ACCEPTED but not final: not counted, not resubmitted, finished next run", async () => {
  const f = new Fake(1), s = memStore();
  f.waitPolls = 1;
  f.lifecycle = () => ["ACCEPTED", "FINALIZED"];
  const { run: r1 } = await run(f, s);
  const a1 = s.state.actions[keyOf(REG, 1, "SETTLE")];
  assert.equal(a1.status, "ACCEPTED");
  assert.equal(r1.done, 0);
  assert.ok(s.state.unprocessed.some((u) => u.why.startsWith("waiting for")));
  const { run: r2 } = await run(f, s);
  assert.equal(r2.done, 1);
  assert.equal(f.submits.length, 1);
  assert.equal(s.state.actions[keyOf(REG, 1, "SETTLE")].status, "DONE");
});

test("ACCEPTED for many runs: never a second transaction", async () => {
  const f = new Fake(1), s = memStore();
  f.lifecycle = () => ["ACCEPTED"];
  for (let i = 0; i < 6; i++) { f.t += 60; await run(f, s); }
  assert.equal(f.submits.length, 1);
  assert.equal(s.state.actions[keyOf(REG, 1, "SETTLE")].status, "ACCEPTED");
});

test("crash right after submit: resume from the stored hash, no duplicate", async () => {
  const f = new Fake(1), s = memStore();
  f.lifecycle = () => ["ACCEPTED", "FINALIZED"];
  s.crashAfter = s.saves + 1; // the checkpoint after submit is written, then the process dies
  await assert.rejects(run(f, s), /CRASH/);
  assert.equal(s.state.actions[keyOf(REG, 1, "SETTLE")].status, "SUBMITTED");
  assert.equal(f.submits.length, 1);
  await run(f, s);                       // resumes: still ACCEPTED, due again but in flight
  assert.equal(f.submits.length, 1);
  assert.equal(s.state.actions[keyOf(REG, 1, "SETTLE")].status, "ACCEPTED");
  await run(f, s);
  assert.equal(f.submits.length, 1);
  assert.equal(s.state.actions[keyOf(REG, 1, "SETTLE")].status, "DONE");
});

test("crash mid-scan: pages before the crash are not rescanned into duplicates", async () => {
  const f = new Fake(45), s = memStore();
  s.crashAfter = 30;
  await assert.rejects(run(f, s, { maxActions: 1000 }), /CRASH/);
  const before = f.submits.length;
  await run(f, s, { maxActions: 1000 });
  assert.equal(new Set(f.submits.map((x) => x.id)).size, f.submits.length);
  assert.equal(f.submits.length, 45);
  assert.ok(before > 0);
});

test("reverted because someone else settled first: DONE by other, no retry", async () => {
  const f = new Fake(1), s = memStore();
  const c = f.chain();
  const orig = c.submit.bind(c);
  c.submit = async (reg, action, offer) => { const h = await orig(reg, action, offer); f.apply(REG, "SETTLE", 1); return h; };
  await runKeeper({ chain: c, store: s, registries: [REG] });
  const a = s.state.actions[keyOf(REG, 1, "SETTLE")];
  assert.equal(a.status, "DONE");
  assert.equal(a.done_by_other, true);
});

test("someone settled before the keeper looked: no submit", async () => {
  const f = new Fake(1), s = memStore();
  const c = f.chain();
  const og = c.getDue.bind(c);
  c.getDue = async (...a) => { const p = await og(...a); f.apply(REG, "SETTLE", 1); return p; };
  await runKeeper({ chain: c, store: s, registries: [REG] });
  assert.equal(f.submits.length, 0);
  assert.equal(s.state.actions[keyOf(REG, 1, "SETTLE")].status, "DONE");
});

test("UNDETERMINED: queued for retry with backoff, resubmitted after it", async () => {
  const f = new Fake(1), s = memStore();
  f.lifecycle = () => ["UNDETERMINED"];
  await run(f, s);
  const a = s.state.actions[keyOf(REG, 1, "SETTLE")];
  assert.equal(a.status, "RETRY");
  assert.equal(a.next_try_at, f.t + backoffS(1));
  await run(f, s);
  assert.equal(f.submits.length, 1, "not before the backoff");
  f.lifecycle = () => ["FINALIZED"];
  f.t += backoffS(1);
  await run(f, s);
  assert.equal(f.submits.length, 2);
  assert.equal(s.state.actions[keyOf(REG, 1, "SETTLE")].status, "DONE");
});

test("retry queue survives in state between runs", async () => {
  const f = new Fake(1), s = memStore();
  f.failSubmit = 1;
  await run(f, s);
  const saved = JSON.parse(JSON.stringify(s.state));
  assert.equal(saved.actions[keyOf(REG, 1, "SETTLE")].status, "RETRY");
  const s2 = memStore(saved);
  f.t += 3600;
  await run(f, s2);
  assert.equal(s2.state.actions[keyOf(REG, 1, "SETTLE")].status, "DONE");
});

test("gives up after MAX_ATTEMPTS and lists it, never silently", async () => {
  const f = new Fake(1), s = memStore();
  f.lifecycle = () => ["UNDETERMINED"];
  for (let i = 0; i < MAX_ATTEMPTS + 2; i++) { await run(f, s); f.t += 6 * 3600 + 1; }
  const a = s.state.actions[keyOf(REG, 1, "SETTLE")];
  assert.equal(a.status, "FAILED");
  assert.equal(f.submits.length, MAX_ATTEMPTS);
  assert.ok(s.state.unprocessed.some((u) => u.key === a.key && u.why.startsWith("failed permanently")));
});

test("finalized but the read does not show it: not DONE until verified", async () => {
  const f = new Fake(1), s = memStore();
  f.visible = false;
  await run(f, s);
  assert.equal(s.state.actions[keyOf(REG, 1, "SETTLE")].status, "FINAL_UNVERIFIED");
  f.visible = true;
  await run(f, s);
  assert.equal(s.state.actions[keyOf(REG, 1, "SETTLE")].status, "DONE");
  assert.equal(f.submits.length, 1);
});

test("finalized but reverted for another reason: retried", async () => {
  const f = new Fake(1), s = memStore();
  f.applyOnFinal = false;
  f.lifecycle = () => ["FINALIZED"];
  const c = f.chain();
  const og = c.getTx.bind(c);
  c.getTx = async (h) => { const t = await og(h); return t ? { ...t, ok: false, reason: "REFUSED: X" } : t; };
  c.wait = (h) => c.getTx(h);
  await runKeeper({ chain: c, store: s, registries: [REG] });
  const a = s.state.actions[keyOf(REG, 1, "SETTLE")];
  assert.equal(a.status, "RETRY");
  assert.match(a.last_error, /reverted/);
});

test("a hash that never appears is treated as dropped after an hour", async () => {
  const f = new Fake(1), s = memStore();
  f.lifecycle = () => ["NOT_VISIBLE"];
  await run(f, s);
  assert.equal(s.state.actions[keyOf(REG, 1, "SETTLE")].status, "SUBMITTED");
  f.t += 600;
  await run(f, s);
  assert.equal(f.submits.length, 1);
  f.t += 3600;
  f.lifecycle = () => ["FINALIZED"];
  await run(f, s);                       // dropped: queued for retry
  f.t += backoffS(1);
  await run(f, s);
  assert.equal(f.submits.length, 2);
  assert.equal(s.state.actions[keyOf(REG, 1, "SETTLE")].status, "DONE");
});

test("poll failure while resuming keeps the action pending", async () => {
  const f = new Fake(1), s = memStore();
  f.waitPolls = 1;
  f.lifecycle = () => ["ACCEPTED", "ACCEPTED", "FINALIZED"];
  await run(f, s);
  const c = f.chain();
  c.getTx = async () => { throw new Error("studio down"); };
  await runKeeper({ chain: c, store: s, registries: [REG] });
  assert.equal(s.state.actions[keyOf(REG, 1, "SETTLE")].status, "ACCEPTED");
  assert.equal(f.submits.length, 1);
});

test("offer unreadable at act time: listed, not acted", async () => {
  const f = new Fake(1), s = memStore();
  f.failOffer = true;
  await run(f, s);
  assert.equal(f.submits.length, 0);
  assert.ok(s.state.unprocessed.some((u) => u.why.startsWith("offer unreadable")));
});

test("two registries are both kept", async () => {
  const f = new Fake(3), s = memStore();
  f.add(REG2, {});
  await runKeeper({ chain: f.chain(), store: s, registries: [REG, REG2] });
  assert.equal(f.regs[REG2][0].status, "SETTLED_NONE");
  assert.ok(s.state.registries[REG2]);
});

test("runs are recorded, newest first, capped", async () => {
  const f = new Fake(0), s = memStore();
  for (let i = 0; i < 50; i++) { f.t += 1; await run(f, s); }
  assert.equal(s.state.runs.length, 48);
  assert.ok(s.state.runs[0].started_at > s.state.runs[1].started_at);
  assert.ok(s.state.last_run.finished_at >= s.state.last_run.started_at);
});

test("unprocessed list only names what is still open", async () => {
  const f = new Fake(30), s = memStore();
  await run(f, s, { maxActions: 10 });
  assert.equal(s.state.unprocessed.length, 20);
  await run(f, s, { maxActions: 100 });
  assert.equal(s.state.unprocessed.length, 0);
});

test("stillDue mirrors the contract", () => {
  const o = { found: true, status: "OPEN", fraction_ppm: 0, settle_at: 100, owed: "0", claimed: "0", unclaimed_refunded: "0", claim_deadline: 0 };
  assert.equal(stillDue("SETTLE", o, 99), false);
  assert.equal(stillDue("SETTLE", o, 100), true);
  assert.equal(stillDue("SETTLE", { ...o, fraction_ppm: 1e6 }, 0), true);
  const s = { ...o, status: "SETTLED_PARTIAL", owed: "5", claim_deadline: 200 };
  assert.equal(stillDue("REFUND_UNCLAIMED", s, 200), false);
  assert.equal(stillDue("REFUND_UNCLAIMED", s, 201), true);
  assert.equal(stillDue("REFUND_UNCLAIMED", { ...s, claimed: "5" }, 201), false);
  assert.equal(stillDue("REFUND_UNCLAIMED", { ...s, owed: "0" }, 201), false);
  assert.equal(stillDue("SETTLE", { found: false }, 1), false);
});

test("effectVisible needs the read to show the change", () => {
  assert.equal(effectVisible("SETTLE", { status: "OPEN" }), false);
  assert.equal(effectVisible("SETTLE", { status: "SETTLED_NONE" }), true);
  assert.equal(effectVisible("REFUND_UNCLAIMED", { unclaimed_refunded: "0", claimed: "0" }), false);
  assert.equal(effectVisible("REFUND_UNCLAIMED", { unclaimed_refunded: "3", claimed: "0" }), true);
  assert.equal(effectVisible("SETTLE", null), false);
});

test("backoff grows and is capped", () => {
  assert.equal(backoffS(1), 60);
  assert.equal(backoffS(2), 120);
  assert.equal(backoffS(30), 6 * 3600);
});

test("state starts empty and versioned", () => {
  const s = emptyState();
  assert.equal(s.version, 1);
  assert.deepEqual(s.actions, {});
});

test("keys are stable and lowercase", () => {
  assert.equal(keyOf("0xAB", 3, "SETTLE"), "0xab:3:SETTLE");
});

test("a failed verifying read keeps the action pending and listed, and is resolved next run", async () => {
  const f = new Fake(1), s = memStore();
  const c = f.chain();
  const og = c.getOffer.bind(c);
  let fail = false;
  c.getOffer = async (...a) => { if (fail) throw new Error("not found"); return og(...a); };
  const ow = c.wait.bind(c);
  c.wait = async (h) => { const t = await ow(h); fail = true; return t; };
  await runKeeper({ chain: c, store: s, registries: [REG] });
  const a = s.state.actions[keyOf(REG, 1, "SETTLE")];
  assert.equal(a.status, "SUBMITTED");
  assert.ok(s.state.unprocessed.some((u) => u.key === a.key && /verifying read failed/.test(u.why)));
  assert.equal(s.state.last_run.pending, 1);
  fail = false;
  c.wait = ow;
  await runKeeper({ chain: c, store: s, registries: [REG] });
  assert.equal(s.state.actions[keyOf(REG, 1, "SETTLE")].status, "DONE");
  assert.equal(f.submits.length, 1);
});

test("state keys are lowercase; the chain layer gets the checksummed registry back", () => {
  const regs = ["0x461399B65edA1C0634a47A658d34624eC4C24a31"];
  assert.equal(canonicalAddress(regs, "0x461399b65eda1c0634a47a658d34624ec4c24a31"), regs[0]);
  assert.equal(canonicalAddress(regs, regs[0]), regs[0]);
  assert.equal(canonicalAddress(regs, "0xabc"), "0xabc");
});

test("RETRY_PENDING: retried during the recovery window, then settled once nothing is pending", async () => {
  const f = new Fake(0);
  const id = f.add(REG, { settle_at: f.t - 10, recover_until: f.t + 86400, n_pending: 2 });
  const store = memStore();
  f.retryClears = false;
  let { run } = await runKeeper({ chain: f.chain(), store, registries: [REG] });
  assert.equal(f.regs[REG][id - 1].retries, 1);
  assert.equal(f.regs[REG][id - 1].status, "OPEN");
  assert.equal(run.done, 1);
  // the same hour: no second retry
  ({ run } = await runKeeper({ chain: f.chain(), store, registries: [REG] }));
  assert.equal(f.regs[REG][id - 1].retries, 1);
  // next hour: retried again, and this time the proofs resolve; the run after settles
  f.t += 3600;
  f.retryClears = true;
  await runKeeper({ chain: f.chain(), store, registries: [REG] });
  assert.equal(f.regs[REG][id - 1].retries, 2);
  await runKeeper({ chain: f.chain(), store, registries: [REG] });
  assert.notEqual(f.regs[REG][id - 1].status, "OPEN");
});

test("RETRY_PENDING: after the recovery window the keeper settles even with proofs still pending", async () => {
  const f = new Fake(0);
  const id = f.add(REG, { settle_at: f.t - 100, recover_until: f.t - 1, n_pending: 3 });
  await runKeeper({ chain: f.chain(), store: memStore(), registries: [REG] });
  assert.equal(f.regs[REG][id - 1].retries, undefined);
  assert.equal(f.regs[REG][id - 1].status, "SETTLED_NONE");
});

test("stillDue mirrors the contract's settle and retry rules", () => {
  const o = { status: "OPEN", fraction_ppm: 0, settle_at: 100, recover_until: 200, n_pending: 1 };
  assert.equal(stillDue("SETTLE", o, 150), false);
  assert.equal(stillDue("RETRY_PENDING", o, 150), true);
  assert.equal(stillDue("SETTLE", o, 200), true);
  assert.equal(stillDue("RETRY_PENDING", o, 201), false);
  assert.equal(stillDue("SETTLE", { ...o, n_pending: 0 }, 100), true);
  assert.equal(stillDue("REFUND_UNCLAIMED", { status: "SETTLED_PARTIAL", owed: "10", claimed: "4", unclaimed_refunded: "0", claim_deadline: 5 }, 6), true);
  assert.equal(stillDue("REFUND_UNCLAIMED", { status: "SETTLED_PARTIAL", owed: "10", claimed: "10", unclaimed_refunded: "0", claim_deadline: 5 }, 6), false);
});
