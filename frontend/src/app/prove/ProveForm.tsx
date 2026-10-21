"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useWallet } from "@/components/WalletProvider";
import { Progress, WalletBar, useReg } from "@/components/client";
import { send, viewOf } from "@/lib/contract";
import { nowS, pct, short, txLink, units } from "@/lib/format";
import type { OfferSummary, Page, Proof, TxProgress } from "@/lib/types";

type Check = { chain: string; hash: string; verdict: string; detail?: string; credits?: { amount: string; token: string; log: number }[]; time?: number; from?: string; to?: string };

export function ProveForm() {
  const { reg, q } = useReg();
  const sp = useSearchParams();
  const w = useWallet();
  const [offers, setOffers] = useState<OfferSummary[]>([]);
  const [oid, setOid] = useState<number>(Number(sp.get("offer") ?? 0));
  const [chain, setChain] = useState("ethereum");
  const [text, setText] = useState("");
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [p, setP] = useState<TxProgress | null>(null);
  const [recorded, setRecorded] = useState<Proof[] | null>(null);
  const [pending, setPending] = useState<Proof[]>([]);

  useEffect(() => {
    // the newest 50 offers (one page), never every offer
    void viewOf<Page<OfferSummary>>(reg, "get_offers", [0, 1])
      .then((h) => viewOf<Page<OfferSummary>>(reg, "get_offers", [Math.max(0, h.total - 50), 50]))
      .then((pg) => { const items = [...pg.items].reverse(); setOffers(items); if (!oid) { const o = items.find((x) => x.status === "OPEN"); if (o) setOid(o.offer_id); } }).catch(() => setOffers([]));
  }, [reg]); // eslint-disable-line react-hooks/exhaustive-deps

  const offer = offers.find((o) => o.offer_id === oid);
  useEffect(() => {
    // PENDING proofs of this offer, newest pages first, bounded to three pages
    void (async () => {
      const out: Proof[] = [];
      if (!oid || !offer || offer.n_pending === 0) { setPending(out); return; }
      for (let off = Math.max(offer.n_proofs - 50, 0), pages = 0; off >= 0 && pages < 3 && out.length < 5; off -= 50, pages++) {
        const pg = await viewOf<Page<Proof>>(reg, "get_proofs", [oid, off, 50]);
        out.push(...pg.items.filter((x) => x.status === "PENDING"));
        if (off === 0) break;
      }
      setPending(out.slice(0, 5));
    })().catch(() => setPending([]));
  }, [reg, oid, offer]);

  async function retry() {
    if (!w.account || !offer || pending.length === 0) return;
    const ids = pending.map((x) => x.proof_id);
    await send(w.account, reg, "retry_proofs", [oid, JSON.stringify(ids)], 0n, {
      onProgress: setP, confirm: async () => (await viewOf<Proof>(reg, "get_proof", [ids[0]])).attempts > pending[0].attempts,
    });
  }
  const items = text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean).map((s) => {
    const m = s.match(/^(ethereum|arbitrum|wfdemo)[:/](0x[0-9a-fA-F]{64})$/);
    return m ? { chain: m[1], hash: m[2].toLowerCase() } : { chain, hash: s.toLowerCase() };
  }).slice(0, 5);
  const bad = items.filter((i) => !/^0x[0-9a-f]{64}$/.test(i.hash));

  async function check() {
    setBusy(true); setChecks(null);
    try {
      const r = await fetch(`/api/check?r=${q ? "demo" : "canonical"}&offer=${oid}&items=${items.map((i) => `${i.chain}:${i.hash}`).join(",")}`);
      const j = await r.json();
      setChecks(j.results ?? [{ chain: "", hash: "", verdict: j.error ?? "error" }]);
    } finally { setBusy(false); }
  }

  async function submit() {
    if (!w.account || !offer) return;
    const before = offer.n_proofs;
    const r = await send(w.account, reg, "submit_proofs", [oid, JSON.stringify(items.map((i) => [i.chain, i.hash]))], 0n, {
      onProgress: setP, confirm: async () => (await viewOf<{ n_proofs: number }>(reg, "get_offer", [oid])).n_proofs >= before + items.length,
    });
    if (r.kind === "ok") {
      const pg = await viewOf<Page<Proof>>(reg, "get_proofs", [oid, before, 5]);
      setRecorded(pg.items);
    }
  }

  return (
    <div className="form">
      <div className="field"><label htmlFor="offer">Offer</label>
        <select id="offer" value={oid} onChange={(e) => setOid(Number(e.target.value))}>
          <option value={0}>Choose an offer</option>
          {offers.map((o) => <option key={o.offer_id} value={o.offer_id}>#{o.offer_id} {o.name} · {o.status === "OPEN" ? `open, ${pct(o.fraction_ppm)} back` : o.status.toLowerCase()}</option>)}
        </select>
        {offer && offer.status !== "OPEN" && <div className="hint bad">This offer is settled; it takes no more proofs.</div>}
        {offer && offer.status === "OPEN" && nowS() > offer.settle_at && <div className="hint bad">Submissions closed {new Date(offer.settle_at * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC; only PENDING proofs can be retried, until {new Date(offer.recover_until * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC.</div>}
        {pending.length > 0 && (
          <div className="hint">
            {pending.length} PENDING proof(s) on this offer ({pending.map((x) => `#${x.proof_id} ${x.reason}`).join(", ")}): an RPC error, the two RPCs disagreeing, or a block not final yet. Anyone can retry them until the recovery window ends.
            <div className="row" style={{ marginTop: 8 }}><button className="btn" disabled={!w.account} onClick={() => void retry()}>Retry PENDING proofs</button></div>
          </div>
        )}
      </div>
      <div className="field"><label htmlFor="chain">Chain for bare hashes</label>
        <select id="chain" value={chain} onChange={(e) => setChain(e.target.value)}><option value="ethereum">Ethereum</option><option value="arbitrum">Arbitrum One</option>{q && <option value="wfdemo">WhiteFlag demo chain</option>}</select></div>
      <div className="field"><label htmlFor="tx">Transaction hashes (up to 5; one per line, or chain:hash)</label>
        <textarea id="tx" value={text} onChange={(e) => { setText(e.target.value); setChecks(null); }} placeholder={"0x...\narbitrum:0x..."} />
        {bad.length > 0 && <div className="hint bad">Not a transaction hash: {bad.map((b) => short(b.hash)).join(", ")}</div>}
      </div>
      <div className="row">
        <button className="btn" disabled={!oid || items.length === 0 || bad.length > 0 || busy} onClick={() => void check()}>{busy ? "Reading both RPCs…" : "Check now, from two RPCs"}</button>
      </div>
      {checks && (
        <div className="table-wrap"><table className="ledger">
          <thead><tr><th>Transaction</th><th>Live verdict</th><th>Would credit</th></tr></thead>
          <tbody>{checks.map((c) => (
            <tr key={c.chain + c.hash}>
              <td className="mono small">{c.chain} <a href={txLink(c.chain, c.hash)} target="_blank" rel="noreferrer">{short(c.hash, 8)}</a>{c.time ? <div className="muted">{new Date(c.time * 1000).toISOString().slice(0, 16)} · from {short(c.from ?? "")}</div> : null}</td>
              <td className={`mono small ${c.verdict === "WOULD_COUNT" ? "ok" : "bad"}`}>{c.verdict}{c.detail ? <div className="muted">{c.detail}</div> : null}</td>
              <td className="mono small">{c.credits?.map((x) => `${units(x.amount, 18, 4)} ${x.token === "native" ? "native" : short(x.token)}`).join(" + ") || "—"}</td>
            </tr>))}</tbody>
        </table></div>
      )}
      <p className="small muted">The live check is advice. The registry records what its validators read: COUNTED, REJECTED (permanent: the facts are wrong) or PENDING (transient: an RPC error, disagreement or a block not final yet; anyone retries it until the recovery window ends). A counted transfer cannot be counted twice.</p>
      <WalletBar />
      <div className="row"><button className="btn btn-flag" disabled={!w.account || !offer || offer.status !== "OPEN" || items.length === 0 || bad.length > 0} onClick={() => void submit()}>Send to the validators</button></div>
      <Progress p={p} />
      {recorded && (
        <div className="panel">
          <span className="caps">Recorded by the registry</span>
          <ul className="mono small">{recorded.map((r) => <li key={r.proof_id}>#{r.proof_id} {short(r.tx_hash)} · {r.status === "COUNTED" ? <span className="ok">COUNTED</span> : <span className={r.status === "REJECTED" ? "bad" : ""}>{r.status} {r.reason}</span>}</li>)}</ul>
          <Link href={`/incident/${oid}${q}`}>Open the case file</Link>
        </div>
      )}
    </div>
  );
}
