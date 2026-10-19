import { Suspense } from "react";
import { ClaimDesk } from "./ClaimDesk";

export const metadata = { title: "Claim · WhiteFlag" };

export default function Page() {
  return (
    <div className="page"><div className="wrap">
      <div className="kicker"><span className="caps">For the exploiter</span></div>
      <h1>Collect the bounty you earned.</h1>
      <p className="lede" style={{ marginTop: 18 }}>Sign with an exploiter address listed on the offer. You may name a payout address in the same call;
        nobody else can claim it, redirect it or front-run it. After the claim window the owed bounty goes back to the protocol.</p>
      <hr className="rule" />
      <Suspense><ClaimDesk /></Suspense>
    </div></div>
  );
}
