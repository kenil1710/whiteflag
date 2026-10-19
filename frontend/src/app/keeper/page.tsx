import { STATE_URL } from "../api/keeper/route";
import { REPO } from "@/lib/deployments";
import { iso, short, studioTx } from "@/lib/format";

export const revalidate = 60;
export const metadata = { title: "Keeper · WhiteFlag" };

type Action = { key: string; registry: string; offer_id: number; action: string; status: string; attempts: number; hashes: string[]; hash?: string | null; last_error?: string; verified_at?: number; done_by_other?: boolean; next_try_at?: number };
type Run = { started_at: number; finished_at: number; resumed: number; scanned: number; due: number; submitted: number; done: number; pending: number; failed: number; errors: string[] };
type State = { keeper?: string; saved_at?: string; registries: Record<string, { cursor: number; scans_completed: number; last_scan_at: number; total: number }>; actions: Record<string, Action>; runs: Run[]; unprocessed: { key: string; why: string; since: number }[]; last_run: Run | null };

export default async function Page() {
  let s: State | null = null, err = "";
  try { const r = await fetch(STATE_URL, { next: { revalidate: 60 } }); if (!r.ok) throw new Error("GitHub " + r.status); s = await r.json(); } catch (e) { err = String((e as Error).message); }
  const actions = s ? Object.values(s.actions).sort((a, b) => (b.verified_at ?? 0) - (a.verified_at ?? 0)) : [];
  return (
    <div className="page"><div className="wrap">
      <div className="kicker"><span className="caps">The keeper bot · GitHub Actions, scheduled</span></div>
      <h1>Nothing waits on a person.</h1>
      <p className="lede" style={{ marginTop: 18 }}>On an hourly schedule, with a 6-hourly fallback because GitHub starts scheduled runs late, the keeper settles offers past their settle time and refunds owed bounties nobody claimed. Anyone can do the same at any time.
        Every checkpoint is a commit on the <a href={`${REPO}/tree/keeper-state`}>keeper-state</a> branch; an action counts only when its
        transaction is finalized, executed and visible in a fresh read.</p>
      {err && <p className="note note-flag">The keeper state could not be read ({err}).</p>}
      {s && (<>
        <div className="grid-3 section">
          <div className="stat"><span className="caps">Last run</span><div className="figure-md">{s.last_run ? iso(s.last_run.finished_at).slice(11, 16) : "—"}</div><span className="mono small muted">{s.last_run ? iso(s.last_run.finished_at) : "never"}</span></div>
          <div className="stat"><span className="caps">Actions done</span><div className="figure-md">{actions.filter((a) => a.status === "DONE").length}</div><span className="mono small muted">of {actions.length} recorded</span></div>
          <div className="stat"><span className="caps">Unprocessed</span><div className={`figure-md ${s.unprocessed.length ? "flag-text" : ""}`}>{s.unprocessed.length}</div><span className="mono small muted">listed with their reason</span></div>
        </div>
        <section className="section">
          <div className="section-head"><h2>Unprocessed items</h2><span className="mono small muted">nothing is skipped silently</span></div>
          {s.unprocessed.length === 0 ? <p className="muted">None: everything due at the last run was finished and verified.</p> : (
            <div className="table-wrap"><table className="ledger"><thead><tr><th>Item</th><th>Why</th><th>Since</th></tr></thead><tbody>
              {s.unprocessed.map((u) => <tr key={u.key}><td className="mono small break">{u.key}</td><td className="small">{u.why}</td><td className="mono small">{iso(u.since)}</td></tr>)}</tbody></table></div>)}
        </section>
        <section className="section">
          <div className="section-head"><h2>Checkpoints</h2><span className="mono small muted">saved {s.saved_at ?? "—"} by {short(s.keeper ?? "")}</span></div>
          <div className="table-wrap"><table className="ledger"><thead><tr><th>Registry</th><th className="num">Offers</th><th className="num">Page cursor</th><th className="num">Full scans</th><th>Last full scan</th></tr></thead><tbody>
            {Object.entries(s.registries).map(([k, v]) => <tr key={k}><td className="mono small">{short(k)}</td><td className="num mono">{v.total}</td><td className="num mono">{v.cursor}</td><td className="num mono">{v.scans_completed}</td><td className="mono small">{iso(v.last_scan_at)}</td></tr>)}</tbody></table></div>
        </section>
        <section className="section">
          <div className="section-head"><h2>Actions</h2></div>
          <div className="table-wrap"><table className="ledger"><thead><tr><th>Offer</th><th>Action</th><th>Status</th><th>Transactions</th><th>Verified</th></tr></thead><tbody>
            {actions.map((a) => <tr key={a.key}><td className="mono small">{short(a.registry)} #{a.offer_id}</td><td className="mono small">{a.action}</td>
              <td className={`mono small ${a.status === "DONE" ? "ok" : a.status === "FAILED" ? "bad" : ""}`}>{a.status}{a.done_by_other ? " (by another caller)" : ""}{a.last_error && a.status !== "DONE" ? <div className="muted">{a.last_error}</div> : null}</td>
              <td className="mono small">{a.hashes.map((h) => <div key={h}><a href={studioTx(h)}>{short(h, 8)}</a></div>)}</td><td className="mono small">{a.verified_at ? iso(a.verified_at) : "—"}</td></tr>)}
            {actions.length === 0 && <tr><td colSpan={5} className="muted">No action yet.</td></tr>}</tbody></table></div>
        </section>
        <section className="section">
          <div className="section-head"><h2>Runs</h2><a className="mono small" href={`${REPO}/actions/workflows/keeper.yml`}>workflow history</a></div>
          <div className="table-wrap"><table className="ledger"><thead><tr><th>Finished</th><th className="num">Scanned</th><th className="num">Due</th><th className="num">Submitted</th><th className="num">Done</th><th className="num">Pending</th><th className="num">Failed</th><th>Errors</th></tr></thead><tbody>
            {s.runs.slice(0, 24).map((r) => <tr key={r.started_at}><td className="mono small">{iso(r.finished_at)}</td><td className="num mono">{r.scanned}</td><td className="num mono">{r.due}</td><td className="num mono">{r.submitted}</td><td className="num mono">{r.done}</td><td className="num mono">{r.pending}</td><td className="num mono">{r.failed}</td><td className="small">{r.errors.join("; ") || "—"}</td></tr>)}</tbody></table></div>
        </section>
      </>)}
    </div></div>
  );
}
