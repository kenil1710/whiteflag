# Real-world check

Before submission, every canonical outcome was checked against public reporting and against each exploiter
address's full outgoing history on chain (Blockscout and Routescan indexers, every native transaction and every
token transfer, not only transfers to our listed recovery addresses). The question each time: did the listed
exploiter send funds back anywhere we do not list (another protocol address, a multisig, a whitehat or SEAL address,
another chain)? Checked on 2026-10-19.

| Case | Our outcome | Public reporting | On chain, outside our recovery list | Verdict |
|---|---|---|---|---|
| GMX V1 GLP | SETTLED_PARTIAL 89.02% | about $40.5M returned, about $5M kept ([Decrypt](https://decrypt.co/329821/gmx-hacker-white-hat-returns-40-million-sends-rest-tornado-cash)); 40.5 / 45.5 = 89% | the four Ethereum wallets made 8 native sends between them: 7 to the GMX multisig `0x8d1d2e24…` (10,000 ETH) and 1,701.02 ETH to a fresh wallet; the other "ETH" entries are fake tokens from look-alike addresses | matches |
| Alchemix alETH-ETH | SETTLED_FULL 100% | all stolen funds returned ([Cointelegraph](https://cointelegraph.com/news/alchemix-reports-return-of-all-stolen-funds-from-curve-pools)) | not needed: already 100% | matches |
| Seneca | SETTLED_PARTIAL 83.67% | 1,537 ETH returned, 300 ETH kept as the 20% bounty ([Cointelegraph](https://cointelegraph.com/news/seneca-hacker-returns-stolen-funds-exploit)); 1,537 / 1,837 = 83.67% ("80%" in headlines is the share Seneca asked for) | exploiter 1 sent 537 ETH to the Seneca Safe and 500 ETH to each of the other two wallets, which each sent 500 ETH to the Safe; nothing else went to a Seneca address | matches |
| KyberSwap Elastic | SETTLED_NONE 0% | the main exploiter never returned funds; KyberSwap covered users from its treasury. Separately, front-running bots that took about $5.7M on Polygon and Avalanche returned 90% after negotiation ([The Block](https://www.theblock.co/post/264756/kyberswap-recovers-4-7-million-after-exploit)) | Ethereum: bridges (Optimism, Arbitrum, Base, Scroll, LI.FI), a DEX and the exploiter's own wallets (`0x441e3634…` swaps on Paraswap and deposits to Binance). Optimism: Aave and own wallets. Avalanche: LI.FI and `0x441e3634…`. Arbitrum (every ERC-20 Transfer out of both addresses from block 152,500,000 to 516,380,590, read with `eth_getLogs`): the exploiter's own wallets, look-alike addresses, and 2,000,000 ARB to `0xc0f9c4b3…`, which sold it through Paraswap; nothing to `0x8180a5ca…` or any KyberSwap address. Polygon and Base: the explorers refused automated reads; no report names a return there by this exploiter, and neither chain is in the offer | matches |
| Curve CRV/ETH | SETTLED_NONE 0% | the CRV/ETH exploiter returned nothing; Curve opened a public $1.85M bounty for their identity ([The Block](https://www.theblock.co/amp/post/243464/curve-exploit-identity-bounty)). Separately, c0ffeebabe.eth ran the same exploit against the pool's remaining 2,879.65 ETH and returned it to Curve ([LlamaRisk](https://hackmd.io/@LlamaRisk/BJzSKHNjn)) | `0xb752def3…` sent its 7,680.49 WETH and 7.19M CRV to `0xb1c33b39…`, which still holds 6,180.49 WETH and every CRV; the other 1,500 WETH went in July 2024 to `0xc772bdb4…`, which put it into Tornado Cash | matches |
| UwU Lend | SETTLED_NONE 0% | no return; the deadline passed, the exploiter struck again on 13 June and UwU Lend posted a $5M bounty for their identity ([The Block](https://www.theblock.co/post/300074/uwu-lend-offers-a-5-million-bounty-to-whoever-catches-its-exploiter)) | the three wallets sent only to DEX pools (Curve router, Uniswap V3), between themselves and to fresh wallets; the remaining "ETH" entries are fake tokens from look-alike addresses | matches |

## The two returns by other actors

Both are real returns that WhiteFlag does not count, and both are excluded on purpose:

- **Curve CRV/ETH, c0ffeebabe.eth.** An MEV operator ran the exploit after the attacker and sent the 2,879.54 ETH it
  took to a Curve address (`0xc447fcaf…`) in
  [0xb7675412…](https://eth.blockscout.com/tx/0xb76754124fdde090f25129105ed2907e3c62e0db87ecb8ffcefcb1dede0954fd).
  Those funds were never held by the listed exploiter, and our stolen amounts (7,680.49 WETH and 7,193,401.78 CRV) are
  exactly what `0xb752def3…` received in the exploit, so the fraction's numerator and denominator both leave them out.
- **KyberSwap, front-running bots on Polygon and Avalanche.** These were different addresses on chains the offer does
  not list. The offer covers the main exploiter's Ethereum and Arbitrum takes, and that exploiter returned nothing.

An offer for either of these actors would be its own offer, with its own exploiter address, stolen amounts and
recovery address. Under the rules a return by an unlisted sender never counts toward someone else's offer
(SENDER_NOT_EXPLOITER).
