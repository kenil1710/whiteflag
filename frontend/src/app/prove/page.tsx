import { Suspense } from "react";
import { ProveForm } from "./ProveForm";

export const metadata = { title: "Prove a return · WhiteFlag" };

export default function Page() {
  return (
    <div className="page"><div className="wrap">
      <div className="kicker"><span className="caps">For anyone: the exploiter, the protocol, a bystander</span></div>
      <h1>Prove a return.</h1>
      <p className="lede" style={{ marginTop: 18 }}>Paste the transaction hashes of a return. Each one is read now from the same two RPCs the validators use and
        judged by the same rule; then send them to the registry, where every validator reads them again before anything counts.</p>
      <hr className="rule" />
      <Suspense><ProveForm /></Suspense>
    </div></div>
  );
}
