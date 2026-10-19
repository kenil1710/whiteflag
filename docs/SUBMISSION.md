# Submission

Plain ASCII. Lengths checked by `node tools/submission.mjs`.

## One-liner (167/180 characters)

WhiteFlag: a hacked protocol locks a whitehat bounty; GenLayer validators verify each returned transfer on chain and code pays the bounty pro rata, refunding the rest.

## Description (862/1000 characters)

After a hack, protocols offer bounties in on-chain messages that nobody can check or enforce. WhiteFlag makes the offer an escrow on GenLayer. The protocol locks GEN and freezes the terms: exploiter and recovery addresses, stolen tokens with value weights, deadline, claim window. Anyone submits return tx hashes; every validator reads each tx, receipt and finalized head from two RPCs per chain (Ethereum, Arbitrum) and counts only transfers from a listed exploiter to a recovery address. Returned fraction = weighted min(returned, stolen) / stolen; bounty x fraction goes to the exploiter (only an exploiter address can claim), the rest back to the protocol. No cancel, no admin, no model. Seeded with 6 real incidents (GMX 89.02%, Alchemix 100%, Seneca 83.67%, KyberSwap, Curve, UwU 0%). SafeHarborGate answers consumers; an hourly keeper settles and refunds.

## Review verification (457/500 characters)

Live: whiteflag-ledger.vercel.app (/verify checks source byte for byte). Registry 0x461399B65edA1C0634a47A658d34624eC4C24a31, demo 0xa06816B6CF6AA72c64027A84Dc04bfb708935Aa2, gates 0x54035218daFDf7fB68F01cF36E70044f51878c75, 0x886095700276BA236Fc00cfd710AEb2f2d594E37 on Studio Dev. Repo github.com/kenil1710/whiteflag: sh test/run_offline.sh (387 tests), node tools/verify_source.mjs, node tools/final_check.mjs. docs/SEEDS.md links every proof and payout.

## Addresses

- WhiteFlagRegistry: 0x461399B65edA1C0634a47A658d34624eC4C24a31
- WhiteFlagRegistryDemo: 0xa06816B6CF6AA72c64027A84Dc04bfb708935Aa2
- SafeHarborGate: 0x54035218daFDf7fB68F01cF36E70044f51878c75
- SafeHarborGateDemo: 0x886095700276BA236Fc00cfd710AEb2f2d594E37
