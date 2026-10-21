# Superseded: the deployment before the steward review

These are the records of the contracts deployed from commit `ce7a77282beee2a8c9b121aa95ac9639388a64d0` and checked
at `4251f48`, kept as they were: the seeds, the demo run, its payouts, the final check and the submission notes of
that deployment, and `deployments.json` as it stood.

They were replaced after the steward review (claim fairness, evidence recovery, the protocol-bound gate, amendment
rules, Direct Mode and CI, bounded frontend reads). The new contracts, seeds, demo run and checks are linked from the
README; `deployments.json` lists every superseded contract under `superseded`.

| Contract | Address (superseded) |
|---|---|
| WhiteFlagRegistry | `0x461399B65edA1C0634a47A658d34624eC4C24a31` |
| WhiteFlagRegistryDemo | `0xa06816B6CF6AA72c64027A84Dc04bfb708935Aa2` |
| SafeHarborGate | `0x54035218daFDf7fB68F01cF36E70044f51878c75` |
| SafeHarborGateDemo | `0x886095700276BA236Fc00cfd710AEb2f2d594E37` |

Both old registries ended with an eth_getBalance of 0 (every payout and refund delivered); see `payouts.json` and
`FINAL_CHECK.md` here.
