# Fight Night Order Book

A two-outcome CLOB per bout: **fighter A** or **fighter B**, one book each side, one
contract for every card. This is the on-chain half of the Forge League — the other
half is the league itself, in `app/` and `worker/` one directory up.

Self-contained foundry project. `cd chain && forge test`, or `npm run chain:test`
from the repo root.

**Live on Robinhood testnet (chain 46630)**, collateral is the chain's USDC at
`0xAc80194dc1aE8eF52df73e7e1864fB3C62290fe0`:

| Contract | Address |
|---|---|
| `FightCardCLOB` | `0xB4968646ae84ceDA57144EfF2B6eeA7E6B36267A` |
| `FightCardReader` | `0x7a2e4b2Db2AB51E42ADeCD4d67276dF720A5DDA9` |
| `FightCardParlay` | `0xA627068bc6E7661Bfb9D5752A09AEBFD1951CB7F` |

Deployed in block 96,795,485 with a 1% taker fee. `deployments/robinhoodTestnet-fightcard.json`
is the machine-readable copy, and the same values are in the repo's `.env.example`.

| Contract | Runtime size | Role |
|---|---|---|
| `contracts/FightCardCLOB.sol` | 21,732 B | The market. Holds all collateral, all books, all settlement. |
| `contracts/FightCardReader.sol` | 10,115 B | Views only. Holds nothing, can move nothing — redeploy freely. |
| `contracts/FightCardParlay.sol` | 9,769 B | Parimutuel parlay card. Reads outcomes from the book, holds its own pot. |

---

## 1. The model

Collateral is one ERC-20, fixed at deploy (6–18 decimals; USDC-shaped is the intended
case). Prices are ticks of 1–99 cents against one collateral unit.

```
mint(bout, N)   →  N collateral in   →  N A-shares + N B-shares
burn(bout, N)   →  N A + N B back    →  N collateral out
redeem(bout)    →  1 winning share   →  1 collateral unit
```

Shares are internal balances, not ERC-20. Two ways an order fills:

1. **Direct** — a bid on A at P takes any ask on A at ≤ P.
2. **Complementary** — a bid on A at P pairs with a bid on B at exactly (100 − P).
   Together they fund a whole set, so the contract mints one and hands each party the
   side they asked for. This is what gives a fresh bout liquidity before anyone holds
   a single share.

Order types are GTC (rests), FOK (all or revert), FAK (fill what's there, drop the rest).
Every collateral outflow is pull-based: trades credit `pendingWithdrawal`, and the user
calls `withdraw()` when they want it.

### The invariant everything rests on

```
collateralPool[bout] == totalShares[bout][A] == totalShares[bout][B]
```

Collateral enters only on mint and leaves only on burn or redeem. Trading moves money
*between users* — buying A at 30¢ pays the seller, it does not touch the pool. So the
pool always covers every outstanding share, and this is what makes a void solvent no
matter how much has already been withdrawn. `FightCardReader.checkBoutInvariant()` is
the monitoring hook.

### Draws

The league reports `finish: "Draw"` with `winnerId: null`. That resolves the bout
**VOID**, and every share on both sides redeems for its pro-rata slice of the pool —
0.50 per share, funded exactly.

Worth being explicit in the UI: a void pays 0.50 per share, it does **not** refund what
you paid. Someone who bought A at 30¢ profits on a draw; someone who bought at 70¢
loses. Cost-basis refunds are impossible in any order book — the counterparty already
took the difference, and the contract never held it.

---

## 2. Operator runbook

One key, `operator`, drives the whole card. It is the only address that can book,
close, or resolve — it cannot touch anyone's funds.

| League event | Call |
|---|---|
| Tonight's card is drawn up | `createCard(cardId, fightersA[], fightersB[], latestCloseAt, voidAfter)` |
| Opening bell | `closeBout(boutId)` |
| Final bell, winner scored | `resolveBout(boutId, FIGHTER_A \| FIGHTER_B)` |
| Final bell, draw | `resolveBout(boutId, VOID)` |

### The league books its own card

Nothing above has to be run by hand. `../worker/market-operator.ts` does all of it, from
inside the league's own tick and behind the same simulation lease that gates the expensive half of it:

| League event | What the worker sends |
|---|---|
| A night is drawn up (18 bouts, 6h before the first bell) | one `createCard` |
| A bout is booked and its book is untouched | two `placeBuyOrder`s at the opening line |
| Each opening bell | `closeBouts` |
| Each result, once committed | `resolveBouts` |
| A settled bout still holding the operator's money | `cancelOrder`, `redeemMany`, `withdraw` |

It is idempotent by construction: it reads the chain, diffs it against the card, and
sends only what is missing — so a pass that loses a race or dies halfway costs a tick
and nothing else. It swallows every failure, because a chain that is down must not be
able to stop the league from fighting.

No mapping table anywhere. The card is booked with the league's own identifiers — night
number as `cardId`, athlete ids as the two `bytes32` fighters — so "which bout is which"
can be read back off the contract instead of stored twice. A second copy of that fact
is a second thing that can be wrong, and when it is wrong it closes betting on the
wrong fight.

It needs `FIGHT_OPERATOR_KEY` as a Wrangler secret. Its absence is what makes the whole
module a no-op, which is the default.

### The opening line

A fresh book quotes nothing, and a market that quotes nothing reads as 50/50 on a fight
that is plainly not even. The first person to notice takes the second person's money,
which is not price discovery — it is a toll for arriving late. So the league quotes
first.

`../app/opening-line.ts` prices a matchup from what the card already knows: a weighted stat
line (reaction and defense lead, cardio trails), the record shrunk toward even by a
four-fight prior, reach and weight, age against a prime of 28, and how many fights the
policy has learned from. The difference between the two corners goes through a logistic
whose scale is set from the roster rather than from taste — the widest gap two men in a
division actually have is about thirteen points, and that fight should open near 70/30
rather than pinned at a clamp. Lines are held inside 25–75.

The worker then puts that line on the book as **bids on both corners**, at the line less
`FIGHT_SEED_SPREAD` (2¢ by default), `FIGHT_SEED_SHARES` deep (25) — so about 24 units of
collateral per bout, 430 for a full card. Bids only, and that is enough for two-way
trading: a buy of A at 63¢ matches a resting bid on B at 37¢ and mints the set between
them, so one pair of bids lets people buy *either* fighter as well as sell one, with no
shares held up front and no minting by the league. The two prices deliberately sum to
less than a whole unit; at exactly 100 they would match each other on the way in and the
league would have bought both sides of its own fight and paid the taker fee for it.

Set `FIGHT_SEED_SHARES=0` to turn quoting off entirely. The site still shows the line —
it computes the same number in the browser — but the book starts empty.

Because that quoting money is parked rather than spent, the worker also has to get it
back: a resting bid holds collateral until it is cancelled, and a filled one becomes
shares that pay only when somebody redeems. Each pass reclaims a little from bouts that
have been scored. Without it the operator quotes exactly one card and is then broke,
with every unit of it sitting in books on fights that finished days ago.

### Why the bell is a call and not a timestamp

The league runs on its own broadcast clock, which an admin can pause or fast-forward
(`../app/broadcast.ts`). A bout's real start time is therefore not
knowable when the card is booked, so betting closes on an operator call.

Two wall-clock backstops sit behind it so nothing can hang forever:

- **`latestCloseAt`** — trading stops here regardless, and anyone may call `closeBout`.
  Set it generously past the slot's expected airtime, since a paused clock stretches
  real time. If it fires early the market simply freezes early; nobody loses money.
- **`voidAfter`** — past this, anyone may call `forceVoid(boutId)` and every share
  redeems pro-rata. This is the safety valve if the operator key goes dark.

### When a fight is over

`resolveBout` closes the bout itself, so scoring does not wait on a close landing first:
a fight whose verdict is on screen is payable in the same pass that put it there. The
worker resolves on `airtimeEnd` — the moment the result becomes public — and only on a
*committed* result. Bouts are simulated ahead of their slot, and paying out on a fight
the audience has not been shown yet is how you leak the card.

From that point the fight prints at **99/1** rather than at whatever mid it was showing
when the bell went. `_freezeBook` has already cleared both sides, so reading the book
would otherwise hand back the last trade before the stoppage — a fight that ended in
round one still quoted 58/42. Not 100/0: the book only ever quoted 1–99, so 99 keeps the
settled price on the same scale as every price before it. A draw is a void and prints 50.

### Mapping league bouts to on-chain bouts

The contract assigns its own sequential `boutId` and emits it in `BoutCreated`; store
the league `ScheduledBout.id → boutId` mapping in Supabase alongside the rest of the
card. Fighter ids are `bytes32` — the league's athlete id, left-aligned
(`ethers.encodeBytes32String(athleteId)` for ids up to 31 chars). Names live off-chain;
the chain only needs something stable to identify who's who.

### Cleanup after a card

Orders that never filled still hold collateral when a bout resolves. Anyone can call
`sweepLevel(bout, side, price, isBid)` to refund a whole price level back to its
owners, and any trader can call `cancelMyOrders(startIdx, maxBatch)`. Neither can take
funds anywhere except back to the order's owner.

---

## 3. Deploying on Robinhood Chain

Robinhood Chain is an Arbitrum Orbit L2 — standard EVM, with the constraints that come
with the stack. What that dictated here:

- **EIP-170 is enforced.** Orbit chains hold the 24KB code cap. This is why the views
  live in a separate reader contract: `FightCardCLOB` lands at 21,622 B with ~3KB to
  spare. Note the existing `CLOBMarket.sol` (26,233 B) and `MultiOutcomeCLOB.sol`
  (24,289 B) are at or over that line and would not deploy here — `scripts/_redeploy_clob_singleton.js`
  gets away with it on Base today.
- **No `block.number`.** On Arbitrum it approximates the *L1* block, not the L2 one.
  Every deadline in this contract is `block.timestamp`.
- **`evm_version = "paris"`** (already the repo default) — no reliance on PUSH0,
  TSTORE, MCOPY or blob opcodes.
- **Calldata is the expensive part**, since it gets posted to L1. Hence the batch
  entry points: `createCard`, `closeBouts`, `resolveBouts`, `redeemMany`.
- **No native-token paths.** The contract never holds or moves ETH, so it doesn't
  matter what the chain uses for gas.

### Steps

The deployer needs **gas and nothing else** — no collateral. The token is a
constructor argument, so the book can be brought up against a stablecoin the deployer
has never held. Only trading and the opening quote need the token itself.

```bash
cd chain && DEPLOYER_PRIVATE_KEY=0x... \
  COLLATERAL_TOKEN=0xAc80194dc1aE8eF52df73e7e1864fB3C62290fe0 \
  FIGHT_TAKER_FEE_BPS=100 \
  DEPLOY_NETWORK=robinhoodTestnet \
  forge script script/DeployFightCard.s.sol:DeployFightCard \
    --rpc-url https://rpc.testnet.chain.robinhood.com/rpc --broadcast --slow
```

Leave `COLLATERAL_TOKEN` unset and the script deploys `TestUSD` instead — a faucet
ERC-20 with a 10,000-unit `drip()` on a four-hour cooldown — which is what you want on
a chain with no stablecoin to point at. `FIGHT_OPERATOR` and `FIGHT_FEE_RECIPIENT`
both default to the deployer, so a testnet deploy is one key and no setup.

It writes `deployments/<network>-fightcard.json`, including the `startBlock` the
league's event index starts reading from (`FIGHT_START_BLOCK`). Copy those addresses into the league's
`FIGHT_*` environment (see the repo root `.env.example`).

The whole run costs about **0.00025 ETH**.

---

## 4. Fees and roles

| Role | Set by | Can do |
|---|---|---|
| `owner` | deployer | Rotate the operator, set the fee and fee recipient. Cannot touch user funds or resolve. |
| `operator` | owner | Book, close and resolve bouts. Cannot touch user funds. |
| `feeRecipient` | owner | Claim accrued fees. |

One fee: a taker fee, charged on fill notional, capped at 1% — which is also what it
is set to. Only the aggressor ever pays it. Makers pay nothing, always receive the
full price of their resting order, and keep a share of the fee on top.

```
taker pays 1%  →  75% platform (accFees)  →  claimFees()
               →  25% maker    (MAKER_REBATE_BPS)  →  pendingWithdrawal, per fill
```

`MAKER_REBATE_BPS` is a constant, not a setting. A rebate somebody quoted a market on
should not be something the owner can move out from under them mid-card. The rebate is
what pays anyone to put the first orders up on a book that starts empty — which every
book here does, eighteen times a night.

Both destinations already sit inside `totalObligations()`, so the split changes who is
owed and never how much: the solvency invariant is untouched by construction, and
`test_RebateAndPlatformShareAddUpToTheFee` pins it.

Self-trading is not special-cased and does not need to be. Taking your own resting
order pays 1% and returns a quarter of it — a net loss of 0.75%, so there is nothing
to farm. Changing the fee never affects an order already on the book.

---

## 5. The parlay card

`contracts/FightCardParlay.sol` (9,769 B) sits beside the book. It reads bout outcomes
from the CLOB and never writes to it, holds its own pot, and cannot touch order-book
collateral.

### Why it isn't a priced parlay

A parlay is a bet on a conjunction, and the per-bout books have no counterparty for a
conjunction — nobody in them is selling "A takes fight 3 AND B takes fight 7". The two
alternatives both fail here:

- **Combinatorial market** (the textbook answer): 2^legs outcomes, and a separate book
  for every *set* of fights. Three legs out of an eighteen-fight card is 816 books.
  Liquidity goes to zero in all of them.
- **House-banked vault**: needs LP capital, and pricing off these books is exploitable
  while they're thin — shove a market to 5¢, buy a 20× parlay, let it revert. If you
  ever want this, price it off the simulator with operator-signed EIP-712 quotes, not
  off the books.

A pot needs no pricing at all. Crowded picks pay less, contrarian picks pay more, and
the payout is bounded by what was actually staked — so the contract cannot go insolvent
regardless of results. `testFuzz_NeverPaysMoreThanThePot` is the proof.

### Tickets and payout

A ticket is a bitmask over the card's legs: bit *i* clear = fighter A of leg *i*, set =
fighter B. Legs are capped at 8, so the combo space is at most 256 and settlement
enumerates all of it in one pass — which is what keeps each claim O(1) and the contract
small.

```
payout = stake × (pot − rake) ÷ total staked on your combo
```

Perfect tickets take 80% of the payable pot; the best imperfect tier splits the other
20%, so no night is dead. If nobody is perfect the best tier present takes everything.
If *only* one combo was backed, everyone is perfect together and the pot comes back
whole — which is also why a lone bettor always gets their stake back.

### What the bettor sees before committing

`quote(parlayId, combo, amount)` returns the exact figure, not an estimate — it accounts
for the 80/20 split by checking whether any other combo is backed. It moves while
betting is open (money on other combos raises it, crowding lowers it) and is **final at
close**, which happens at the first leg's opening bell. So a bettor knows their exact
payout before any fight in the parlay is contested. `comboStakes()` returns the whole
board for rendering.

### Seeding the pot

A parimutuel payout is capped by participation, not by how hard the picks were, so a
quiet night pays badly however good the calls. `seedPot()` adds operator money that
isn't a ticket and is won by whoever settles best. It shows up in `quote` immediately,
so early bettors see a real number. It isn't raked, and `reclaimSeed()` returns it if
the card refunds or nobody turns up. The cost is bounded and known up front — that's the
whole difference between this and backing parlays off a vault.

### Draws

A drawn leg resolves VOID in the CLOB and then counts as a hit for *every* ticket,
shortening the parlay rather than killing it, the way a sportsbook drops a voided leg.
A card where every leg draws returns every stake.

### Operator runbook

| League event | Call |
|---|---|
| Nominate tonight's parlay legs | `createParlay(cardId, boutIds[], closesAt, refundAfter, rakeBps)` |
| Guarantee a pot (optional) | `seedPot(parlayId, amount)` |
| First leg's opening bell | `closeParlay(parlayId)` |
| Every leg resolved | `settleParlay(parlayId)` — permissionless, anyone can call |

Legs must already exist in the CLOB and must not have started. Rake is capped at 5% and
is charged on stakes only. `refundAfter` is the backstop: past it, anyone can call
`refundParlay` and every ticket takes back exactly what it staked, with no rake.

---

## 6. Monitoring

| Check | Query | Severity if it breaks |
|---|---|---|
| Solvency | `FightCardReader.getSolvencyInfo().solvent` | P0 — halt the frontend |
| Share conservation | `FightCardReader.checkBoutInvariant(bout)` | P0 — accounting bug |
| Stale bout | `voidAfter` passed and `!resolved` | P2 — call `forceVoid` |
| Level depth | `levelLive(bout, side, price, isBid)` near 500 | P1 — level cap, orders will be rejected |

---

## 7. Known limits

- **`MAX_FILLS_PER_ORDER = 50`** bounds the matching loop. A very large order against
  a very fragmented book fills 50 makers and rests or drops the rest; a crossed book
  can briefly survive that. The next order clears it.
- **`MAX_ORDERS_PER_LEVEL = 500`**, `MAX_ORDERS_PER_USER = 500` active.
- **Order sizes must be a multiple of 100 base units**, so `shares × price / 100` is
  always exact and a complementary match funds a set to the wei.
- **Fee-on-transfer collateral is rejected** at deposit — it would break every payout
  invariant.
- **Losing shares are left in place** after settlement rather than zeroed. They're
  worth nothing; the balance is the record of the position.
- **The operator is trusted for the outcome.** There's no oracle here — resolution is
  the league reporting its own result, which is the honest trust model for a league
  that also runs the fights. `forceVoid` is what bounds that trust: the operator can
  report a wrong winner, but cannot lock funds up by staying silent.
