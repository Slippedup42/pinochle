"""
Tests for issue #242 - the Base Bid valuation must not price a trump Run as
absorbing the Royal Marriage. Plain assert-based, pytest-discoverable.

`pinochle_rules.md` states the rule the scorers already follow:

    A card may count toward multiple *different* meld types at once (e.g. a
    trump King is part of both a Run and a Royal Marriage)

`score_melds` pays both. `compute_base_bid` did not, so the AI's own valuation
of every hand holding a run was 40 points under the meld that hand is certain
to score - and 0.42% of dealt hands declined to open for no reason but that.

What is pinned here is *agreement between the two functions*, not the new
number on its own. The defect was one judgement made twice, in the valuation
and never in the scorer, and a test that only recorded the corrected total
would let them drift apart again without saying so.

The near-run branch is deliberately excluded and its current behaviour is
asserted as-is. `NEAR_RUN_VALUE` is a guess at a run that is not in the hand,
so whether it already prices in the marriage that *is* there is a separate
question from this one, on a separate call site.
"""

import random

from pinochle_engine import (
    Card,
    Deck,
    NEAR_RUN_VALUE,
    ROYAL_MARRIAGE_VALUE,
    RUN_RANKS,
    Suit,
    compute_base_bid,
    score_melds,
)


TRUMP = Suit.HEARTS

# The Base Bid lines that describe meld actually held. The flat Ace value and
# the 3-different-Aces bonus are trick-taking estimates rather than meld, and
# the two "near" lines are speculative - so every hand below is built to hold
# neither, which is what lets the remaining lines be compared to the scorer.
MELD_LINES = (
    "Run/near-run",
    "Royal Marriage",
    "Common Marriage",
    "Dix",
    "Pinochle/near-double",
    "Arounds",
)


def meld_portion(breakdown):
    return sum(breakdown.get(key, 0) for key in MELD_LINES)


def _run(copy_id=1):
    return [Card(TRUMP, rank, copy_id) for rank in RUN_RANKS]


BARE_RUN = _run()
RUN_PLUS_SECOND_MARRIAGE = _run() + [Card(TRUMP, "K", 2), Card(TRUMP, "Q", 2)]
DOUBLE_RUN = _run(1) + _run(2)


def test_a_bare_run_is_valued_at_the_run_and_its_royal_marriage():
    total, breakdown, _pool = compute_base_bid(BARE_RUN, TRUMP)
    assert breakdown["Run/near-run"] == 150
    assert breakdown["Royal Marriage"] == ROYAL_MARRIAGE_VALUE
    # 150 + 40 + the trump Ace's flat 20. This read 170 before #242.
    assert total == 210


def test_a_run_and_a_spare_king_queen_are_two_royal_marriages():
    _total, breakdown, _pool = compute_base_bid(RUN_PLUS_SECOND_MARRIAGE, TRUMP)
    assert breakdown["Run/near-run"] == 150
    assert breakdown["Royal Marriage"] == 2 * ROYAL_MARRIAGE_VALUE


def test_the_valuation_pays_what_the_scorer_pays():
    """The invariant, not the numbers: these hands hold no speculative meld, so
    the meld lines of the Base Bid and `score_melds` are describing the same
    cards and must agree card for card."""
    for hand, expected in (
        (BARE_RUN, 150 + 40),
        (RUN_PLUS_SECOND_MARRIAGE, 150 + 80),
        (DOUBLE_RUN, 1500 + 80),
    ):
        _total, breakdown, _pool = compute_base_bid(hand, TRUMP)
        melded, _meld_breakdown = score_melds(hand, TRUMP)
        assert meld_portion(breakdown) == melded
        assert melded == expected


def test_every_dealt_hand_holding_a_run_agrees_about_the_royal_marriage():
    """The curated hands above are shapes someone chose; this is the same claim
    made against hands nobody chose. A run is rare (about 3.8% of hands at their
    own best trump), so this deals enough to hit the case a few dozen times
    rather than relying on a lucky seed."""
    rng = random.Random(0x242)
    seen_runs = 0
    for _ in range(400):
        deck = Deck()
        deck.shuffle(rng)
        for start in range(0, 48, 12):
            hand = deck.cards[start:start + 12]
            for trump in Suit:
                counts = [sum(1 for c in hand if c.suit == trump and c.rank == r)
                          for r in RUN_RANKS]
                if min(counts) < 1:
                    continue  # no run held; the near-run branch is out of scope
                seen_runs += 1
                _total, breakdown, _pool = compute_base_bid(hand, trump)
                _melded, meld_breakdown = score_melds(hand, trump)
                assert breakdown.get("Royal Marriage", 0) == meld_breakdown.get(
                    "Royal Marriage", 0
                )
    assert seen_runs > 20, f"only {seen_runs} run hands dealt - the sweep proved little"


def test_the_near_run_branch_is_left_where_it_was():
    """Out of #242's scope by decision, recorded here so its behaviour is
    deliberate rather than merely surviving. Four run ranks plus a second King
    and Queen: the valuation credits NEAR_RUN_VALUE and one marriage, while the
    scorer pays two marriages and no run. They disagree, and that disagreement
    is a live question about how the layered valuation splits certain meld from
    speculative - not the same bug this file fixes."""
    hand = [Card(TRUMP, rank, 1) for rank in RUN_RANKS if rank != "A"] + [
        Card(TRUMP, "K", 2),
        Card(TRUMP, "Q", 2),
    ]
    _total, breakdown, _pool = compute_base_bid(hand, TRUMP)
    assert breakdown["Run/near-run"] == NEAR_RUN_VALUE
    assert breakdown["Royal Marriage"] == ROYAL_MARRIAGE_VALUE

    melded, _meld_breakdown = score_melds(hand, TRUMP)
    assert melded == 2 * ROYAL_MARRIAGE_VALUE
