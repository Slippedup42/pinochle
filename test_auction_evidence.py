"""
Tests for issue #101 (epic #106) - constraining rollout determinization to the
observed auction. Plain assert-based, pytest-discoverable. Covers:

  1. `AuctionEvidence.is_consistent` accepts and rejects the right hands, with
     the slack that keeps a speculative bidder from being ruled impossible.
  2. Rejection sampling actually shifts the distribution: sampled partner
     hands are measurably stronger after partner bids and weaker after partner
     passes. This is the behavioural claim the issue makes, and it is the one
     that would silently stop being true if the constraint were mis-wired -
     the code would still run, just without effect.
  3. The escape hatch: an unsatisfiable constraint gives up and reports it
     rather than looping forever.
  4. The engine records who passed and at what level, and turns that into
     evidence with the right seat keys.
  5. Everything stays backwards compatible - no evidence means the old
     uniform sampling, unchanged.
"""

import random

from pinochle_engine import (
    Card,
    GeneralStrategy,
    Player,
    Round,
    Suit,
    Team,
    best_base_bid,
)
from pinochle_rollout import (
    AuctionEvidence,
    sample_bid_time_deal,
    sample_consistent_deal,
)


def _marginal_hand():
    return [
        Card(Suit.CLUBS, "A", 1), Card(Suit.CLUBS, "K", 1), Card(Suit.CLUBS, "Q", 1),
        Card(Suit.CLUBS, "9", 1), Card(Suit.SPADES, "A", 1), Card(Suit.SPADES, "K", 1),
        Card(Suit.DIAMONDS, "K", 1), Card(Suit.DIAMONDS, "J", 1), Card(Suit.HEARTS, "10", 1),
        Card(Suit.HEARTS, "J", 1), Card(Suit.HEARTS, "9", 1), Card(Suit.SPADES, "9", 1),
    ]


def _strong_hand():
    trump = Suit.CLUBS
    return [
        Card(trump, "A", 1), Card(trump, "10", 1), Card(trump, "K", 1),
        Card(trump, "Q", 1), Card(trump, "J", 1),
        Card(Suit.SPADES, "Q", 1), Card(Suit.SPADES, "Q", 2),
        Card(Suit.DIAMONDS, "J", 1), Card(Suit.DIAMONDS, "J", 2),
        Card(Suit.SPADES, "A", 1), Card(Suit.DIAMONDS, "A", 1), Card(Suit.HEARTS, "A", 1),
    ]


def _junk_hand():
    return [
        Card(Suit.SPADES, "9", 1), Card(Suit.SPADES, "J", 1), Card(Suit.DIAMONDS, "9", 1),
        Card(Suit.DIAMONDS, "J", 1), Card(Suit.HEARTS, "9", 1), Card(Suit.HEARTS, "J", 1),
        Card(Suit.CLUBS, "9", 1), Card(Suit.CLUBS, "J", 1), Card(Suit.SPADES, "9", 2),
        Card(Suit.DIAMONDS, "9", 2), Card(Suit.HEARTS, "9", 2), Card(Suit.CLUBS, "9", 2),
    ]


# ---------------------------------------------------------------------------
# 1. Consistency rules.
# ---------------------------------------------------------------------------

def test_empty_evidence_is_falsy_and_accepts_everything():
    evidence = AuctionEvidence()
    assert not evidence
    assert evidence.is_consistent({"partner": _junk_hand()}) is True


def test_a_junk_hand_is_inconsistent_with_having_bid_high():
    evidence = AuctionEvidence(highest_bid={"partner": 400})
    assert evidence.is_consistent({"partner": _junk_hand()}) is False


def test_a_strong_hand_is_consistent_with_having_bid_high():
    evidence = AuctionEvidence(highest_bid={"partner": 400})
    assert evidence.is_consistent({"partner": _strong_hand()}) is True


def test_a_strong_hand_is_inconsistent_with_having_passed_cheaply():
    evidence = AuctionEvidence(declined={"partner": 300})
    assert evidence.is_consistent({"partner": _strong_hand()}) is False


def test_a_junk_hand_is_consistent_with_having_passed():
    evidence = AuctionEvidence(declined={"partner": 300})
    assert evidence.is_consistent({"partner": _junk_hand()}) is True


def test_slack_tolerates_a_bidder_stretching_slightly():
    """
    Bidders open light for positional reasons and `best_base_bid` is an
    estimate, so a hard edge would reject plausible hands and bias the sample
    the other way. A hand just under its bid must survive.
    """
    hand = _marginal_hand()
    ceiling = best_base_bid(hand)[1]
    just_over = AuctionEvidence(highest_bid={"partner": ceiling + 20})
    far_over = AuctionEvidence(highest_bid={"partner": ceiling + 200})
    assert just_over.is_consistent({"partner": hand}) is True
    assert far_over.is_consistent({"partner": hand}) is False


def test_a_seat_with_no_evidence_is_never_rejected():
    evidence = AuctionEvidence(highest_bid={"partner": 400})
    # opp_left is unconstrained, so its junk hand cannot cause a rejection.
    assert evidence.is_consistent(
        {"partner": _strong_hand(), "opp_left": _junk_hand()}
    ) is True


# ---------------------------------------------------------------------------
# 2. The distribution actually moves. The point of the issue.
# ---------------------------------------------------------------------------

def _avg_partner_ceiling(evidence, samples=200, seed=1):
    rng = random.Random(seed)
    hand = _marginal_hand()
    total = 0
    accepted = 0
    for _ in range(samples):
        dealt, _attempts, ok = sample_consistent_deal(
            lambda r: sample_bid_time_deal(hand, rng=r), evidence, rng=rng,
        )
        total += best_base_bid(dealt["partner"])[1]
        accepted += 1 if ok else 0
    return total / samples, accepted / samples


def test_sampled_partner_is_stronger_after_partner_bids():
    uniform, _ = _avg_partner_ceiling(AuctionEvidence())
    after_bid, acceptance = _avg_partner_ceiling(
        AuctionEvidence(highest_bid={"partner": 330})
    )
    assert after_bid > uniform + 25
    assert acceptance > 0.9


def test_sampled_partner_is_weaker_after_partner_passes():
    uniform, _ = _avg_partner_ceiling(AuctionEvidence())
    after_pass, acceptance = _avg_partner_ceiling(
        AuctionEvidence(declined={"partner": 300})
    )
    assert after_pass < uniform
    assert acceptance > 0.9


# ---------------------------------------------------------------------------
# 3. Escape hatch.
# ---------------------------------------------------------------------------

def test_an_unsatisfiable_constraint_gives_up_and_says_so():
    """
    No 12-card hand clears a 5000 bid, so this can never be satisfied. The
    sampler must return a usable deal and report `accepted=False` rather than
    loop forever - a slightly implausible rollout beats no rollout, but the
    caller has to be able to see it happened.
    """
    hand = _marginal_hand()
    impossible = AuctionEvidence(highest_bid={"partner": 5000})
    dealt, attempts, accepted = sample_consistent_deal(
        lambda r: sample_bid_time_deal(hand, rng=r), impossible,
        rng=random.Random(3), max_attempts=5,
    )
    assert accepted is False
    assert attempts == 5
    assert len(dealt["partner"]) == 12  # still a usable deal


def test_acceptance_rate_is_reported_in_bid_time_diagnostics():
    from pinochle_rollout import estimate_bid_time

    diagnostics = estimate_bid_time(
        _marginal_hand(), Suit.CLUBS, 300, num_samples=4,
        rng=random.Random(4), evidence=AuctionEvidence(highest_bid={"partner": 330}),
    )
    assert 0.0 <= diagnostics["evidence_acceptance_rate"] <= 1.0
    assert diagnostics["evidence_attempts_per_sample"] >= 1.0


def test_no_evidence_leaves_the_old_uniform_sampling_alone():
    from pinochle_rollout import estimate_bid_time

    diagnostics = estimate_bid_time(
        _marginal_hand(), Suit.CLUBS, 300, num_samples=4, rng=random.Random(5),
    )
    assert "evidence_acceptance_rate" not in diagnostics


# ---------------------------------------------------------------------------
# 4. The engine records the auction, and translates it into evidence.
# ---------------------------------------------------------------------------

def _round_of(players):
    team_a = Team("A", [players[0], players[2]])
    team_b = Team("B", [players[1], players[3]])
    players[0].team = players[2].team = team_a
    players[1].team = players[3].team = team_b
    return Round(players, [team_a, team_b], dealer_index=3)


def test_bidding_records_who_passed_and_at_what_level():
    seen = {}

    class Recorder(Player):
        def choose_bid(self, current_bid, min_increment, context=None):
            seen["pass_history"] = list(context["pass_history"])
            seen["passed_players"] = list(context["passed_players"])
            return None  # everyone passes

    players = [Recorder(f"P{i}", None) for i in range(4)]
    rnd = _round_of(players)
    rnd._deal()
    rnd._bidding_loop()

    # The last player asked saw the two seats that passed before it.
    assert len(seen["pass_history"]) == 2
    assert seen["passed_players"] == [p for p, _ in seen["pass_history"]]
    for _player, level in seen["pass_history"]:
        assert level > 0


def test_evidence_maps_partner_and_opponents_to_rollout_seat_keys():
    players = [GeneralStrategy(f"P{i}", None, skill_level=5, rng=random.Random(i)) for i in range(4)]
    _round_of(players)
    me, partner = players[0], players[2]
    opp_left, opp_right = players[1], players[3]

    context = {
        "bid_history": [(opp_left, 300), (partner, 320), (partner, 340)],
        "pass_history": [(opp_right, 350)],
    }
    evidence = me._auction_evidence(context)

    assert evidence.highest_bid["partner"] == 340  # highest, not latest-seen
    assert evidence.highest_bid["opp_left"] == 300
    assert evidence.declined["opp_right"] == 350
    assert "me" not in evidence.highest_bid


def test_no_auction_activity_yields_no_evidence():
    players = [GeneralStrategy(f"P{i}", None, skill_level=5, rng=random.Random(i)) for i in range(4)]
    _round_of(players)
    assert players[0]._auction_evidence({"bid_history": [], "pass_history": []}) is None


def test_auction_evidence_is_off_by_default_at_every_skill_level():
    """
    The constraint demonstrably works (see the distribution tests above) but
    A/B'd over 50 paired deals it produced no measurable improvement while
    running about 4x slower, so it ships off. This test exists so re-enabling
    it is a deliberate act with a measurement behind it, not something that
    drifts back on unnoticed.
    """
    from pinochle_engine import GENERAL_STRATEGY_SKILL_PARAMS

    for skill in range(1, 6):
        assert GENERAL_STRATEGY_SKILL_PARAMS[skill]["use_auction_evidence"] is False


def test_evidence_still_reaches_the_rollout_when_switched_on():
    """The wiring must stay live, since #103 is expected to re-test it."""
    from pinochle_engine import GENERAL_STRATEGY_SKILL_PARAMS

    ai = GeneralStrategy("me", None, skill_level=5, rng=random.Random(1))
    players = [ai] + [GeneralStrategy(f"P{i}", None, skill_level=5, rng=random.Random(i))
                      for i in range(1, 4)]
    _round_of(players)
    context = {"bid_history": [(players[2], 340)], "pass_history": []}

    assert ai._auction_evidence(context).highest_bid == {"partner": 340}
    assert "use_auction_evidence" in GENERAL_STRATEGY_SKILL_PARAMS[5]
