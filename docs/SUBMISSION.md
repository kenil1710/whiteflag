# Submission

Plain ASCII. Lengths checked by `node tools/submission.mjs`.

## One-liner (167/180 characters)

WhiteFlag: a hacked protocol locks a whitehat bounty; GenLayer validators verify each returned transfer on chain and code pays the bounty pro rata, refunding the rest.

## Description (865/1000 characters)

After a hack, protocols offer bounties in on-chain messages nobody can check or enforce. WhiteFlag makes the offer an escrow on GenLayer. The protocol locks GEN and freezes the terms; it may only extend the deadline or add a recovery address, never in the final 24h, each amendment recorded on chain. Anyone submits return tx hashes; validators read each from two RPCs per chain and count only transfers from a listed exploiter to a recovery address. Unreadable proofs stay PENDING and can be retried in a fixed 24h recovery window. Bounty x weighted returned fraction is split by each exploiter address's own returns; each claims only its share, optionally to a beneficiary it committed. The rest goes back to the protocol. No admin, no model. 6 real incidents (GMX 89.02%, Alchemix 100%, Seneca 83.67%, three 0%). SafeHarborGate answers only for a named protocol.

## Review verification (490/500 characters)

Live: whiteflag-ledger.vercel.app (/verify checks source byte for byte). Registry 0x11b9e1d185ADd2b88dF872743734Db1124b80390, demo 0x0c5c9cB1826530A5a90cA1676cA0477F36FC9D55, gates 0xd7a4A4a7836aB46c003606884d9962320460aEB8, 0x5d7376dD53bCb4f3A8791A2ddB79F5F2f230F43f on Studio Dev. Repo github.com/kenil1710/whiteflag: tests 437+24 (offline + Direct Mode, CI), node tools/verify_source.mjs, tools/audit.mjs. Deploy commit 2c92d06, final aa8f052. docs/SEEDS.md links every proof and payout.

## Evidence (pinned to the final commit)

Final commit `aa8f052f4b265ee6aab3494bc1f22c9d0e9fa4cc`; contracts deployed from `2c92d0692a0b5ce33cdba522f3a95f27d7e3c8ca`.

- Seeds, every proof and payout, read from chain: https://github.com/kenil1710/whiteflag/blob/aa8f052f4b265ee6aab3494bc1f22c9d0e9fa4cc/docs/SEEDS.md
- Final check (written after the final commit, so on main): https://github.com/kenil1710/whiteflag/blob/main/docs/FINAL_CHECK.md
- Steward review response: https://github.com/kenil1710/whiteflag/blob/aa8f052f4b265ee6aab3494bc1f22c9d0e9fa4cc/docs/STEWARD_RESPONSE.md
- Audit A-N from chain: https://github.com/kenil1710/whiteflag/blob/aa8f052f4b265ee6aab3494bc1f22c9d0e9fa4cc/docs/AUDIT.md
- Browser-wallet flows (screenshots, videos): https://github.com/kenil1710/whiteflag/blob/aa8f052f4b265ee6aab3494bc1f22c9d0e9fa4cc/docs/e2e/README.md
- Real-world check of every canonical outcome: https://github.com/kenil1710/whiteflag/blob/aa8f052f4b265ee6aab3494bc1f22c9d0e9fa4cc/docs/REAL_WORLD_CHECK.md
- Rules: https://github.com/kenil1710/whiteflag/blob/aa8f052f4b265ee6aab3494bc1f22c9d0e9fa4cc/docs/RULES.md
- Attack round: https://github.com/kenil1710/whiteflag/blob/aa8f052f4b265ee6aab3494bc1f22c9d0e9fa4cc/docs/ATTACK_REPORT.md
- Demo log and payouts: https://github.com/kenil1710/whiteflag/blob/aa8f052f4b265ee6aab3494bc1f22c9d0e9fa4cc/docs/demo-run.log, https://github.com/kenil1710/whiteflag/blob/aa8f052f4b265ee6aab3494bc1f22c9d0e9fa4cc/docs/payouts.json
- Deployed source: https://github.com/kenil1710/whiteflag/blob/aa8f052f4b265ee6aab3494bc1f22c9d0e9fa4cc/build/WhiteFlagRegistry.py, https://github.com/kenil1710/whiteflag/blob/aa8f052f4b265ee6aab3494bc1f22c9d0e9fa4cc/build/SafeHarborGate.py, https://github.com/kenil1710/whiteflag/blob/aa8f052f4b265ee6aab3494bc1f22c9d0e9fa4cc/deployments.json
- Feasibility (real incidents read from two RPCs and from GenVM): https://github.com/kenil1710/whiteflag/blob/aa8f052f4b265ee6aab3494bc1f22c9d0e9fa4cc/docs/FEASIBILITY.md
- Keeper, a scheduled run: https://github.com/kenil1710/whiteflag/actions/runs/39599573859
- Live source check: https://whiteflag-ledger.vercel.app/verify

## Addresses

- WhiteFlagRegistry: 0x11b9e1d185ADd2b88dF872743734Db1124b80390
- WhiteFlagRegistryDemo: 0x0c5c9cB1826530A5a90cA1676cA0477F36FC9D55
- SafeHarborGate: 0xd7a4A4a7836aB46c003606884d9962320460aEB8
- SafeHarborGateDemo: 0x5d7376dD53bCb4f3A8791A2ddB79F5F2f230F43f
