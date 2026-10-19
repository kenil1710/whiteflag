import { Suspense } from "react";
import { GateDemo } from "./GateDemo";

export const metadata = { title: "Gate · WhiteFlag" };

export default function Page() {
  return (
    <div className="page"><div className="wrap">
      <div className="kicker"><span className="caps">SafeHarborGate, for other contracts</span></div>
      <h1>Is this incident resolved?</h1>
      <p className="lede" style={{ marginTop: 18 }}>A lending market reopening a pool, an insurer releasing a payout, a DAO lifting a pause: they ask the gate.
        It answers from the registry only, and never favorably on missing, malformed or inconsistent data.</p>
      <div className="panel mono small" style={{ marginTop: 26 }}>
        check(offer_id) · check_for(offer_id, protocol) · is_favorable(offer_id) · is_favorable_for(offer_id, protocol) · attest(offer_id) · get_latest(offer_id)
      </div>
      <hr className="rule" />
      <Suspense><GateDemo /></Suspense>
    </div></div>
  );
}
