# WhiteFlag

**A whitehat bounty that pays only for what came back.** A protocol that was hacked locks a bounty in GEN on
GenLayer. The exploiter returns funds on any supported chain. GenLayer validators read every returned transfer from
two independent RPCs per chain, and code pays the bounty pro rata to the returned value and refunds the rest to the
protocol. Nobody decides anything after the offer is opened: no admin, no vote, no model.

Live: **https://whiteflag-ledger.vercel.app** · Rules: [docs/RULES.md](docs/RULES.md) · Seeds: [docs/SEEDS.md](docs/SEEDS.md) ·
Final check: [docs/FINAL_CHECK.md](docs/FINAL_CHECK.md) · Real-world check: [docs/REAL_WORLD_CHECK.md](docs/REAL_WORLD_CHECK.md)

## What and why

After an exploit, protocols post on-chain messages: "keep 10%, return the rest within 48 hours, no legal action".
GMX did it in 2025 and got about 90% back; Curve, Metronome and Alchemix did it jointly in 2023; Seneca, KyberSwap
and UwU Lend did it too. The offer is a promise in a transaction's input data. The exploiter cannot see the bounty
locked anywhere, cannot know how much counts as "returned", and has to trust the protocol to pay a share of funds it
already gave back. The protocol cannot prove to anyone that what came back was what was stolen.

WhiteFlag turns the offer into an escrow with arithmetic. The bounty is locked up front. Returns are facts on public
chains: a transaction from a listed exploiter address that moved a listed token to a listed recovery address, in a
finalized block, inside the return window. Validators agree on those facts by reading them twice each, and the payout
follows from a formula frozen at creation. If nothing comes back, the protocol gets its GEN back; if half comes
back, half the bounty is paid and half refunded.

Six real incidents are on the canonical registry with their real addresses, amounts, offers and return transactions
([docs/FEASIBILITY.md](docs/FEASIBILITY.md)): GMX V1 (89.02% returned, across Arbitrum and Ethereum), the Alchemix
alETH pool of the Curve/Vyper exploit (100%), Seneca (83.67%), KyberSwap Elastic, Curve CRV/ETH and UwU Lend (nothing).
Each outcome was checked against public reporting and every outgoing transfer of the exploiter addresses
([docs/REAL_WORLD_CHECK.md](docs/REAL_WORLD_CHECK.md)).

## How the rules work

1. **The offer is frozen.** Incident, chains, exploiter addresses, recovery addresses, stolen tokens (chain, token,
   amount, the protocol's value weight), bounty share, return window, claim window, payout rule. The bounty is the
   GEN sent with `create_offer`. No cancel; the protocol may only extend the deadline (180 days at most) or add a
   recovery address.
2. **Anyone proves returns.** `submit_proofs` takes up to 5 transaction hashes. Every validator reads each transaction,
   its receipt, its block header and the finalized head from both RPCs of its chain, and the answers must be
   identical. A proof counts only if the transaction succeeded, its block is finalized, its time is inside the
   window, it was sent by an exploiter address, and it moved a listed token (native value, or a Transfer log of the
   listed token contract) from an exploiter address to a recovery address. Each (chain, tx, log) counts once per
   offer. A proof that does not count is REJECTED when the facts are wrong (permanent) or PENDING when they could not
   be read yet (RPC error, the RPCs disagree, block not final). PENDING proofs can be retried by anyone during a
   fixed recovery window after submissions close (24 h canonical, 5 min demo); one still PENDING at settlement is
   EXPIRED. Nothing a submitter does moves the window.
3. **The fraction is arithmetic.** `sum(min(returned, stolen) * weight) / sum(stolen * weight)`, integer math;
   owed = bounty × fraction.
4. **Settlement.** Anyone settles at once at 100%; otherwise at `settle_at`, the later of the deadline plus a finality
   grace (2 h) and the offer's creation plus a minimum open time (3 h), when no proof is PENDING, and always once the
   recovery window after `settle_at` has ended:
   SETTLED_FULL, SETTLED_PARTIAL or SETTLED_NONE. The remainder goes back to the protocol in the same transaction.
5. **Claim.** Every counted transfer is attributed to the exploiter address that sent it, and each address claims only
   the share its own weighted returns earned: paid to itself, or to a beneficiary it committed on chain from that
   address beforehand (nobody else can set or change it). A listed address that returned nothing gets nothing. After
   the claim window (1 h canonical), anyone refunds the unclaimed shares to the protocol. Every GEN has an exit.
6. **SafeHarborGate.** Other contracts ask it whether an incident is resolved: NO_OFFER, OPEN, SETTLED_FULL,
   SETTLED_PARTIAL, SETTLED_NONE (or UNREADABLE), never favorable on missing data, pinned to the protocol that opened
   the offer with `check_for`.
7. **Keeper.** A GitHub Actions job ([.github/workflows/keeper.yml](.github/workflows/keeper.yml)) settles, retries PENDING proofs and refunds
   on an hourly schedule with a 6-hourly fallback (GitHub starts scheduled runs late, sometimes by hours),
   checkpointing each step on the [keeper-state](https://github.com/kenil1710/whiteflag/tree/keeper-state)
   branch. Everything it does, anyone can do.

## Addresses (GenLayer Studio Dev, chain 61997)

Every contract was deployed from commit `ce7a77282beee2a8c9b121aa95ac9639388a64d0`. Final commit `4251f48bdbc925c7d811e03ea0ce0c86826fc2bf`: every evidence link in
[docs/SUBMISSION.md](docs/SUBMISSION.md) is pinned to it, and later commits change only README.md, docs/SUBMISSION.md
and docs/FINAL_CHECK.md.

| Contract | Address | Deployed file | sha256 | Constructor |
|---|---|---|---|---|
| WhiteFlagRegistry | [`0x461399B65edA1C0634a47A658d34624eC4C24a31`](https://explorer-studio-dev.genlayer.com/address/0x461399B65edA1C0634a47A658d34624eC4C24a31) | `build/WhiteFlagRegistry.py` | `dba2a5da09d13de0` | `["CANONICAL"]` |
| WhiteFlagRegistryDemo | [`0xa06816B6CF6AA72c64027A84Dc04bfb708935Aa2`](https://explorer-studio-dev.genlayer.com/address/0xa06816B6CF6AA72c64027A84Dc04bfb708935Aa2) | `build/WhiteFlagRegistry.py` | `dba2a5da09d13de0` | `["DEMO"]` |
| SafeHarborGate | [`0x54035218daFDf7fB68F01cF36E70044f51878c75`](https://explorer-studio-dev.genlayer.com/address/0x54035218daFDf7fB68F01cF36E70044f51878c75) | `build/SafeHarborGate.py` | `f4b6411127c1f7b3` | `["0x461399B65edA1C0634a47A658d34624eC4C24a31", 900000]` |
| SafeHarborGateDemo | [`0x886095700276BA236Fc00cfd710AEb2f2d594E37`](https://explorer-studio-dev.genlayer.com/address/0x886095700276BA236Fc00cfd710AEb2f2d594E37) | `build/SafeHarborGate.py` | `f4b6411127c1f7b3` | `["0xa06816B6CF6AA72c64027A84Dc04bfb708935Aa2", 900000]` |

The canonical registry runs the 1 h claim window and holds the real incidents; the demo registry runs a 3 minute
window and holds the [demo run](docs/demo-run.log), in which every path was exercised and every payout was checked at
its recipient ([docs/payouts.json](docs/payouts.json)).

## How to verify

- **Source.** `node tools/verify_source.mjs` reads each address's code from Studio Dev and compares it byte for byte
  with `build/` at the deploy commit and at HEAD. The site does the same live at
  [/verify](https://whiteflag-ledger.vercel.app/verify). `build/` is `contracts/` with the shared helpers inlined
  (`python3 tools/build.py`).
- **Returns.** Every case file on the site links each counted return to Etherscan or Arbiscan; `node tools/feasibility.mjs`
  re-reads every real return from both RPCs and judges it with the same rule.
- **Tests.** `sh test/run_offline.sh`: contract tests against the deployed build files and mock chains (every rule and
  boundary, RPC disagreement, fund conservation), the attack round ([docs/ATTACK_REPORT.md](docs/ATTACK_REPORT.md)),
  meaning tests (the gate never favorable on missing data, docs equal to code), and the keeper (outages, more than 50
  offers, crashes, transactions accepted but not final).
- **Everything at once.** `node tools/final_check.mjs`, result in [docs/FINAL_CHECK.md](docs/FINAL_CHECK.md).
- **API.** `/api/incident?id=<offer>` returns an incident as JSON read from chain; `&format=svg` returns a badge:
  ![badge](https://whiteflag-ledger.vercel.app/api/incident?id=1&format=svg)

## Scope

- WhiteFlag verifies returns and pays the bounty. It does not enforce legal promises ("no further legal action" stays
  a promise between people). Only listed exploiter addresses, recovery addresses, tokens and chains count: a return
  from an address the offer does not list, to an address it does not list, through an internal call, of a token it
  does not list or on a chain it does not list does not move the fraction. Returns by other people (an MEV bot that
  ran the same exploit, a front-runner) belong to no offer but their own.
- Only submitted returns count. Nothing is discovered automatically: anyone may submit a return's transaction hash
  until the offer's settle time, and every submission is recorded COUNTED, REJECTED (permanent) or PENDING
  (transient, retried until the recovery window ends) with its reason. A return nobody submits in time is not counted.
- An offer is the protocol's own statement of the incident. SafeHarborGate reports what the registry settled for one
  offer id; a consumer pins the protocol address it trusts with `check_for`.
- Chains: Ethereum and Arbitrum One, each read from two RPCs run by different operators. Adding a chain means adding
  two RPCs that serve old receipts and the `finalized` tag from GenVM under validator load.
- The weights are the protocol's own valuation, frozen when the offer opens. A partial return of a token that later
  changes price keeps the weight it had.
- Each listed exploiter address claims only its own share; listing an extra address the exploiter controls gives it nothing unless it returned funds.
- Studio keeps GEN sent with a failing call, so `create_offer` never fails: a refused offer credits its GEN back for
  `withdraw_refund`, and GEN that reached the registry any other way can only be swept to the deployer.

## Repository

`contracts/` source · `build/` deployed bytes · `data/incidents.json` the real incidents · `test/` offline suite and
on-chain scripts (deploy, seed, demo) · `tools/` feasibility, keeper, verification, final check · `frontend/` the site ·
`docs/` everything written down.
