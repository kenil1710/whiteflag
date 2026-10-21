"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useWallet } from "@/components/WalletProvider";
import { Progress, WalletBar, useReg } from "@/components/client";
import { Countdown } from "@/components/Countdown";
import { send, viewOf } from "@/lib/contract";
import { gen, iso, nowS, pct, short } from "@/lib/format";
import type { Offer, OfferSummary, Page, TxProgress } from "@/lib/types";

const PER_PAGE = 10;

export function ClaimDesk() {
  const { reg, q } = useReg();
  const w = useWallet();
  const router = useRouter();
  const [offers, setOffers] = useState<Offer[]>([]);
  const [payout, setPayout] = useState("");
  const [p, setP] = useState<TxProgress | null>(null);
  const [due, setDue] = useState<(OfferSummary & { due: string })[]>([]);

  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const load = useCallback(async () => {
    // one page of 10 offers, newest first; full offers are read only for that page
    const head = await viewOf<Page<OfferSummary>>(reg, "get_offers", [0, 1]);
    const n = Math.max(1, Math.ceil(head.total / PER_PAGE));
    setPages(n);
    const end = head.total - Math.min(page, n - 1) * PER_PAGE, start = Math.max(0, end - PER_PAGE);
    const pg = end > 0 ? await viewOf<Page<OfferSummary>>(reg, "get_offers", [start, end - start]) : { items: [] as OfferSummary[] };
    const full: Offer[] = [];
    for (let i = 0; i < pg.items.length; i += 4) full.push(...(await Promise.all(pg.items.slice(i, i + 4).map((o) => viewOf<Offer>(reg, "get_offer", [o.offer_id])))));
    setOffers(full.reverse());
    const d = await viewOf<Page<OfferSummary & { due: string }>>(reg, "get_due", [nowS(), 0, 50]);
    setDue(d.items);
  }, [reg, page]);
  useEffect(() => {
    const t = setTimeout(() => void load().catch(() => undefined), 0);
    return () => clearTimeout(t);
  }, [load]);

  const me = w.account?.toLowerCase() ?? "";
  const mine = offers.filter((o) => o.exploiters.some((e) => e.address === me));
  const now = nowS();

  async function commit(o: Offer) {
    if (!w.account) return;
    await send(w.account, reg, "commit_beneficiary", [o.offer_id, payout.trim()], 0n, { payee: null, onProgress: setP,
      confirm: async () => Boolean((await viewOf<Offer>(reg, "get_offer", [o.offer_id])).beneficiaries[me]) });
    void load();
  }
  async function claim(o: Offer) {
    if (!w.account) return;
    const to = o.beneficiaries[me] || me;
    await send(w.account, reg, "claim", [o.offer_id], 0n, { payee: to, onProgress: setP,
      confirm: async () => Boolean((await viewOf<Offer>(reg, "get_offer", [o.offer_id])).claims[me]) });
    void load();
  }
  async function act(o: OfferSummary & { due: string }) {
    if (!w.account) return;
    if (o.due === "RETRY_PENDING") { router.push(`/prove${q}${q ? "&" : "?"}offer=${o.offer_id}`); return; }
    const fn = o.due === "SETTLE" ? "settle" : "refund_unclaimed";
    const payee = o.due === "SETTLE" && o.fraction_ppm >= 1_000_000 ? null : o.protocol;
    await send(w.account, reg, fn, [o.offer_id], 0n, { payee, onProgress: setP,
      confirm: async () => { const x = await viewOf<Offer>(reg, "get_offer", [o.offer_id]); return fn === "settle" ? x.status !== "OPEN" : x.unclaimed_refunded !== "0"; } });
    void load();
  }

  return (
    <div>
      <WalletBar />
      {w.account && (
        <section className="section">
          <div className="section-head"><h2>Offers that list {short(w.account)}</h2>
            <span className="row mono small muted">
              <button className="btn" disabled={page === 0} onClick={() => setPage(page - 1)}>← newer</button>
              page {page + 1} / {pages}
              <button className="btn" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>older →</button>
            </span>
          </div>
          {mine.length === 0 && <p className="note">This address is not an exploiter address on any offer on this page, so the registry would refuse its claim there (NOT_AN_EXPLOITER_ADDRESS).</p>}
          {mine.map((o) => {
            const share = o.shares[me] ?? "0";
            const mineClaim = o.claims[me];
            const ben = o.beneficiaries[me];
            const claimable = o.status !== "OPEN" && BigInt(share) > 0n && !mineClaim && o.unclaimed_refunded === "0" && now <= o.claim_deadline;
            const canCommit = o.payout_rule === "EXPLOITER_OR_NAMED" && !ben && !mineClaim;
            return (
              <div key={o.offer_id} className="panel" style={{ marginBottom: 16 }}>
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <Link href={`/incident/${o.offer_id}${q}`} className="serif" style={{ fontSize: "1.5rem" }}>#{o.offer_id} {o.name}</Link>
                  <span className="mono small">{pct(o.fraction_ppm)} returned · your share {o.status === "OPEN" ? "set at settlement" : `${gen(share, 4)} GEN`}</span>
                </div>
                {o.status === "OPEN" && <p className="small muted">Not settled yet: settles {iso(o.settle_at)} (<Countdown at={o.settle_at} />), or at once at 100%.</p>}
                {mineClaim && <p className="small ok">Claimed {gen(mineClaim.amount, 4)} GEN, paid to {short(mineClaim.to)}.</p>}
                {o.status !== "OPEN" && share === "0" && <p className="small muted">This address returned nothing that counted, so its share is 0 (NOTHING_OWED_TO_THIS_ADDRESS).</p>}
                {o.unclaimed_refunded !== "0" && <p className="small muted">The claim window closed; unclaimed shares were refunded to the protocol.</p>}
                {ben && <p className="small">Beneficiary committed: {short(ben)}. It cannot be changed, by anyone.</p>}
                {canCommit && (
                  <div className="form" style={{ marginTop: 12 }}>
                    <div className="field"><label htmlFor={`po${o.offer_id}`}>Commit a beneficiary (optional, once, from this address; blank claim pays this address)</label><input id={`po${o.offer_id}`} value={payout} onChange={(e) => setPayout(e.target.value)} placeholder="0x…" /></div>
                    <div className="row"><button className="btn" disabled={payout.trim() === ""} onClick={() => void commit(o)}>Commit beneficiary</button></div>
                  </div>
                )}
                {claimable && (
                  <div className="form" style={{ marginTop: 12 }}>
                    <p className="small">Claim window closes {iso(o.claim_deadline)} (<Countdown at={o.claim_deadline} passed="closed" />). Rule: {o.payout_rule}. Pays {short(ben || me)}.</p>
                    <div className="row"><button className="btn btn-flag" onClick={() => void claim(o)}>Claim {gen(share, 4)} GEN</button></div>
                  </div>
                )}
              </div>
            );
          })}
        </section>
      )}
      <Progress p={p} />
      <section className="section">
        <div className="section-head"><h2>Due now, for anyone</h2><span className="mono small muted">the keeper does these on its schedule</span></div>
        {due.length === 0 ? <p className="muted">Nothing is due: no offer past its settle time, no owed bounty past its claim window.</p> : (
          <div className="table-wrap"><table className="ledger"><thead><tr><th>Offer</th><th>Action</th><th>Pays</th><th /></tr></thead><tbody>
            {due.map((o) => (
              <tr key={o.offer_id + o.due}><td><Link href={`/incident/${o.offer_id}${q}`}>#{o.offer_id} {o.name}</Link></td><td className="mono small">{o.due}</td>
                <td className="mono small">{o.due === "RETRY_PENDING" ? `re-reads ${o.n_pending} PENDING proof(s)` : o.due === "SETTLE" ? (o.fraction_ppm >= 1_000_000 ? "nothing (100% returned)" : "the remainder to the protocol") : `${gen((BigInt(o.owed) - BigInt(o.claimed)).toString(), 4)} GEN to the protocol`}</td>
                <td><button className="btn" disabled={!w.account} onClick={() => void act(o)}>{o.due === "SETTLE" ? "Settle" : o.due === "RETRY_PENDING" ? "Retry" : "Refund"}</button></td></tr>
            ))}</tbody></table></div>
        )}
      </section>
    </div>
  );
}
