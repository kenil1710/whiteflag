# Attack round

One internal round over the three layers: the contracts (WhiteFlagRegistry, SafeHarborGate), the keeper bot, and
what the docs and the gate claim. Each attack has a test that passes only if the attack fails:
`test/test_attacks.py` (contracts and gate), `test/keeper.test.mjs` (keeper), `test/test_meaning.py` (docs and
meaning). Run all with `sh test/run_offline.sh`.

Every High and Medium finding was fixed before the deployment in [deployments.json](../deployments.json).

## Findings

| # | Layer | Attack | Severity | Status |
|---|---|---|---|---|
| 1 | contract | Copycat offer consumes a real return | High | fixed |
| 2 | contract | Return just before the deadline cannot finalize in time | Medium | fixed |
| 3 | gate | Copycat offer reads favorable to a consumer that only checks the offer id | Medium | fixed |
| 4 | contract | Protocol stalls settlement with deadline extensions | Medium | fixed (capped) |
| 5 | contract | Non-canonical address topics in a Transfer log | Low | fixed |
| 6 | infra | One RPC operator refuses batches under validator load | Medium | fixed (RPCs replaced) |
| 7 | contract | Value sent with a failing or non-payable call is kept by the runtime | Medium | fixed (credit back, sweep) |

### 1. Copycat offer consumes a real return (High, fixed)

The first version counted each (chain, tx, log) once per *registry*. Anyone could open a cheap offer (0.001 GEN)
listing the same exploiter and recovery addresses and submit the hacker's real return to it first; the real offer
would then reject it as `ALREADY_COUNTED` and the hacker would lose the bounty. Uniqueness is now per offer: a
transfer counts once in each offer it satisfies, and each offer pays only from its own bounty.
Tests: `Griefing.test_copycat_offer_cannot_consume_the_real_offers_return`,
`Proofs.test_same_log_counts_in_each_offer_it_satisfies`, `Proofs.test_counted_tx_cannot_be_resubmitted`.

### 2. A return just before the deadline cannot be proved in time (Medium, fixed)

Settlement opened exactly at the deadline. Arbitrum's `finalized` head trails by up to about an hour, so a return
made minutes before the deadline would still be `NOT_FINALIZED` when a keeper settled, and never count. Settlement
now waits `deadline + finality grace` (2 h canonical, 60 s demo); the block-time window itself is unchanged.
Tests: `Settle.test_return_just_before_deadline_still_counts`, `Settle.test_exactly_at_deadline_plus_grace`.

### 3. Copycat offer reads favorable through the gate (Medium, fixed)

Anyone can open an offer under any incident name, give it a fake exploiter they control, "return" one wei and settle
it FULL. A consumer contract asking only `is_favorable(offer_id)` for an id it did not pin to the protocol would be
fooled. The gate now returns the offer's `protocol` (creator) and `incident`, and `check_for` /
`is_favorable_for(offer_id, protocol)` are favorable only if the creator matches. An answer without a protocol
address is `UNREADABLE`. Tests: `GateAttacks.*`.

### 4. Protocol stalls settlement (Medium, fixed by a cap)

Extending the deadline is one of the protocol's two powers; unbounded, it could keep a partially returned bounty
unsettled for years. Extensions are capped at 180 days past the original deadline. A 100% return settles at once
regardless. Test: `Protocol.test_extend_cap`.

### 5. Non-canonical address topics (Low, fixed)

A Transfer log whose address topics carry non-zero high bytes was read as the low 20 bytes. A standard token never
emits one, and only a listed token's logs count, but the read is now strict: such a log is not a transfer of an
address. Test: `FakeLogs.test_dirty_topic_padding`.

### 6. RPC refuses batches under validator load (Medium, fixed)

On the first on-chain trial every proof was rejected `RPC_UNREADABLE`: with five validators reading at once, the
Nodies endpoints refused the batches (measured inside GenVM, [FEASIBILITY.md](FEASIBILITY.md)). The read path now sends
one batch per RPC per submission (at most 12 calls) and the RPCs are ones that hold up under that load (Ethereum:
MEV Blocker and Blast; Arbitrum: arb1 and Blast). A rejection stores which RPC failed (`detail`).
Tests: `Griefing.test_batch_chunks_when_an_rpc_takes_fewer_calls`, `Griefing.test_rejection_detail_names_the_rpc`.

### 7. Value kept from a failing call (Medium, fixed)

Measured on Studio: GEN sent with a call that raises, or with a non-payable method, stays in the contract. So
`create_offer` never raises (a refusal credits the value back for `withdraw_refund`), and any balance above the ledger
can be swept to the deployer, but only 2 days (canonical) after the registry's last payout, so a payout that is posted
and not yet applied is never mistaken for stray value. Tests: `Create.test_refused_value_is_credited_and_withdrawable`,
`Stray.*`, `Money.*`, `test_static.ValueExits.test_create_offer_never_raises`.

## Attacks that fail as designed

| Attack | Why it fails | Tests |
|---|---|---|
| Leader invents a transfer, inflates an amount, claims finality | every validator re-reads both RPCs and compares | `ProofSpoofing.test_leader_*` |
| Leader hides a valid return | the rejection is not agreed; the transaction is undetermined and nothing is stored | `ProofSpoofing.test_leader_rejects_a_good_proof` |
| One RPC lies | the two RPCs must answer identically | `ProofSpoofing.test_one_lying_rpc`, `Proofs.test_rpc_disagree_*` |
| Hash from another chain, wrong chain id, unlisted RPC | read from the named chain's two RPCs only; chain id checked | `ProofSpoofing.*` |
| Look-alike token, attacker contract emitting `Transfer`, ERC-721 `Transfer`, `Approval` | only 3-topic Transfer logs emitted by a listed token address count | `FakeLogs.*` |
| Proxy token | the proxy is the log's address; listing the implementation does not count proxy events | `ProxyTokens.*` |
| Reorg, unfinalized block, RPCs on different forks | block at or below both finalized heads; block hash and header must match on both RPCs | `Reorgs.*` |
| Non-exploiter sends to a recovery address | sender must be a listed exploiter address | `WrongParties.test_non_exploiter_sends_to_recovery` |
| Exploiter moves a victim's tokens via allowance | the Transfer must be *from* an exploiter address | `WrongParties.test_exploiter_moves_victim_tokens_via_allowance` |
| Exploiter "returns" to its own second address | recipient must be a recovery address; a recovery address cannot be an exploiter | `WrongParties.*` |
| Splitting returns into many transactions | sums are exact, capped per token, no per-transfer rounding | `Splitting.*` |
| Junk proofs to block or delay | per-sender rate limit, rejected proofs are resubmittable, settle time is fixed | `Griefing.*` |
| Claim front-running, redirecting a payout | only an exploiter address can claim; the payout address is in the same call | `ClaimFrontRunning.*` |
| Refund racing an open claim window | refund only after `claim_deadline` | `ClaimFrontRunning.test_refund_cannot_race_an_open_window` |
| Protocol cancels, reduces or edits the offer | no such method exists | `ClaimFrontRunning.test_protocol_cannot_cancel_to_dodge_paying`, `Protocol.*` |
| Keeper acts twice (two runs, a crash, a slow transaction) | per-action key, stored hash resumed before any resubmit, contract refuses a second settle | `keeper.test.mjs`: idempotent, crash right after submit, ACCEPTED for many runs, someone else settled |
| Keeper counts a transaction that is not final | DONE needs FINALIZED + success + the effect visible in a read | `keeper.test.mjs`: ACCEPTED but not final, finalized but the read does not show it |
| Keeper skips something silently | every unfinished item is in `unprocessed` with a reason, shown on the site | `keeper.test.mjs`: outage on one page, gives up after MAX_ATTEMPTS, budget |
| Gate reports settled on missing data | missing, malformed or inconsistent answers are `NO_OFFER` or `UNREADABLE`, never favorable | `test_meaning.GateNeverFavorableOnMissingData.*` |
| Docs say something the code does not do | constants, reasons, states, check order and the formula are read from the code and checked against RULES.md | `test_meaning.DocsMatchCode.*` |
| Site's live check disagrees with the contract | the site's JavaScript rule is run against the contract's rule on 400 random cases | `test_meaning.JsMatchesContract` |

## What the protocol must get right

These are inputs, not attacks; the docs say so plainly:

- List only addresses the exploiter controls. A listed address can claim the bounty.
- List the address that emits a token's Transfer events (the proxy, not the implementation).
- The weights are the protocol's own valuation, frozen at creation.
- A consumer of the gate pins the offer to the protocol's address (`check_for`), not just to an id.
