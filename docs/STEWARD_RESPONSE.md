# Response to the steward review

Six requested changes, each with its commit, the files it changed and the tests that hold it. The contracts were
redeployed from one commit after all six, the six real incidents and every demo path were reseeded under the new rules,
and the results are checked from chain in [AUDIT.md](AUDIT.md) and [FINAL_CHECK.md](FINAL_CHECK.md).

Deploy commit `2c92d0692a0b5ce33cdba522f3a95f27d7e3c8ca` (all four contracts, byte-identical to `build/`):

| Contract | Address |
|---|---|
| WhiteFlagRegistry (canonical) | `0x11b9e1d185ADd2b88dF872743734Db1124b80390` |
| WhiteFlagRegistryDemo | `0x0c5c9cB1826530A5a90cA1676cA0477F36FC9D55` |
| SafeHarborGate (canonical) | `0xd7a4A4a7836aB46c003606884d9962320460aEB8` |
| SafeHarborGateDemo | `0x5d7376dD53bCb4f3A8791A2ddB79F5F2f230F43f` |

The previous deployment and its records are in [superseded/2026-10-21-before-steward-review](superseded/2026-10-21-before-steward-review/README.md).

## 1. Claim fairness

**Commit** `7ab7fae` (rules), with the demo-chain commit `270de03` so the demo exploiter keys can send real signed
returns they are entitled to claim.

- Every counted transfer is attributed to the exploiter address that sent it (`returned_by`): the transaction sender for
  a native transfer, the Transfer log's `from` for a token.
- At settlement each token's counted value is split between its senders in proportion to what each sent; each address's
  share is `bounty * its part / den`; the rounding remainder goes to the largest contributor so the shares add up to
  exactly the owed amount (`shares_of`).
- `claim(offer_id)` pays only the caller's own share. A listed address that returned nothing has no share
  (`NOTHING_OWED_TO_THIS_ADDRESS`).
- `commit_beneficiary(offer_id, payout_to)`: optional, from the exploiter address itself, set once, before it claims,
  only under `EXPLOITER_OR_NAMED`. Nobody can set or change it for another address; the claim pays the committed
  beneficiary or the address itself.
- Files: `contracts/WhiteFlagRegistry.py`, `build/WhiteFlagRegistry.py`, `docs/RULES.md` (section 5), `README.md`,
  `frontend/src/app/claim/ClaimDesk.tsx`, `frontend/src/app/incident/[id]/page.tsx`, `frontend/src/lib/types.ts`.
- Tests: `test/test_registry.py` `ClaimFairness` (competing claimants, multiple contributing addresses, an affiliated
  listed address that returned nothing gets 0, claim front-running, weighted tokens, over-return capped, log sender vs
  transaction sender, rounding dust, partial claims then refund), `Claim.*`, `test/test_attacks.py` `ClaimFrontRunning`;
  Direct Mode `test/direct/test_registry_direct.py::test_each_exploiter_address_claims_only_its_own_share`,
  `::test_beneficiary_commitment_is_set_once_by_the_exploiter_only`. On chain: demo paths A and B
  ([SEEDS.md](SEEDS.md)), audit letters C and D.

## 2. Evidence recovery

**Commit** `8aeb4ec`.

- Every proof ends COUNTED, REJECTED or PENDING. REJECTED is permanent (wrong sender, recipient, token or window, failed
  transaction, unknown hash). PENDING is transient (`RPC_UNREADABLE`, `RPC_DISAGREE`, `WRONG_CHAIN_ID`, `TX_PENDING`,
  `NOT_FINALIZED`).
- Submissions close at `settle_at`. A fixed recovery window follows (86400 s canonical, 300 s demo) in which anyone calls
  `retry_proofs(offer_id, [proof ids])`. Settle is allowed at `settle_at` if no proof is PENDING, and always from
  `recover_until`; leftover PENDING proofs show EXPIRED. Both windows are fixed when the offer opens; a PENDING
  transaction cannot be resubmitted, junk hashes are REJECTED and never hold settlement.
- Validators agree on a PENDING read only when both fail transiently; a leader cannot turn a readable return into
  PENDING (validators that can read it disagree).
- The keeper retries PENDING proofs (`RETRY_PENDING`, once per hour) during the recovery window.
- Files: `contracts/WhiteFlagRegistry.py`, `tools/lib/keeper_core.mjs`, `tools/keeper.mjs`, `docs/RULES.md` (section 2,
  4, reasons table), `README.md`, `frontend/src/app/prove/ProveForm.tsx`, `frontend/src/app/incident/[id]/page.tsx`,
  `frontend/src/lib/format.ts`.
- Tests: `test/test_registry.py` `Recovery` (extended outage, delayed finality, recovery success, recovery expiry,
  provider disagreement, competing settle attempts, junk spam, submissions closing, foreign and duplicate ids, full
  return with a pending proof), updated `Proofs.*`, `test/keeper.test.mjs` (retry then settle, settle after the window);
  Direct Mode `test/direct/test_consensus_direct.py` and `test_registry_direct.py::test_outage_*`. On chain: demo path F
  (a real Ethereum transaction proved before finality, PENDING, retried after Ethereum finalized it, COUNTED) and G
  (never final: settle refused until the window ended, then EXPIRED); audit letter E.

## 3. Gate

**Commit** `a00a363`.

- `check` and `is_favorable` are removed; no gate view takes an offer id alone. Only `check_for(protocol, incident)` and
  `is_favorable_for(protocol, incident)` remain (plus `attest` / `get_latest` with the same pair).
- The registry keeps an index `get_offer_by(protocol, incident)`: the latest offer that address itself created under that
  incident. A copy opened by another address under the same name is never returned; the gate also rejects an answer
  whose creator or incident differs (`UNREADABLE`).
- Files: `contracts/SafeHarborGate.py`, `contracts/WhiteFlagRegistry.py`, `frontend/src/app/gate/*`,
  `frontend/src/app/api/*`, `docs/RULES.md` (section 7), `docs/ATTACK_REPORT.md`, `README.md`.
- Tests: integration with both real contracts in `test/test_gate.py` `OnRegistry` (copied incident created by another
  address never found, a copy before or after the real offer never shadows it, latest offer of the protocol, exact
  incident match, attest of a copied incident records NO_OFFER), `test/test_attacks.py` `GateAttacks`, `PureState`;
  Direct Mode `test/direct/test_gate_direct.py` and `test_registry_direct.py::test_get_offer_by_returns_only_the_protocols_own_offer`.
  On chain: a stranger's copy of the demo incident `demo-full` settled at 100% does not change
  `check_for(protocol, "demo-full")`; audit letter F reads the gate's schema from Studio.

## 4. Amendments

**Commit** `6d95484`.

- `extend_deadline` and `add_recovery` only while the offer is open and before `deadline - lock` (86400 s canonical,
  120 s demo): never in the final day, never after the deadline. Total extension capped (180 days canonical, 3600 s
  demo) from the original deadline, across all extensions.
- Each amendment is appended to the offer's on-chain `amendments` list with a registry-wide sequence number and the
  transaction's consensus time (GenVM gives a contract the transaction time, not a block number); shown on the incident
  page; `amendments_close_at` and `max_deadline` are returned with the offer.
- Disclosed on the offer page (`/create`), in [RULES.md](RULES.md#1a-amendment-rules) and the README.
- Because historic incidents are past their deadlines, the canonical Alchemix offer now lists Curve's recovery address
  at creation instead of adding it later.
- Files: `contracts/WhiteFlagRegistry.py`, `frontend/src/app/create/page.tsx`, `frontend/src/app/incident/[id]/page.tsx`,
  `docs/RULES.md`, `README.md`, `docs/ATTACK_REPORT.md`, `test/seed_canonical.mjs`, `data/incidents.json`.
- Tests: `test/test_registry.py` `Protocol` (lock near settlement, after the deadline, total cap, ordered history,
  refused amendments record nothing), Direct Mode
  `test_registry_direct.py::test_amendments_close_before_the_deadline_and_are_recorded`. On chain: demo path H and the
  refused amendments of E; audit letter G.

## 5. Testing

**Commit** `02491c8` (Direct Mode and CI).

- GenLayer Direct Mode with `genlayer-test` (`direct_vm`, `direct_deploy`, `run_validator`): the build files run inside
  the official GenLayer Python SDK. JSON-RPC answers change between the leader's run and each validator's re-run:
  validator disagreement on a value, a leader inventing a return, a leader hiding a return behind a transient failure,
  leader errors and malformed answers, one RPC down, the two RPCs disagreeing, rate limits retried, finality moving
  mid-round, permanent vs transient reasons. Run: `sh test/run_direct.sh`.
- Two disclosed adaptations: the contracts pin the runner Studio Dev accepts (`5jycge4q…`), which no published GenVM
  bundle contains, so Direct Mode runs the build files with only that line pointed at `1zr6nqk5…` from GenVM v0.3.0-rc7
  (`test/direct/test_runner_pin.py` checks nothing else differs); and that SDK's `emit_call` is a no-op stub, so the
  harness records sends (real delivery is checked on Studio by the demo payouts).
- CI: [.github/workflows/ci.yml](../.github/workflows/ci.yml), public, badge in the README: offline contract tests,
  Direct Mode, lint (`genvm-lint lint`, pyflakes, eslint), frontend typecheck and build, keeper tests, deployed-source
  verification.
- Files: `test/direct/*`, `test/run_direct.sh`, `.github/workflows/ci.yml`, `README.md`, lint fixes in `frontend/src`.

## 6. Frontend

**Commits** `2fe412e` (bounded reads), `03fa771` (create form id), `a9ae5a0` (browser flows).

- Bounded pagination everywhere: the board reads one page of 12 offers (newest first), an incident one page of 25
  proofs, the claim desk 10 offers, the prove form the newest 50; the live check reads at most 500 proofs. Nothing
  loads every offer or proof.
- Caching: bounded LRU of view answers server-side (15 s) and in the browser (10 s), plus the CDN's 20 s.
- Retry with exponential backoff and jitter on RPC rate limits (server and browser).
- The declared bounty share is labelled informational on the board, the incident page, the create form, the API and
  RULES.
- End-to-end browser-wallet flows with Playwright and throwaway wallets on the demo registry: create offer, submit
  proofs (one COUNTED, one REJECTED), successful finalization, settle (remainder refunded), claim of the wallet's own
  share, refund of an unclaimed share. Screenshots, videos and log: [e2e/README.md](e2e/README.md).
- Files: `frontend/src/lib/server.ts`, `frontend/src/lib/contract.ts`, `frontend/src/app/**`, `test/e2e/*`, `docs/e2e/*`.
- The site is redeployed with Vercel; the team's free plan allows 100 deployments a day, which delayed the redeploy of
  the demo chain by about an hour. Because of that the demo chain's scheduled endpoint outage had passed before the demo
  ran, so the live recovery path uses a real not-yet-final Ethereum transaction instead; RPC outages and provider
  disagreement are exercised in Direct Mode and the offline suite.

## After the six

Redeploy from `2c92d06`, `node tools/verify_source.mjs` byte-identical; the six real incidents reseeded
([seed-canonical.json](seed-canonical.json)) and settled by the scheduled keeper, their unclaimed shares refunded to the
protocol; every demo path rerun ([demo-run.log](demo-run.log), payouts verified at recipients in
[payouts.json](payouts.json); the run was resumed by `test/demo_finish.mjs` after one claim landed past the 3 min
window, closed by `test/demo_close.mjs` after Studio canceled one refund, and one balance measurement that overlapped
the browser flows was repeated cleanly by `test/demo_repeat_withdraw.mjs`; the log keeps every failed expectation and
its explanation); both registries end at an eth_getBalance of 0; the audit and the final check read all of
it back from chain.
