import { Suspense } from "react";
import { CreateForm } from "./CreateForm";

export const metadata = { title: "Open an offer · WhiteFlag" };

export default function Page() {
  return (
    <div className="page"><div className="wrap">
      <div className="kicker"><span className="caps">For a protocol that was hacked</span></div>
      <h1>Raise the white flag.</h1>
      <p className="lede" style={{ marginTop: 18 }}>Lock a bounty in GEN and freeze the terms. From then on, nobody decides anything:
        returns are read from chain, the bounty follows the returned fraction, and what is not earned comes back to you.</p>
      <p className="note" style={{ marginTop: 24 }}>There is no cancel. You may only extend the deadline (up to 180 days past the original) or add recovery addresses.
        List only addresses the exploiter controls: any listed exploiter address can claim.</p>
      <hr className="rule" />
      <Suspense><CreateForm /></Suspense>
    </div></div>
  );
}
