"use client";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useWallet } from "@/components/WalletProvider";
import { Progress, WalletBar, useReg } from "@/components/client";
import { send, viewOf } from "@/lib/contract";
import { gen, iso, pct, short, studioAddr } from "@/lib/format";
import type { GateState, Page, TxProgress } from "@/lib/types";

type Att = GateState & { attestation_id: number; attested_at: number; attested_by: string };

export function GateDemo() {
  const { gate } = useReg();
  const sp = useSearchParams();
  const w = useWallet();
  const [id, setId] = useState(sp.get("offer") ?? "1");
  const [protocol, setProtocol] = useState("");
  const [s, setS] = useState<GateState | null>(null);
  const [err, setErr] = useState("");
  const [atts, setAtts] = useState<Att[]>([]);
  const [p, setP] = useState<TxProgress | null>(null);

  async function ask() {
    setErr(""); setS(null);
    try {
      setS(protocol.trim() ? await viewOf<GateState>(gate, "check_for", [Number(id), protocol.trim()]) : await viewOf<GateState>(gate, "check", [Number(id)]));
    } catch (e) { setErr(String((e as Error).message)); }
  }
  async function loadAtts() {
    const first = await viewOf<Page<Att>>(gate, "get_attestations", [0, 1]);
    const off = Math.max(0, first.total - 10);
    setAtts((await viewOf<Page<Att>>(gate, "get_attestations", [off, 10])).items.reverse());
  }
  useEffect(() => { void ask(); void loadAtts().catch(() => undefined); }, [gate]); // eslint-disable-line react-hooks/exhaustive-deps

  async function attest() {
    if (!w.account) return;
    const before = (await viewOf<Page<Att>>(gate, "get_attestations", [0, 1])).total;
    await send(w.account, gate, "attest", [Number(id)], 0n, { onProgress: setP, confirm: async () => (await viewOf<Page<Att>>(gate, "get_attestations", [0, 1])).total > before });
    void loadAtts();
  }

  return (
    <div>
      <div className="form">
        <div className="grid-2" style={{ gap: 18 }}>
          <div className="field"><label htmlFor="gid">Offer id</label><input id="gid" value={id} onChange={(e) => setId(e.target.value)} /></div>
          <div className="field"><label htmlFor="gp">Expected protocol address (optional)</label><input id="gp" value={protocol} onChange={(e) => setProtocol(e.target.value)} placeholder="0x… the offer must have been opened by" /></div>
        </div>
        <div className="row"><button className="btn" onClick={() => void ask()}>Ask the gate</button><span className="mono small muted">gate <a href={studioAddr(gate)}>{short(gate)}</a></span></div>
      </div>
      {err && <p className="note note-flag">{err}</p>}
      {s && (
        <div className="grid-2 section">
          <div>
            <span className="caps">State</span>
            <div className="figure-md">{s.state.replace("SETTLED_", "settled · ").toLowerCase()}</div>
            <p className={`mono ${s.favorable ? "ok" : "bad"}`} style={{ marginTop: 10 }}>favorable: {String(s.favorable)}</p>
            <p className="small">{s.why}</p>
          </div>
          <div className="table-wrap"><table className="ledger"><tbody>
            <tr><td className="caps">Returned</td><td className="mono">{pct(s.fraction_ppm)}</td></tr>
            <tr><td className="caps">Bounty</td><td className="mono">{gen(s.bounty)} GEN</td></tr>
            <tr><td className="caps">Owed · paid · refunded</td><td className="mono">{gen(s.owed)} · {gen(s.paid)} · {gen(s.refunded)}</td></tr>
            <tr><td className="caps">Protocol</td><td className="mono break">{s.protocol || "—"}</td></tr>
            <tr><td className="caps">Incident</td><td className="mono">{s.incident || "—"}</td></tr>
          </tbody></table></div>
        </div>
      )}
      <section className="section">
        <div className="section-head"><h2>Attest on chain</h2><span className="mono small muted">stores the state with the time it was read</span></div>
        <WalletBar />
        <div className="row" style={{ marginTop: 14 }}><button className="btn btn-flag" disabled={!w.account} onClick={() => void attest()}>Attest offer {id}</button></div>
        <Progress p={p} />
        <div className="table-wrap" style={{ marginTop: 20 }}><table className="ledger">
          <thead><tr><th>#</th><th>Offer</th><th>State</th><th>Favorable</th><th>Read at</th><th>By</th></tr></thead>
          <tbody>{atts.map((a) => <tr key={a.attestation_id}><td className="mono">{a.attestation_id}</td><td className="mono">{a.offer_id}</td><td className="mono small">{a.state}</td><td className={`mono small ${a.favorable ? "ok" : ""}`}>{String(a.favorable)}</td><td className="mono small">{iso(a.attested_at)}</td><td className="mono small">{short(a.attested_by)}</td></tr>)}
            {atts.length === 0 && <tr><td colSpan={6} className="muted">No attestation yet.</td></tr>}</tbody>
        </table></div>
      </section>
    </div>
  );
}
