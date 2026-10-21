import { Suspense } from "react";
import { GateDemo } from "./GateDemo";

export const metadata = { title: "Gate · WhiteFlag" };

export default function Page() {
  return (
    <div className="page"><div className="wrap">
      <div className="kicker"><span className="caps">SafeHarborGate, for other contracts</span></div>
      <h1>Is this incident resolved?</h1>
      <p className="lede" style={{ marginTop: 18 }}>A lending market reopening a pool, an insurer releasing a payout, a DAO lifting a pause: they ask the gate.
        Every question names the protocol address that must have opened the offer and the incident it was opened under; an
        offer anyone else opened under the same name is never found. It answers from the registry only, and never favorably on
        missing, malformed or inconsistent data.</p>
      <div className="panel mono small" style={{ marginTop: 26 }}>
        check_for(protocol, incident) · is_favorable_for(protocol, incident) · attest(protocol, incident) · get_latest(protocol, incident)
      </div>
      <hr className="rule" />
      <Suspense><GateDemo /></Suspense>
    </div></div>
  );
}
