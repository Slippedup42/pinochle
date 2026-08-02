"""
Tests for issue #62 - Trick-play rollout strategy + gated deception,
implementing pinochle_expert_ai_strategy.md Section 4 (trick-play strategy)
and, gated behind an optional deception_evaluator, Section 7 (deception) as
shared, callable functions (`choose_expert_lead_card` /
`choose_expert_follow_card` in pinochle_engine.py) independent of any
Player subclass or the rollout sampler itself. Plain assert-based,
pytest-discoverable, matching test_expert_pass.py / test_rollout.py's
convention.

Covers:
  1. Bidder-leading Ace-first trump lead (doc Section 4 point 1), and that
     the exact same shared function drives both the Bidder's and the
     partner's lead (doc Section 9 Q4, resolved).
  2. The no-trump-Ace mid-hand conservative shift (doc Section 9 Q3,
     resolved): abandons the aggressive trump-draw plan, never proactively
     leads trump when a non-trump lead is available.
  3. Endgame loser-first sequencing: once all trump is accounted for
     outside a near-empty hand, losers lead first and trump is held back.
  4. Following-suit heuristics: duck vs. feed when partner is already
     winning (including *which* counter goes across, and that the
     mandatory-beat tier above pre-empts the choice - #168), count-card
     protection on both a forced non-beat and a free sluff (including the
     case where a naive shortest-suit tie-break would get it wrong), and
     over-trump-vs-under-trump judgment when first to trump a trick.
  5. The defender static/rollout-compare split (doc Section 9 Q5, revised
     resolution): static mode never leads trump; rollout-compare mode CAN
     override that default when the injected evaluator prefers it.
  6. Deception (Section 7): false-card/fake-void candidate generators only
     propose believable candidates per PlayTracker's per-copy tracking,
     and `choose_expert_follow_card` with `deception_evaluator` supplied
     can diverge from the honest baseline while always returning a legal
     move.
  7. General legality across randomized hands/trick states for both the
     lead and follow entry points.
  8. The Proficient-tier `choose_follow_card`'s feed-partner tier (#164) -
     not a #62 function, but the same rule as section 4's feed case, so it
     is asserted here rather than in a file of its own.
  9. Forced-beat *detection* on both follow paths (#173): a trump ruff is
     not something a lead-suit card can beat, in either direction, plus the
     all-trump `forced_beat` that is correct on raw rank and was left alone.

Run directly (`python test_trick_play_strategy.py`) or via pytest.
"""

from pinochle_engine import (
    Card,
    Deck,
    PlayTracker,
    Suit,
    Trick,
    choose_expert_follow_card,
    choose_expert_lead_card,
    choose_follow_card,
    generate_fake_void_candidates,
    generate_false_card_candidates,
)


def C(suit, rank, copy_id=1):
    return Card(suit, rank, copy_id)


def _fresh_hands():
    deck = Deck()
    deck.shuffle()
    cards = deck.cards
    return [cards[i * 12:(i + 1) * 12] for i in range(4)]


# ---------------------------------------------------------------------------
# 1. Ace-first trump lead, shared by Bidder and partner (doc Section 9 Q4).
# ---------------------------------------------------------------------------

def test_offense_leads_trump_ace_when_held():
    trump = Suit.HEARTS
    tracker = PlayTracker()
    hand = [C(trump, "A"), C(trump, "K"), C(Suit.CLUBS, "9"), C(Suit.SPADES, "A")]
    card = choose_expert_lead_card(hand, trump, tracker, is_bidding_team=True)
    assert card.suit == trump and card.rank == "A", card


def test_offense_ace_first_shared_by_bidder_and_partner():
    """Doc Section 9 Q4, resolved: the partner runs the exact same
    Ace-first logic independently - not a special-cased deferral to
    whatever the Bidder's plan was. Proven here by calling the one shared
    function on two different hands, both with is_bidding_team=True."""
    trump = Suit.SPADES
    tracker = PlayTracker()
    bidder_hand = [C(trump, "A"), C(Suit.HEARTS, "9"), C(Suit.CLUBS, "K")]
    partner_hand = [C(Suit.DIAMONDS, "9"), C(trump, "A"), C(Suit.CLUBS, "Q")]

    bidder_lead = choose_expert_lead_card(bidder_hand, trump, tracker, is_bidding_team=True)
    partner_lead = choose_expert_lead_card(partner_hand, trump, tracker, is_bidding_team=True)

    assert bidder_lead.suit == trump and bidder_lead.rank == "A"
    assert partner_lead.suit == trump and partner_lead.rank == "A"


# ---------------------------------------------------------------------------
# 2. No-trump-Ace mid-hand conservative shift (doc Section 9 Q3, resolved).
# ---------------------------------------------------------------------------

def test_offense_conservative_lead_without_trump_ace():
    """Holding trump but no trump Ace: the aggressive trump-draw plan is
    abandoned - a non-trump lead is preferred whenever one is available,
    rather than proactively forcing trump out."""
    trump = Suit.HEARTS
    tracker = PlayTracker()
    hand = [C(trump, "K"), C(Suit.CLUBS, "9"), C(Suit.CLUBS, "9", 2)]
    card = choose_expert_lead_card(hand, trump, tracker, is_bidding_team=True)
    assert card.suit != trump, "must not proactively lead trump without a trump Ace"


def test_offense_leads_trump_only_when_nothing_else_left():
    trump = Suit.HEARTS
    tracker = PlayTracker()
    hand = [C(trump, "K"), C(trump, "Q")]  # trump-only hand, no Ace
    card = choose_expert_lead_card(hand, trump, tracker, is_bidding_team=True)
    assert card.suit == trump  # no non-trump option exists at all


# ---------------------------------------------------------------------------
# 3. Endgame sequencing - protect the last-trick bonus.
# ---------------------------------------------------------------------------

def test_endgame_holds_trump_back_and_leads_losers_first():
    trump = Suit.HEARTS
    tracker = PlayTracker()
    for rank in ("A", "10", "K", "Q", "J"):
        tracker.record(C(trump, rank, 1))
        tracker.record(C(trump, rank, 2))
    tracker.record(C(trump, "9", 2))  # the OTHER copy of the 9 this hand still holds
    # All 12 trump copies are now accounted for: 10 played + 1 played + 1 in hand.

    hand = [C(trump, "9", 1), C(Suit.CLUBS, "A"), C(Suit.DIAMONDS, "9")]

    offense_lead = choose_expert_lead_card(hand, trump, tracker, is_bidding_team=True)
    defense_lead = choose_expert_lead_card(hand, trump, tracker, is_bidding_team=False)

    assert offense_lead.suit != trump, "endgame sequencing must hold the last trump back"
    assert defense_lead.suit != trump, "endgame sequencing applies regardless of which side is leading"


def test_endgame_not_triggered_while_trump_still_unaccounted():
    """Sanity check: with a fresh tracker (nothing played), the endgame
    guard must not fire, and normal Ace-first offense logic still applies."""
    trump = Suit.HEARTS
    tracker = PlayTracker()
    hand = [C(trump, "A"), C(Suit.CLUBS, "9")]
    card = choose_expert_lead_card(hand, trump, tracker, is_bidding_team=True)
    assert card.suit == trump and card.rank == "A"


# ---------------------------------------------------------------------------
# 4. Defender static/rollout-compare split (doc Section 9 Q5, revised).
# ---------------------------------------------------------------------------

def test_defender_static_avoids_trump_lead():
    trump = Suit.HEARTS
    tracker = PlayTracker()
    hand = [C(trump, "A"), C(Suit.CLUBS, "9"), C(Suit.CLUBS, "9", 2)]
    card = choose_expert_lead_card(hand, trump, tracker, is_bidding_team=False)
    assert card.suit != trump, "static-mode defenders must not lead trump, even holding a trump Ace"


def test_defender_rollout_compare_can_choose_trump_over_static_default():
    trump = Suit.HEARTS
    tracker = PlayTracker()
    hand = [C(trump, "A"), C(Suit.CLUBS, "9"), C(Suit.CLUBS, "9", 2)]

    static_pick = choose_expert_lead_card(hand, trump, tracker, is_bidding_team=False)
    assert static_pick.suit != trump  # static default: avoid trump

    def prefer_trump(hand_, trump_, tracker_, candidate):
        return 20.0 if candidate.suit == trump_ else 10.0

    compare_pick = choose_expert_lead_card(
        hand, trump, tracker, is_bidding_team=False, rollout_evaluator=prefer_trump,
    )
    assert compare_pick.suit == trump, \
        "rollout-compare mode must be able to override the static avoidance default"
    assert static_pick.suit != compare_pick.suit, \
        "the two modes must actually diverge on this hand, not just both exist"


def test_defender_rollout_compare_keeps_static_pick_when_evaluator_prefers_it():
    """Symmetric check: the evaluator - not a hardcoded ranking - decides."""
    trump = Suit.HEARTS
    tracker = PlayTracker()
    hand = [C(trump, "A"), C(Suit.CLUBS, "9"), C(Suit.CLUBS, "9", 2)]

    def prefer_non_trump(hand_, trump_, tracker_, candidate):
        return 20.0 if candidate.suit != trump_ else 10.0

    static_pick = choose_expert_lead_card(hand, trump, tracker, is_bidding_team=False)
    compare_pick = choose_expert_lead_card(
        hand, trump, tracker, is_bidding_team=False, rollout_evaluator=prefer_non_trump,
    )
    assert static_pick == compare_pick


# ---------------------------------------------------------------------------
# 5. Following suit - duck/feed, count-card protection, over/under-trump.
# ---------------------------------------------------------------------------

def test_follow_ducks_when_partner_winning_and_nothing_to_feed():
    trump = Suit.HEARTS
    partner = object()
    trick_plays = [(partner, C(Suit.CLUBS, "K"))]
    hand = [C(Suit.CLUBS, "9"), C(Suit.CLUBS, "Q")]  # neither beats K, no K/10 to feed
    card = choose_expert_follow_card(hand, hand, trick_plays, trump, {partner}, PlayTracker())
    assert card.rank == "9"  # lowest - duck, don't overspend on a secured trick


def test_follow_feeds_partner_when_a_count_card_is_free():
    trump = Suit.HEARTS
    partner = object()
    trick_plays = [(partner, C(Suit.CLUBS, "K", 1))]
    hand = [C(Suit.CLUBS, "9"), C(Suit.CLUBS, "K", 2)]  # 2nd copy of K ties, doesn't beat
    card = choose_expert_follow_card(hand, hand, trick_plays, trump, {partner}, PlayTracker())
    assert card.rank == "K", "should feed the count card across to partner's secured trick"


def test_expert_follow_feeds_the_king_not_the_ten():
    """#168 - the third and last copy of the bug #154 fixed in TypeScript and
    #164 fixed in `choose_follow_card`. King and 10 are worth 10 points each
    (`pinochle_rules.md`), so the trick banks the same score either way; the
    only difference is what stays in hand, and the 10 is beaten by nothing but
    an Ace. This tier called `max` - throwing the 10, keeping the King - for
    the whole life of the function, and it is the copy skills 4-5 actually
    follow with.

    The legal set is taken from `Trick.legal_moves` rather than written by
    hand: partner is sitting on the Ace, so no card of this suit beats it, no
    beat is mandatory, and the feed tier is genuinely the one that runs."""
    trump = Suit.SPADES
    partner = "partner"
    trick = Trick(trump)
    trick.play(partner, C(Suit.HEARTS, "A"))
    hand = [C(Suit.HEARTS, "9"), C(Suit.HEARTS, "K"), C(Suit.HEARTS, "10")]
    legal = trick.legal_moves(hand)
    assert {c.rank for c in legal} == {"9", "K", "10"}, "no beater exists, so nothing is forced"
    card = choose_expert_follow_card(hand, legal, trick.plays, trump, {partner}, PlayTracker())
    assert card.rank == "K", card


def test_expert_follow_holds_the_ace_when_it_is_the_only_counter():
    """The half of the rule that was measured rather than reasoned out. "Feed
    your cheapest counter" read literally orders K -> 10 -> A and would donate
    the Ace here for the same 10 points; #154 ran that variant as its own arm
    over 5000 paired deals, where it was a null against the pre-fix behaviour
    and 3.5 points a deal behind excluding the Ace. The trick pays the same
    either way, the boss of the suit does not. Settled in both engines - #168
    kept the exclusion rather than re-opening it.

    Partner leads one copy of the Ace, so the second copy ties instead of
    beating it and is legal without being forced."""
    trump = Suit.SPADES
    partner = "partner"
    trick = Trick(trump)
    trick.play(partner, C(Suit.HEARTS, "A", 1))
    hand = [C(Suit.HEARTS, "9"), C(Suit.HEARTS, "A", 2)]
    legal = trick.legal_moves(hand)
    assert len(legal) == 2, "the tying second Ace is legal, not a mandatory beat"
    card = choose_expert_follow_card(hand, legal, trick.plays, trump, {partner}, PlayTracker())
    assert card.rank == "9", card


def test_expert_follow_forced_beat_pre_empts_the_feed_tier():
    """Guards the tier ordering: when every legal card already beats the card
    on the table the mandatory-beat tier runs first and wins as cheaply as
    possible, so `_feed_partner` is never reached. Chosen so the two tiers
    disagree - the cheapest legal card is the zero-count Queen, while the feed
    tier would have spent the King."""
    trump = Suit.SPADES
    partner = "partner"
    trick = Trick(trump)
    trick.play(partner, C(Suit.HEARTS, "J"))
    hand = [C(Suit.HEARTS, "Q"), C(Suit.HEARTS, "K")]
    legal = trick.legal_moves(hand)
    assert len(legal) == 2, "both cards beat the Jack, so the beat is mandatory"
    card = choose_expert_follow_card(hand, legal, trick.plays, trump, {partner}, PlayTracker())
    assert card.rank == "Q", card


def test_follow_protects_count_card_when_unable_to_beat():
    trump = Suit.HEARTS
    opponent = object()
    trick_plays = [(opponent, C(Suit.CLUBS, "A"))]  # unbeatable
    hand = [C(Suit.CLUBS, "9"), C(Suit.CLUBS, "10")]
    card = choose_expert_follow_card(hand, hand, trick_plays, trump, set(), PlayTracker())
    assert card.rank == "9", "must sluff the zero-count 9, not the 10, into a trick that can't be won"


def test_follow_sluff_protects_count_cards_over_shorter_suit():
    """The tricky case: a naive shortest-suit-first tie-break would sluff
    the count-card 10 (its suit has only 1 card) instead of the zero-count
    9 sitting in a longer suit. Count-card protection must win."""
    trump = Suit.HEARTS
    hand = [C(Suit.CLUBS, "10"), C(Suit.DIAMONDS, "9"), C(Suit.DIAMONDS, "J")]
    legal_moves = list(hand)  # void of lead suit and trump - free sluff
    trick_plays = [(object(), C(Suit.SPADES, "K"))]
    card = choose_expert_follow_card(hand, legal_moves, trick_plays, trump, set(), PlayTracker())
    assert card.suit == Suit.DIAMONDS and card.rank == "9", card


def test_follow_trump_forced_beat_wins_cheaply():
    trump = Suit.HEARTS
    trick_plays = [(object(), C(Suit.CLUBS, "9")), (object(), C(trump, "9"))]
    hand = [C(trump, "Q"), C(trump, "K")]
    card = choose_expert_follow_card(hand, hand, trick_plays, trump, set(), PlayTracker())
    assert card.rank == "Q"  # cheapest sufficient beat over the trumped-in 9


def test_follow_over_trumps_when_trick_has_points():
    trump = Suit.HEARTS
    trick_plays = [(object(), C(Suit.CLUBS, "A"))]  # count-card lead, worth winning
    hand = [C(trump, "9"), C(trump, "Q")]
    card = choose_expert_follow_card(hand, hand, trick_plays, trump, set(), PlayTracker())
    assert card.rank == "Q", "should commit the higher trump when the trick is worth securing"


def test_follow_under_trumps_when_not_worth_winning():
    trump = Suit.HEARTS
    partner = object()
    trick_plays = [(partner, C(Suit.CLUBS, "J"))]  # zero-count, partner already shown ahead
    hand = [C(trump, "9"), C(trump, "Q")]
    card = choose_expert_follow_card(hand, hand, trick_plays, trump, {partner}, PlayTracker())
    assert card.rank == "9", "should conserve the higher trump on a point-less forced ruff over partner"


# ---------------------------------------------------------------------------
# 6. Deception (Section 7) - gated behind deception_evaluator.
# ---------------------------------------------------------------------------

def test_false_card_candidates_require_believability():
    tracker = PlayTracker()
    hand = [C(Suit.CLUBS, "9"), C(Suit.CLUBS, "Q")]
    legal_moves = list(hand)

    candidates = generate_false_card_candidates(hand, legal_moves, [], tracker)
    assert any(c.rank == "Q" for c in candidates), "unaccounted rank is a believable false-card"

    tracker.record(C(Suit.CLUBS, "9", 2))  # now both copies of clubs-9 are accounted for
    candidates2 = generate_false_card_candidates(hand, legal_moves, [], tracker)
    assert not any(c.rank == "9" for c in candidates2), \
        "a provably-exhausted rank isn't a believable false-card"


def test_false_card_candidates_are_always_legal():
    tracker = PlayTracker()
    hand = [C(Suit.CLUBS, "9"), C(Suit.CLUBS, "Q"), C(Suit.CLUBS, "K")]
    legal_moves = hand[:2]  # only a subset is actually legal right now
    candidates = generate_false_card_candidates(hand, legal_moves, [], tracker)
    for c in candidates:
        assert c in legal_moves


def test_fake_void_candidates_require_multi_suit_and_prior_discard_history():
    tracker = PlayTracker()
    hand = [C(Suit.CLUBS, "9"), C(Suit.DIAMONDS, "9")]
    legal_moves = list(hand)

    assert generate_fake_void_candidates(hand, legal_moves, [], Suit.HEARTS, tracker) == []

    tracker.record(C(Suit.CLUBS, "9", 2))
    candidates = generate_fake_void_candidates(hand, legal_moves, [], Suit.HEARTS, tracker)
    pairs = {(c.suit, c.rank) for c in candidates}
    assert (Suit.CLUBS, "9") in pairs
    assert (Suit.DIAMONDS, "9") not in pairs


def test_fake_void_candidates_empty_when_single_suit_present():
    tracker = PlayTracker()
    tracker.record(C(Suit.CLUBS, "9", 2))
    hand = [C(Suit.CLUBS, "9"), C(Suit.CLUBS, "Q")]
    assert generate_fake_void_candidates(hand, hand, [], Suit.HEARTS, tracker) == []


def test_deception_disabled_returns_honest_pick_unchanged():
    trump = Suit.HEARTS
    hand = [C(Suit.CLUBS, "10"), C(Suit.DIAMONDS, "9"), C(Suit.DIAMONDS, "J")]
    legal_moves = list(hand)
    trick_plays = [(object(), C(Suit.SPADES, "K"))]
    without = choose_expert_follow_card(hand, legal_moves, trick_plays, trump, set(), PlayTracker())
    with_none = choose_expert_follow_card(
        hand, legal_moves, trick_plays, trump, set(), PlayTracker(), deception_evaluator=None,
    )
    assert without == with_none


def test_deception_enabled_can_diverge_but_always_returns_a_legal_move():
    """Required by issue #62: false-carding/fake-void must produce only
    legal moves when enabled."""
    trump = Suit.HEARTS
    tracker = PlayTracker()
    hand = [C(Suit.CLUBS, "9"), C(Suit.CLUBS, "Q"), C(Suit.DIAMONDS, "9")]
    legal_moves = list(hand)  # free sluff scenario
    trick_plays = [(object(), C(Suit.SPADES, "K"))]

    def evaluator(hand_, trump_, tracker_, trick_plays_, candidate):
        # Deliberately prefers a card the honest baseline would avoid (a
        # count-free choice exists, so the honest pick would never be the
        # Q of clubs) - proves the evaluator decides, not a hardcoded rule.
        return 100.0 if candidate.rank == "Q" else 0.0

    honest = choose_expert_follow_card(hand, legal_moves, trick_plays, trump, set(), tracker)
    deceptive = choose_expert_follow_card(
        hand, legal_moves, trick_plays, trump, set(), tracker, deception_evaluator=evaluator,
    )

    assert deceptive in legal_moves, "deceptive pick must still be a legal move"
    assert deceptive.rank == "Q"
    assert deceptive != honest, "deception must be able to diverge from the honest baseline"


# ---------------------------------------------------------------------------
# 7. General legality across randomized hands/trick states.
# ---------------------------------------------------------------------------

def test_lead_always_returns_a_card_in_hand():
    for _ in range(20):
        for hand in _fresh_hands():
            for trump in Suit:
                tracker = PlayTracker()
                for is_bidding_team in (True, False):
                    card = choose_expert_lead_card(hand, trump, tracker, is_bidding_team)
                    assert card in hand


def test_follow_always_returns_a_legal_move():
    trump = Suit.HEARTS
    for _ in range(30):
        hands = _fresh_hands()
        trick = Trick(trump)
        lead_card = hands[0][0]
        trick.play("p0", lead_card)
        tracker = PlayTracker()
        tracker.record(lead_card)

        follower_hand = hands[1]
        legal = trick.legal_moves(follower_hand)
        card = choose_expert_follow_card(follower_hand, legal, trick.plays, trump, {"p0"}, tracker)
        assert card in legal


# ---------------------------------------------------------------------------
# 8. Proficient-tier choose_follow_card - the feed-partner tier (#164).
# ---------------------------------------------------------------------------

def test_proficient_follow_feeds_partner_the_lowest_counter():
    """King and 10 bank the same 10 points, so spend the King and keep the 10 -
    it loses only to an Ace and often takes a later trick outright. This tier
    used to call `max` and throw the 10; #154 fixed the identical bug in
    `web/src/engine/tracker.ts` and #164 fixed it here."""
    trump = Suit.SPADES
    partner = object()
    # Partner leads a Queen; the 9 does not beat it, so this is not a forced
    # beat and the feed tier is what runs.
    trick_plays = [(partner, C(Suit.HEARTS, "Q"))]
    legal = [C(Suit.HEARTS, "9"), C(Suit.HEARTS, "K"), C(Suit.HEARTS, "10")]
    card = choose_follow_card(legal, legal, trick_plays, trump, {partner}, PlayTracker())
    assert card.rank == "K"


def test_proficient_follow_holds_the_ace_back_when_it_is_the_only_counter():
    """The measured half of #154, mirrored into Python. "Play your lowest legal
    point" read literally orders K -> 10 -> A and would donate the Ace here for
    the same 10 points; that variant was a null against the pre-fix behaviour
    over 5000 paired deals and 3.6 points a deal behind this one. The trick pays
    the same either way; the boss of a suit does not."""
    trump = Suit.SPADES
    partner = object()
    trick_plays = [(partner, C(Suit.HEARTS, "Q"))]
    legal = [C(Suit.HEARTS, "9"), C(Suit.HEARTS, "A")]
    card = choose_follow_card(legal, legal, trick_plays, trump, {partner}, PlayTracker())
    assert card.rank == "9"


def test_proficient_follow_forced_beat_still_wins_cheaply():
    """Guards the tier above it: when every legal card already beats the current
    winner the forced-beat branch runs first, so `_feed_partner` must not be
    reached and the cheapest winner goes in."""
    trump = Suit.SPADES
    opponent = object()
    trick_plays = [(opponent, C(Suit.HEARTS, "J"))]
    legal = [C(Suit.HEARTS, "K"), C(Suit.HEARTS, "A")]
    card = choose_follow_card(legal, legal, trick_plays, trump, set(), PlayTracker())
    assert card.rank == "K"


# ---------------------------------------------------------------------------
# 9. Forced-beat detection compares trick-winning power, not raw rank (#173).
#
# `_current_winner` returns a trump whenever one has been played, and
# `RANK_VALUE` is rank-only and suit-blind, so both follow paths read a partner
# who had ruffed in with the 9 of trump - the lowest `RANK_VALUE` there is - as
# beatable by every Queen in hand. Both directions are pinned, on both paths:
# `choose_follow_card` is what Proficient and skills 1-3 follow with, and
# `_expert_follow_card_honest` (via `choose_expert_follow_card`) is what skills
# 4-5 follow with. Same bug #155 fixed in `web/src/engine/tracker.ts`.
# ---------------------------------------------------------------------------

def _ruffed_trick(ruffer, trump):
    """An opponent leads the 9 of Hearts, `ruffer` is void and trumps in with
    the 9 of trump, the fourth seat sluffs. The trump is the lowest rank in the
    deck, which is what made the suit-blind comparison fire."""
    trick = Trick(trump)
    trick.play("opener", C(Suit.HEARTS, "9"))
    trick.play(ruffer, C(trump, "9"))
    trick.play("sluffer", C(Suit.DIAMONDS, "9"))
    return trick


def test_proficient_follow_partner_ruff_is_not_a_forced_beat():
    """The #173 bug, on the path Proficient and skills 1-3 take. A Heart cannot
    beat a Spade at any rank, so this is not a forced beat and the seat must
    fall through to the feed-partner tier and bank the King into a trick its own
    side has already won. The old comparison fired here and threw the Queen."""
    trump = Suit.SPADES
    partner = "partner"
    trick = _ruffed_trick(partner, trump)
    hand = [C(Suit.HEARTS, "Q"), C(Suit.HEARTS, "K")]
    legal = trick.legal_moves(hand)
    assert len(legal) == 2, "both Hearts beat the led 9, so the beat is mandatory"
    card = choose_follow_card(hand, legal, trick.plays, trump, {partner}, PlayTracker())
    assert card.rank == "K", card


def test_proficient_follow_opponent_ruff_changes_nothing():
    """The other direction, pinned because it is the half that must *not* move.
    Pinochle's rank order (9 J Q K 10 A) puts every non-counter strictly below
    every counter, so the forced-beat tier and the dump-low tier pick the same
    Queen - the fix is a null on the opponent side by construction, and this
    records that rather than leaving it to be re-derived."""
    trump = Suit.SPADES
    trick = _ruffed_trick("opponent", trump)
    hand = [C(Suit.HEARTS, "Q"), C(Suit.HEARTS, "K")]
    legal = trick.legal_moves(hand)
    card = choose_follow_card(hand, legal, trick.plays, trump, {"partner"}, PlayTracker())
    assert card.rank == "Q", card


def test_expert_follow_partner_ruff_is_not_a_forced_beat():
    """The same bug in `_expert_follow_card_honest`, the copy skills 4-5 follow
    with at the table (as opposed to only inside their rollouts)."""
    trump = Suit.SPADES
    partner = "partner"
    trick = _ruffed_trick(partner, trump)
    hand = [C(Suit.HEARTS, "Q"), C(Suit.HEARTS, "K")]
    legal = trick.legal_moves(hand)
    card = choose_expert_follow_card(hand, legal, trick.plays, trump, {partner}, PlayTracker())
    assert card.rank == "K", card


def test_expert_follow_opponent_ruff_changes_nothing():
    """Opponent side of the expert path - unchanged, for the rank-order reason."""
    trump = Suit.SPADES
    trick = _ruffed_trick("opponent", trump)
    hand = [C(Suit.HEARTS, "Q"), C(Suit.HEARTS, "K")]
    legal = trick.legal_moves(hand)
    card = choose_expert_follow_card(hand, legal, trick.plays, trump, {"partner"}, PlayTracker())
    assert card.rank == "Q", card


def test_forced_beat_over_trump_still_fires_on_an_all_trump_legal_set():
    """The third `forced_beat` in `pinochle_engine.py` - inside
    `_expert_follow_card_honest`'s `all_trump` branch - is *correct* on raw
    `RANK_VALUE` and was deliberately left alone by #173: there every legal card
    is trump and so is the card being compared against, which is the same-suit
    precondition `Card.beats` exists to enforce. Pinned so a later pass at the
    two sites above does not sweep this one up with them."""
    trump = Suit.SPADES
    trick = Trick(trump)
    trick.play("opener", C(Suit.HEARTS, "9"))
    trick.play("opponent", C(trump, "9"))
    hand = [C(trump, "Q"), C(trump, "K")]
    legal = trick.legal_moves(hand)
    assert len(legal) == 2, "void of Hearts, holding trump - both trumps must beat the 9"
    card = choose_expert_follow_card(hand, legal, trick.plays, trump, {"partner"}, PlayTracker())
    assert card.rank == "Q", "cheapest sufficient over-trump, not a fall-through to protect/feed"


def test_the_worked_example_is_decided_before_the_comparison_matters():
    """#155's worked example, which is the position that makes the bug look
    reachable and is not: partner leads the King of Diamonds, an opponent ruffs
    with the 9 of trump, this seat holds the Ace and the 9 of Diamonds.
    `Trick.legal_moves` forces the set to the Ace alone. `choose_follow_card`
    then returns on its single-legal-move line without evaluating `forced_beat`
    at all; the expert path has no such line, reaches the comparison, and plays
    the Ace either way because it is the only card there is. A one-card legal
    set can never distinguish the two readings - it is the multi-card positions
    above that expose the bug."""
    trump = Suit.SPADES
    partner = "partner"
    trick = Trick(trump)
    trick.play(partner, C(Suit.DIAMONDS, "K"))
    trick.play("opponent", C(trump, "9"))
    hand = [C(Suit.DIAMONDS, "A"), C(Suit.DIAMONDS, "9")]
    legal = trick.legal_moves(hand)
    assert [c.rank for c in legal] == ["A"], legal
    assert choose_follow_card(hand, legal, trick.plays, trump, {partner}, PlayTracker()).rank == "A"
    expert = choose_expert_follow_card(hand, legal, trick.plays, trump, {partner}, PlayTracker())
    assert expert.rank == "A", expert


if __name__ == "__main__":
    tests = [obj for name, obj in list(globals().items())
             if name.startswith("test_") and callable(obj)]
    for t in tests:
        t()
        print(f"OK: {t.__name__}")
    print(f"\n{len(tests)} tests passed.")
