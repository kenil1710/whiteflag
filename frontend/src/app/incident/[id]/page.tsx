import Link from "next/link";
import { notFound } from "next/navigation";
import { asReg, regAddr } from "@/lib/deployments";
import { allProofs, offer as getOffer } from "@/lib/server";
import { CHAIN_LABEL, addrLink, caseNo, gen, iso, money, nextEvent, pct, returnedOf, short, studioAddr, txLink, units, usd, incidentInfo } from "@/lib/format";
import { Bar, Ext, Stamp } from "@/components/bits";
import { Countdown } from "@/components/Countdown";
import type { Proof } from "@/lib/types";

export const revalidate = 30;

export default async function Incident({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ r?: string }> }) {
  const id = Number((await params).id);
  const r = asReg((await searchParams).r);
  const reg = regAddr(r);
  if (!Number.isInteger(id) || id <= 0) notFound();
  const o = await getOffer(reg, id);
  if (!o.found) notFound();
  const proofs = await allProofs(reg, id);
  const info = incidentInfo(o);
  const now = Math.floor(Date.now() / 1000);
  const ev = nextEvent(o, now);
  const meta = o.meta as { message_tx?: { chain: string; hash: string }; source?: string; deadline_basis?: string; hack_date?: string };
  const sym = (chain: string, token: string) => o.tokens.find((t) => t.chain === chain && t.token === token)?.symbol || (token === "native" ? "ETH" : short(token));
  const dec = (chain: string, token: string) => o.tokens.find((t) => t.chain === chain && t.token === token)?.decimals ?? 18;
  const byTime = [...proofs].sort((a, b) => (a.status === b.status ? 0 : a.status === "COUNTED" ? -1 : 1) || (a.block_time || a.submitted_at) - (b.block_time || b.submitted_at));
  const counted = byTime.filter((p) => p.status === "COUNTED");
  const rejected = byTime.filter((p) => p.status !== "COUNTED");
  const stolenUsd = usd(o.tokens, (t) => BigInt(t.stolen));
  const q = r === "demo" ? "?r=demo" : "";

  return (
    <div className="page">
      <div className="wrap">
        <div className="kicker">
          <span className="caps">Incident #{caseNo(o)} · case file · offer {o.offer_id} on the {r} registry</span>
          <Stamp status={o.status} />
        </div>
        <h1 className="rise">{o.name}</h1>
        {info && <p className="lede" style={{ marginTop: 18 }}>{info.summary}</p>}

        <div className="grid-2 section">
          <div>
            <span className="caps">Returned, by the frozen weights</span>
            <div className="figure green">{pct(o.fraction_ppm)}</div>
            <div style={{ margin: "14px 0 8px" }}><Bar ppm={o.fraction_ppm} large /></div>
            <span className="mono small muted">of {money(stolenUsd)} stolen at the protocol&apos;s own weights</span>
          </div>
          <div className="grid-2" style={{ gap: 20 }}>
            <div className="stat"><span className="caps">Bounty locked</span><div className="figure-md">{gen(o.bounty, 4)}</div><span className="mono small muted">GEN · {o.bounty_share_bps / 100}% share announced</span></div>
            <div className="stat"><span className="caps">Owed to exploiter addresses</span><div className="figure-md">{gen(o.owed, 4)}</div><span className="mono small muted">{o.status === "OPEN" ? "decided at settlement" : "GEN"}</span></div>
            <div className="stat"><span className="caps">Paid</span><div className="figure-md">{gen(o.claimed, 4)}</div><span className="mono small muted">{Object.keys(o.claims).length} of {Object.keys(o.shares).length} shares claimed</span></div>
            <div className="stat"><span className="caps">Refunded to the protocol</span><div className="figure-md">{gen((BigInt(o.refunded_at_settle) + BigInt(o.unclaimed_refunded)).toString(), 4)}</div><span className="mono small muted">GEN</span></div>
          </div>
        </div>
        {ev && <p className="note note-flag" style={{ marginTop: 28 }}>{ev.label} {ev.at > now ? <>in <Countdown at={ev.at} /> ({iso(ev.at)})</> : <>now: anyone can call it; the keeper does on its next scheduled run.</>}</p>}

        <section className="section">
          <div className="section-head"><h2>Timeline</h2><span className="mono small muted">chain times, UTC</span></div>
          <ol className="timeline">
            <li className="tl"><div className="tl-when">{info?.hack_date ?? meta.hack_date ?? "—"}</div><div className="tl-title">The hack</div><div className="small muted">{o.chains.map((c) => CHAIN_LABEL[c] ?? c).join(", ")}</div></li>
            {meta.message_tx && (
              <li className="tl tl-flag"><div className="tl-when">{iso(o.start)}</div><div className="tl-title">The white flag: a public offer</div>
                {info && <p className="small" style={{ maxWidth: "70ch" }}>&ldquo;{info.offer.excerpt}&rdquo;</p>}
                <div className="mono small"><Ext href={txLink(meta.message_tx.chain, meta.message_tx.hash)}>on-chain message {short(meta.message_tx.hash)}</Ext>{meta.source && <> · <Ext href={meta.source}>source</Ext></>}</div>
                <div className="small muted">Return window until {iso(o.deadline)}{meta.deadline_basis ? ` (${meta.deadline_basis})` : ""}</div>
              </li>
            )}
            <li className="tl tl-flag"><div className="tl-when">{iso(o.created_at)}</div><div className="tl-title">Offer opened on GenLayer, {gen(o.bounty, 4)} GEN locked</div>
              <div className="mono small">by <a href={studioAddr(o.protocol)}>{short(o.protocol)}</a> on <a href={studioAddr(reg)}>{short(reg)}</a></div></li>
            {o.amendments.map((h) => (
              <li key={h.seq} className="tl"><div className="tl-when">{iso(h.at)}</div>
                <div className="tl-title">Amendment #{h.seq}: {h.what === "deadline" ? "deadline extended" : "recovery address added"}</div>
                <div className="mono small">{h.what === "deadline" ? <>{iso(Number(h.from))} → {iso(Number(h.to))}</> : <>{String(h.chain)} <Ext href={addrLink(String(h.chain), String(h.address))}>{short(String(h.address))}</Ext></>}</div></li>
            ))}
            {counted.map((p) => <ProofItem key={p.proof_id} p={p} sym={sym} dec={dec} />)}
            {o.status !== "OPEN" && (
              <li className="tl tl-flag"><div className="tl-when">{iso(o.settled_at)}</div><div className="tl-title">Settled: {pct(o.fraction_ppm)} returned</div>
                <div className="small">{gen(o.owed, 4)} GEN owed to the exploiter, {gen(o.refunded_at_settle, 4)} GEN refunded to the protocol in the same transaction.</div>
                <div className="mono small muted">settled by {short(o.settled_by)}</div></li>
            )}
            {Object.entries(o.claims).sort((a, b) => a[1].at - b[1].at).map(([who, c]) => (
              <li key={who} className="tl tl-green"><div className="tl-when">{iso(c.at)}</div><div className="tl-title">Claimed: {gen(c.amount, 4)} GEN</div><div className="mono small">by {short(who)}, paid to <a href={studioAddr(c.to)}>{short(c.to)}</a></div></li>
            ))}
            {o.unclaimed_refunded !== "0" && <li className="tl tl-grey"><div className="tl-when">{iso(o.refunded_at)}</div><div className="tl-title">Unclaimed after the window: {gen(o.unclaimed_refunded, 4)} GEN refunded</div><div className="mono small">to <a href={studioAddr(o.protocol)}>{short(o.protocol)}</a></div></li>}
            {o.status !== "OPEN" && BigInt(o.owed) > BigInt(o.claimed) && o.unclaimed_refunded === "0" && (
              <li className="tl tl-grey"><div className="tl-when">until {iso(o.claim_deadline)}</div><div className="tl-title">Claim window</div><div className="small">Each exploiter address claims only the share its own returns earned; after the window the unclaimed shares go back to the protocol.</div></li>
            )}
          </ol>
        </section>

        <section className="section">
          <div className="section-head"><h2>Exploiter addresses</h2><span className="mono small muted">each claims only what its own returns earned</span></div>
          <div className="table-wrap">
            <table className="ledger">
              <thead><tr><th>Address</th><th>Returned</th><th className="num">Share (GEN)</th><th>Beneficiary</th><th>Claim</th></tr></thead>
              <tbody>
                {[...new Set(o.exploiters.map((e) => e.address))].map((a) => {
                  const ret = Object.entries(o.returned_by[a] ?? {});
                  const c = o.claims[a];
                  return (
                    <tr key={a}>
                      <td className="mono small"><a href={studioAddr(a)}>{short(a)}</a></td>
                      <td className="mono small">{ret.length === 0 ? "nothing" : ret.map(([k, v]) => { const [ch, tk] = k.split(":"); return `${units(v, dec(ch, tk))} ${sym(ch, tk)}`; }).join(", ")}</td>
                      <td className="num mono small">{o.status === "OPEN" ? "at settlement" : gen(o.shares[a] ?? "0", 4)}</td>
                      <td className="mono small">{o.beneficiaries[a] ? <a href={studioAddr(o.beneficiaries[a])}>{short(o.beneficiaries[a])}</a> : "itself"}</td>
                      <td className="mono small">{c ? <>paid {gen(c.amount, 4)} to {short(c.to)}</> : o.shares[a] ? (o.unclaimed_refunded !== "0" ? "refunded" : "unclaimed") : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <section className="section">
          <div className="section-head"><h2>Stolen against returned</h2><span className="mono small muted">counted transfers only</span></div>
          <div className="table-wrap">
            <table className="ledger">
              <thead><tr><th>Token</th><th>Chain</th><th className="num">Stolen</th><th className="num">Returned</th><th className="num">Outstanding</th><th className="num">Weight (¢)</th><th>Share</th></tr></thead>
              <tbody>
                {o.tokens.map((t) => {
                  const got = returnedOf(o, t);
                  const capped = got < BigInt(t.stolen) ? got : BigInt(t.stolen);
                  const ppm = Number((capped * 1_000_000n) / BigInt(t.stolen));
                  return (
                    <tr key={t.chain + t.token}>
                      <td><strong>{t.symbol || sym(t.chain, t.token)}</strong><br /><span className="mono small muted">{t.token === "native" ? "native" : <Ext href={addrLink(t.chain, t.token)}>{short(t.token)}</Ext>}</span></td>
                      <td>{CHAIN_LABEL[t.chain] ?? t.chain}</td>
                      <td className="num mono">{units(t.stolen, t.decimals, 2)}</td>
                      <td className="num mono green">{units(got.toString(), t.decimals, 2)}</td>
                      <td className="num mono muted">{units((BigInt(t.stolen) - capped).toString(), t.decimals, 2)}</td>
                      <td className="num mono">{Number(t.weight).toLocaleString("en-US")}</td>
                      <td style={{ minWidth: 120 }}><Bar ppm={ppm} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <div className="grid-2 section">
          <div>
            <div className="section-head"><h3>Exploiter addresses</h3></div>
            <ul className="mono small" style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {o.exploiters.map((e) => <li key={e.chain + e.address} className="break" style={{ padding: "4px 0" }}>{e.chain} · <Ext href={addrLink(e.chain, e.address)}>{e.address}</Ext></li>)}
            </ul>
          </div>
          <div>
            <div className="section-head"><h3>Recovery addresses</h3></div>
            <ul className="mono small" style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {o.recoveries.map((e) => <li key={e.chain + e.address} className="break" style={{ padding: "4px 0" }}>{e.chain} · <Ext href={addrLink(e.chain, e.address)}>{e.address}</Ext></li>)}
            </ul>
          </div>
        </div>

        <section className="section">
          <div className="section-head"><h2>Every proof submitted</h2><span className="mono small muted">{o.n_counted} counted · {o.n_rejected} rejected · {o.n_pending} pending · {o.n_expired} expired</span></div>
          <div className="table-wrap">
            <table className="ledger">
              <thead><tr><th>#</th><th>Chain</th><th>Transaction</th><th>Block time</th><th>Verdict</th><th className="num">Credited</th></tr></thead>
              <tbody>
                {[...counted, ...rejected].map((p) => (
                  <tr key={p.proof_id}>
                    <td className="mono">{p.proof_id}</td>
                    <td>{p.chain}</td>
                    <td className="mono"><Ext href={txLink(p.chain, p.tx_hash)}>{short(p.tx_hash, 8)}</Ext></td>
                    <td className="mono small">{p.block_time ? iso(p.block_time) : "—"}</td>
                    <td>{p.status === "COUNTED" ? <span className="ok mono small">COUNTED</span> : <span className={`mono small ${p.status === "REJECTED" ? "bad" : ""}`}>{p.status} · {p.reason}</span>}{p.attempts > 1 ? <div className="small muted">{p.attempts} reads</div> : null}{p.detail ? <div className="small muted">{p.detail}</div> : null}</td>
                    <td className="num mono">{p.credits.map((c) => `${units(c.amount, dec(p.chain, c.token), 3)} ${sym(p.chain, c.token)}`).join(" + ") || "—"}</td>
                  </tr>
                ))}
                {proofs.length === 0 && <tr><td colSpan={6} className="muted">No proof submitted yet. <Link href={`/prove${q}${q ? "&" : "?"}offer=${o.offer_id}`}>Submit one</Link>.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>

        <section className="section">
          <div className="section-head"><h2>Terms, frozen</h2></div>
          <div className="table-wrap"><table className="ledger"><tbody>
            <tr><td className="caps">Return window</td><td className="mono">{iso(o.start)} → {iso(o.deadline)}{o.original_deadline !== o.deadline ? ` (originally ${iso(o.original_deadline)})` : ""}</td></tr>
            <tr><td className="caps">Amendments</td><td className="mono">{o.amendments.length} recorded; {o.status === "OPEN" && Math.floor(Date.now() / 1000) < o.amendments_close_at ? `the protocol may extend the deadline (to ${iso(o.max_deadline)} at most) or add a recovery address until ${iso(o.amendments_close_at)}` : "closed: no extension or new recovery address is possible"} (rules: none in the final {o.deadline - o.amendments_close_at} s before the deadline or after it; extensions capped in total)</td></tr>
            <tr><td className="caps">Submissions close</td><td className="mono">{iso(o.settle_at)}; settles then if no proof is PENDING (at once if 100% returned)</td></tr>
            <tr><td className="caps">Recovery window</td><td className="mono">until {iso(o.recover_until)}: anyone retries PENDING proofs; then settle always succeeds and leftover PENDING proofs are EXPIRED</td></tr>
            <tr><td className="caps">Claim window</td><td className="mono">{o.claim_window_s} s after settlement</td></tr>
            <tr><td className="caps">Payout rule</td><td className="mono">{o.payout_rule}</td></tr>
            <tr><td className="caps">Machine-readable</td><td className="mono"><a href={`/api/incident?id=${o.offer_id}${r === "demo" ? "&r=demo" : ""}`}>JSON</a> · <a href={`/api/incident?id=${o.offer_id}${r === "demo" ? "&r=demo" : ""}&format=svg`}>SVG badge</a></td></tr>
          </tbody></table></div>
          <div className="row" style={{ marginTop: 24 }}>
            {o.status === "OPEN" && <Link className="btn btn-flag" href={`/prove${q}${q ? "&" : "?"}offer=${o.offer_id}`}>Prove a return</Link>}
            {o.status !== "OPEN" && BigInt(o.owed) > 0n && o.claimed === "0" && o.unclaimed_refunded === "0" && <Link className="btn btn-flag" href={`/claim${q}`}>Claim the bounty</Link>}
            <Link className="btn" href={`/gate${q}${q ? "&" : "?"}offer=${o.offer_id}`}>Ask the gate</Link>
          </div>
        </section>
      </div>
    </div>
  );
}

function ProofItem({ p, sym, dec }: { p: Proof; sym: (c: string, t: string) => string; dec: (c: string, t: string) => number }) {
  return (
    <li className="tl tl-green">
      <div className="tl-when">{iso(p.block_time)} · block {p.block.toLocaleString("en-US")} · {p.chain}</div>
      <div className="tl-title">Returned {p.credits.map((c) => `${units(c.amount, dec(p.chain, c.token), 3)} ${sym(p.chain, c.token)}`).join(" + ")}</div>
      <div className="mono small"><Ext href={txLink(p.chain, p.tx_hash)}>{short(p.tx_hash, 8)}</Ext> · from {short(p.from)} · verified from two RPCs, proof #{p.proof_id}</div>
    </li>
  );
}
