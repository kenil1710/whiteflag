import { Suspense } from "react";
import { VerifyTable } from "./VerifyTable";
import { COMMIT, REPO } from "@/lib/deployments";

export const metadata = { title: "Verify · WhiteFlag" };

export default function Page() {
  return (
    <div className="page"><div className="wrap">
      <div className="kicker"><span className="caps">Source, byte for byte</span></div>
      <h1>What runs is what you can read.</h1>
      <p className="lede" style={{ marginTop: 18 }}>Read live: the code GenLayer Studio Dev serves for each contract, against the build file at the deploy commit
        <a href={`${REPO}/commit/${COMMIT}`}> {COMMIT.slice(0, 7)}</a> on GitHub, compared byte for byte and by sha256.</p>
      <p className="note" style={{ marginTop: 20 }}>Offline: <span className="mono">node tools/verify_source.mjs</span> does the same from a clone and also checks that contracts/ and build/ have not changed since the deploy commit.</p>
      <hr className="rule" />
      <Suspense><VerifyTable /></Suspense>
    </div></div>
  );
}
