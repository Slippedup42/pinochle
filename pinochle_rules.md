# Partnership Pinochle — Rules Reference

This is the finalized rule set backing `pinochle_engine.py`. It corrects a
few errors found in the original spec and reflects the house-rule changes
made in this project (3-card pass, 1000/-1000 game thresholds).

## Players & Teams

- 4 players, fixed partnerships sitting across from each other.
- Player 0 & Player 2 = Team A. Player 1 & Player 3 = Team B.
- Seating order is clockwise; dealer rotates clockwise each round.

## The Deck

- 48 cards: two identical copies of **A, 10, K, Q, J, 9** in each of the
  4 suits (Spades, Diamonds, Clubs, Hearts).
- Each player is dealt 12 cards.

## Card Rank (highest to lowest)

```
Ace → 10 → King → Queen → Jack → 9
```

Note the 10 outranks the King — this is the one place Pinochle diverges
from standard card-game rank order.

## Phase 1: Bidding

- Opening bid: **250**. Minimum raise: **10**.
- Starting with the player left of the dealer, bidding rotates clockwise.
- On your turn: bid `current_bid + 10` (or more), or pass.
- Once you pass, you're out of the rotation for the rest of the auction.
- Bidding ends when 3 players have passed. The 4th is the **ContractWinner**.
- Edge case: if all 4 players pass without ever bidding, the dealer is
  forced to take the contract at the opening bid of 250.

## Phase 2: Trump & Passing

1. The ContractWinner declares the **TrumpSuit**.
2. The ContractWinner's partner passes **3 cards** to the ContractWinner.
3. The ContractWinner adds those to their hand, then passes **3 cards**
   back to their partner.
4. There is **no restriction** on which cards can be passed back — the
   ContractWinner may return any of their cards, including ones they
   just received. (An earlier draft of these rules incorrectly forbade
   this; it does not exist in standard Pinochle.)

## Phase 3: Melding

Meld is **not a player decision** — it's a pure scan of each hand once
trump is set. A card may count toward multiple *different* meld types
at once (e.g. a trump King is part of both a Run and a Royal Marriage),
but a single physical card can't be reused twice *within* the same
meld type — a second instance of a meld needs a second copy of the card.

### Class A — Trump & Marriage Melds

| Meld | Requirement | Points |
|---|---|---|
| Run | A, 10, K, Q, J of TrumpSuit | 150 |
| Royal Marriage | K + Q of TrumpSuit | 40 |
| Common Marriage | K + Q of a non-trump suit | 20 |
| Dix | 9 of TrumpSuit | 10 |

### Class B — Pinochle Melds

| Meld | Requirement | Points |
|---|---|---|
| Pinochle | Q♠ + J♦ | 40 |
| Double Pinochle | Both Q♠ + both J♦ | 300 |

Double Pinochle **replaces** two single Pinochles — it is not
2 × 40 = 80. If you hold both Queens of Spades and both Jacks of
Diamonds, you score 300, not 80.

### Class C — Around Melds

| Meld | Requirement | Points | Double (both copies, all 4 suits) |
|---|---|---|---|
| Aces Around | 1 Ace of each suit | 100 | 1000 |
| Kings Around | 1 King of each suit | 80 | 800 |
| Queens Around | 1 Queen of each suit | 60 | 600 |
| Jacks Around | 1 Jack of each suit | 40 | 400 |

Doubles **replace** the single value (10×), they don't stack on top of it.

## Phase 4: Trick-Taking

12 tricks are played, one card per player per trick. The ContractWinner
leads the first trick; the winner of each trick leads the next.

Legal-move rules, applied in order:

1. **Lead**: the first player may play any card. This sets the LeadSuit.
2. **Follow suit**: if you hold a card of LeadSuit, you must play one.
3. **Beat if possible**: if following suit, you must play a higher rank
   of LeadSuit than the current highest LeadSuit card on the table, if
   you're able to.
4. **Trump if void**: if you have no LeadSuit card, you must play a
   TrumpSuit card if you hold one.
5. **Beat trump if possible**: if playing trump because you couldn't
   follow suit, you must play a higher TrumpSuit card than any trump
   already on the table, if able.
6. **Sluff**: if you have neither LeadSuit nor TrumpSuit cards, you may
   play anything.

### Trick Resolution

- If any TrumpSuit card was played, the highest trump wins the trick.
- Otherwise, the highest card of the LeadSuit wins.
- Ties (the same physical rank/suit played twice, e.g. two Aces of
  Spades) go to whichever copy was played **first**.
- The trick winner collects all 4 cards and leads the next trick.

## Phase 5: Round Scoring

- Every **Ace, 10, and King** collected in tricks = 10 points each.
- Every **Queen, Jack, and 9** = 0 points.
- The team that wins the **12th (last) trick** gets a **+10 bonus**.
- Total trick points available per round: **250**.

### Contract Check

- Add each team's `meld_points + trick_points` for the round.
- If the bidding team's total is **less than** their bid, they score
  **−bid** for the round (they "go set").
- The defending team always scores their own meld + trick points,
  regardless of what happens to the bidding team.

## Game Win / Loss

- First team to reach **1000 points** (cumulative across rounds) wins,
  checked at the end of each round.
- If both teams cross 1000 in the same round, the **bidding team** wins
  the tie.
- If a team's cumulative score drops to **−1000 or lower**, the game
  ends immediately and the **other team wins**, regardless of that
  team's own score.

## Implementation Notes (for future chats picking this up)

- `pinochle_engine.py` implements all of the above end-to-end and has
  been tested (deal integrity, legal-move filtering, meld edge cases,
  bidding/passing card counts, and full multi-round games to a winner).
- `choose_bid`, `choose_trump`, `choose_pass_cards`, and `choose_card`
  on `Player` are currently **placeholder logic** (coin-flip bidding,
  most-cards-held trump choice, random passing, first-legal-move play).
  These are the seams where real strategy (or human input) gets added
  next — the rules engine itself doesn't need to change for that.
