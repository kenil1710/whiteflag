import { readFileSync } from "node:fs";
import path from "node:path";
import { marked } from "marked";
import { REPO } from "@/lib/deployments";

export const metadata = { title: "Rules · WhiteFlag" };

export default function Page() {
  // content/RULES.md is docs/RULES.md copied by tools/sync_frontend.mjs; test_meaning.py holds it to the code
  const md = readFileSync(path.join(process.cwd(), "src/content/RULES.md"), "utf8");
  const html = marked.parse(md, { async: false }) as string;
  return (
    <div className="page"><div className="wrap">
      <div className="kicker"><span className="caps">Every rule, exactly as the code does it</span></div>
      <div className="prose" dangerouslySetInnerHTML={{ __html: html }} />
      <hr className="rule" />
      <p className="small">Also: <a href={`${REPO}/blob/main/docs/ATTACK_REPORT.md`}>attack report</a> · <a href={`${REPO}/blob/main/docs/FEASIBILITY.md`}>feasibility</a> · <a href={`${REPO}/blob/main/docs/SEEDS.md`}>seeds</a> · <a href={`${REPO}/blob/main/docs/FINAL_CHECK.md`}>final check</a> · <a href={`${REPO}`}>source</a></p>
    </div></div>
  );
}
