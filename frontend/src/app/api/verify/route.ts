/**
 * GET /api/verify: every deployed contract's code as Studio Dev serves it
 * (gen_getContractCode) against the build file at the deploy commit on
 * GitHub, byte for byte. Live; cached 60 s.
 */
import { createHash } from "node:crypto";
import { createClient } from "genlayer-js";
import { studioDevnet } from "genlayer-js/chains";
import { CONTRACTS } from "@/lib/deployments";

export const dynamic = "force-dynamic";
const client = createClient({ chain: studioDevnet });
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

async function onChain(address: string): Promise<Buffer> {
  for (let i = 0; i < 3; i++) {
    try { return Buffer.from(String(await client.getContractCode(address as `0x${string}`)), "utf8"); }
    catch { await new Promise((res) => setTimeout(res, 1500 * (i + 1))); }
  }
  throw new Error("Studio Dev did not return the code");
}

export async function GET() {
  const rows = await Promise.all(Object.entries(CONTRACTS).map(async ([name, c]) => {
    const url = `https://raw.githubusercontent.com/kenil1710/whiteflag/${c.commit}/${c.file}`;
    try {
      const [chain, file] = await Promise.all([onChain(c.address), fetch(url, { cache: "no-store" }).then(async (r) => { if (!r.ok) throw new Error("GitHub " + r.status); return Buffer.from(await r.arrayBuffer()); })]);
      return { name, address: c.address, file: c.file, commit: c.commit, source_url: url, chain_sha256: sha(chain), file_sha256: sha(file),
        recorded_sha256: c.sha256, bytes: chain.length, identical: chain.equals(file) && sha(file) === c.sha256 };
    } catch (e) {
      return { name, address: c.address, file: c.file, commit: c.commit, source_url: url, error: String((e as Error).message), identical: false };
    }
  }));
  return Response.json({ checked_at: new Date().toISOString(), all_identical: rows.every((r) => r.identical), contracts: rows },
    { headers: { "cache-control": "public, s-maxage=60" } });
}
