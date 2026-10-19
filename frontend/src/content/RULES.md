# WhiteFlag rules

Every rule here is what `contracts/WhiteFlagRegistry.py` and `contracts/SafeHarborGate.py` do, in the order they do it.
`test/test_meaning.py` reads this file and fails if a constant, a rejection reason or a state named here differs from
the code. No model is asked anything anywhere: every decision is a comparison of numbers and addresses read from chains.

## 1. The offer

A protocol that was hacked calls `create_offer` and sends the bounty in GEN with the call. The offer freezes:

| Field | Rule |
|---|---|
| incident, name | printable text, at most 80 characters, markup characters removed |
| chains | a subset of the supported chains: `ethereum`, `arbitrum` |
| exploiter addresses | 1 to 24 (chain, address) pairs; a transaction counts only if it was sent from one |
| recovery addresses | 1 to 24 (chain, address) pairs; no address may be both exploiter and recovery |
| stolen tokens | 1 to 12 entries: chain, token (`native` or an ERC-20 contract address), decimals (0 to 18), stolen amount in base units, value weight (a positive integer the protocol picks) |
| bounty share | 1 to 10000 basis points: the public share the protocol announced (informational) |
| return window | `start` (not in the future) and `deadline` (after `start`, at most 3653 days later) |
| payout rule | `EXPLOITER_OR_NAMED` (paid to the claiming exploiter address or a payout address it names) or `EXPLOITER_ONLY` |
| claim window | set by the registry: 3600 s on the canonical registry, 180 s on the demo registry |
| bounty | the GEN sent with the call, at least 0.001 GEN (10^15 wei) |

`create_offer` is the only payable method and it never fails: a refused offer credits the GEN back to the sender
(`withdraw_refund` pays it out) and returns `{"ok": false, "reason": ...}`. Studio keeps the value of a failing call,
so raising there would strand it.

There is no cancel. The protocol (the address that created the offer) may only, while the offer is open:

- `extend_deadline`: move the deadline later, at most 180 days past the original deadline;
- `add_recovery`: add a recovery address on one of the offer's chains (never an exploiter address).

## 2. Return proofs

Anyone may call `submit_proofs(offer_id, [[chain, tx_hash], ...])` with 1 to 5 transactions while the offer is open.
Every validator reads, for each chain, from BOTH of its RPCs, in one batch of at most 12 calls per RPC:
the transaction, its receipt, the receipt's block header, the RPC's finalized head and its chain id.

| Chain | Chain id | RPC A | RPC B |
|---|---|---|---|
| ethereum | 1 | `https://rpc.mevblocker.io` | `https://eth-mainnet.public.blastapi.io` |
| arbitrum | 42161 | `https://arb1.arbitrum.io/rpc` | `https://arbitrum-one.public.blastapi.io` |

Only these fields are compared and used: status, block number, block hash, block time, sender, recipient, value,
and every log with exactly three topics whose first topic is the ERC-20 `Transfer` event and whose address topics
are canonically zero-padded. The two RPCs must return identical fields; the leader's reading is accepted only if every
validator's own reading is identical. A proof is then judged, in this order:

1. read failed -> the reason below (`RPC_UNREADABLE`, `RPC_DISAGREE`, `WRONG_CHAIN_ID`, `TX_NOT_FOUND`, `TX_PENDING`, `UNSUPPORTED_CHAIN`);
2. receipt status is not success -> `TX_FAILED`;
3. block number above the lower of the two RPCs' finalized heads -> `NOT_FINALIZED`;
4. block time before `start` -> `BEFORE_OFFER_START` (a block exactly at `start` counts);
5. block time after `deadline` -> `AFTER_DEADLINE` (a block exactly at `deadline` counts);
6. transaction sender not an exploiter address on that chain -> `SENDER_NOT_EXPLOITER`;
7. credits: the transaction's native value if `native` is listed for the chain, the value is above zero and the
   recipient is a recovery address; plus every Transfer log emitted by a listed token contract of that chain, from an
   exploiter address, to a recovery address, for an amount above zero. None -> `NO_RETURN_TO_RECOVERY`;
8. every credit already counted for this offer -> `ALREADY_COUNTED`; otherwise the new credits are COUNTED.

Each (chain, transaction, log index) counts once per offer (`native` stands for the transaction's value). A rejected
proof is recorded with its reason and may be submitted again; a counted transaction is refused before reading
(`ALREADY_COUNTED`). The rate limit is 20 proofs per (offer, sender) per window of 3600 s (canonical) or 600 s
(demo). Transfers inside contract calls (internal ETH transfers, self-destructs) and transfers from addresses that are
not listed do not count; the protocol lists the address that emits a token's events (for a proxy token, the proxy).

## 3. The returned fraction

For each listed token, amounts are scaled to 18 decimals, then

```
fraction = sum over tokens of min(returned, stolen) * weight
           ------------------------------------------------
                 sum over tokens of stolen * weight
owed     = bounty * fraction                (integer division, rounded down)
refund   = bounty - owed
```

A token returned beyond its stolen amount counts only up to the stolen amount; it does not make up for another token.

## 4. Settlement

Anyone may call `settle(offer_id)`:

- at once if the fraction is exactly 100%;
- otherwise at or after `settle_at` = the later of `deadline + finality grace` and `created + minimum open time`.
  Finality grace: 7200 s canonical, 60 s demo (a return made just before the deadline can still finalize and be
  proved). Minimum open time: 10800 s canonical, 60 s demo (an offer opened after its deadline, a historic incident,
  still takes proofs).

Status: OPEN -> `SETTLED_FULL` (100%), `SETTLED_PARTIAL` (above 0, below 100%) or `SETTLED_NONE` (0). The refund goes
to the protocol in the settling transaction. The owed bounty becomes claimable until `claim_deadline` = settlement
time + claim window. Proofs are refused once an offer is settled.

## 5. Claim and refunds

- `claim(offer_id, payout_to)`: the caller must be an exploiter address of the offer (on any of its chains), the offer
  settled with something owed, not yet claimed or refunded, and the time at or before `claim_deadline`. Paid to the
  caller, or to `payout_to` if the payout rule is `EXPLOITER_OR_NAMED`. If several exploiter addresses are listed,
  the first claim takes the whole owed amount.
- `refund_unclaimed(offer_id)`: anyone, after `claim_deadline`, if the owed amount was not claimed: it goes to the protocol.
- `withdraw_refund()`: GEN credited back by a refused `create_offer`, to the address that sent it.
- `sweep_stray()`: anyone; GEN in the balance above what the ledger holds (value the runtime kept from a failing or
  non-payable call) goes to the deployer, never sooner than 172800 s (canonical) or 3600 s (demo) after the registry's
  last payout, so a payout that is posted but not yet applied is never swept.

Every payout is one external value message, posted in the transaction that marks it paid, funded by the caller's fee
(an External message allocation for the recipient). Every state has an exit and every timeout leads to a refund:
OPEN always becomes settled after `settle_at`; owed GEN is either claimed or refunded after the claim window.

## 6. The ledger

```
received = held + paid + refunded + credits paid out
held     = open bounties + owed unclaimed + credits owed
balance  = held + stray (stray is only ever swept to the deployer)
```

Counters change only after every check of a call has passed.

## 7. SafeHarborGate

`check(offer_id)` reads the registry's `get_offer` and returns one of `NO_OFFER`, `OPEN`, `SETTLED_FULL`,
`SETTLED_PARTIAL`, `SETTLED_NONE` or `UNREADABLE`, with the fraction, bounty, owed, paid, refunded, the offer's protocol
address and incident. `favorable` is true only for `SETTLED_FULL`, or `SETTLED_PARTIAL` at or above the gate's
threshold (900000 parts per million on both deployed gates), from an answer that is complete and adds up
(owed + refund = bounty, paid + refunded-unclaimed <= owed, the status agrees with the fraction). A missing offer is
`NO_OFFER`; a failed or malformed read is `UNREADABLE`; neither is ever favorable, and nothing is reported settled or
recovered without the registry saying so. `check_for(offer_id, protocol)` and `is_favorable_for` are favorable only
if the offer was created by `protocol`, because anyone can open an offer under any incident name. `attest(offer_id)`
stores the state with the time it was read.

## 8. Lists

Every list is paginated by `offset` and `limit` (at most 50 per page): `get_offers`, `get_due` (offers needing
`SETTLE` or `REFUND_UNCLAIMED` at a given time), `get_proofs`, and the gate's `get_attestations`. Each offer summary
carries `deadline`, `settle_at`, `claim_deadline`, `status`, `owed`, `claimed` and `unclaimed_refunded`.

## Rejection reasons

| Reason | Meaning |
|---|---|
| `UNSUPPORTED_CHAIN` | the chain is not one of the registry's chains |
| `RPC_UNREADABLE` | an RPC did not answer, answered an error, or answered something malformed |
| `RPC_DISAGREE` | the two RPCs of the chain answered differently (or only one knows the transaction) |
| `WRONG_CHAIN_ID` | an RPC is not on the expected chain |
| `TX_NOT_FOUND` | neither RPC knows the transaction |
| `TX_PENDING` | the transaction has no receipt yet |
| `TX_FAILED` | the transaction reverted |
| `NOT_FINALIZED` | its block is above a finalized head |
| `BEFORE_OFFER_START` | its block time is before the return window |
| `AFTER_DEADLINE` | its block time is after the deadline |
| `SENDER_NOT_EXPLOITER` | it was not sent by a listed exploiter address |
| `NO_RETURN_TO_RECOVERY` | it moved no listed token from an exploiter address to a recovery address |
| `ALREADY_COUNTED` | everything it moved was already counted for this offer |

The stored reason and detail of a rejection are the leading validator's; validators agree that the proof is rejected,
not on the wording.
