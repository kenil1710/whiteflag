// The keeper's logic, with the chain and the state store injected so the
// offline tests (test/keeper.test.mjs) drive it through outages, crashes and
// half-final transactions.
//
// One run:
//   1. RESUME every action that has a stored transaction hash and is not
//      finished: poll that hash. Never submit a second transaction for an
//      action whose last one is not terminal.
//   2. SCAN every registry from its persisted cursor, page by page, to the
//      end of its offers and around to where it started; the cursor is saved
//      after every page.
//   3. ACT on each due item (SETTLE / REFUND_UNCLAIMED): re-read the offer,
//      submit, checkpoint the hash at once, then wait for it.
// An action counts as DONE only when its transaction is FINALIZED, executed
// successfully, and a read of the offer shows the effect. Failures go to a
// persistent retry queue with backoff. Anything due that this run did not
// finish is listed in state.unprocessed with the reason.
export const VERSION = 1;
export const MAX_ATTEMPTS = 8;
export const PAGE = 20;
const TERMINAL_BAD = ["UNDETERMINED", "CANCELED", "LEADER_TIMEOUT", "VALIDATORS_TIMEOUT"];

export function emptyState() {
  return { version: VERSION, registries: {}, actions: {}, runs: [], unprocessed: [], last_run: null };
}

/** State keys hold lowercase addresses; Studio finds a contract only by its checksummed address. */
export const canonicalAddress = (list, a) => list.find((r) => r.toLowerCase() === String(a).toLowerCase()) ?? a;

export const keyOf = (registry, offerId, action) => `${registry.toLowerCase()}:${offerId}:${action}`;

/** Did the offer reach the state this action produces? */
export function effectVisible(action, offer) {
  if (!offer || offer.found === false) return false;
  if (action === "SETTLE") return offer.status !== "OPEN";
  if (action === "REFUND_UNCLAIMED") return BigInt(offer.unclaimed_refunded ?? 0) > 0n || BigInt(offer.claimed ?? 0) > 0n;
  return false;
}

/** Is the action still needed according to the offer? */
export function stillDue(action, offer, now) {
  if (!offer || offer.found === false) return false;
  if (action === "SETTLE") {
    if (offer.status !== "OPEN") return false;
    return offer.fraction_ppm >= 1_000_000 || now >= offer.settle_at;
  }
  if (action === "REFUND_UNCLAIMED") {
    return offer.status !== "OPEN" && BigInt(offer.owed) > 0n && BigInt(offer.claimed) === 0n
      && BigInt(offer.unclaimed_refunded) === 0n && now > offer.claim_deadline;
  }
  return false;
}

export const backoffS = (attempts) => Math.min(60 * 2 ** Math.max(attempts - 1, 0), 6 * 3600);

/**
 * chain: { now(), getDue(reg, offset, limit, now) -> {items, next_offset, total, scanned},
 *          getOffer(reg, id), submit(reg, action, offer) -> hash, getTx(hash) -> {statusName, ok} | null,
 *          wait(hash, budgetMs) -> {statusName, ok} | null }
 * store: { load() -> state, save(state, note) }    log: (line) => void
 */
export async function runKeeper({ chain, store, registries, log = () => {}, maxActions = 25, waitMs = 600_000 }) {
  const state = (await store.load()) ?? emptyState();
  const run = { started_at: chain.now(), finished_at: null, resumed: 0, scanned: 0, due: 0, submitted: 0, done: 0, pending: 0, failed: 0, errors: [] };
  const unprocessed = new Map();
  const note = (key, why) => unprocessed.set(key, { key, why, since: state.actions[key]?.first_seen_at ?? chain.now() });
  const save = async (why) => { await store.save(state, why); };

  async function settleAction(a, tx) {
    // a transaction for this action reached a terminal state: decide what it means
    const now = chain.now();
    let offer = null;
    try { offer = await chain.getOffer(a.registry, a.offer_id); } catch (e) {
      // the transaction is known; only the verifying read failed: keep it pending, resumed next run
      a.last_error = "read failed: " + String(e.message).slice(0, 160);
      run.pending++;
      note(a.key, `${a.hash} reached ${tx?.statusName ?? "an unknown state"}; verifying read failed, retried next run`);
      return;
    }
    if (tx?.statusName === "FINALIZED" && tx.ok && effectVisible(a.action, offer)) {
      a.status = "DONE"; a.verified_at = now; a.finalized_hash = a.hash; run.done++;
      log(`DONE ${a.key} ${a.hash} (finalized, executed, verified by read)`);
      return;
    }
    if (effectVisible(a.action, offer)) {
      // someone else's transaction did it (or ours reverted because it was already done)
      a.status = "DONE"; a.verified_at = now; a.done_by_other = true; run.done++;
      log(`DONE ${a.key} (state shows it done; our tx ${a.hash} ${tx?.statusName ?? "unknown"})`);
      return;
    }
    if (tx?.statusName === "FINALIZED" && tx.ok) {
      // final and successful, but the read does not show it yet: check again next run
      a.status = "FINAL_UNVERIFIED"; a.last_error = "finalized but effect not visible in read"; run.pending++;
      note(a.key, "finalized, waiting for the read to show the effect");
      return;
    }
    a.attempts = (a.attempts ?? 0) + 1;
    a.last_error = `tx ${a.hash} ${tx?.statusName ?? "not found"}${tx && !tx.ok ? " (reverted: " + (tx.reason ?? "") + ")" : ""}`;
    a.hash = null;
    if (a.attempts >= MAX_ATTEMPTS) { a.status = "FAILED"; run.failed++; note(a.key, "gave up after " + a.attempts + " attempts: " + a.last_error); }
    else { a.status = "RETRY"; a.next_try_at = now + backoffS(a.attempts); note(a.key, `retry ${a.attempts} after ${a.next_try_at}: ${a.last_error}`); }
    log(`FAIL ${a.key}: ${a.last_error}`);
  }

  // 1. resume
  for (const a of Object.values(state.actions)) {
    if (!["SUBMITTED", "ACCEPTED", "FINAL_UNVERIFIED"].includes(a.status)) continue;
    run.resumed++;
    if (a.status === "FINAL_UNVERIFIED") { await settleAction(a, { statusName: "FINALIZED", ok: true }); await save("verify " + a.key); continue; }
    let tx = null;
    try { tx = await chain.getTx(a.hash); } catch (e) { a.last_error = "poll failed: " + e.message; note(a.key, "could not poll " + a.hash); run.pending++; continue; }
    if (!tx || (!["FINALIZED", ...TERMINAL_BAD].includes(tx.statusName))) {
      a.status = tx?.statusName === "ACCEPTED" ? "ACCEPTED" : "SUBMITTED";
      // a hash nobody has seen for a long time was dropped; anything else is still in flight
      if (!tx && chain.now() - a.submitted_at > 3600) { await settleAction(a, null); await save("dropped " + a.key); continue; }
      run.pending++; note(a.key, `waiting for ${a.hash} (${tx?.statusName ?? "not visible yet"})`);
      continue;
    }
    await settleAction(a, tx);
    await save("resolved " + a.key);
  }

  // 2 + 3. scan every page of every registry from its cursor, act on what is due
  let acted = 0;
  for (const reg of registries) {
    const r = (state.registries[reg.toLowerCase()] ??= { cursor: 0, scans_completed: 0, last_scan_at: 0, total: 0 });
    const startCursor = r.cursor;
    let offset = r.cursor, wrapped = false, pages = 0;
    for (;;) {
      const now = chain.now();
      let page;
      try { page = await chain.getDue(reg, offset, PAGE, now); } catch (e) {
        run.errors.push(`${reg} page ${offset}: ${e.message}`);
        log(`page ${offset} of ${reg} unreadable: ${e.message}; cursor stays at ${offset}`);
        note(`${reg}:page:${offset}`, "page unreadable: " + e.message);
        break;
      }
      pages++;
      r.total = page.total;
      run.scanned += page.scanned ?? 0;
      for (const item of page.items) {
        run.due++;
        const key = keyOf(reg, item.offer_id, item.due);
        const a = (state.actions[key] ??= { key, registry: reg.toLowerCase(), offer_id: item.offer_id, action: item.due, status: "NEW", attempts: 0, hashes: [], first_seen_at: now });
        if (a.status === "DONE") {
          // done before, yet listed due again: never act twice; flag it
          note(key, "listed due although marked DONE at " + a.verified_at);
          continue;
        }
        if (["SUBMITTED", "ACCEPTED", "FINAL_UNVERIFIED"].includes(a.status)) continue; // in flight; resumed next run
        if (a.status === "FAILED") { note(key, "failed permanently: " + a.last_error); continue; }
        if (a.status === "RETRY" && a.next_try_at > now) { note(key, `queued for retry at ${a.next_try_at}: ${a.last_error}`); continue; }
        if (acted >= maxActions) { note(key, "run budget reached; next run"); continue; }
        let offer;
        try { offer = await chain.getOffer(reg, item.offer_id); } catch (e) { note(key, "offer unreadable: " + e.message); continue; }
        if (!stillDue(item.due, offer, chain.now())) {
          if (effectVisible(item.due, offer)) { a.status = "DONE"; a.verified_at = chain.now(); a.done_by_other = true; run.done++; }
          else note(key, "no longer due on re-read");
          continue;
        }
        let hash;
        try { hash = await chain.submit(reg, item.due, offer); } catch (e) {
          a.attempts++; a.last_error = "submit failed: " + e.message; a.status = a.attempts >= MAX_ATTEMPTS ? "FAILED" : "RETRY";
          a.next_try_at = chain.now() + backoffS(a.attempts); note(key, a.last_error); run.failed++;
          await save("submit failed " + key);
          continue;
        }
        acted++; run.submitted++;
        a.status = "SUBMITTED"; a.hash = hash; a.hashes.push(hash); a.submitted_at = chain.now();
        await save("submitted " + key + " " + hash);          // checkpoint before waiting
        log(`SUBMITTED ${key} ${hash}`);
        let tx = null;
        try { tx = await chain.wait(hash, waitMs); } catch { tx = null; }
        if (tx && ["FINALIZED", ...TERMINAL_BAD].includes(tx.statusName)) await settleAction(a, tx);
        else { a.status = tx?.statusName === "ACCEPTED" ? "ACCEPTED" : "SUBMITTED"; run.pending++; note(key, `waiting for ${hash} (${tx?.statusName ?? "not visible yet"})`); }
        await save("after " + key);
      }
      offset = page.next_offset;
      if (offset === -1) { offset = 0; wrapped = true; r.scans_completed++; r.last_scan_at = chain.now(); }
      r.cursor = offset;
      await save(`cursor ${reg} ${offset}`);
      if (wrapped && offset >= startCursor) break;
      if (!wrapped && startCursor === 0 && offset === 0) break;
      if (pages > 10_000) break;
    }
  }

  // the unprocessed list is rebuilt every run: it names exactly what is still open
  for (const a of Object.values(state.actions)) {
    if (a.status === "RETRY" && !unprocessed.has(a.key)) note(a.key, `queued for retry at ${a.next_try_at}: ${a.last_error}`);
    if (a.status === "FAILED" && !unprocessed.has(a.key)) note(a.key, "failed permanently: " + a.last_error);
  }
  state.unprocessed = [...unprocessed.values()];
  run.finished_at = chain.now();
  state.last_run = run;
  state.runs = [run, ...state.runs].slice(0, 48);
  await save("run finished");
  return { state, run };
}
