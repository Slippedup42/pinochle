"""
Tests for the Run/Royal-Marriage rule, in both the scorer and the Base Bid
valuation. Plain assert-based, pytest-discoverable.

The rule, ruled by Paul on 2026-08-31 (#273):

    A meld scores on top of a Run only if it requires at least one card the
    Run does not use.

The Royal Marriage is the unique meld that fails that test - you must hold
the trump K and Q to have a Run at all, so the Run absorbs them. A Pinochle
needs the Q(S) or the J(D), one of which is always outside the run; an Around
needs three cards in other suits; the Dix needs the trump 9, which is never
in a run. So a bare trump Run scores **150, not 190**, a Run plus a spare
trump K+Q scores 190, and a Double Run - which uses both copies of both
cards - scores 1500 flat with no marriage left over.

This file began life as #242's, which moved the valuation to pay both on the
grounds that `score_melds` paid both. The disagreement it found was real and
it resolved it in the wrong direction; the scorer was the wrong side to
believe. What survives unchanged is the *shape* - what is pinned is agreement
between `compute_base_bid` and `score_melds`, not either number alone, because
the original defect was one judgement made twice and never checked against the
other. The two now agree on a different total.

The near-run branch is deliberately excluded and its current behaviour is
asserted as-is. `NEAR_RUN_VALUE` is a guess at a run that is not in the hand,
and #268 confirmed the extra-marriage-only rule on that branch was right the
whole time.
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
    compute_trick_potential,
    score_melds,
)


TRUMP = Suit.HEARTS

# The Base Bid lines that describe meld actually held. Only the two "near"
# lines are speculative, and every hand below is built to hold neither, which
# is what lets the remaining lines be compared to the scorer. #277 took the
# flat Ace value and the 3-different-Aces bonus out of `compute_base_bid`
# entirely - the first to `compute_trick_potential`, the second deleted - so
# this list is now the whole of the breakdown on these hands rather than a
# filtered subset of it.
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


def test_a_bare_run_scores_150_and_not_190():
    """The rule: the Run consumes the trump K and Q it needs to exist, so the
    Royal Marriage inside it is not a second meld. Scorer and valuation both."""
    melded, meld_breakdown = score_melds(BARE_RUN, TRUMP)
    assert meld_breakdown["Run"] == 150
    assert "Royal Marriage" not in meld_breakdown
    assert melded == 150

    total, breakdown, _pool = compute_base_bid(BARE_RUN, TRUMP)
    assert breakdown["Run/near-run"] == 150
    assert "Royal Marriage" not in breakdown
    # The run and nothing else. 210 between #242 and #273, then 170 while the
    # trump Ace's flat 20 was still a Base Bid line; #277 moved that 20 out to
    # `compute_trick_potential`, where the same card is now worth 40 - the flat
    # Ace plus the Ace-of-trump line - and the Base Bid is the meld alone.
    assert total == 150
    trick_total, trick_breakdown = compute_trick_potential(BARE_RUN, TRUMP)
    assert trick_breakdown["Aces (flat, 20/ea)"] == 20
    assert trick_breakdown["Ace of trump"] == 20
    assert trick_total == 20 + 20 + 20  # + one trump card past the fourth


def test_a_run_and_a_spare_king_queen_score_190():
    """The rule: a *second* K+Q needs a second King and a second Queen, which
    the Run has not used, so it does pay - one marriage, not two."""
    melded, meld_breakdown = score_melds(RUN_PLUS_SECOND_MARRIAGE, TRUMP)
    assert meld_breakdown["Run"] == 150
    assert meld_breakdown["Royal Marriage"] == ROYAL_MARRIAGE_VALUE
    assert melded == 190

    _total, breakdown, _pool = compute_base_bid(RUN_PLUS_SECOND_MARRIAGE, TRUMP)
    assert breakdown["Run/near-run"] == 150
    assert breakdown["Royal Marriage"] == ROYAL_MARRIAGE_VALUE


def test_a_double_run_scores_1500_with_no_marriage_left_over():
    """The rule, worked out to its end: a Double Run uses both copies of the
    trump King and both of the Queen, so there is no K+Q pair outside it and
    no Royal Marriage to pay. 1500 flat - not 1540, and not #242's 1580."""
    melded, meld_breakdown = score_melds(DOUBLE_RUN, TRUMP)
    assert meld_breakdown["Double Run"] == 1500
    assert "Royal Marriage" not in meld_breakdown
    assert melded == 1500

    _total, breakdown, _pool = compute_base_bid(DOUBLE_RUN, TRUMP)
    assert breakdown["Run/near-run"] == 1500
    assert "Royal Marriage" not in breakdown


def test_the_valuation_pays_what_the_scorer_pays():
    """The invariant, not the numbers: these hands hold no speculative meld, so
    the meld lines of the Base Bid and `score_melds` are describing the same
    cards and must agree card for card."""
    for hand, expected in (
        (BARE_RUN, 150),
        (RUN_PLUS_SECOND_MARRIAGE, 150 + 40),
        (DOUBLE_RUN, 1500),
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
    rng = random.Random(0x242)  # the seed #242 chose; kept so the sweep is the same one
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
    """The rule applied to a run that is not there yet, recorded so the
    behaviour is deliberate rather than merely surviving. Four run ranks plus a
    second King and Queen: the valuation credits NEAR_RUN_VALUE and one
    marriage, because the run it is imagining would consume the other pair,
    while the scorer pays two marriages and no run, because no run is held.
    They disagree on purpose - one is speculative and one is not - and #268
    ruled this branch correct as it stands."""
    hand = [Card(TRUMP, rank, 1) for rank in RUN_RANKS if rank != "A"] + [
        Card(TRUMP, "K", 2),
        Card(TRUMP, "Q", 2),
    ]
    _total, breakdown, _pool = compute_base_bid(hand, TRUMP)
    assert breakdown["Run/near-run"] == NEAR_RUN_VALUE
    assert breakdown["Royal Marriage"] == ROYAL_MARRIAGE_VALUE

    melded, _meld_breakdown = score_melds(hand, TRUMP)
    assert melded == 2 * ROYAL_MARRIAGE_VALUE
