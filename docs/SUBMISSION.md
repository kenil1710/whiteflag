# Submission

Plain ASCII. Lengths checked by `node tools/submission.mjs`.

## One-liner (167/180 characters)

WhiteFlag: a hacked protocol locks a whitehat bounty; GenLayer validators verify each returned transfer on chain and code pays the bounty pro rata, refunding the rest.

## Description (864/1000 characters)

After a hack, protocols offer bounties in on-chain messages that nobody can check or enforce. WhiteFlag makes the offer an escrow on GenLayer. The protocol locks GEN and freezes the terms: exploiter and recovery addresses, stolen tokens with value weights, deadline, claim window. Anyone submits return tx hashes; every validator reads each tx, receipt and finalized head from two RPCs per chain (Ethereum, Arbitrum) and counts only transfers from a listed exploiter to a recovery address. Returned fraction = weighted min(returned, stolen) / stolen; bounty x fraction goes to the exploiter (only an exploiter address can claim), the rest back to the protocol. No cancel, no admin, no model. Seeded with 6 real incidents (GMX 89.02%, Alchemix 100%, Seneca 83.67%, KyberSwap, Curve, UwU 0%). SafeHarborGate answers consumers; a scheduled keeper settles and refunds.

## Review verification (495/500 characters)

Live: whiteflag-ledger.vercel.app (/verify checks source byte for byte). Registry 0x461399B65edA1C0634a47A658d34624eC4C24a31, demo 0xa06816B6CF6AA72c64027A84Dc04bfb708935Aa2, gates 0x54035218daFDf7fB68F01cF36E70044f51878c75, 0x886095700276BA236Fc00cfd710AEb2f2d594E37 on Studio Dev. Repo github.com/kenil1710/whiteflag: sh test/run_offline.sh (389 tests), node tools/verify_source.mjs, node tools/final_check.mjs. Deploy commit ce7a772, final 60d9903. docs/SEEDS.md links every proof and payout.

## Evidence (pinned to the final commit)

Final commit `60d990365ded6bd5ef125685a156ed29fdf2fcbd`; contracts deployed from `ce7a77282beee2a8c9b121aa95ac9639388a64d0`.

- Seeds, every proof and payout, read from chain: https://github.com/kenil1710/whiteflag/blob/60d990365ded6bd5ef125685a156ed29fdf2fcbd/docs/SEEDS.md
- Final check: https://github.com/kenil1710/whiteflag/blob/60d990365ded6bd5ef125685a156ed29fdf2fcbd/docs/FINAL_CHECK.md
- Real-world check of every canonical outcome: https://github.com/kenil1710/whiteflag/blob/60d990365ded6bd5ef125685a156ed29fdf2fcbd/docs/REAL_WORLD_CHECK.md
- Rules: https://github.com/kenil1710/whiteflag/blob/60d990365ded6bd5ef125685a156ed29fdf2fcbd/docs/RULES.md
- Attack round: https://github.com/kenil1710/whiteflag/blob/60d990365ded6bd5ef125685a156ed29fdf2fcbd/docs/ATTACK_REPORT.md
- Demo log and payouts: https://github.com/kenil1710/whiteflag/blob/60d990365ded6bd5ef125685a156ed29fdf2fcbd/docs/demo-run.log, https://github.com/kenil1710/whiteflag/blob/60d990365ded6bd5ef125685a156ed29fdf2fcbd/docs/payouts.json
- Deployed source: https://github.com/kenil1710/whiteflag/blob/60d990365ded6bd5ef125685a156ed29fdf2fcbd/build/WhiteFlagRegistry.py, https://github.com/kenil1710/whiteflag/blob/60d990365ded6bd5ef125685a156ed29fdf2fcbd/build/SafeHarborGate.py, https://github.com/kenil1710/whiteflag/blob/60d990365ded6bd5ef125685a156ed29fdf2fcbd/deployments.json
- Feasibility (real incidents read from two RPCs and from GenVM): https://github.com/kenil1710/whiteflag/blob/60d990365ded6bd5ef125685a156ed29fdf2fcbd/docs/FEASIBILITY.md
- Keeper, a scheduled run: https://github.com/kenil1710/whiteflag/actions/runs/39351621873
- Live source check: https://whiteflag-ledger.vercel.app/verify

## Addresses

- WhiteFlagRegistry: 0x461399B65edA1C0634a47A658d34624eC4C24a31
- WhiteFlagRegistryDemo: 0xa06816B6CF6AA72c64027A84Dc04bfb708935Aa2
- SafeHarborGate: 0x54035218daFDf7fB68F01cF36E70044f51878c75
- SafeHarborGateDemo: 0x886095700276BA236Fc00cfd710AEb2f2d594E37
