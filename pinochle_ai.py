"""
Pinochle AI - the strategy half of the Python engine (#249, epic #214).

AUTHORITY: this file is NOT authoritative for the TypeScript port. Its
constants are auction and play strategy, and since #213 the measured
strategy constants are owned by TypeScript - `web/src/engine/bidding.ts`
- not by this file (`test_ported_constants.py`'s TYPESCRIPT and SHARED
pairs). Python remains the research harness these numbers are measured
on; it is not where a disagreement with the browser is settled. The rules
and valuation numbers Python *does* own live in `pinochle_rules_engine.py`.

Everything here is a *decision*: what to bid, which suit to name, what to
pass, what to lead and follow with. The rules it decides within - cards,
melds, the bid-valuation chain, tricks, rounds, the game - live in
`pinochle_rules_engine.py`, and this module imports them from there.
Nothing here is a rule, and nothing on the rules side imports this module
at load time.

What is here:

  - Auction strategy: OPENER_THRESHOLD, the opening anchor,
    DEFENSIVE_PUSH_FLOOR, endgame protection, THIRD_BIDDER_FLOOR and the
    two #213 partner floors. These are the SHARED and TYPESCRIPT pairs in
    `test_ported_constants.py`; the PYTHON pairs (rules and valuation)
    are in `pinochle_rules_engine.py`, which is the point of the split.
  - Proficient trick play: `choose_lead_card`, `choose_follow_card` and
    their helpers.
  - Pass selection: `choose_forward_pass_cards`, `choose_return_pass_cards`
    and the bidder/partner split under them.
  - Expert play: `choose_expert_lead_card`, `choose_expert_follow_card`,
    the deception candidates.
  - The players: `Player` (Proficient), `EasyPlayer`, `GeneralStrategy`
    and `GENERAL_STRATEGY_SKILL_PARAMS`, `RandomStrategy`.

`pinochle_engine.py` re-exports every name defined here, so existing
`from pinochle_engine import ...` callers did not change. New code may
import from either; patch strategy names here, not on the shim (#250).
"""

import random

from pinochle_rules_engine import (
    AROUND_DOUBLE_MULTIPLIER,
    AROUND_VALUES,
    COMMON_MARRIAGE_VALUE,
    DIX_VALUE,
    DOUBLE_RUN_VALUE,
    FORCED_BID,
    GAME_WIN_SCORE,
    OPENING_BID,
    PINOCHLE_DOUBLE_VALUE,
    PINOCHLE_SINGLE_VALUE,
    POINT_RANKS,
    RANK_VALUE,
    RANKS,
    ROYAL_MARRIAGE_VALUE,
    RUN_RANKS,
    RUN_VALUE,
    TOTAL_TRUMP_COPIES,
    PlayTracker,
    Suit,
    Team,
    _hand_count,
    _is_protected_ten,
    _n_of,
    _suit_length,
    best_base_bid,
    score_melds,
)


# ---------------------------------------------------------------------------
# Auction strategy — the thresholds `Player.choose_bid` reads the valuation
# ceiling against. The ceiling itself (`compute_max_bid`, `best_base_bid`) is
# valuation and lives in pinochle_rules_engine.py.
# ---------------------------------------------------------------------------

OPENER_THRESHOLD = 320  # minimum Base Bid to justify opening at all

# -- The opening anchor: what a seat names once it has decided to open.
#
# Where a contract lands is set by the runner-up, not the winner. A +10
# auction stops one rung past the last opposing seat's walk-away point, so
# the winner pays the second-best hand's price and its own valuation never
# reaches the table unless the opponents drag it there. Measured over 3000
# browser auctions at 0-0 (web/README.md, "What the opener puts on the
# table"): the winning seat's ceiling ran median 370, the contract median
# 320, and 38.6% of contracts were an uncontested 300. Paul's account of
# ~15 years at real tables is that a normal contract is 330-380 - which is
# where the ceilings already were. Moving the valuation cannot fix that,
# because it moves the runner-up by the same amount; only the number the
# opener names can.
#
# The shape was measured, not chosen. Every slope of anchor from the ceiling
# put ~57% of contracts in 330-380 against the floor opener's 32%, and the
# cost per deal tracked the slope alone: -67 at slope 0.5, -35 at 0.25, and
# -13 to -21 across three seeds for a flat 330 - all measured with a capacity
# confound the TypeScript harness has since equalised; the flat 330 re-measures
# at about -30 (web/README.md, "The capacity confound"). All of the distribution is
# bought by naming 330 instead of 300 on a hand worth 330, so the slope is
# zero and the anchor is one number - which is Paul's house rule with the
# number on it: a bid asserts a hand. The constants stay general so the
# sweep can be re-run.
#
# Switched on for the shipped AI on Paul's decision of 2026-09-21, made on
# -17/deal; shown the equalised figure of about -30 on 2026-09-22, he kept it.
# The TypeScript engine's `openingLevelFor` is this function.
ANCHOR_INTERCEPT = 330
ANCHOR_SLOPE = 0
ANCHOR_CAP = 380


def opening_level_for(ceiling, floor_level=OPENING_BID):
    """The level an opener names, given it has decided to open. Never below
    `floor_level`, and the floor itself for a ceiling under the intercept."""
    if ceiling < ANCHOR_INTERCEPT:
        return floor_level
    compressed = ANCHOR_INTERCEPT + int(ANCHOR_SLOPE * (ceiling - ANCHOR_INTERCEPT) // 10) * 10
    return max(floor_level, min(ANCHOR_CAP, compressed))
# Minimum ceiling to justify a defensive push against an opening bid of 300.
# Hands at or above this floor should almost always raise a 300 opener,
# since even moderate hands can contribute toward making 300 with partner's
# help, and pushing deprives the opponent of a cheap contract. "Truly
# hopeless" hands (no meld, no aces — ceiling ~90 since #308, a little more
# with loose honours) fall below this floor.
DEFENSIVE_PUSH_FLOOR = 200

# -- Endgame protection (#256). The one bidding rule that is about the *game*
# rather than about the hand: a team this close to 1000 banks its meld and
# lets the contract go, because the contract is worth little to it - the
# defending team scores its own meld either way - while being set costs the
# whole bid and hands back a game that was one hand from over. Both thresholds
# are derived from GAME_WIN_SCORE so they follow the target if it ever moves;
# #243 records why moving it is expensive. 750 is "within 250 of going out",
# which one ordinary meld plus a share of the tricks reaches. 450 is "more
# than 550 away", more than the opponents can plausibly take off a single
# hand, so there is a next hand to fight it out in.
ENDGAME_SCORE_FLOOR = GAME_WIN_SCORE - 250
ENDGAME_OPP_SCORE_CAP = GAME_WIN_SCORE - 550
# The one hand check in the rule, and the only thing that puts a bid back on
# the table while the trigger holds. This is the Max Bid *ceiling* (all three
# valuation stages summed), not the Base Bid: in the score
# band this rule fires in `compute_competitive_adjustment` returns +60 (+100
# before #308), so the effective bar is a Base Bid plus trick potential a
# little over 140 and few hands fail it.
# That is a deliberate choice rather than an oversight - if the rescue turns
# out to fire on hands that cannot carry OPENING_BID, this is the number to
# revisit, not the choice of measure.
ENDGAME_RESCUE_CEILING = 200

# -- The hand floor under the third bidder's positional open (#255).
#
# The seat that speaks after two passes with nobody having bid opens to deny
# the last player a cheap contract. That used to happen on *any* hand at all,
# which is what #255 was filed about: Paul's house rule from live play is that
# a bid asserts a hand - "assume anyone bidding has 320 or they should not
# bid."
#
# This is 200 and NOT OPENER_THRESHOLD, and the difference was measured. A
# paired A/B on identical deals with the seats mirrored (ab_harness.run_ab,
# 800 pairs / 1600 games) put each candidate floor against the unfloored rule
# it replaces:
#
#   320: -57 score margin per deal, 95% CI -76 to -37, exact two-sided
#        binomial p < 1e-4, sign test 34 sweeps to 83. Replicated on a second
#        seed at -28/deal, CI -46 to -11, p = 0.0023.
#   200: -7/deal, 95% CI -17 to +1, NOT significant (7 sweeps to 16, p = 0.09).
#
# So the positional open really is worth something, and all of what it is
# worth lives in the 200-320 band - precisely the hands the house rule would
# forbid. Paying 57 points a deal to enforce 320 here is not a trade worth
# making; 200 still stops the seat opening on a hand with no meld and no aces,
# which is what was actually seen at the table.
#
# The two numbers express different ideas and are deliberately not linked.
# OPENER_THRESHOLD is "worth a contract". This is "not literally worthless".
# Setting this to OPENER_THRESHOLD, or deriving it from it, would relink two
# values that have just been measured apart.
#
# Like ENDGAME_RESCUE_CEILING (which independently landed on 200 by judgement
# rather than by measurement) this is the Max Bid *ceiling*, not the Base Bid,
# and the comparison is `>=` - reached, not cleared - which is the form that
# was measured.
#
# Both runs predate #242, which raised every hand holding a trump Run by 40,
# and #273, which put it back - so on the run/marriage question the valuation
# is once again the one that was measured. They also predate #277, which added
# a whole trick-potential stage, and #283, which removed the 400 cap the
# valuation used to run into. The gap between the arms is far larger than any
# of those shifts and the direction stands, but the exact figures are of the
# valuation as it was that day and a re-measurement is owed.
THIRD_BIDDER_FLOOR = 200

# -- Two auction-strategy numbers this file does NOT rule (#213).
#
# Python is authoritative for rules constants; the TypeScript engine is
# authoritative for these, because they were measured or reasoned there
# (CLAUDE.md, pinochle_rules.md's "Which engine is the real one"). They are
# named here so the next reader sees a deliberate divergence, not an
# oversight. Naming them is not porting them, and nothing here changed value.
#
# PARTNER_RAISE_FLOOR: when partner has raised over this seat's own earlier
# bid, raise again only on a ceiling that reaches it. Python uses it as that
# gate alone and then bids the next rung; `bidding.ts`'s PARTNER_RAISE_FLOOR
# (#206) uses the same gate and also *bids* at least 340, because a ten-point
# nudge over one's own partner tells a human partner nothing - a reason with
# no referent in an all-AI Python game.
#
# COMPETITIVE_CEILING_FLOOR: once partner has bid, the ceiling used to contest
# an opponent's bid is lifted to at least this, since a partner bid is a signal
# worth backing. Same value and same use in both engines today; the TypeScript
# side owns it. TypeScript's further #180 rule - a seat whose partner has
# passed commits to PARTNER_PASSED_FLOOR (320) - has no Python counterpart.
#
# #213 traced both divergences and found them inert on every path that still
# consumes this bidding: the skill-5 rollout labeller
# (`GeneralStrategy._rollout_ev_bid`) uses `choose_bid` only as a positional
# gate and discards its level, and `export_parity_scenarios.py` writes bids as
# scenario data that TypeScript replays rather than re-derives.
PARTNER_RAISE_FLOOR = 340
COMPETITIVE_CEILING_FLOOR = 330


def endgame_protection_applies(my_score, opp_score):
    """True when this team should be banking its meld rather than buying a
    contract: within 250 of going out while the opponents are more than 550
    away. It is a property of the *team*, so both its seats are covered, not
    only the one holding a good hand."""
    return my_score >= ENDGAME_SCORE_FLOOR and opp_score < ENDGAME_OPP_SCORE_CAP


def endgame_protection_bid(context, opponents, partner_is_dealer, ceiling):
    """
    What a seat bids while `endgame_protection_applies` holds. The default is
    None - pass, for the whole auction, on any hand, opening or over anyone.
    If the dealer is an opponent the auction passes out and they are stuck at
    FORCED_BID, which is the outcome this rule is happy to buy.

    The single exception is a partner who is dealing: passing out would stick
    *us* with a contract nobody chose, so this seat opens at OPENING_BID
    instead - but only holding a hand worth more than ENDGAME_RESCUE_CEILING,
    and only while no opponent has bid. An opponent who has bid has already
    taken the contract off our hands, which is what we wanted.

    Reading only one opponent is a seat-order fact rather than a
    simplification. The auction opens left of the dealer and rotates
    clockwise, so a partner-of-the-dealer seat speaks *second*: after exactly
    one opponent, and before both the other opponent and the dealer. There is
    no later turn at which this seat knows more, because to still be in the
    auction it would have had to bid. `context` carries the auction record but
    no seat indices (see `GeneralStrategy._auction_evidence`), so "the
    opponent who spoke immediately before me has passed" is read here as "an
    opponent has passed and none has bid" - at this seat, and only at this
    seat, those are the same statement.
    """
    if not partner_is_dealer:
        return None
    if any(p in opponents for p, _ in context.get("bid_history", [])):
        return None
    if not any(p in opponents for p in context.get("passed_players", [])):
        return None
    return OPENING_BID if ceiling > ENDGAME_RESCUE_CEILING else None


# ---------------------------------------------------------------------------
# Trick-play strategy — card counting, safe-card cascade, feed/withhold logic.
# Shared by all four seats; role only matters via which team-set gets passed.
# ---------------------------------------------------------------------------

def is_safe(card, hand, tracker):
    """A card is safe to lead once every higher-ranked card in its suit
    is accounted for - either already played, or still in your own hand
    (a card you hold yourself can't beat you)."""
    if card.rank == "A":
        return True
    idx = RANK_VALUE[card.rank]
    for rank, value in RANK_VALUE.items():
        if value > idx:
            accounted = tracker.played_count(card.suit, rank) + _hand_count(hand, card.suit, rank)
            if accounted < 2:
                return False
    return True


def is_unsecured_ace(card, hand, tracker):
    """Exactly 1 copy of this Ace in hand, and the other copy hasn't been
    played yet - a live liability that needs to move before someone else's
    lead traps you into losing it to the tie-break rule."""
    if card.rank != "A":
        return False
    if _hand_count(hand, card.suit, "A") != 1:
        return False  # 0 copies (n/a) or 2 copies (secure double, no rush)
    return tracker.played_count(card.suit, "A") == 0


def _lead_safe_cascade(hand, trump, tracker):
    """Original Proficient safe-card cascade, extracted so offense/defender
    wraps can call it with a filtered hand."""
    trump_aces = [c for c in hand if c.suit == trump and c.rank == "A" and is_unsecured_ace(c, hand, tracker)]
    if trump_aces:
        return trump_aces[0]

    other_unsecured_aces = [c for c in hand if c.rank == "A" and c.suit != trump and is_unsecured_ace(c, hand, tracker)]
    if other_unsecured_aces:
        other_unsecured_aces.sort(key=lambda c: -_suit_length(hand, c.suit))
        return other_unsecured_aces[0]

    safe_cards = [c for c in hand if is_safe(c, hand, tracker)]
    if safe_cards:
        safe_cards.sort(key=lambda c: (-RANK_VALUE[c.rank], -_suit_length(hand, c.suit)))
        return safe_cards[0]

    junk = [c for c in hand if c.rank not in POINT_RANKS and c.suit != trump]
    if junk:
        junk.sort(key=lambda c: _suit_length(hand, c.suit))
        return junk[0]

    junk_trump = [c for c in hand if c.rank not in POINT_RANKS and c.suit == trump]
    if junk_trump:
        junk_trump.sort(key=lambda c: _suit_length(hand, c.suit))
        return junk_trump[0]

    return min(hand, key=lambda c: RANK_VALUE[c.rank])


def choose_lead_card(hand, trump, tracker, is_bidder_first_lead=False, is_bidding_team=None):
    """
    Choose what to lead when you have control. Priority:
      0. Bidder's first lead (#82) — must lead trump if any is held
      1. When side is known: bidding team draws trump, defending team avoids it
      2. Otherwise: original safe-card cascade fallback

    @param is_bidder_first_lead - When True (bidder opening the first trick of the
      round), forces a trump lead if the player has any trump cards remaining.
    @param is_bidding_team - When True, use offense trump-draw strategy. When
      False, use defender strategy (avoid leading trump). None = fallback.
    """
    # Bidder's first lead must be trump if they have any — rule #82
    if is_bidder_first_lead:
        trumps = [c for c in hand if c.suit == trump]
        if trumps:
            unsecured_ace = next((c for c in trumps if c.rank == "A" and is_unsecured_ace(c, hand, tracker)), None)
            if unsecured_ace:
                return unsecured_ace
            ace = next((c for c in trumps if c.rank == "A"), None)
            if ace:
                return ace
            return max(trumps, key=lambda c: RANK_VALUE[c.rank])

    # Dispatch by side when known
    if is_bidding_team is True:
        return _offense_trump_lead(hand, trump, tracker)
    if is_bidding_team is False:
        return _defender_lead(hand, trump, tracker)

    # Fallback when side is unknown: original safe-card cascade
    return _lead_safe_cascade(hand, trump, tracker)


def _current_winner(trick_plays, trump):
    trump_plays = [(p, c) for p, c in trick_plays if c.suit == trump]
    pool = trump_plays if trump_plays else [(p, c) for p, c in trick_plays if c.suit == trick_plays[0][1].suit]
    return max(pool, key=lambda pc: RANK_VALUE[pc[1].rank])


def _feed_partner(legal_moves):
    """
    Partner is winning and you cannot take the trick off them: bank a counter
    into it, and make it the *cheapest* one you hold (#164).

    A, 10 and K are worth exactly 10 points each (`pinochle_rules.md:140`), so
    which counter goes in does not change what the trick pays - only what is
    left in hand afterwards. The King is the one to spend: it banks the same
    10 while the 10 it keeps is beaten by nothing but an Ace and will often take
    a later trick outright. This used to be `max`, which threw the 10 and kept
    the King - identical points for a worse hand, on every deal.

    The Ace stays out of it, so a hand holding an Ace and no other counter
    donates junk rather than the boss of the suit. That exclusion is measured,
    not assumed: #154 ran the "play your lowest legal point" variant (which
    orders K -> 10 -> A and so puts the Ace in) as its own arm over 5000 paired
    deals, where it was a null against the old `max` behaviour (+0.4 per deal,
    95% CI -1.7 to +2.5) and 3.6 points a deal behind this one - donating the
    Ace gives back the whole gain of spending the King. Both results reproduced
    on a second seed; see `web/README.md`. That question is settled, in both
    engines, and this side did not re-open it.

    Re-measured here rather than inherited, because the Python AI reaches this
    tier differently - `ab_harness.py`, 5000 paired deals per arm, this against
    the old `max`:

        Proficient, seed 164   +3.61/deal   95% CI +1.83 to +5.45   swept 32-10
        Proficient, seed 27    +2.16/deal   95% CI +0.66 to +3.70   swept 16-8
        GeneralStrategy 4      -3.07/deal   95% CI -7.67 to +1.54   swept 125-135

    Proficient reproduces the TypeScript result almost exactly (+3.55 there),
    on both seeds. Skill 4 is a null, and expected to be: skills 4-5 follow with
    `choose_expert_follow_card`, so the only thing this function changes for
    them is how the *rollouts* play - and a rollout is self-play, so both sides
    of the simulated playout get the same 10 points either way. That arm is also
    much noisier (260 decisive pairs against Proficient's 42), so it could not
    have resolved an effect this size regardless. Skills 1-3 are the levels this
    moves, and skill 3 measured byte-identical to Proficient.

    #168 then found a third copy of the same `max`, inline in
    `_expert_follow_card_honest` - the one skills 4-5 follow with *at the table*,
    rather than only inside their rollouts. That copy now calls this helper, so
    Python has one implementation of the rule, and the skill 4-5 arms #164 could
    not move were re-run against it, same harness and same 5000 paired deals:

        skill 4, seed 168000   +6.69/deal   95% CI +3.26 to +10.03   swept  89-67
        skill 4, seed 270000  +10.56/deal   95% CI +7.22 to +13.95   swept 117-55
        skill 5, seed 168000   +6.22/deal   95% CI +2.79 to  +9.63   swept  91-62

    All three intervals exclude zero, so the rule is worth roughly twice at the
    top of the dial what it is at Proficient (+3.55 to +3.61). That is consistent
    with the reason it works: skills 4-5 hold their counters into the late tricks
    far more often, so the difference between banking the King and banking the 10
    keeps mattering for longer. It also closes out the "skill 4 is a null" line
    above - that null was a property of #164's scope, not of the rule, and the
    two are not in conflict. Both readings needed the measurement; neither could
    have been argued from the code.
    """
    counters = [c for c in legal_moves if c.rank in ("K", "10")]
    if counters:
        return min(counters, key=lambda c: RANK_VALUE[c.rank])
    return min(legal_moves, key=lambda c: RANK_VALUE[c.rank])  # avoid donating a live Ace unless forced


def _feed_ahead(hand, trick_plays, my_team_players, tracker):
    """
    Paul's follow rule read with position (`PartnerRead` 'feedAhead' in the
    TypeScript engine, shipped 2026-09-22): "if partner is likely to take the
    trick, put in the lowest point you can."

    "Likely" is the seat. An opponent led and this seat is second, so partner
    plays *last* - the best seat at the table - and the card currently winning
    is not boss in its suit (some higher copy is still unaccounted for, which
    partner may hold). The caller has already established a forced beat, so
    every legal card takes the trick as it stands; the shipped rule took it as
    cheaply as it could, and this one feeds the King for partner to collect.

    Measured on the capacity-equalised TypeScript harness at +5 a deal (95% CI
    +2 to +9, 5000 pairs); its sibling `holdBack` - hold the King when an
    opponent still sits behind you - was a null and does not ship. Without a
    tracker nothing is known to be accounted for, so the winner is read as
    beatable, which is what the TypeScript side does too.
    """
    if len(trick_plays) != 1:
        return False
    leader, winner_card = trick_plays[0]
    if leader in my_team_players:
        return False
    if tracker is None:
        return True
    return not is_safe(winner_card, hand, tracker)


def _sluff_card(hand, legal_moves):
    """
    Python's one sluff rule, shared by `choose_follow_card` and
    `_expert_follow_card_honest` (as `_feed_ahead` is): free choice across
    suits, so protect count cards first, then work toward a void in the
    shortest suit, lowest rank within it. Falls back to every legal card when
    all of them count. Ties keep `legal_moves` order. Held in one place
    because the two copies drifted apart before (issue #324).
    """
    non_points = [c for c in legal_moves if c.rank not in POINT_RANKS]
    pool = non_points if non_points else legal_moves
    return min(pool, key=lambda c: (_suit_length(hand, c.suit), RANK_VALUE[c.rank]))


def choose_follow_card(hand, legal_moves, trick_plays, trump, my_team_players, tracker=None):
    """
    Choose which legal card to play when following (not leading).
    `legal_moves` already has the mandatory beat-if-possible / trump-if-void
    rules applied by Trick.legal_moves - this only picks which one to use.

    Following suit, off-trump, in priority order:
      1. Forced beat (every legal card already beats the current winner,
         measured as trick-winning power rather than raw rank - #173) -
         play the lowest one, saving the bigger cards for later.
      2. Partner is winning - feed them the cheapest counter (`_feed_partner`).
      3. Otherwise - lowest non-point card, falling back to the lowest legal
         card when only point cards are left.

    Tier 1's *detection* is #173's subject, and it is worth recording what it
    is worth, because the answer is small and the temptation is to round it to
    nothing. `ab_harness.py`, 5000 paired deals per arm, this against the
    pre-fix suit-blind comparison, Proficient on both sides:

        seed 173   +1.32/deal   95% CI +0.55 to +2.13   swept  7-1   p 0.070
        seed  27   +2.01/deal   95% CI +1.20 to +2.94   swept 11-3   p 0.057

    Both margin intervals exclude zero; the sign test reaches significance on
    neither, off eight and fourteen decisive deals in 5000. That is the reading
    to report as margin and not as games-won, and it reproduces #155's
    TypeScript measurement of the same fix (+1.81 and +1.77 per deal, 12-4 and
    7-1) closely enough to be the same effect. It is small because the position
    is rare: instrumented over 300 paired deals, the old predicate fired on 11%
    of follow decisions, 2.4% of them against a trump winner, and only 0.19%
    changed the card actually played - the divergence needs partner (not an
    opponent) to have ruffed in, this seat to still hold the lead suit, and the
    legal set to contain both a counter and a non-counter.
    """
    if len(legal_moves) == 1:
        return legal_moves[0]

    lead_suit = trick_plays[0][1].suit if trick_plays else None
    winner_player, winner_card = _current_winner(trick_plays, trump) if trick_plays else (None, None)
    partner_winning = winner_player is not None and winner_player in my_team_players

    all_lead_suit = lead_suit is not None and all(c.suit == lead_suit for c in legal_moves)
    all_trump = all(c.suit == trump for c in legal_moves)

    if all_lead_suit and lead_suit != trump:
        # Trick-winning power, not raw rank (#173, after #155 in TypeScript).
        # `_current_winner` returns a *trump* whenever one has been played, and
        # `RANK_VALUE` is rank-only and suit-blind, so the comparison this
        # replaces - `RANK_VALUE[c.rank] > RANK_VALUE[winner_card.rank]` - read a
        # partner who had ruffed in with the 9 of trump (the lowest RANK_VALUE
        # there is) as beatable by every Queen in hand. That is not a near miss:
        # it skipped the feed-partner tier below and threw the cheapest card into
        # a trick this side had already won. `Card.beats` asks the question that
        # is actually being asked - trump over non-trump, else rank within the
        # suit - and here every legal card is of the lead suit, so it returns
        # False against any trump, correctly: no card of the lead suit can take a
        # trick a trump is winning.
        forced_beat = winner_card is not None and all(
            c.beats(winner_card, trump) for c in legal_moves
        )
        # Second seat after an opponent's lead, partner last: feed the King
        # for partner rather than beat cheaply (`_feed_ahead`).
        if forced_beat and _feed_ahead(hand, trick_plays, my_team_players, tracker):
            return _feed_partner(legal_moves)
        if forced_beat:
            return min(legal_moves, key=lambda c: RANK_VALUE[c.rank])
        if partner_winning:
            return _feed_partner(legal_moves)
        non_points = [c for c in legal_moves if c.rank not in POINT_RANKS]
        if non_points:
            return min(non_points, key=lambda c: RANK_VALUE[c.rank])
        return min(legal_moves, key=lambda c: RANK_VALUE[c.rank])

    if all_trump:
        trump_secure = True
        if tracker is not None:
            played_trump = sum(tracker.played_count(trump, r) for r in RANKS)
            hand_trump = sum(1 for c in hand if c.suit == trump)
            trump_secure = (played_trump + hand_trump) >= 12
        if trump_secure:
            return min(legal_moves, key=lambda c: RANK_VALUE[c.rank])
        points = [c for c in legal_moves if c.rank in POINT_RANKS]
        if points:
            return min(points, key=lambda c: RANK_VALUE[c.rank])
        return min(legal_moves, key=lambda c: RANK_VALUE[c.rank])

    # Sluff - free choice across suits. Protect count cards first, then work
    # toward a void in the shortest suit, lowest rank within it. This is the
    # expert tier's rule (`_expert_follow_card_honest`), adopted here on Paul's
    # ruling of 2026-09-22 that the expert tier is right, so Python has one
    # sluff rule rather than two that disagree. The old form - suit length
    # then rank with point value not consulted - handed away a lone King from
    # a one-card suit ahead of a 9 from a two-card one. Measured as the
    # TypeScript `sluff` A/B on the equalised harness: +4, +5 and +2 a deal
    # (95% CIs -1 to +9, -1 to +11, -1 to +6), a null that leans the right way
    # and costs nothing detectable.
    return _sluff_card(hand, legal_moves)


# ---------------------------------------------------------------------------
# Passing strategy — skill-level-proficient, split by trump category
# (Diamonds/Spades vs Hearts/Clubs) and role (bidder vs partner).
# ---------------------------------------------------------------------------

def _breaks_marriage(hand, card):
    """Would removing this K/Q break an existing marriage in its suit?"""
    if card.rank not in ("K", "Q"):
        return False
    other_rank = "Q" if card.rank == "K" else "K"
    return _n_of(hand, card.suit, other_rank) >= 1


def _breaks_around(hand, card):
    """Would removing this card break an existing 'around' meld (all 4
    suits present) for its rank?"""
    if card.rank not in ("A", "K", "Q", "J"):
        return False
    if min(_n_of(hand, s, card.rank) for s in Suit) < 1:
        return False
    return _n_of(hand, card.suit, card.rank) == 1


def _protects_a_ten(hand, trump, card):
    """Is this one of the two Aces that make a 10 of its own suit protected?

    The corollary of `_is_protected_ten`, and not optional. The reason to
    keep the 10 is that both Aces are behind it, so a pass rule that keeps
    the 10 while shedding an Ace produces the one outcome that is strictly
    worse than shedding the 10 was: a bare 10 with nothing left to make it
    win. A-A-10 of a non-trump suit is a running suit, and the pass tiers
    below move it as a unit rather than as three independent cards.
    """
    return (
        card.rank == "A"
        and card.suit != trump
        and _n_of(hand, card.suit, "A") == 2
        and _n_of(hand, card.suit, "10") >= 1
    )


def _in_protected_ten_run(hand, trump, card):
    """A-A-10 of a non-trump suit, as one group (#276) - see the two
    predicates above."""
    return _is_protected_ten(hand, trump, card) or _protects_a_ten(hand, trump, card)


# Within the protected group, if it has to be broken up at all, the 10 is
# the cheapest piece to give up: the two Aces still win their tricks
# without it, while a lone Ace does nothing for a 10 left behind.
_PROTECTED_RUN_SHED_ORDER = {"10": 0, "A": 1}


def _take(pool, chosen, count, predicate, sort_key=lambda c: 0):
    """Move matching cards from pool into chosen (in place) until count is hit."""
    cands = sorted([c for c in pool if predicate(c)], key=sort_key)
    for c in cands:
        if len(chosen) >= count:
            return
        chosen.append(c)
        pool.remove(c)


# Inside the trump tiers, a spread beats duplicates. The bidder is building
# a Run - A-10-K-Q-J of the trump suit - so three distinct trump ranks are
# worth far more to them than two copies of one rank, which fills a single
# slot of that run and leaves the rest of it open. Paul, 2026-09-02: "do
# not send KKQ of trump if you have other trump J or better. The goal is
# for a Run so you want to send a spread."
_TRUMP_RUN_ORDER = {"A": 0, "10": 1, "K": 2, "Q": 3, "J": 4}


def _take_spread(pool, chosen, count, predicate, rank_order):
    """Like `_take`, in rank order, but at most one card of any one rank.

    K-K-Q-J of trump sends K, Q and J and keeps the spare King. Nothing is
    thrown away by declining that second King: the leftover-trump tier
    picks the duplicates back up further down the list, once the side Aces
    have had their turn.

    `seen` is per-call rather than read off `chosen`, deliberately - the
    two trump tiers that use this cover disjoint ranks (A/10/J and K/Q) so
    they have nothing to share, while the Q(S) an earlier tier may already
    have sent is a Queen of another suit entirely and must not block the
    Queen of trump.
    """
    seen = set()
    for c in sorted([c for c in pool if predicate(c)], key=lambda c: rank_order[c.rank]):
        if len(chosen) >= count:
            return
        if c.rank in seen:
            continue
        seen.add(c.rank)
        chosen.append(c)
        pool.remove(c)


# The partner's last tier, once trump, Aces and 9s have all gone: J, then
# 10, then Q, then K, in increasing cost to give away. Paul, 2026-09-02:
# "You do not want to pass points, 10 and K, and K are even worse because
# they make marriages, this is also why keeping a Q is better." So: a Jack
# is neither a counter nor a marriage card and costs nothing, a 10 is a
# counter, a Queen carries a marriage, and a King is both.
#
# There is deliberately NO exception here for the protected 10 of #276, and
# the reason is worth stating because the instinct to add one is strong and
# will come back. Every tier above this one runs to exhaustion - `_take`
# stops only when the pass is full, and if the pass were full this tier
# would never run at all - so reaching it means the non-trump Ace tier has
# already sent *every* Ace this hand had. `_is_protected_ten` reads the
# hand as it was dealt, so by now it is answering a question about a hand
# that no longer exists: both Aces are in the bidder's hand, not this one.
# Holding the 10 back would leave the partner a bare 10 and deny the bidder
# the one card those two Aces would protect over there. That is the mirror
# of #276's own lesson - protection is a property of what *remains* after
# the pass, not of the hand you started with.
_PARTNER_FILLER_ORDER = {"J": 0, "10": 1, "Q": 2, "K": 3}
# The default is unreachable in practice - trump, Aces and 9s are all gone
# by the time this tier runs - and is here so the tier can double as the
# catch-all that guarantees `count` gets filled.
_PARTNER_FILLER_LAST = 4


def _partner_pass_selection(hand, trump, category, count):
    """
    Partner's send-to-bidder priority (Paul's rework, #280):

      1. Q(S)/J(D) - D/S category only
      2. Trump A, 10, J - at most one of each rank
      3. Trump K, Q - at most one of each rank
      4. Non-trump Aces, singletons before pairs
      5. Whatever trump is left above the 9, highest first
      6. The 9 of trump (the dix)
      7. Void building
      8. Any 9
      9. J, then 10, then Q, then K

    Two of those orderings are not self-evident. A/10/J comes before K/Q
    because the partner may want to keep the royal marriage - Paul: "really
    if you have enough Trump you might keep the Royal Marriage." Three
    slots are often used up before tier 3 is reached at all, and the A, the
    10 and the J fill the run's other ranks without breaking a K-Q pair
    this hand can still score. And tiers 2, 3 and 5 between them prefer a
    spread over duplicates: see `_take_spread` for why, and
    `_PARTNER_FILLER_ORDER` for tier 9's order.
    """
    pool = list(hand)
    chosen = []

    if category == "DS":
        _take(pool, chosen, count,
              lambda c: (c.suit == Suit.SPADES and c.rank == "Q")
              or (c.suit == Suit.DIAMONDS and c.rank == "J"))

    _take_spread(pool, chosen, count,
                 lambda c: c.suit == trump and c.rank in ("A", "10", "J"),
                 {"A": 0, "10": 1, "J": 2})

    # King before Queen for the same reason tier 9 gives a Queen away before
    # a King: of the two, the King is the more expensive card to be left
    # holding, so it is the better one to have gone.
    _take_spread(pool, chosen, count,
                 lambda c: c.suit == trump and c.rank in ("K", "Q"),
                 {"K": 0, "Q": 1})

    _take(pool, chosen, count, lambda c: c.suit != trump and c.rank == "A",
          sort_key=lambda c: 0 if _n_of(hand, c.suit, "A") == 1 else 1)

    # The duplicate trump the two spread tiers declined, highest first -
    # ahead of the dix, which scores its 10 for the team wherever it sits.
    _take(pool, chosen, count, lambda c: c.suit == trump and c.rank != "9",
          sort_key=lambda c: _TRUMP_RUN_ORDER[c.rank])

    _take(pool, chosen, count, lambda c: c.suit == trump and c.rank == "9")

    # Void opportunity: once the intentional trump-building/ace tiers are
    # done, a clean full-suit void beats scattering leftover 9s/filler.
    if len(chosen) < count:
        is_protected = lambda c: c.suit == trump  # partner has no QS/JD-style personal protection
        void_cards = _find_void_opportunity(pool, trump, is_protected, count - len(chosen))
        if void_cards:
            for c in void_cards:
                if len(chosen) >= count:
                    break
                chosen.append(c)
                pool.remove(c)

    _take(pool, chosen, count, lambda c: c.rank == "9")

    # Everything else, cheapest to give away first. Doubles as the
    # catch-all: the predicate matches any card, so `count` is always filled.
    _take(pool, chosen, count, lambda c: True,
          sort_key=lambda c: _PARTNER_FILLER_ORDER.get(c.rank, _PARTNER_FILLER_LAST))

    return chosen[:count]


def _find_void_opportunity(hand, trump, is_protected, remaining_count):
    """
    Look for a non-trump suit where EVERY card is safe to pass (not
    protected, not an Ace) and the whole suit fits within the remaining
    pass slots - fully voiding it unlocks immediate trump control, which
    beats scattering the same number of cards across multiple suits.
    Prefers the largest such suit (most impactful void).
    """
    candidates = []
    for suit in Suit:
        if suit == trump:
            continue
        suit_cards = [c for c in hand if c.suit == suit]
        if not suit_cards or len(suit_cards) > remaining_count:
            continue
        if all(not is_protected(c) and c.rank != "A" for c in suit_cards):
            candidates.append(suit_cards)
    if not candidates:
        return None
    candidates.sort(key=lambda cards: -len(cards))
    return candidates[0]


def _bidder_pass_selection(hand, trump, category, count):
    """
    Bidder's send-back-to-partner priority (Paul's rework, #280):

      1. Q(S)/J(D) - H/C category only, unconditional
      2. Void building
      3. Spare K/Q doing no meld work
      4. Non-trump 10s, unprotected ones only (#276)
      5. Non-trump J/9 that breaks no marriage and no around
      6. Any unprotected non-Ace
      7. Any unprotected card
      8. Trump 9s and Js - H/C category only
      9. Anything left

    The bidder does not send an Ace back. Nothing above tier 7 can pick
    one up, and tier 7 only fires on a hand with nothing unprotected left
    in it at all. #280 removed the one tier that ever did so on purpose -
    Paul: "I took them out on purpose. I want to see the play before I add
    pro moves."

    Tier 8 is the all-trump-and-Aces hand: when nothing safe is left, the
    low trump goes rather than a card the bid is counting on. H/C only,
    because with Spades or Diamonds trump a trump J or 9 can be a pinochle
    card or sit in the run. It is placed ahead of the take-anything tier
    rather than after it - after it, it could never run, since by then
    every remaining card is protected.

    The "non-trump 10s" tier means *unprotected* 10s only (#276). A 10
    with both Aces of its suit behind it is a winner the bidder can cash
    by playing that suit out last, not a liability, so it is held out of
    that tier - and out of the void tier, the other place a piece of that
    A-A-10 group could leave early - and reaches the shed list only at
    "any unprotected non-ace", behind every J/9 rag. See
    `_is_protected_ten` for the rule and Paul's reasoning.
    """
    pool = list(hand)
    chosen = []

    is_protected = lambda c: (
        c.suit == trump
        or (c.suit == Suit.SPADES and c.rank == "Q")
        or (c.suit == Suit.DIAMONDS and c.rank == "J")
    )

    if category == "HC":
        # Unconditional since #280. The exception this used to carry - keep
        # them when the hand holds Queens Around plus a pinochle plus a run
        # card - was removed deliberately, not lost.
        _take(pool, chosen, count,
              lambda c: (c.suit == Suit.SPADES and c.rank == "Q")
              or (c.suit == Suit.DIAMONDS and c.rank == "J"))

    # Void opportunity: fully emptying a suit unlocks immediate trump
    # control, which beats scattering the same number of cards - check
    # this before falling into the generic rank tiers.
    if len(chosen) < count:
        void_cards = _find_void_opportunity(
            pool, trump,
            lambda c: is_protected(c) or _in_protected_ten_run(hand, trump, c),
            count - len(chosen))
        if void_cards:
            for c in void_cards:
                if len(chosen) >= count:
                    break
                chosen.append(c)
                pool.remove(c)

    # Spare K/Q not currently doing meld work (only QS is inherently
    # protected - KS and other K/Q are fair game here). #280 moved this
    # ahead of the 10s and the J/9 filler: a King or Queen in no marriage
    # and no around is scoring nothing in this hand, and it may well find
    # the card that marries it in the partner's.
    _take(pool, chosen, count,
          lambda c: not is_protected(c) and c.rank in ("K", "Q")
          and not _breaks_marriage(hand, c) and not _breaks_around(hand, c))

    # Non-trump 10s - but not one that both Aces of its suit make a winner
    # (#276); that one falls through to the "any unprotected non-ace" tier,
    # behind the J/9 filler this bidder can spend more cheaply.
    _take(pool, chosen, count,
          lambda c: not is_protected(c) and c.rank == "10"
          and not _is_protected_ten(hand, trump, c))

    # Safe filler: non-trump J/9, only if it doesn't break a marriage/around
    _take(pool, chosen, count,
          lambda c: not is_protected(c) and c.rank in ("J", "9")
          and not _breaks_marriage(hand, c) and not _breaks_around(hand, c))

    # Any unprotected non-ace (Aces stay off-limits until the tier below)
    _take(pool, chosen, count, lambda c: not is_protected(c) and c.rank != "A")

    # Any unprotected card at all, including Aces if truly nothing else is left
    _take(pool, chosen, count, lambda c: not is_protected(c))

    if category == "HC":
        # Nothing safe is left: the hand is trump and Aces. Low trump goes
        # before the run and the marriages do. H/C only - a trump J or 9 in
        # Spades or Diamonds can be a pinochle card or a run card.
        _take(pool, chosen, count,
              lambda c: c.suit == trump and c.rank in ("J", "9"))

    # True last resort: protected cards
    _take(pool, chosen, count, lambda c: True)

    return chosen[:count]


# ---------------------------------------------------------------------------
# Expert-tier pass logic (issue #61) — implements
# pinochle_expert_ai_strategy.md Sections 2 (forward pass) and 3 (return
# pass) as shared, callable logic, per the doc's Appendix: "there should be
# exactly one implementation of 'how a partner passes', not two that can
# drift apart." `choose_forward_pass_cards`/`choose_return_pass_cards` are
# deliberately free functions, independent of the Proficient-tier
# `_partner_pass_selection`/`_bidder_pass_selection` above (which stay
# untouched — Proficient is the tournament control group, see
# CLAUDE.md/README.md) and of any Player subclass, so both a future
# ExpertPlayer (#63) and the rollout sampler's internal simulated players
# (pinochle_rollout.py, #59) can call into the exact same code. Pure
# functions over a hand + trump + count, independent of the rollout
# machinery itself (per issue #61's Scope note) — callers that want
# rollout-compare mode (Section 2) wire in a `rollout_evaluator` callback
# from the outside; this module never imports pinochle_rollout.
# ---------------------------------------------------------------------------

def _pad_pass_selection(hand, chosen, count):
    """Safety net matching Player.choose_pass_cards' own fallback: the
    tiered logic above should always fill `count`, but pad deterministically
    with whatever's left rather than ever returning short."""
    if len(chosen) < count:
        remaining = [c for c in hand if c not in chosen]
        chosen = chosen + remaining[:count - len(chosen)]
    return chosen[:count]


def _tier0_forward_pass_candidates(hand, trump):
    """
    Section 2 Tier 0 — "always chase if missing": cards the partner should
    unconditionally offer toward the bidder's meld, in priority order:

      1. QS / JD (Pinochle) — trump-independent, always a candidate since
         the physical cards are QS/JD specifically.
      2. Trump A/10/K/Q/J (Run/Marriage) — trump-suit only, in RUN_RANKS
         order (A, 10, K, Q, J).
      3. Any Ace, any suit (Aces Around only).

    Hard exclusion (doc-confirmed, not implemented here by omission, not
    by a negative check): Kings/Queens/Jacks Around are NEVER chased, from
    zero or from partial progress — no "3 Kings implies partner might hold
    a Queen" heuristic. That kind of inference is meant to emerge from the
    rollout itself (Section 0), not be hardcoded. A trump K/Q/J still shows
    up here, but only via the Run/Marriage tier above, not because of
    Kings/Queens/Jacks Around.
    """
    pool = list(hand)
    chosen = []
    limit = len(hand)

    _take(pool, chosen, limit,
          lambda c: (c.suit == Suit.SPADES and c.rank == "Q")
          or (c.suit == Suit.DIAMONDS and c.rank == "J"))

    _take(pool, chosen, limit,
          lambda c: c.suit == trump and c.rank in RUN_RANKS,
          sort_key=lambda c: RUN_RANKS.index(c.rank))

    _take(pool, chosen, limit, lambda c: c.rank == "A")

    return chosen


def _tier1_forward_pass_candidates(hand, trump, exclude):
    """
    Section 2 Tier 1 — fallback shedding, used only when Tier 0 doesn't
    fill all slots (static mode) or as the competing alternative to a
    marginal Tier 0 pick (rollout-compare mode). Priority order:

      1. **Unprotected** non-trump 10s not already chosen — a 10 with no
         Ace of its own suit behind it has zero meld value outside a
         trump-only Run/Double Run and no way to win a trick either, so it
         is pure liability (same reasoning as the return-pass rule in
         Section 3).
      2. Other unprotected non-trump count-cards (A/K) that wouldn't break
         partner's own kept marriage/around.
      3. Void-building filler: a whole non-trump suit that fits the
         remaining slots and contains nothing protected.
      4. Any other non-trump card that doesn't break a kept meld.
      5. A **protected** A-A-10 group (`_in_protected_ten_run`, #276): both
         Aces of a non-trump suit and the 10 they hold up. The suit can be
         played out last and the 10 takes a trick behind the Aces, so this
         is a winner rather than a liability and it is shed only once every
         ordinary rag is gone — the 10 first if the group has to break.
      6. True last resort: anything left (surplus trump, or a card that
         would break a kept meld).

    A 10's protection is measured against what will still be here after
    the pass, not against the whole hand, which is why the group test uses
    `exclude`'s complement. Tier 0 ships every Ace it can reach, so in the
    common case both Aces are already committed to the Bidder, the 10 is
    NOT protected in what remains, and it sheds at tier 1 exactly as
    before — which is right: it follows the Aces into the hand that can
    now cash all three. Tier 5 only bites when Tier 0 found three better
    cards than the Aces and the running suit is staying put.

    Concrete doc example: partner holds 10-K-Q of a non-trump suit and
    nothing Tier-0 eligible — keeps K+Q (preserves the 20-pt Common
    Marriage), ships the 10 (tier 1). That still holds, because the 10
    there is unprotected. Never proposes a card that would break the
    partner's own kept meld ahead of one that wouldn't.
    """
    pool = [c for c in hand if c not in exclude]
    chosen = []
    limit = len(pool)

    keeps_meld = lambda c: _breaks_marriage(hand, c) or _breaks_around(hand, c)

    # Frozen before the tiers run, so the group test reads the post-Tier-0
    # hand and does not evaporate as `_take` empties `pool` (#276).
    kept = list(pool)
    protected_run = lambda c: _in_protected_ten_run(kept, trump, c)

    _take(pool, chosen, limit,
          lambda c: c.suit != trump and c.rank == "10" and not protected_run(c),
          sort_key=lambda c: _suit_length(hand, c.suit))

    _take(pool, chosen, limit,
          lambda c: c.suit != trump and c.rank in POINT_RANKS and not keeps_meld(c)
          and not protected_run(c),
          sort_key=lambda c: _suit_length(hand, c.suit))

    if len(chosen) < limit:
        void_cards = _find_void_opportunity(
            pool, trump, lambda c: keeps_meld(c) or protected_run(c), limit - len(chosen))
        if void_cards:
            for c in void_cards:
                if c in pool and len(chosen) < limit:
                    chosen.append(c)
                    pool.remove(c)

    _take(pool, chosen, limit,
          lambda c: c.suit != trump and not keeps_meld(c) and not protected_run(c))

    # The protected A-A-10 group (#276): behind every ordinary rag, ahead
    # only of surplus trump and cards that would break a kept meld.
    _take(pool, chosen, limit, protected_run,
          sort_key=lambda c: _PROTECTED_RUN_SHED_ORDER[c.rank])

    _take(pool, chosen, limit, lambda c: True)

    return chosen


def choose_forward_pass_cards(hand, trump, count, rollout_evaluator=None):
    """
    Section 2 entry point: partner -> bidder pass selection. Combines Tier
    0 ("always chase if missing", `_tier0_forward_pass_candidates`) and
    Tier 1 fallback shedding (`_tier1_forward_pass_candidates`).

    **Resolved v1 design (doc Section 9 Q1 / issue #61's revised open
    question)**: whether Tier 1 can outrank a marginal Tier 0 pick is NOT
    one fixed global rule — it's a static-mode-vs-rollout-compare-mode
    split tied to skill level (see #63's GeneralStrategy dial):

      - `rollout_evaluator=None` (static/no-rollout-budget skill levels):
        Tier 1 is a strict last resort — it only fills slots Tier 0 left
        empty, and never outranks a Tier 0 pick. Intentionally not the
        smartest possible play; that gap is part of what makes low skill
        actually play worse.
      - `rollout_evaluator` supplied (rollout-budget skill levels): no
        hardcoded ranking. When Tier 0 alone has enough candidates to fill
        every slot, this generates two candidate pass sets — the static
        all-Tier-0 pick, and one that swaps the single lowest-priority
        ("marginal") Tier 0 card for the best competing Tier 1 card — and
        lets `rollout_evaluator` pick the winner by simulated EV. This is
        what lets higher skill levels discover the cases where shedding
        differently is actually correct, instead of following a fixed
        rule.

    `rollout_evaluator`, if provided, must be a callable:

        rollout_evaluator(hand, trump, candidate_cards) -> float

    returning a higher-is-better simulated EV for passing exactly
    `candidate_cards` (a list of `count` Card objects drawn from `hand`).
    This function only needs that numeric comparison — it never imports or
    calls into pinochle_rollout.py itself, so it stays pure/testable
    against constructed hands independent of the rollout machinery (a
    caller wires a real evaluator on top of `monte_carlo_rollout`/
    `rollout_deal` from pinochle_rollout.py, #59, elsewhere).
    """
    tier0 = _tier0_forward_pass_candidates(hand, trump)

    if len(tier0) < count:
        # Tier 0 has nothing left to offer for the remaining slots — both
        # modes agree here, there's no marginal pick to compare against.
        chosen = list(tier0)
        tier1 = _tier1_forward_pass_candidates(hand, trump, exclude=chosen)
        chosen += tier1[:count - len(chosen)]
        return _pad_pass_selection(hand, chosen, count)

    static_chosen = tier0[:count]
    if rollout_evaluator is None:
        return static_chosen

    tier1 = _tier1_forward_pass_candidates(hand, trump, exclude=static_chosen)
    if not tier1:
        return static_chosen  # nothing to compare against — static and compare modes agree

    marginal_kept = static_chosen[:-1]
    competing_tier1_pick = tier1[0]
    candidate_static = static_chosen
    candidate_compare = marginal_kept + [competing_tier1_pick]

    ev_static = rollout_evaluator(hand, trump, candidate_static)
    ev_compare = rollout_evaluator(hand, trump, candidate_compare)
    return candidate_compare if ev_compare > ev_static else candidate_static


def _first_n_of(hand, suit, rank, n):
    return [c for c in hand if c.suit == suit and c.rank == rank][:n]


def _return_pass_meld_groups(hand, trump):
    """
    Section 3 knapsack input: every meld currently present in `hand` (same
    categories as `score_melds`), as (value, name, required_cards) triples.
    `required_cards` are the exact physical Card objects that meld needs —
    deliberately allowed to overlap across groups (e.g. the trump Queen is
    part of Run, Royal Marriage and, in spades, Pinochle using the very
    same card), since `_knapsack_lock_return_pass_melds` below dedupes by
    tracking what's already locked rather than by partitioning cards into
    disjoint pools.

    The Royal Marriage line stays at the full `royal_count` here even though
    `score_melds` now subtracts the run's own K+Q (#273). That is not drift:
    this is a list of *candidates* for a knapsack that may decline to keep
    the Run whole, and a hand whose run gets broken up still melds the
    marriage. What the group is worth is what it is worth if kept, and with
    the Run also kept the overlap costs nothing, because locking dedupes.
    """
    groups = []

    def n(suit, rank):
        return _n_of(hand, suit, rank)

    run_count = min(n(trump, r) for r in RUN_RANKS)
    if run_count == 2:
        cards = [c for r in RUN_RANKS for c in _first_n_of(hand, trump, r, 2)]
        groups.append((DOUBLE_RUN_VALUE, "Double Run", cards))
    elif run_count == 1:
        cards = [c for r in RUN_RANKS for c in _first_n_of(hand, trump, r, 1)]
        groups.append((RUN_VALUE, "Run", cards))

    royal_count = min(n(trump, "K"), n(trump, "Q"))
    if royal_count:
        cards = _first_n_of(hand, trump, "K", royal_count) + _first_n_of(hand, trump, "Q", royal_count)
        groups.append((royal_count * ROYAL_MARRIAGE_VALUE, "Royal Marriage", cards))

    for suit in Suit:
        if suit == trump:
            continue
        cm = min(n(suit, "K"), n(suit, "Q"))
        if cm:
            cards = _first_n_of(hand, suit, "K", cm) + _first_n_of(hand, suit, "Q", cm)
            groups.append((cm * COMMON_MARRIAGE_VALUE, f"Common Marriage ({suit.value})", cards))

    dix_count = n(trump, "9")
    if dix_count:
        groups.append((dix_count * DIX_VALUE, "Dix", _first_n_of(hand, trump, "9", dix_count)))

    qs_count = n(Suit.SPADES, "Q")
    jd_count = n(Suit.DIAMONDS, "J")
    pin_count = min(qs_count, jd_count)
    if pin_count == 2:
        cards = _first_n_of(hand, Suit.SPADES, "Q", 2) + _first_n_of(hand, Suit.DIAMONDS, "J", 2)
        groups.append((PINOCHLE_DOUBLE_VALUE, "Double Pinochle", cards))
    elif pin_count == 1:
        cards = _first_n_of(hand, Suit.SPADES, "Q", 1) + _first_n_of(hand, Suit.DIAMONDS, "J", 1)
        groups.append((PINOCHLE_SINGLE_VALUE, "Pinochle", cards))

    for rank, base in AROUND_VALUES.items():
        around_count = min(n(s, rank) for s in Suit)
        if around_count == 2:
            cards = [c for s in Suit for c in _first_n_of(hand, s, rank, 2)]
            groups.append((base * AROUND_DOUBLE_MULTIPLIER, f"{rank}s Around (double)", cards))
        elif around_count == 1:
            cards = [c for s in Suit for c in _first_n_of(hand, s, rank, 1)]
            groups.append((base, f"{rank}s Around", cards))

    return groups


def _knapsack_lock_return_pass_melds(hand, trump, cap):
    """
    Section 3 knapsack triage: sort candidate meld groups by point value
    descending, greedily lock the cards each one needs — skipping cards a
    higher-value group already locked — as long as the running total stays
    within `cap` slots. A group that would push the total over `cap` is
    skipped ENTIRELY, never partially locked: doc example — a hand that
    could complete Kings Around (80) *and* Run (150) + Double Pinochle
    (300) + Aces Around (100) but lacks slots for all of it breaks Kings
    Around whole and keeps the higher group whole.

    **Resolved v1 default (doc Section 9 Q2)**: this has no "reopen a
    locked meld to chase its Double" step — a complete single meld that
    gets locked here stays locked for good, it is never broken later to
    protect progress toward a Double of the same meld. Documented here as
    the current default/tunable, same as Section 2's mode split.
    """
    groups = sorted(_return_pass_meld_groups(hand, trump), key=lambda g: -g[0])
    locked = []
    for _value, _name, cards in groups:
        additional = [c for c in cards if c not in locked]
        if len(locked) + len(additional) <= cap:
            locked.extend(additional)
    return locked


def _return_pass_pool_priority(pool, hand, trump):
    """
    Section 3 shedding priority within the return-pass pool (cards NOT
    locked by the knapsack triage — see `_knapsack_lock_return_pass_melds`).
    Objective: reduce the Bidder's count-card liability, pass loser-points
    to partner. Priority order:

      1. **Unprotected** non-trump 10s — zero meld value outside a
         trump-only Run/Double Run and nothing in the suit to make them
         win, so any such 10 is a top ship candidate (doc-mandated,
         tier-agnostic).
      2. Other unprotected non-trump count-cards (A/K) — reduces liability
         the Bidder would otherwise have to protect through 12 tricks.
      3. Void-building filler: a whole non-trump suit that fits the
         remaining slots.
      4. Any other non-trump card.
      5. A **protected** A-A-10 group (`_in_protected_ten_run`, #276): the
         Bidder holds both Aces of a non-trump suit and the 10 behind
         them, so the suit can be played out last and all three win. That
         is three tricks the declarer owns, not liability to hand off, and
         shipping the 10 could not buy the drop-on-partner's-Ace trick
         either — both Aces being here means the partner has none. The
         group is shed only after every ordinary non-trump card, and the
         10 goes first if it has to break at all.
      6. True last resort: trump (or anything left).

    Tier 2 has to know about the group as well, and that is the whole
    reason `_protects_a_ten` exists: keeping the 10 while tier 2 shipped
    the Aces out from under it would leave a bare 10, which is worse than
    what the code did before this rule (#276).
    """
    remaining = list(pool)
    chosen = []
    limit = len(remaining)

    # Everything reaching this pool is already NOT part of a locked meld
    # (that's what makes it pool, not locked), so there's no kept-meld to
    # break here. The one thing `_find_void_opportunity` still has to be
    # told to leave alone is a protected A-A-10 group (#276) — the void
    # tier is the only place a piece of it could leave without passing one
    # of the rank predicates below.
    #
    # Locked cards stay in the hand, so unlike the forward pass the group
    # test reads `hand` and not the pool: nothing has been committed away.
    protected_run = lambda c: _in_protected_ten_run(hand, trump, c)

    _take(remaining, chosen, limit,
          lambda c: c.suit != trump and c.rank == "10" and not protected_run(c),
          sort_key=lambda c: _suit_length(hand, c.suit))

    _take(remaining, chosen, limit,
          lambda c: c.suit != trump and c.rank in POINT_RANKS and not protected_run(c),
          sort_key=lambda c: _suit_length(hand, c.suit))

    if len(chosen) < limit:
        void_cards = _find_void_opportunity(remaining, trump, protected_run, limit - len(chosen))
        if void_cards:
            for c in void_cards:
                if c in remaining and len(chosen) < limit:
                    chosen.append(c)
                    remaining.remove(c)

    _take(remaining, chosen, limit, lambda c: c.suit != trump and not protected_run(c))

    _take(remaining, chosen, limit, protected_run,
          sort_key=lambda c: _PROTECTED_RUN_SHED_ORDER[c.rank])

    _take(remaining, chosen, limit, lambda c: True)

    return chosen


def choose_return_pass_cards(hand, trump, count):
    """
    Section 3 entry point: bidder -> partner pass selection. `hand` is the
    bidder's full 15-card hand (12 dealt + 3 already received from the
    forward pass) — no restriction on which cards can be returned,
    including ones just received (pinochle_rules.md).

    Knapsack-locks up to `len(hand) - count` cards to the hand's
    highest-value melds (`_knapsack_lock_return_pass_melds`), then ranks
    everything NOT locked by shedding priority
    (`_return_pass_pool_priority`) and ships the top `count`. Locking never
    exceeds `len(hand) - count` cards, so the pool is always guaranteed at
    least `count` cards — the fallback pad below is just a defensive net,
    not expected to ever trigger in practice.
    """
    cap = len(hand) - count
    locked = _knapsack_lock_return_pass_melds(hand, trump, cap)
    pool = [c for c in hand if c not in locked]
    chosen = _return_pass_pool_priority(pool, hand, trump)[:count]
    return _pad_pass_selection(hand, chosen, count)


# ---------------------------------------------------------------------------
# Expert-tier trick-play logic (issue #62) — implements
# pinochle_expert_ai_strategy.md Section 4 (trick-play strategy) and, gated
# behind an optional deception_evaluator, Section 7 (deception) as shared,
# callable logic. Same design shape as Section 2/3's
# choose_forward_pass_cards / choose_return_pass_cards above (issue #61):
# free functions, independent of any Player subclass and of the Proficient-
# tier choose_lead_card / choose_follow_card (which stay untouched — that's
# the tournament control group, see CLAUDE.md/README.md) — reused/extended
# here rather than duplicated, per this issue's Scope note. A future
# ExpertPlayer (#63) and the rollout sampler's internal simulated players
# (pinochle_rollout.py, #59) can both call into the exact same code. This
# module never imports pinochle_rollout — callers that want rollout-compare
# mode (defenders' trump-lead question, Section 9 Q5) or deception wire in
# real evaluator callbacks from the outside, built on top of
# monte_carlo_rollout/rollout_deal elsewhere, matching #61's precedent of
# leaving that wiring to the GeneralStrategy issue.
# ---------------------------------------------------------------------------



def _trick_has_points(trick_plays):
    return any(c.rank in POINT_RANKS for _, c in trick_plays)


def _trump_fully_accounted(hand, trump, tracker):
    """
    Conservative proxy for Section 4's endgame trigger, "no trump remains
    live among opponents". Real trick play only ever exposes this player's
    own hand plus PlayTracker's played-so-far counts — never partner's
    hand — so there is no way to prove trump is specifically dead among
    *opponents* without also knowing partner's hand. This reuses the same
    accounted-for pattern as `is_safe`/`is_unsecured_ace` above: sum
    played-count + this hand's own count for every trump rank, and only
    fire when that reaches all 12 copies (i.e. no trump card remains
    unaccounted for ANYWHERE — a strictly stronger, always-safe subset of
    "dead among opponents", since it also implies dead among partner).
    Documented as the current default/tunable, same spirit as Section
    2/3's resolved v1 defaults.
    """
    accounted = sum(
        tracker.played_count(trump, rank) + _hand_count(hand, trump, rank)
        for rank in RANKS
    )
    return accounted >= TOTAL_TRUMP_COPIES


def _offense_trump_lead(hand, trump, tracker):
    """
    Section 4 "Bidder leading — draw trump", shared by both the Bidder and
    the Bidder's partner (doc Section 9 Q4, resolved for v1: the partner
    runs this exact same logic independently if *they* end up on lead —
    no special-casing that defers to the Bidder's plan). Callers on the
    bidding team (either seat) call this same function; there is exactly
    one implementation of "how the offense leads trump", not two that can
    drift apart.

    1. If a trump Ace is held, it is always the first lead — unconditionally
       (doc Section 4 point 1: unbeatable by rank, risk-free, and clarifies
       whether the second Ace is still live).
    2. Otherwise (doc Section 9 Q3, resolved for v1): this is a mid-hand
       behavioral shift, not a bid-time refusal — the contract is kept
       (bid-time EV already priced this risk in), but the aggressive
       trump-draw plan is abandoned in favor of a conservative lead:
       protect count cards, don't force trump out. Concretely, this
       prefers any non-trump lead (via the existing safe-card cascade,
       `choose_lead_card`) over proactively leading trump; trump is only
       led here if it's literally all that's left in hand.
    """
    trump_aces = [c for c in hand if c.suit == trump and c.rank == "A"]
    if trump_aces:
        return trump_aces[0]

    non_trump = [c for c in hand if c.suit != trump]
    if non_trump:
        return choose_lead_card(non_trump, trump, tracker)
    return choose_lead_card(hand, trump, tracker)


def _defender_lead(hand, trump, tracker, rollout_evaluator=None):
    """
    Section 4 "Defending team" — doc Section 9 Q5, revised resolution: NOT
    one fixed global rule, the same static-mode-vs-rollout-compare-mode
    split as #61, tied to skill level (see #63's dial):

      - `rollout_evaluator=None` (static/no-rollout-budget skill levels):
        avoid leading trump — it helps the Bidder consolidate control —
        and instead attack the Bidder's weakest suit. Implemented as the
        existing safe-card cascade (`choose_lead_card`) restricted to
        non-trump cards (falls back to trump only when the hand is
        entirely trump, i.e. there is no other legal lead at all).
      - `rollout_evaluator` supplied (rollout-budget skill levels): no
        hardcoded avoidance. Generates both the static non-trump-lead
        candidate AND a trump-lead candidate, and lets
        `rollout_evaluator` pick whichever scores better in this exact
        game state — e.g. once the Bidder is nearly out of trump, leading
        trump may no longer help them and the flat avoidance rule would
        be wrong. This is exactly the kind of exception higher skill
        should be able to find that the static rule can't.

    `rollout_evaluator`, if provided, must be a callable:

        rollout_evaluator(hand, trump, tracker, candidate_card) -> float

    returning a higher-is-better simulated EV for leading `candidate_card`
    in this exact state. This function only needs that numeric comparison
    — it never imports or calls into pinochle_rollout.py itself, so it
    stays pure/testable against constructed hands independent of the
    rollout machinery (a caller wires a real evaluator on top of
    `monte_carlo_rollout`/`rollout_deal` from pinochle_rollout.py, #59,
    elsewhere).
    """
    non_trump = [c for c in hand if c.suit != trump]
    trump_cards = [c for c in hand if c.suit == trump]

    static_pick = (
        choose_lead_card(non_trump, trump, tracker) if non_trump
        else choose_lead_card(hand, trump, tracker)
    )

    if rollout_evaluator is None or not trump_cards or not non_trump:
        return static_pick

    trump_pick = choose_lead_card(trump_cards, trump, tracker)
    ev_static = rollout_evaluator(hand, trump, tracker, static_pick)
    ev_trump = rollout_evaluator(hand, trump, tracker, trump_pick)
    return trump_pick if ev_trump > ev_static else static_pick


def choose_expert_lead_card(hand, trump, tracker, is_bidding_team,
                            is_bidder_first_lead=False, rollout_evaluator=None):
    """
    Section 4 entry point for leading (having table control). Order of
    decisions:

      0. Bidder's first lead (#82) — must lead trump if any is held,
         overriding all other considerations.
      1. Endgame sequencing (doc "Endgame sequencing — protect the
         last-trick bonus"): once no trump remains live among opponents
         (see `_trump_fully_accounted` for exactly what that means here)
         and this hand holds a mix of trump and non-trump cards, play
         losers first and hold trump back — this guarantees a trump card
         is still in hand to win trick 12's +10 bonus. Implemented by
         restricting the lead choice to non-trump cards via the existing
         safe-card cascade.
      2. Otherwise, dispatch by side: the bidding team (Bidder or
         partner, doc Section 9 Q4) uses the shared Ace-first trump-draw
         logic (`_offense_trump_lead`); the defending team (doc Section 9
         Q5) uses the static/rollout-compare split (`_defender_lead`).

    `rollout_evaluator` is only consulted for a defending-team lead (see
    `_defender_lead`) — the offense side's Ace-first rule has no
    static/compare split (doc Section 4 point 1 is unconditional).

    @param is_bidder_first_lead - When True (bidder opening the first trick of
      the round), forces a trump lead if the player has any trump cards, per
      rule #82.
    """
    # Bidder's first lead must be trump if they have any — rule #82
    if is_bidder_first_lead:
        trumps = [c for c in hand if c.suit == trump]
        if trumps:
            ace = next((c for c in trumps if c.rank == "A"), None)
            if ace:
                return ace
            return max(trumps, key=lambda c: RANK_VALUE[c.rank])

    non_trump = [c for c in hand if c.suit != trump]
    trump_cards = [c for c in hand if c.suit == trump]

    if trump_cards and non_trump and _trump_fully_accounted(hand, trump, tracker):
        return choose_lead_card(non_trump, trump, tracker)

    if is_bidding_team:
        return _offense_trump_lead(hand, trump, tracker)
    return _defender_lead(hand, trump, tracker, rollout_evaluator=rollout_evaluator)


def generate_false_card_candidates(hand, legal_moves, trick_plays, tracker):
    """
    Section 7 false-carding: legal alternative follow-plays that
    misrepresent this player's holding in the suit being played — e.g.
    playing a card other than the "honest" cheapest-sufficient/lowest
    choice so an opponent tracking per-copy history (`PlayTracker`, reused
    here rather than rebuilt) reads the remaining holding incorrectly.

    Only proposes a rank as a false-card candidate when it's still
    *believable* — i.e. the other physical copy of that exact (suit,
    rank) is not yet fully accounted for (played, or still in this hand)
    — so the deception isn't immediately self-defeating: playing a rank
    you're provably out of (because both copies are otherwise accounted
    for) wouldn't fool a card-counting opponent regardless of which one
    you play.

    Pure candidate generator — every returned card is drawn from
    `legal_moves`, so it is trivially still a legal move. Never called
    unless a caller supplies a `deception_evaluator` to
    `choose_expert_follow_card`; does not decide anything on its own.
    """
    if len(legal_moves) < 2:
        return []
    candidates = []
    for c in legal_moves:
        other_copy_accounted = (
            tracker.played_count(c.suit, c.rank) + _hand_count(hand, c.suit, c.rank) >= 2
        )
        if not other_copy_accounted:
            candidates.append(c)
    return candidates


def generate_fake_void_candidates(hand, legal_moves, trick_plays, trump, tracker):
    """
    Section 7 fake voids: only meaningful during a genuine free sluff —
    more than one suit represented among `legal_moves` — where discarding
    from a suit that already has at least one copy of that same card's
    rank recorded as played (via `PlayTracker`) is more believable as "I'm
    voiding this suit" than a first-ever discard from it would be.

    Pure candidate generator, same contract as
    `generate_false_card_candidates` — every returned card is drawn from
    `legal_moves`, so it is trivially still legal.
    """
    suits_present = {c.suit for c in legal_moves}
    if len(suits_present) < 2:
        return []  # no real choice of which suit to discard from
    candidates = []
    for c in legal_moves:
        if tracker.played_count(c.suit, c.rank) >= 1:
            candidates.append(c)
    return candidates


def _expert_follow_card_honest(hand, legal_moves, trick_plays, trump, my_team_players, tracker):
    """
    Section 4 "Following suit (general)" — the non-deceptive baseline
    follow-card choice `choose_expert_follow_card` builds on:

      - Mandatory-beat cases (`Trick.legal_moves` has already restricted
        `legal_moves` to beaters-only) win as cheaply as possible — this
        is where "third-hand-high" is mechanically enforced by the rules
        engine itself, so there's no separate heuristic needed for it.
      - Duck when partner is already winning: don't spend a big card on a
        trick that's already secured; feed a counter across if doing so is
        free (doesn't cost the trick). Delegates to `_feed_partner` — this
        tier had its own inline copy of that rule, and the copy carried the
        `max`-instead-of-`min` bug for the whole life of the function
        (#168, after #154 in TypeScript and #164 in `choose_follow_card`).
        Sharing the one helper is what stops a fourth copy drifting.
      - Protect count cards (A/10/K): when following suit but unable to
        beat, or when free-sluffing, prefer a zero-count card (9/J/Q)
        over a count card whenever one is legal.
      - Trump-in judgment when first to trump a trick (void of the lead
        suit, no trump yet on the table — the one point in this ruleset
        where trumping in is mandatory but *which* trump is a genuine
        free choice): over-trump (commit the highest trump held) only
        when the trick is worth winning — it already carries count
        points, or the partner isn't already the one showing as the
        trick's leader — otherwise under-trump (play the lowest trump
        held) to conserve high trump for later.
    """
    lead_suit = trick_plays[0][1].suit if trick_plays else None
    winner_player, winner_card = _current_winner(trick_plays, trump) if trick_plays else (None, None)
    partner_winning = winner_player is not None and winner_player in my_team_players

    all_lead_suit = lead_suit is not None and all(c.suit == lead_suit for c in legal_moves)
    all_trump = all(c.suit == trump for c in legal_moves)

    if all_lead_suit and lead_suit != trump:
        # Same fix as `choose_follow_card`'s copy, and for the same reason
        # (#173) - `winner_card` can be a trump from another suit, and comparing
        # a Heart's `RANK_VALUE` against a trump Spade's is not a trick-winning
        # comparison. `Card.beats` returns False for any lead-suit card against
        # a trump, which is the truth: this seat cannot take the trick, so it
        # should fall through to the feed/protect tiers below.
        #
        # This copy is the one skills 4-5 follow with at the table, so it is a
        # separate A/B arm from `choose_follow_card`'s (which Proficient and
        # skills 1-3 take). See that function's docstring for the measured
        # numbers there, and PR/issue #173 for this arm's - it is the slow,
        # noisy one #164 flagged, ~1.1 s/game against Proficient's 20 ms.
        forced_beat = winner_card is not None and all(
            c.beats(winner_card, trump) for c in legal_moves
        )
        # Same positional read as `choose_follow_card`: this is the copy skills
        # 4-5 follow with at the table, so it moves with it (`_feed_ahead`).
        if forced_beat and _feed_ahead(hand, trick_plays, my_team_players, tracker):
            return _feed_partner(legal_moves)
        if forced_beat:
            return min(legal_moves, key=lambda c: RANK_VALUE[c.rank])
        if partner_winning:
            return _feed_partner(legal_moves)
        non_points = [c for c in legal_moves if c.rank not in POINT_RANKS]
        if non_points:
            return min(non_points, key=lambda c: RANK_VALUE[c.rank])
        return min(legal_moves, key=lambda c: RANK_VALUE[c.rank])

    if all_trump:
        trump_on_table = any(c.suit == trump for _, c in trick_plays)
        if trump_on_table:
            current_best_trump = max(
                (c for _, c in trick_plays if c.suit == trump), key=lambda c: RANK_VALUE[c.rank]
            )
            # The third `forced_beat` in this file, and the one that is *correct*
            # on raw `RANK_VALUE` - deliberately not converted to `Card.beats`
            # when #173 converted the other two. This branch is `all_trump`, so
            # every card in `legal_moves` is trump and `current_best_trump` is
            # trump by construction: both sides of the comparison are already the
            # same suit, which is the precondition `Card.beats` exists to handle.
            # A search for `forced_beat` returns three hits and this one looks
            # identical out of context; changing it would be a regression.
            #
            # It is also inert either way, which is the belt to that braces and
            # is why no test can tell the two readings apart here: this tier and
            # the protect-count-card fallback below it return the *same card* for
            # every possible legal set, because pinochle's rank order (9 J Q K 10
            # A) puts every non-counter strictly below every counter, so
            # "min over the whole legal set" and "min over its non-counters"
            # coincide whenever a non-counter exists. Checked exhaustively over
            # all 2509 legal-set shapes up to six cards: zero disagreements.
            forced_beat = all(
                RANK_VALUE[c.rank] > RANK_VALUE[current_best_trump.rank] for c in legal_moves
            )
            if forced_beat:
                return min(legal_moves, key=lambda c: RANK_VALUE[c.rank])
            non_points = [c for c in legal_moves if c.rank not in POINT_RANKS]
            if non_points:
                return min(non_points, key=lambda c: RANK_VALUE[c.rank])
            return min(legal_moves, key=lambda c: RANK_VALUE[c.rank])

        worth_winning = _trick_has_points(trick_plays) or not partner_winning
        if worth_winning:
            return max(legal_moves, key=lambda c: RANK_VALUE[c.rank])
        return min(legal_moves, key=lambda c: RANK_VALUE[c.rank])

    # Free sluff - no lead-suit card, no trump forced. Same rule as the
    # Proficient-tier choose_follow_card (`_sluff_card`).
    return _sluff_card(hand, legal_moves)


def choose_expert_follow_card(hand, legal_moves, trick_plays, trump, my_team_players,
                               tracker=None, deception_evaluator=None):
    """
    Section 4 + Section 7 entry point for following (not leading).
    `legal_moves` already has the mandatory beat-if-possible / trump-if-
    void rules applied by `Trick.legal_moves` — this only picks which one
    to use.

    Computes the honest baseline (`_expert_follow_card_honest`) per the
    "Following suit (general)" heuristics. If `deception_evaluator` is
    supplied (Section 7 — gated to the top skill levels by the caller, not
    unconditionally on), also generates false-card and fake-void
    candidates (`generate_false_card_candidates` /
    `generate_fake_void_candidates`, both reusing `PlayTracker`'s per-copy
    tracking to judge believability) and lets the evaluator pick among the
    honest baseline plus every deceptive candidate — never a hardcoded
    "always false-card when X" rule. Every candidate considered is drawn
    from `legal_moves`, so the result is always a legal move regardless of
    whether deception is enabled.

    `deception_evaluator`, if provided, must be a callable:

        deception_evaluator(hand, trump, tracker, trick_plays, candidate_card) -> float

    returning a higher-is-better simulated EV for playing `candidate_card`
    in this exact trick-play state. As with `rollout_evaluator` elsewhere
    in this module, a caller wires a real evaluator on top of
    `monte_carlo_rollout`/`rollout_deal` (pinochle_rollout.py, #59)
    elsewhere — this module never imports pinochle_rollout.
    """
    tracker = tracker if tracker is not None else PlayTracker()
    honest = _expert_follow_card_honest(hand, legal_moves, trick_plays, trump, my_team_players, tracker)

    if deception_evaluator is None or len(legal_moves) < 2:
        return honest

    candidates = {honest}
    candidates.update(generate_false_card_candidates(hand, legal_moves, trick_plays, tracker))
    candidates.update(generate_fake_void_candidates(hand, legal_moves, trick_plays, trump, tracker))
    return max(
        candidates,
        key=lambda c: deception_evaluator(hand, trump, tracker, trick_plays, c),
    )


# ---------------------------------------------------------------------------
# Player / Team
# ---------------------------------------------------------------------------

class Player:
    # Per-seat override for the #326 loose-K/Q reading, so a paired A/B can
    # seat the two arms at one table: None follows the module's
    # LOOSE_KQ_PASS_ONLY (False), True/False pin it for this seat. Read by
    # choose_bid and choose_trump, the two places this seat values its hand.
    loose_kq_pass_only = None

    def __init__(self, name, team):
        self.name = name
        self.team = team
        self.hand = []

    def receive_cards(self, cards):
        self.hand.extend(cards)

    def choose_bid(self, current_bid, min_increment, context=None):
        """
        Proficient bidding logic, built on Base Bid plus positional and
        score-context rules. Falls back to the old coin-flip placeholder
        if called without context (keeps old call sites/tests working).

        context is a dict with:
          ever_bid, passes_so_far, bid_history (list of (player, amount)),
          dealer, teams (list of Team)
        """
        if context is None:
            if random.random() < 0.6:
                return None
            return current_bid + min_increment

        my_score = self.team.score
        opp_team = next(t for t in context["teams"] if t is not self.team)
        opp_score = opp_team.score

        _trump, ceiling, _ = best_base_bid(self.hand, my_score, opp_score,
                                           self.loose_kq_pass_only)

        partner = next(p for p in self.team.players if p is not self)
        is_dealer = (self is context["dealer"])
        partner_is_dealer = (partner is context["dealer"])

        # Endgame protection (#256) sits in front of every other bidding rule
        # and in front of the valuation, because it is not a judgement about
        # the hand at all - once the trigger holds, what the cards are worth
        # stops being the question. It replaces the old dealer-protection
        # tier outright (partner dealing, my_score >= 850, opp_score < 500,
        # open on anything): the new rule supersedes it on thresholds, adds
        # the hand floor whose absence was half of #255, and asks whether the
        # opponent ahead of us has actually passed rather than assuming it.
        if endgame_protection_applies(my_score, opp_score):
            return endgame_protection_bid(
                context, opp_team.players, partner_is_dealer, ceiling,
            )

        if not context["ever_bid"]:
            # 3rd bidder (2 passes already, no one's bid). This opened on *any*
            # hand at all to deny the last player a cheap contract, which is
            # the path #255 was filed about. It still opens on position rather
            # than on hand strength - that is what the tier is for, and the A/B
            # on THIRD_BIDDER_FLOOR says the position is genuinely worth
            # something - but there is a floor under it now, so a seat with no
            # meld and no aces lets the auction pass out instead.
            #
            # The floor is deliberately well below OPENER_THRESHOLD (320).
            # Paul's house rule is that a bid asserts a hand (ANCHOR_INTERCEPT
            # is its number); holding this open to OPENER_THRESHOLD cost 57
            # points a deal and 200 costs nothing detectable. The constant
            # carries the numbers.
            #
            # The >800 sub-case is gone: it applied OPENER_THRESHOLD, which is
            # no longer this rule's floor, and a seat near the end of the game
            # has #256's endgame protection in front of it doing that job with
            # thresholds chosen for it.
            # A hand worth a contract names the anchor (`opening_level_for`);
            # the positional open under it is still the bare OPENING_BID, since
            # that open asserts position, not a hand.
            if context["passes_so_far"] == 2:
                if ceiling >= OPENER_THRESHOLD:
                    return opening_level_for(ceiling)
                return OPENING_BID if ceiling >= THIRD_BIDDER_FLOOR else None

            # Normal opener threshold
            return opening_level_for(ceiling) if ceiling >= OPENER_THRESHOLD else None

        # Someone has already bid this auction.
        last_bidder = context["bid_history"][-1][0]
        bid_is_ours = last_bidder in self.team.players

        if bid_is_ours:
            partner_bid_count = sum(1 for p, _ in context["bid_history"] if p is partner)
            my_own_bids = [amt for p, amt in context["bid_history"] if p is self]

            if partner_bid_count >= 2:
                return None  # partner's carrying it, back off

            if last_bidder is partner and my_own_bids and current_bid > my_own_bids[-1]:
                # partner raised over my own earlier bid
                return None if ceiling < PARTNER_RAISE_FLOOR else current_bid + min_increment

            return None  # our own bid already stands, no need to raise ourselves

        # Opponent currently holds the bid.
        partner_has_bid = any(p is partner for p, _ in context["bid_history"])
        effective_ceiling = max(ceiling, COMPETITIVE_CEILING_FLOOR) if partner_has_bid else ceiling

        next_bid = current_bid + min_increment

        # Defensive push (#78): when opponent opened at the minimum (300),
        # respond unless the hand is truly hopeless (ceiling below
        # DEFENSIVE_PUSH_FLOOR). In real Pinochle, 300 is the absolute floor
        # and is almost always raised.
        if current_bid <= OPENING_BID and ceiling >= DEFENSIVE_PUSH_FLOOR:
            return next_bid

        return next_bid if next_bid <= effective_ceiling else None

    def choose_trump(self):
        """Uses the same per-suit Base Bid comparison as choose_bid, so
        trump selection reflects real speculative hand strength rather
        than raw card count."""
        trump, _, _ = best_base_bid(self.hand, loose_kq_pass_only=self.loose_kq_pass_only)
        return trump

    def choose_pass_cards(self, count, trump_suit=None, is_bid_winner=None):
        """
        Skill-level-proficient passing strategy, split by trump category
        (Diamonds/Spades vs Hearts/Clubs) and role (bidder vs partner).
        Falls back to random selection if trump_suit/is_bid_winner aren't
        supplied (keeps the method usable in isolation / old call sites).
        """
        if trump_suit is None or is_bid_winner is None:
            return random.sample(self.hand, count)

        category = "DS" if trump_suit in (Suit.SPADES, Suit.DIAMONDS) else "HC"
        if is_bid_winner:
            chosen = _bidder_pass_selection(self.hand, trump_suit, category, count)
        else:
            chosen = _partner_pass_selection(self.hand, trump_suit, category, count)

        # Fallback safety net: strategy tiers should always fill `count`,
        # but pad with random remaining cards if some edge case leaves us short.
        if len(chosen) < count:
            remaining = [c for c in self.hand if c not in chosen]
            chosen += random.sample(remaining, count - len(chosen))
        return chosen[:count]

    def choose_card(self, legal_moves, trick=None, trump=None, tracker=None, my_team_players=None,
                    is_bidder_first_lead=False):
        """
        Uses the real trick-play strategy (safe-card cascade when leading,
        feed/withhold/conserve logic when following) if given full context.
        Falls back to first-legal-move if called in isolation (e.g. old
        call sites, or tests that don't set up a Round).
        """
        if trick is None or trump is None:
            return legal_moves[0]

        if not trick.plays:
            # Determine side when in a full Round context (self.team and
            # round_bid are set), so the offense/defense split works.
            is_bidding_team = None
            if self.team is not None and self.team.round_bid is not None:
                is_bidding_team = True
            return choose_lead_card(self.hand, trump, tracker if tracker else PlayTracker(),
                                    is_bidder_first_lead=is_bidder_first_lead,
                                    is_bidding_team=is_bidding_team)

        team_set = my_team_players if my_team_players is not None else set(self.team.players)
        return choose_follow_card(self.hand, legal_moves, trick.plays, trump, team_set, tracker)

    def decide_fold(self, trump, bid, bidding_meld, defending_meld):
        """
        Whether to concede the contract rather than play it out (issue #100).
        Asked of the bid winner only, once, after meld is declared and before
        the first card is led - matching the concede window the web client
        offers the human (#83).

        Proficient and below always play the hand out. Conceding well needs a
        read on how the tricks will actually go, and this tier has no way to
        get one; guessing with a threshold is exactly what #106 is moving
        away from. `GeneralStrategy` overrides this at the skill levels that
        carry a rollout budget.
        """
        return False


# ---------------------------------------------------------------------------
# AI difficulty tiers (issue #53). Player above is the "Proficient" tier and
# is the tournament control group - its choose_bid/choose_trump/
# choose_pass_cards/choose_card are NOT touched by anything below. Easy is a
# new, additive-only subclass so a future ExpertPlayer (see
# pinochle_expert_ai_strategy.md) can plug into the same pattern.
#
# There used to be a RandomPlayer here (issue #53/PR #55): a floor tier that
# made a uniformly-random *legal* choice at every decision point, with no
# hand evaluation at all. Product direction changed - no tier should ever
# make a literal random move, "even Easy should be better than random" - so
# it was removed in issue #58. A "Random" tier will return once
# GeneralStrategy exists (see #57/#63): implemented as a random draw over
# GeneralStrategy's skill levels, not as its own strategy class.
# ---------------------------------------------------------------------------

# Static constants for EasyPlayer's bidding formula. Kept as module-level
# names (like OPENING_BID etc. above) rather than buried in the method, per
# the file's existing convention for tunable numbers.
EASY_FLAT_TRICK_ESTIMATE = 60  # flat, non-hand-shape-aware stand-in for "some trick points" -
                                # doc §8 says Easy's hand worth is "meld only, no trick-potential
                                # estimate", so this can't scale with hand contents the way
                                # Player's Base Bid does; it's just enough of a constant that a
                                # decent-meld hand can clear OPENING_BID at all.
EASY_BID_NOISE = 30            # +/- uniform noise added to the ceiling, giving "static formula
                                # + noise" (doc §8) rather than a deterministic cutoff every time.


def _easy_card_worth(card, trump):
    """
    Cheap, single-pass "how much do I want to keep this card" score used by
    EasyPlayer's passing logic. Deliberately flat and context-free (no
    marriage/around-breaking checks, no trump-category/role-specific tiers
    like Player's _bidder_pass_selection/_partner_pass_selection) - Easy
    reasons about cards individually, not about hand-wide meld shape.
    """
    worth = 0
    if card.suit == trump:
        worth += 5  # trump is the scarcest, most valuable resource
    if card.rank in ("A", "10", "K"):
        worth += 2  # count cards - costly to give away even with no meld tie
    if card.rank in ("Q", "J"):
        worth += 1  # cheap acknowledgement that these are the marriage/pinochle ranks
    return worth


class EasyPlayer(Player):
    """
    Weak-but-sane tier, per pinochle_expert_ai_strategy.md §8's "Easy" row:
    meld-only hand valuation (no Base Bid speculative-value machinery),
    static-formula-plus-noise bidding, no risk assessment, no deception.
    Judgment calls the doc doesn't pin down exactly are commented inline
    below.
    """

    def choose_bid(self, current_bid, min_increment, context=None):
        if context is None:
            # Fallback for isolated/old-style calls, matching Player's own
            # fallback shape so EasyPlayer stays usable outside a full Round.
            if random.random() < 0.6:
                return None
            return current_bid + min_increment

        # Hand worth: meld ONLY (doc §8) - the actual guaranteed meld from
        # score_melds() under the best of the 4 candidate trump suits, not
        # Player's speculative Base Bid (near-run bonuses, flat Ace value,
        # 3-Aces-bonus, competitive/score-context adjustment). This is the
        # single biggest behavioral difference from Proficient.
        best_meld_value = max(score_melds(self.hand, t)[0] for t in Suit)

        # Static formula + noise (doc §8): a flat trick-point constant (not
        # derived from this hand at all) plus the meld value, then uniform
        # noise. No dealer-protection, no partner-bid-count tracking, no
        # score-differential awareness, no "opponent already bid" reasoning
        # - all the positional/score-context machinery in Player.choose_bid
        # is exactly what "no risk assessment" (doc §8) rules out here.
        noise = random.uniform(-EASY_BID_NOISE, EASY_BID_NOISE)
        ceiling = best_meld_value + EASY_FLAT_TRICK_ESTIMATE + noise

        next_bid = current_bid + min_increment
        if not context["ever_bid"]:
            return OPENING_BID if ceiling >= OPENING_BID else None
        return next_bid if next_bid <= ceiling else None

    def choose_trump(self):
        # Judgment call: trump choice mirrors the bidding valuation - pick
        # the suit with the highest actual score_melds() value, not
        # Player's speculative best_base_bid() search. Ties keep whichever
        # Suit is encountered first in enum order; Easy has no tie-break
        # reasoning beyond raw meld value.
        best_trump, best_value = None, -1
        for t in Suit:
            value, _ = score_melds(self.hand, t)
            if value > best_value:
                best_trump, best_value = t, value
        return best_trump

    def choose_pass_cards(self, count, trump_suit=None, is_bid_winner=None):
        if trump_suit is None or is_bid_winner is None:
            return random.sample(self.hand, count)

        if not is_bid_winner:
            # Partner, sending to the bidder: judgment call - ship the
            # `count` lowest-worth cards by the flat _easy_card_worth scale.
            # No Tier 0 "always chase toward a missing meld piece" logic
            # (doc §2) - that speculative chasing is exactly the kind of
            # machinery Easy's meld-only philosophy excludes. Easy only
            # avoids obviously overpaying, it doesn't actively build melds.
            ranked = sorted(self.hand, key=lambda c: _easy_card_worth(c, trump_suit))
            return ranked[:count]

        # Bidder, sending back to partner: judgment call - non-trump 10s
        # are shipped first. This isn't Expert-only sophistication; doc §3
        # states plainly that a non-trump 10 has zero meld value and is a
        # pure count-card liability regardless of tier, so it's a safe,
        # tier-agnostic default even for Easy's otherwise-flat logic.
        # The exception is tier-agnostic for the same reason (#276): a 10
        # with both Aces of its suit behind it wins a trick when the suit
        # is played out last, so it isn't shipped on sight - it drops back
        # into the worth-ranked filler, where `_easy_card_worth` scores it
        # level with an Ace or King and behind every Q/J/9 in the hand.
        # Remaining slots fall back to lowest-worth filler, same as the
        # partner branch above.
        pool = list(self.hand)
        chosen = [c for c in pool if c.suit != trump_suit and c.rank == "10"
                  and not _is_protected_ten(self.hand, trump_suit, c)][:count]
        for c in chosen:
            pool.remove(c)
        if len(chosen) < count:
            ranked = sorted(pool, key=lambda c: _easy_card_worth(c, trump_suit))
            chosen += ranked[:count - len(chosen)]
        return chosen[:count]

    def choose_card(self, legal_moves, trick=None, trump=None, tracker=None, my_team_players=None,
                    is_bidder_first_lead=False):
        if trick is None or trump is None:
            return legal_moves[0]

        if not trick.plays:
            # Leading, judgment call: prefer a low, non-trump, non-count
            # card - "don't obviously hand opponents free points" is as far
            # as Easy's leading logic goes. This is not Player's safe-card
            # cascade (no tracking of which copies are still live, no
            # unsecured-Ace handling) - just a single cheap filter.
            safe_leads = [c for c in legal_moves if c.suit != trump and c.rank not in ("A", "10", "K")]
            pool = safe_leads if safe_leads else legal_moves
            return min(pool, key=lambda c: RANK_VALUE[c.rank])

        # Following, judgment call: `legal_moves` already has the mandatory
        # beat-if-possible / trump-if-void rules applied by
        # Trick.legal_moves, so always playing the lowest legal card is
        # legal by construction and spends the least - no
        # feed-partner/duck/protect-count-card reasoning like Player's
        # choose_follow_card (that's the "no risk assessment" difference).
        return min(legal_moves, key=lambda c: RANK_VALUE[c.rank])


# ---------------------------------------------------------------------------
# GeneralStrategy (issue #63) - wires the shared Expert-tier machinery from
# #59/#60/#61/#62 (pinochle_rollout.py's determinization+rollout sampler,
# bid-time EV, forward/return-pass Tier-0/1 logic, and trick-play
# lead/follow logic) into one Player subclass, parameterized by a skill
# level 1-5 - a dial, not a branch to a different algorithm. Same code path
# at every level; only the parameter values in GENERAL_STRATEGY_SKILL_PARAMS
# differ. Per the issue's revised scope, the static-formula-vs-rollout-EV
# switch moves together across all three decision points that have one
# (bidding, forward-pass shedding, defender trump-lead) so a given skill
# level is internally consistent - never rollout at one decision point and
# static at another for the same level.
#
# pinochle_rollout.py can't be imported at module scope here - it already
# imports FROM pinochle_engine, which re-exports this module (#249), and
# this module is scoped (per issue
# #63) to hold GeneralStrategy itself. Every method below that needs the
# rollout machinery imports pinochle_rollout lazily (inside the method
# body), which sidesteps the circular import entirely: by the time any of
# these methods actually runs, both modules have already finished loading.
#
# Player (Proficient) and EasyPlayer above are NOT modified by any of this
# - GeneralStrategy is purely additive, reusing their public surface
# (Player.__init__, Player.choose_trump, Player.choose_bid via super()) and
# the free functions from #61/#62 without changing either class.
# ---------------------------------------------------------------------------

GENERAL_STRATEGY_SKILL_PARAMS = {
    # hand_valuation: which bidding logic runs (Section 8's table).
    #   "meld_only" - flat meld-value-only static formula (skill 1).
    #   "base_bid"  - Player's existing Base-Bid formula, itself a blend of
    #                 meld + heuristic trick-potential (skill 2-3).
    #   "rollout_ev"- pinochle_rollout.bid_ev/choose_bid_by_ev (skill 4-5).
    # pass_logic: controls which pass logic the skill level uses.
    #   "easy"      - EasyPlayer-like flat pass (skill 1).
    #   "proficient"- Player's existing tiered pass logic (skill 2-3).
    #   "expert"    - choose_return_pass_cards / choose_forward_pass_cards
    #                 from #61, the full knapsack-tier logic (skill 4-5).
    # trick_logic: controls which trick-play logic the skill level uses.
    #   "proficient"- Player's existing choose_lead_card/choose_follow_card
    #                 (skill 1-3).
    #   "expert"    - choose_expert_lead_card/choose_expert_follow_card
    #                 from #62 (skill 4-5).
    # use_rollout: the shared static-vs-rollout switch for forward-pass
    #   shedding (#61) and the defender trump-lead question (#62) - must
    #   move together with hand_valuation == "rollout_ev" (both flip at
    #   the same skill threshold), per the issue's consistency note.
    # *_samples: Monte Carlo sample counts fed to the rollout machinery,
    #   tuned empirically via tournament_sim (issue #65).
    # fold_samples: sample count for the concede decision (#100). 0 means the
    #   skill level never folds - it has no rollout budget to judge with, and
    #   a guessed threshold is what #106 exists to remove.
    # use_auction_evidence: reject determinized deals that contradict what the
    #   other seats did in the auction (#101). OFF everywhere for now. The
    #   constraint provably works - a sampled partner's ceiling moves from 276
    #   to 338 once partner has bid 330 - but A/B'd over 50 paired deals it
    #   produced no measurable improvement (46-54 on games, margin -1 with a
    #   95% CI of -109 to +102, make rate 54.4% vs 55.3%) while running about
    #   4x slower. The likely reason is that the bid decision is a coarse
    #   argmax over [pass, next_bid], so a sharper model of partner shifts both
    #   options together and rarely flips the choice. That explanation was
    #   then tested and did NOT hold up: re-run on top of #103's defence
    #   rollout - a genuinely richer comparison - it still showed nothing
    #   (40-40 on games, margin -50 with a 95% CI of -152 to +51). So the
    #   null result is not an artifact of the decision being too coarse, and
    #   a better model of the other seats simply does not appear to change
    #   bidding. Left off; do not re-run this A/B without a new hypothesis.
    # defence_samples: when > 0, bidding compares taking the contract against
    #   *defending* it, both as score differentials, instead of scoring a pass
    #   as a flat 0.0 (#103). ON at skill 4-5: A/B'd over 40 paired deals it
    #   was worth +233 score margin per deal (95% CI +72 to +397). It makes
    #   the AI bid markedly less - 139 contracts taken vs 393, average bid 301
    #   vs 313 - which is the opposite of what #95 asks for and is worth
    #   reading as evidence against that issue's 320 target. Caveat recorded
    #   honestly: the opponent in that A/B was the same AI, which bids
    #   unmakeable contracts ~19% of the time (#100), so some of the gain is
    #   letting a flawed bidder overreach. Re-measure against a stronger
    #   bidder before treating +233 as universal. 20 samples is the value
    #   measured; the count itself was not separately tuned.
    # use_win_probability: score every rollout sample as P(win the game) from
    #   the resulting score state (win_probability.py), instead of as a score
    #   differential (#102). Uses the same rollouts and the same sample budget
    #   as defence_samples - only the function applied to each sample changes -
    #   and requires defence_samples > 0, since the objective compares two
    #   futures. OFF everywhere, following #101's precedent.
    #   It does what the issue asks: the same hand at the same bid passes at
    #   950-300 and bids at 890-950, with no score branch anywhere. But A/B'd
    #   against the differential objective at skill 5 over 120 paired deals it
    #   did not win more games (122-118, 30 decisive pairs, p=0.86) and was
    #   slightly WORSE on margin (-92 per deal, 95% CI -170 to -13). Two
    #   40-pair replicates agreed on "no effect" (41-39, margin -29 with a 95%
    #   CI of -159 to +109; 44-36, margin -46 with a 95% CI of -158 to +69).
    #   Games and margin pointed opposite ways in every run - the exact
    #   divergence #102 warned about - and neither points at enabling this.
    #   The likely reason is measured rather than guessed: the self-play table
    #   is nearly flat in game stage (a 100-point lead is worth ~0.58 at 100-0
    #   and ~0.56 at 700-600), because a Pinochle round swings ~259 points with
    #   a ~406-point spread, so no lead is safe until a side can actually cross
    #   1000. Over 18 sampled hands the two objectives chose identically at 0-0
    #   and at 500-500 and differed only near the finish (2/18 at 890-950,
    #   10/18 at 950-300). An objective that only bites in the last round or
    #   two cannot move a whole-game A/B much, and what it does change here
    #   (758 contracts taken vs 581, make rate 59.6% vs 64.4%, conceded 20.4%
    #   vs 16.5%) is not paying for itself. Do not re-run this A/B without a
    #   new hypothesis; the promising direction is the endgame decisions
    #   specifically, not the objective across the board.
    # deception: whether choose_expert_follow_card gets a deception_evaluator.
    1: {"hand_valuation": "meld_only",   "pass_logic": "easy",      "trick_logic": "proficient", "use_rollout": False, "bid_samples": 0,  "pass_samples": 0,  "trick_samples": 0,  "fold_samples": 0,  "use_auction_evidence": False, "defence_samples": 0,  "use_win_probability": False, "deception": False},
    2: {"hand_valuation": "base_bid",    "pass_logic": "proficient","trick_logic": "proficient", "use_rollout": False, "bid_samples": 0,  "pass_samples": 0,  "trick_samples": 0,  "fold_samples": 0,  "use_auction_evidence": False, "defence_samples": 0,  "use_win_probability": False, "deception": False},
    3: {"hand_valuation": "base_bid",    "pass_logic": "proficient","trick_logic": "proficient", "use_rollout": False, "bid_samples": 0,  "pass_samples": 0,  "trick_samples": 0,  "fold_samples": 0,  "use_auction_evidence": False, "defence_samples": 0,  "use_win_probability": False, "deception": False},
    4: {"hand_valuation": "rollout_ev",  "pass_logic": "expert",    "trick_logic": "expert",     "use_rollout": True,  "bid_samples": 20, "pass_samples": 15, "trick_samples": 10, "fold_samples": 20, "use_auction_evidence": False, "defence_samples": 20, "use_win_probability": False, "deception": False},
    5: {"hand_valuation": "rollout_ev",  "pass_logic": "expert",    "trick_logic": "expert",     "use_rollout": True,  "bid_samples": 50, "pass_samples": 30, "trick_samples": 25, "fold_samples": 50, "use_auction_evidence": False, "defence_samples": 20, "use_win_probability": False, "deception": False},
}

MELD_ONLY_TRICK_ESTIMATE = EASY_FLAT_TRICK_ESTIMATE  # same flat, non-hand-shape-aware stand-in EasyPlayer uses for skill 1's meld-only bidding (doc Section 8) - reused rather than redefined, since it's the same judgment call.


def _score_deception_candidate(hand, trump, tracker, trick_plays, candidate_card):
    """
    `deception_evaluator` for `choose_expert_follow_card` (skill 5 only).

    Deliberately NOT built on the Monte Carlo rollout machinery, unlike
    the other two evaluators below: Section 0 of the strategy doc
    explicitly excludes deception from the rollout mechanism ("Not in
    scope for this rollout mechanism: actual bluffing/deception"), and
    for good reason - the rollout's simulated opponents are plain
    `Player` objects that reason only about their own hand plus
    `PlayTracker`'s aggregate history, with no opponent-belief model to
    fool. A false-card would score identically to the honest play in any
    literal rollout comparison, making one pointless to run.

    Instead: a cheap, self-contained heuristic. Prefers low-rank,
    non-count cards (a real false-card/fake-void is only worth playing if
    it doesn't cost meaningful trick value), with a small flat bonus for
    candidates whose other physical copy is already accounted for as
    played - exactly the believability signal
    `generate_false_card_candidates`/`generate_fake_void_candidates`
    already filtered on, so this naturally favors genuinely deceptive
    candidates over merely-different ones without needing to know which
    candidate is "the honest one" (not available in this signature).
    """
    score = -RANK_VALUE[candidate_card.rank] * 0.1
    if candidate_card.rank in POINT_RANKS:
        score -= 3.0
    if tracker.played_count(candidate_card.suit, candidate_card.rank) >= 1:
        score += 0.5
    return score


class GeneralStrategy(Player):
    """
    Skill-level-dialed AI tier (issue #63) - see
    `pinochle_expert_ai_strategy.md` Section 8 for the parameter table and
    Section 0 for the underlying determinization+rollout principle this
    builds on. `skill_level` must be 1-5 (validated at construction).
    """

    def __init__(self, name, team=None, skill_level=3, rng=None):
        super().__init__(name, team)
        if skill_level not in GENERAL_STRATEGY_SKILL_PARAMS:
            raise ValueError(f"GeneralStrategy skill_level must be 1-5, got {skill_level!r}")
        self.skill_level = skill_level
        self.rng = rng if rng is not None else random

    # -- Bidding (doc Section 1 / Section 8's "Hand worth"/"Bidding" columns) --

    def choose_bid(self, current_bid, min_increment, context=None):
        if context is None:
            # Fallback for isolated/old-style calls, matching Player's own
            # fallback shape.
            if random.random() < 0.6:
                return None
            return current_bid + min_increment

        params = GENERAL_STRATEGY_SKILL_PARAMS[self.skill_level]
        if params["hand_valuation"] == "meld_only":
            return self._meld_only_bid(current_bid, min_increment, context)
        if params["hand_valuation"] == "base_bid":
            # Reuses Player's own Base-Bid logic unmodified (super() call,
            # not a copy) - skill 2-3's "blend of static formula" per the
            # doc's Section 8 table is exactly Player's existing meld +
            # heuristic-trick-potential formula, already a blend.
            return super().choose_bid(current_bid, min_increment, context)
        return self._rollout_ev_bid(current_bid, min_increment, context, params)

    def _meld_only_bid(self, current_bid, min_increment, context):
        """Skill 1: meld-only static formula (doc Section 8), same shape
        as EasyPlayer's bidding logic but implemented independently here
        (GeneralStrategy skill 1 is its own bottom-of-the-dial behavior,
        not literally EasyPlayer) - adds noise matching EasyPlayer's ±30
        (EASY_BID_NOISE) so skill 1 is comparably erratic/weak."""
        best_meld_value = max(score_melds(self.hand, t)[0] for t in Suit)
        noise = random.uniform(-EASY_BID_NOISE, EASY_BID_NOISE)
        ceiling = best_meld_value + MELD_ONLY_TRICK_ESTIMATE + noise
        next_bid = current_bid + min_increment
        if not context["ever_bid"]:
            return OPENING_BID if ceiling >= OPENING_BID else None
        return next_bid if next_bid <= ceiling else None

    def _auction_evidence(self, context):
        """
        Translate what the other three seats have done this auction into the
        rollout's seat-key space, so determinized deals that contradict the
        bidding can be rejected (issue #101).

        Seat keys mirror `estimate_bid_time`'s fixed seating: my partner is
        "partner", and the two opponents are "opp_left"/"opp_right".

        The two opponents are keyed in the order they first acted, which is
        not necessarily their true seating relative to me - `context` carries
        the auction record but no seat indices. Both opponents get constrained
        by their own bidding either way, so the only thing this can get wrong
        is which side of the table a given constrained hand sits on. That
        shifts trick-play order inside the rollout without changing the hand
        strength being modelled. Worth tightening if seat indices ever reach
        here; not worth opening a second seating channel for now.
        """
        from pinochle_rollout import AuctionEvidence

        if self.team is None:
            return None

        partner = next((p for p in self.team.players if p is not self), None)

        # Opponents are everyone who has acted this auction and is neither me
        # nor my partner. Derived from the auction record rather than from the
        # team objects, so a seat that has not acted yet stays unconstrained.
        seen = []
        for player, _amount in context.get("bid_history", []):
            if player not in seen:
                seen.append(player)
        for player, _amount in context.get("pass_history", []):
            if player not in seen:
                seen.append(player)
        opponents = [p for p in seen if p is not self and p is not partner]

        key_for = {}
        if partner is not None:
            key_for[id(partner)] = "partner"
        for opponent, key in zip(opponents, ("opp_left", "opp_right")):
            key_for[id(opponent)] = key

        highest_bid = {}
        for player, amount in context.get("bid_history", []):
            key = key_for.get(id(player))
            if key is not None:
                highest_bid[key] = max(highest_bid.get(key, 0), amount)

        declined = {}
        for player, amount in context.get("pass_history", []):
            key = key_for.get(id(player))
            if key is not None:
                declined[key] = min(declined.get(key, amount), amount)

        evidence = AuctionEvidence(highest_bid=highest_bid, declined=declined)
        return evidence if evidence else None

    def _rollout_ev_bid(self, current_bid, min_increment, context, params):
        """Skill 4-5: replace the static ceiling comparison with simulated
        EV (doc Section 1), via pinochle_rollout.choose_bid_by_ev built on
        top of #59's sampler. Table-position judgment (partner already
        carrying the bid, our own bid already stands) stays governed by
        Player's own logic first - that's not a valuation question the
        rollout should re-litigate, only whether-to-bid/raise is."""
        from pinochle_rollout import choose_bid_by_ev

        static_bid = super().choose_bid(current_bid, min_increment, context)
        if static_bid is None and context["ever_bid"]:
            last_bidder = context["bid_history"][-1][0]
            if last_bidder in self.team.players:
                return None  # our own bid stands / partner carrying it - positional, not a valuation call

        my_score = self.team.score if self.team is not None else 0
        opp_team = next((t for t in context["teams"] if t is not self.team), None)
        opp_score = opp_team.score if opp_team is not None else 0
        trump, ceiling, _ = best_base_bid(self.hand, my_score, opp_score,
                                          self.loose_kq_pass_only)

        # Endgame protection (#256) is a hard rule in front of the simulation,
        # not an input to it. `Player.choose_bid` applies it for the skill
        # levels that route through the static path, but this one does not
        # take its answer from `static_bid` above - it only consults it for
        # the positional back-off - so the check is repeated here rather than
        # left to leak through. A rollout that says "taking this contract has
        # the higher EV" is answering a different question from the one the
        # rule asks, which is whether to put a nearly-won game at risk at all.
        if endgame_protection_applies(my_score, opp_score):
            partner = None if self.team is None else next(
                (p for p in self.team.players if p is not self), None
            )
            return endgame_protection_bid(
                context,
                opp_team.players if opp_team is not None else [],
                partner is not None and partner is context.get("dealer"),
                ceiling,
            )

        # Cheap hard floor, same "prune before the expensive simulation"
        # spirit as the Auto-SET guard elsewhere in this epic: a hand
        # whose static ceiling can't even clear the game's own
        # forced-bid floor is never going to out-EV a pass.
        if ceiling < FORCED_BID:
            return None

        # An opening is weighed at the level this seat would actually name
        # (`opening_level_for`), not at the rules floor: "bid 330 or defend"
        # is the question the table will pose, so it is the one to roll out.
        next_bid = opening_level_for(ceiling) if not context["ever_bid"] else current_bid + min_increment
        evidence = self._auction_evidence(context) if params.get("use_auction_evidence") else None

        defence_samples = params.get("defence_samples", 0)
        if defence_samples > 0:
            if params.get("use_win_probability"):
                # Same two futures and the same rollouts as #103's comparison,
                # scored as P(win the game) from the resulting score state
                # instead of as a score differential (#102). The score reaches
                # the decision by moving the objective, not via a branch.
                from pinochle_rollout import choose_bid_by_win_probability

                best_bid, _best_ev, _all_evs = choose_bid_by_win_probability(
                    self.hand, trump, [None, next_bid], my_score, opp_score,
                    num_samples=defence_samples, rng=self.rng, evidence=evidence,
                )
                return best_bid

            # Compare taking the contract against defending it, both as score
            # differentials (#103), instead of scoring a pass as a flat 0.0.
            from pinochle_rollout import choose_bid_vs_defence

            best_bid, _best_ev, _all_evs = choose_bid_vs_defence(
                self.hand, trump, [None, next_bid],
                num_samples=defence_samples, rng=self.rng, evidence=evidence,
            )
            return best_bid

        best_bid, _best_ev, _all_evs = choose_bid_by_ev(
            self.hand, trump, [None, next_bid],
            num_samples=params["bid_samples"], rng=self.rng, evidence=evidence,
        )
        return best_bid

    # -- Conceding (issue #100, epic #106) --

    def decide_fold(self, trump, bid, bidding_meld, defending_meld):
        """
        Concede when the rollout says playing on is worth less than the
        conceded score, per `pinochle_rollout.should_fold`. Skill levels with
        no fold budget keep Player's never-fold behavior rather than falling
        back to a threshold - the point of #106 is that the alternative to
        measuring is not guessing, it's declining to decide.
        """
        from pinochle_rollout import should_fold

        params = GENERAL_STRATEGY_SKILL_PARAMS[self.skill_level]
        num_samples = params.get("fold_samples", 0)
        if num_samples <= 0:
            return False

        # Under the win-probability objective (#102) the concede decision gets
        # the game score too, so "we are 60 behind with one round left" can
        # reach it. Scores are only passed when both sides are actually known -
        # a hand-built Team in a test has no opponent wired up, and guessing 0
        # there would silently model the wrong game state.
        our_score = their_score = None
        if params.get("use_win_probability") and self.team is not None:
            opponent = self.team.opponent
            if opponent is not None:
                our_score, their_score = self.team.score, opponent.score

        fold, _diagnostics = should_fold(
            self.hand, trump, bid, bidding_meld, defending_meld,
            num_samples=num_samples, rng=self.rng,
            our_score=our_score, their_score=their_score,
        )
        return fold

    # -- Passing (doc Sections 2-3) --

    def choose_pass_cards(self, count, trump_suit=None, is_bid_winner=None):
        if trump_suit is None or is_bid_winner is None:
            return random.sample(self.hand, count)

        params = GENERAL_STRATEGY_SKILL_PARAMS[self.skill_level]
        pass_logic = params.get("pass_logic", "expert")

        if pass_logic == "easy":
            if not is_bid_winner:
                ranked = sorted(self.hand, key=lambda c: _easy_card_worth(c, trump_suit))
                return ranked[:count]
            # Same protected-10 exception as EasyPlayer's own branch (#276).
            pool = list(self.hand)
            chosen = [c for c in pool if c.suit != trump_suit and c.rank == "10"
                      and not _is_protected_ten(self.hand, trump_suit, c)][:count]
            for c in chosen:
                pool.remove(c)
            if len(chosen) < count:
                ranked = sorted(pool, key=lambda c: _easy_card_worth(c, trump_suit))
                chosen += ranked[:count - len(chosen)]
            return chosen[:count]

        if pass_logic == "proficient":
            return Player.choose_pass_cards(self, count, trump_suit, is_bid_winner)

        # Expert-tier pass logic (skill 4-5).
        if is_bid_winner:
            chosen = choose_return_pass_cards(self.hand, trump_suit, count)
        else:
            evaluator = None
            if params["use_rollout"] and self.team is not None and self.team.round_bid is not None:
                evaluator = self._make_forward_pass_evaluator(self.team.round_bid, params["pass_samples"])
            chosen = choose_forward_pass_cards(self.hand, trump_suit, count, rollout_evaluator=evaluator)

        if len(chosen) < count:
            remaining = [c for c in self.hand if c not in chosen]
            chosen = list(chosen) + random.sample(remaining, count - len(chosen))
        return chosen[:count]

    def _make_forward_pass_evaluator(self, bid, num_samples):
        """
        Builds the `rollout_evaluator(hand, trump, candidate_cards) -> float`
        callback `choose_forward_pass_cards` (#61) expects, on top of #59's
        public sampler. `hand` there is MY (the forward-passing partner's)
        own 12-card hand, so this uses the same determinization shape as
        the bid-time decision point (Section 0's table row 1: only my own
        cards are known) - the "partner" key in the dealt sample actually
        represents the Bidder here, not literally my partner; the dict key
        names from `sample_bid_time_deal` are just positional labels. Only
        the return pass remains to simulate (the forward pass this is
        evaluating is baked into the sampled Bidder hand via
        `candidate_cards` already), matching Section 0's row 2 shape from
        there on.
        """
        from pinochle_rollout import sample_bid_time_deal, monte_carlo_rollout

        rng = self.rng

        def rollout_evaluator(hand, trump, candidate_cards):
            kept = [c for c in hand if c not in candidate_cards]

            def sample_fn(active_rng):
                return sample_bid_time_deal(hand, rng=active_rng)

            def build_fn(dealt):
                players = [Player("bidder", None), Player("opp_left", None),
                           Player("me", None), Player("opp_right", None)]
                team_offense = Team("Offense", [players[0], players[2]])
                team_defense = Team("Defense", [players[1], players[3]])
                players[0].team = players[2].team = team_offense
                players[1].team = players[3].team = team_defense
                players[0].hand = list(dealt["partner"]) + list(candidate_cards)
                players[1].hand = list(dealt["opp_left"])
                players[2].hand = list(kept)
                players[3].hand = list(dealt["opp_right"])
                return players, players[0]

            diagnostics = monte_carlo_rollout(
                sample_fn, build_fn, trump, bid, num_samples,
                rollout_kwargs={"passing": "return_only"}, rng=rng,
            )
            p_make = diagnostics["p_make"]
            made = [r for r in diagnostics["samples"] if r["made"]]
            expected_if_made = sum(r["bidding_total"] for r in made) / len(made) if made else 0.0
            return p_make * expected_if_made - (1.0 - p_make) * bid

        return rollout_evaluator

    # -- Trick play (doc Section 4 + Section 7) --

    def choose_card(self, legal_moves, trick=None, trump=None, tracker=None, my_team_players=None,
                    is_bidder_first_lead=False):
        if trick is None or trump is None:
            return legal_moves[0]

        tracker = tracker if tracker is not None else PlayTracker()
        params = GENERAL_STRATEGY_SKILL_PARAMS[self.skill_level]
        trick_logic = params.get("trick_logic", "expert")

        if trick_logic == "proficient":
            team_set = my_team_players if my_team_players is not None else (
                set(self.team.players) if self.team is not None else set()
            )
            return Player.choose_card(self, legal_moves, trick=trick, trump=trump,
                                       tracker=tracker, my_team_players=team_set,
                                       is_bidder_first_lead=is_bidder_first_lead)

        if not trick.plays:
            is_bidding_team = bool(self.team is not None and self.team.is_bidding_team)
            evaluator = None
            if params["use_rollout"] and not is_bidding_team and self.team is not None:
                opponent = self.team.opponent
                bid = self.team.round_bid
                if opponent is not None and bid is not None:
                    evaluator = self._make_defender_lead_evaluator(
                        bid, bidding_meld=opponent.meld_points, defending_meld=self.team.meld_points,
                        num_samples=params["trick_samples"],
                    )
            return choose_expert_lead_card(self.hand, trump, tracker, is_bidding_team,
                                           is_bidder_first_lead=is_bidder_first_lead,
                                           rollout_evaluator=evaluator)

        team_set = my_team_players if my_team_players is not None else (
            set(self.team.players) if self.team is not None else set()
        )
        deception_evaluator = _score_deception_candidate if params["deception"] else None
        return choose_expert_follow_card(
            self.hand, legal_moves, trick.plays, trump, team_set,
            tracker=tracker, deception_evaluator=deception_evaluator,
        )

    def _make_defender_lead_evaluator(self, bid, bidding_meld, defending_meld, num_samples):
        """
        Builds the `rollout_evaluator(hand, trump, tracker, candidate_card)
        -> float` callback `choose_expert_lead_card`/`_defender_lead` (#62)
        expects, on top of #59's public sampler. Determinizes the other 3
        seats' unseen hands the same way #59's trick-play sampling table
        row does (`sample_trick_play_deal`), then resumes the round via
        `rollout_deal` with `forced_lead_card=candidate_card` so the
        REAL trick-play machinery decides everything downstream of this
        one hypothetical lead - not a second, simplified trick-play
        implementation. Each sample gets its own clone of the real
        tracker (copying just `.played`, the only mutable state) rather
        than sharing one mutable tracker across samples or with the live
        game - `monte_carlo_rollout` doesn't support a per-sample tracker
        factory, so this loop is hand-rolled instead of reusing it.

        Scores higher-is-better for the DEFENDER (the caller), not the
        bidding team: defending team's own average total, minus the
        bidding team's simulated EV - so suppressing the bidding team's
        success is rewarded even though it doesn't directly add to the
        defender's own score.
        """
        from pinochle_rollout import sample_trick_play_deal, rollout_deal

        rng = self.rng

        def rollout_evaluator(hand, trump, tracker, candidate_card):
            n = len(hand)  # every seat holds n cards right now - nobody has played this trick yet (I'm leading)
            remaining_hand_sizes = [("right", n), ("partner", n), ("left", n)]
            tricks_already_played = 12 - n

            bidding_totals = []
            made_flags = []
            defending_totals = []

            for _ in range(num_samples):
                dealt = sample_trick_play_deal(hand, tracker, remaining_hand_sizes, rng=rng)

                players = [Player("me", None), Player("right", None),
                           Player("partner", None), Player("left", None)]
                team_defense = Team("Defense", [players[0], players[2]])
                team_offense = Team("Offense", [players[1], players[3]])
                players[0].team = players[2].team = team_defense
                players[1].team = players[3].team = team_offense
                players[0].hand = list(hand)
                players[1].hand = list(dealt["right"])
                players[2].hand = list(dealt["partner"])
                players[3].hand = list(dealt["left"])

                sample_tracker = PlayTracker()
                sample_tracker.played = dict(tracker.played)

                result = rollout_deal(
                    players, trump, bid, players[1],
                    tracker=sample_tracker, leader_index=0,
                    tricks_already_played=tricks_already_played,
                    passing="none", bidding_meld=bidding_meld, defending_meld=defending_meld,
                    forced_lead_card=candidate_card,
                )
                bidding_totals.append(result["bidding_total"])
                made_flags.append(result["made"])
                defending_totals.append(result["defending_total"])

            p_make = sum(made_flags) / len(made_flags)
            made_only = [t for t, m in zip(bidding_totals, made_flags) if m]
            expected_if_made = sum(made_only) / len(made_only) if made_only else 0.0
            bidding_ev = p_make * expected_if_made - (1.0 - p_make) * bid
            defending_avg = sum(defending_totals) / len(defending_totals)
            return defending_avg - bidding_ev

        return rollout_evaluator


class RandomStrategy(GeneralStrategy):
    """
    "Random" difficulty (deferred from issue #58, implemented here per
    #63's revised scope): NOT its own strategy logic - a thin constructor
    wrapper that draws a uniform-random skill level 1-5 once, at creation
    time, and instantiates GeneralStrategy at that level. Every decision
    this player makes afterward runs through the exact same
    GeneralStrategy code path as any other skill level; only the level
    itself was chosen randomly, up front - not any individual move.
    """

    def __init__(self, name, team=None, rng=None):
        rng = rng if rng is not None else random
        skill_level = rng.randint(1, 5)
        super().__init__(name, team, skill_level=skill_level, rng=rng)
