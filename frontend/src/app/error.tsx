"use client";

/** A read that failed (Studio or an RPC not answering) shows this, never a guessed state. */
export default function ReadError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="page"><div className="wrap">
      <div className="kicker"><span className="caps">Read failed</span></div>
      <h1>The chain did not answer.</h1>
      <p className="lede" style={{ marginTop: 18 }}>This page reads everything from chain and shows nothing rather than a guess. The offer, its
        proofs and its money are unaffected: every state on the registry can still be settled, claimed or refunded by anyone.</p>
      <p className="note note-flag" style={{ marginTop: 22 }}>{error.message || "unknown error"}{error.digest ? ` (${error.digest})` : ""}</p>
      <p style={{ marginTop: 22 }}><button className="btn" onClick={() => reset()}>Read again</button></p>
    </div></div>
  );
}
