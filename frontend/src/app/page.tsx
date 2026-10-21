import Link from "next/link";
import { asReg, regAddr } from "@/lib/deployments";
import { OFFERS_PER_PAGE, offersPage, offer as getOffer, stats } from "@/lib/server";
import { caseNo, day, gen, money, nextEvent, pct, usd, incidentInfo, returnedOf, nowS } from "@/lib/format";
import { Bar, Stamp } from "@/components/bits";
import { Countdown } from "@/components/Countdown";
import type { Offer } from "@/lib/types";

export const revalidate = 30;

export default async function Home({ searchParams }: { searchParams: Promise<{ r?: string; page?: string }> }) {
  const sp = await searchParams;
  const r = asReg(sp.r);
  const reg = regAddr(r);
  let offers: Offer[] = [];
  let s: Record<string, unknown> = {};
  let error = "";
  let pg = { total: 0, pages: 1, page: 0 };
  try {
    // one page of the board (newest first), never every offer
    const list = await offersPage(reg, Number(sp.page ?? 0) || 0);
    pg = list;
    offers = [];
    for (let i = 0; i < list.items.length; i += 6) offers.push(...(await Promise.all(list.items.slice(i, i + 6).map((o) => getOffer(reg, o.offer_id)))));
    s = await stats(reg);
  } catch (e) {
    error = String((e as Error).message ?? e).slice(0, 200);
  }
  const now = nowS();
  const stolen = offers.reduce((a, o) => a + usd(o.tokens, (t) => BigInt(t.stolen)), 0);
  const back = offers.reduce((a, o) => a + usd(o.tokens, (t) => { const g = returnedOf(o, t); return g < BigInt(t.stolen) ? g : BigInt(t.stolen); }), 0);
  const q = r === "demo" ? "?r=demo" : "";
  const pageHref = (n: number) => `/?${new URLSearchParams({ ...(r === "demo" ? { r: "demo" } : {}), ...(n > 0 ? { page: String(n) } : {}) })}`;
  return (
    <div className="page">
      <div className="wrap">
        <div className="kicker"><span className="caps">The board · {r === "demo" ? "demo registry (minutes)" : "canonical registry"}</span></div>
        <h1 className="rise">Bounties that pay<br />only for what <em className="flag-text">came back</em>.</h1>
        <p className="lede" style={{ marginTop: 22 }}>
          A hacked protocol locks a whitehat bounty. The exploiter returns funds on Ethereum or Arbitrum. GenLayer validators read every
          returned transfer from two RPCs per chain, and code pays the bounty pro rata. The rest goes back to the protocol.
        </p>

        <div className="grid-3 section">
          <div className="stat"><span className="caps">Stolen on this page, at the protocols&apos; own weights</span><div className="figure-md">{money(stolen)}</div></div>
          <div className="stat"><span className="caps">Verified returned (this page)</span><div className="figure-md green">{money(back)}</div></div>
          <div className="stat"><span className="caps">Bounties locked · paid · refunded (GEN)</span>
            <div className="figure-md">{gen(String(s.received_total ?? "0"), 2)}</div>
            <span className="mono small muted">paid {gen(String(s.paid_total ?? "0"), 4)} · refunded {gen(String(s.refunded_total ?? "0"), 4)}</span>
          </div>
        </div>

        <section className="section" aria-labelledby="board">
          <div className="section-head">
            <h2 id="board">Open and closed cases</h2>
            <span className="mono small muted">{pg.total} offers · page {pg.page + 1} of {pg.pages}, {OFFERS_PER_PAGE} per page, newest first · read from chain</span>
          </div>
          {error && <p className="note note-flag">The registry could not be read just now ({error}). Nothing is shown rather than a guess.</p>}
          <div className="board-head caps" aria-hidden="true"><span>Case</span><span>Incident</span><span>Stolen</span><span>Returned</span><span>Bounty</span><span>Status</span></div>
          <div className="board">
            {offers.map((o) => {
              const info = incidentInfo(o);
              const ev = nextEvent(o, now);
              return (
                <Link key={o.offer_id} href={`/incident/${o.offer_id}${q}`} className="case">
                  <span className="case-no">Incident #{caseNo(o)}</span>
                  <span className="case-title">
                    <span className="case-name">{o.name}</span><br />
                    <span className="mono small muted">{info?.hack_date ?? day(o.start)} · {o.chains.join(" + ")}</span>
                  </span>
                  <span className="case-cell"><span className="caps">Stolen</span><span className="serif" style={{ fontSize: "1.35rem" }}>{money(usd(o.tokens, (t) => BigInt(t.stolen)))}</span></span>
                  <span className="case-cell"><span className="caps">Returned</span><div className="case-pct">{pct(o.fraction_ppm)}</div><Bar ppm={o.fraction_ppm} /></span>
                  <span className="case-cell"><span className="caps">Bounty</span><span className="mono">{gen(o.bounty, 3)} GEN</span><br /><span className="mono small muted" title="The declared share is informational: the payout is the locked bounty times the returned fraction.">{o.bounty_share_bps / 100}% declared (informational)</span></span>
                  <span className="case-cell"><Stamp status={o.status} />{ev && <><br /><span className="small muted">{ev.label} </span>{ev.at > now ? <Countdown at={ev.at} /> : null}</>}</span>
                </Link>
              );
            })}
          </div>
          {pg.pages > 1 && (
            <nav className="row" aria-label="pages" style={{ marginTop: 18, justifyContent: "space-between" }}>
              {pg.page > 0 ? <Link className="btn" href={pageHref(pg.page - 1)}>← newer</Link> : <span />}
              <span className="mono small muted">page {pg.page + 1} / {pg.pages}</span>
              {pg.page < pg.pages - 1 ? <Link className="btn" href={pageHref(pg.page + 1)}>older →</Link> : <span />}
            </nav>
          )}
        </section>
      </div>
    </div>
  );
}
