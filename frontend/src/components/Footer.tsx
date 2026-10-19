import { COMMIT, REPO, ADDR } from "@/lib/deployments";
import { studioAddr, short } from "@/lib/format";

export function Footer() {
  return (
    <footer className="footer">
      <div className="wrap">
        <div className="row">
          <span>WhiteFlag verifies returns and pays the bounty. It does not enforce legal promises; only listed exploiter addresses and tokens count.</span>
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <span className="mono">GenLayer Studio Dev · registry <a href={studioAddr(ADDR.registry)}>{short(ADDR.registry)}</a> · deployed from <a href={`${REPO}/commit/${COMMIT}`}>{COMMIT.slice(0, 7)}</a></span>
          <a className="mono" href={REPO}>source</a>
        </div>
      </div>
    </footer>
  );
}
