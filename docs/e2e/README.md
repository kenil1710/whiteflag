# Browser-wallet flows (Playwright)

Recorded against https://whiteflag-ledger.vercel.app on the demo registry `0x0c5c9cB1826530A5a90cA1676cA0477F36FC9D55` with throwaway wallets injected as `window.ethereum` ([test/e2e/wallet.mjs](../../test/e2e/wallet.mjs)): each transaction the site asks for is signed with a local test key and sent raw to Studio Dev, as MetaMask would. Spec: [test/e2e/flows.spec.mjs](../../test/e2e/flows.spec.mjs). Offers: claim flow #13, refund flow #14. Result: [results.json](results.json) (1 passed), log: [run.log](run.log).

Videos: [protocol wallet](protocol.webm), [exploiter wallet](exploiter.webm).

### 01. Create an offer: the protocol's throwaway wallet fills the form (wfdemo, exploiter = the e2e exploiter wallet)

![01-create-offer-form.png](01-create-offer-form.png)

### 02. Offer accepted and confirmed in contract state

![02-create-offer-accepted.png](02-create-offer-accepted.png)

### 03. The new offer's case file

![03-offer-case-file-open.png](03-offer-case-file-open.png)

### 04. Submit proofs from the exploiter wallet: its own return and a stranger's transfer

![04-proofs-counted-and-rejected-form.png](04-proofs-counted-and-rejected-form.png)

### 05. Recorded by the registry: one COUNTED, one REJECTED (SENDER_NOT_EXPLOITER)

![05-proofs-counted-and-rejected-recorded.png](05-proofs-counted-and-rejected-recorded.png)

### 06. Successful finalization of the proof transaction

![06-transaction-finalized.png](06-transaction-finalized.png)

### 07. Settle from the claim desk once the settle time passed

![07-settle-due.png](07-settle-due.png)

### 08. The exploiter wallet sees its own share

![08-claim-own-share.png](08-claim-own-share.png)

### 09. Claim accepted: paid exactly its share

![09-claim-accepted.png](09-claim-accepted.png)

### 10. Refund: the unclaimed share of the second offer after the 3 min claim window

![10-refund-unclaimed-accepted.png](10-refund-unclaimed-accepted.png)

### 11. Case file after settlement and claim: shares by address

![11-case-file-settled-and-claimed.png](11-case-file-settled-and-claimed.png)
