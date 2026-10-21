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
      <div className="note" style={{ marginTop: 24 }}>
        <strong>Amendment rules, disclosed before you sign.</strong> There is no cancel. While the offer is open you may only:
        <ul>
          <li><code>extend_deadline</code>: move the deadline later, in total at most 180 days past the original deadline (1 hour on the demo registry);</li>
          <li><code>add_recovery</code>: add a recovery address on one of the offer&apos;s chains (never an exploiter address).</li>
        </ul>
        Both close 24 hours before the current deadline (2 minutes on the demo registry) and are impossible after it: nothing
        about the offer changes in the final day or once its deadline has passed. Every amendment is recorded on chain in the
        offer&apos;s amendment history (sequence number and time) and shown on its incident page. Each listed exploiter address
        can claim only the share its own returns earned.
      </div>
      <hr className="rule" />
      <Suspense><CreateForm /></Suspense>
    </div></div>
  );
}
