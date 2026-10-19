# The white flag is a transaction now

On 9 July 2025, about an hour after someone drained roughly $42 million from GMX V1 on Arbitrum, the GMX deployer
sent the attacker a transaction with no value and a message in its input data. "We want to offer a 10% white-hat
bounty for the return of the exploited funds. If the remaining 90% of funds are returned within 48 hours, we commit
to pursuing no further legal action." Two days later the attacker replied the same way, "ok, funds will be returned
later", and then actually did it: 10.5 million FRAX back to the deployer on Arbitrum, and about 10,000 ETH to a GMX
address on Ethereum. They kept 1,701 ETH.

I went looking for how often this happens and found it is close to a ritual. Curve, Metronome and Alchemix sent a
joint message in August 2023 with a deadline of 6 August, 08:00 UTC. Seneca asked for its funds back in February 2024
and offered 20%. KyberSwap offered 10% with a deadline of 6am UTC on 25 November 2023. UwU Lend offered 20% in June
2024. Some of those worked. Some got nothing, or a ransom note.

What struck me is how little of it is actually checkable. The offer is a string in calldata. The bounty is not locked
anywhere, so the person returning the money is trusting the people they just robbed to pay them. Nobody writes down
which addresses count, what "returned" means when the attacker swapped half of it into another token, or what happens
if 80% comes back instead of 90%. Afterwards, the "we got it all back" tweet is the only record most people see.

So I built WhiteFlag on GenLayer to make that whole exchange boring.

## What it does

A protocol that got hacked opens an offer and locks a bounty in GEN. The offer freezes everything that the messages
above leave vague: the exploiter addresses, the recovery addresses, the stolen tokens and amounts, a value weight for
each token, the public bounty share, the return window, and how long the exploiter has to claim. After that the
protocol can do exactly two things: push the deadline later, or add a recovery address. It can't cancel.

Then anyone can submit return proofs. These are just transaction hashes on Ethereum or Arbitrum. GenLayer's
validators each read the transaction, its receipt, its block header and the chain's finalized block from two
different RPC providers, and the two answers have to be identical before anything is believed. A transfer counts if
it was sent from a listed exploiter address, moved a listed token to a listed recovery address, sits in a finalized
block, and happened inside the window. The returned fraction is plain arithmetic over the weights. Settle, and the
bounty is split: the earned part waits for the exploiter to claim it (they can name a payout address in the same
call), and the rest goes back to the protocol in the same transaction. If nobody claims within the window, that goes
back too.

There's no model making a judgment call here, and that was deliberate. Every question in this flow has an exact answer
on a public chain. What GenLayer adds is that the answer is agreed by validators who each read it themselves, so a
contract can act on it.

## Real incidents, not examples

Before writing any contract code I wanted to know whether this could even be verified, so I collected six incidents
and read every relevant transaction from two RPCs per chain, once from my laptop and once from inside GenVM with a
throwaway contract. All 22 return transactions came back byte-identical both ways.

Those six are now offers on the canonical registry with their real addresses and amounts, and every real return was
submitted as a proof:

- GMX V1: 89.02% returned by the formula, across Arbitrum and Ethereum.
- The Alchemix alETH pool from the Curve/Vyper exploit: 100%. One alETH went to Curve's address instead of Alchemix's;
  it was rejected until the protocol added Curve's address, then counted. That's the "add a recovery address" power
  doing exactly what it's for.
- Seneca: 83.67%. The exploiter kept 300 ETH; a transfer that moved 150 ETH of it to a fresh wallet is on record,
  rejected as `NO_RETURN_TO_RECOVERY`.
- KyberSwap Elastic, Curve CRV/ETH and UwU Lend: nothing came back from the listed exploiters, so the whole bounty
  went back. I checked every outgoing transfer of those addresses, not only ours: the CRV/ETH exploiter still holds
  most of it, and the only returns in those incidents came from other people (an MEV bot that ran the same Curve
  exploit and handed it back, front-runners in KyberSwap's pools), which an offer for this exploiter rightly ignores
  ([REAL_WORLD_CHECK.md](REAL_WORLD_CHECK.md)).

A failed transaction from the Alchemix exploiter to the Alchemix multisig is in there too, rejected as `TX_FAILED`.
I like that one. It's a real attempt that didn't land, and the rule treats it as one.

## Things that bit me

The first on-chain trial rejected every single proof as unreadable. Each validator was hammering the same public RPC
at the same moment, and that provider refuses batches under that kind of load. I had to measure providers from inside
GenVM with all the validators reading at once, keep the ones that held up, and batch each submission's reads per RPC
instead of sending many small requests.

Studio also keeps the GEN sent with a call that fails. So the one payable method never fails: a refused offer credits
its GEN back to the sender, who can withdraw it.

Then I tried to break it myself. The worst thing I found was that proofs were counted once per registry rather than
once per offer. Anyone could have opened a cheap copycat offer with the same addresses and submitted the real return to
it first, and the real offer would have rejected it as already counted. Now it's once per offer. I also added a
finality grace after the deadline, because Arbitrum's finalized block can trail by up to an hour, and a return made
just before the deadline would otherwise never count.

## Is it useful

The narrow claim is this: if you're going to offer a whitehat bounty anyway, you can make it credible to the person
you're offering it to and auditable by everyone else, and it costs nothing extra if nothing comes back. A lending
market or an insurer can also ask a small gate contract whether an incident was actually settled, instead of trusting
a tweet. The gate answers "no" whenever it can't be sure.

It doesn't enforce the legal half of these offers. "No further legal action" is still a promise between people. What
WhiteFlag settles is the money part, and that part never needed to be a promise.

The code, the tests and the seeds are all public, and the site reads everything from chain:
https://whiteflag-ledger.vercel.app
