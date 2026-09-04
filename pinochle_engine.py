"""
Pinochle Engine — full rules implementation.

Implements: deal, bidding, 3-card pass, meld scanning, trick-taking,
round scoring, and multi-round game to +1000 / -1000, per
pinochle_rules.md.

Player.choose_bid / choose_trump / choose_pass_cards / choose_card are
placeholder logic (documented inline) — the seams where real strategy
or human input plugs in later. The rules engine itself is complete.
"""

import random
from enum import Enum


# ---------------------------------------------------------------------------
# Card / Deck
# ---------------------------------------------------------------------------

class Suit(Enum):
    SPADES = "S"
    DIAMONDS = "D"
    CLUBS = "C"
    HEARTS = "H"


# Highest to lowest, per pinochle's non-standard rank order (10 beats King).
RANKS = ["9", "J", "Q", "K", "10", "A"]
RANK_VALUE = {rank: i for i, rank in enumerate(RANKS)}

GAME_WIN_SCORE = 1000
GAME_LOSE_SCORE = -1000
# Lowest rung the auction can open at. 300, restored by #257 after #200 had
# moved it to 250: a house preference, not a rules discovery, and one decided
# twice - the second time on the evidence of having played it. The rung on its
# own was never the point; what it buys is the gap to FORCED_BID below. Only
# the opening rung moves - the minimum raise (10), OPENER_THRESHOLD (320, the
# hand a bidder needs to open at all) and PARTNER_PASSED_FLOOR (320) are
# unchanged, so the AI opens on the same set of hands either way and simply
# commits to 300 rather than 250 when it does.
OPENING_BID = 300
# What the dealer is stuck with if everyone passes without ever bidding. Sits
# 50 below OPENING_BID on purpose: the dealer never chose this contract, so
# they get it cheaper than anyone who bid for one. That discount is what #257
# was restoring - with both numbers at 250 there was nothing left to discount,
# and passing the auction out landed the dealer on the very rung the first
# seat could have opened at.
FORCED_BID = 250
# The minimum raise, stated by pinochle_rules.md on the same line as the
# opening rung. Passed to Player.choose_bid as its min_increment argument
# rather than read there directly - the parameter is deliberate, so a caller
# can drive an auction on a different rung size.
MIN_BID_INCREMENT = 10


class Card:
    def __init__(self, suit, rank, copy_id):
        self.suit = suit
        self.rank = rank
        self.copy_id = copy_id  # 1 or 2, since each card exists twice

    @property
    def rank_value(self):
        return RANK_VALUE[self.rank]

    def beats(self, other, trump_suit):
        """
        True if self outranks other in a trick-resolution context.
        Caller is responsible for only comparing cards that are actually
        eligible to be compared (same suit, or both trump).
        """
        if self.suit != other.suit:
            if self.suit == trump_suit and other.suit != trump_suit:
                return True
            if other.suit == trump_suit and self.suit != trump_suit:
                return False
            return False
        return self.rank_value > other.rank_value

    def __eq__(self, other):
        return (
            isinstance(other, Card)
            and self.suit == other.suit
            and self.rank == other.rank
            and self.copy_id == other.copy_id
        )

    def __hash__(self):
        return hash((self.suit, self.rank, self.copy_id))

    def __repr__(self):
        return f"{self.rank}{self.suit.value}_{self.copy_id}"


class Deck:
    def __init__(self):
        self.cards = self._build()

    @staticmethod
    def _build():
        cards = []
        for suit in Suit:
            for rank in RANKS:
                for copy_id in (1, 2):
                    cards.append(Card(suit, rank, copy_id))
        assert len(cards) == 48
        return cards

    def shuffle(self, rng=None):
        """
        Shuffle, optionally from a caller-supplied `random.Random` rather than
        the global module RNG.

        Injectable so a harness can hold the *deal* fixed while varying the
        players (issue #105). Sharing one global RNG with the AI makes that
        impossible: two configs that consume a different number of random
        values while thinking desynchronise every later shuffle, so only the
        first deal of a game would match.
        """
        (rng if rng is not None else random).shuffle(self.cards)

    def deal(self, players):
        """Deal 12 cards to each of the 4 players."""
        assert len(players) == 4
        assert len(self.cards) == 48
        for i, player in enumerate(players):
            hand = self.cards[i * 12:(i + 1) * 12]
            player.receive_cards(hand)
        self.cards = []


# ---------------------------------------------------------------------------
# Melding — pure function, not a player decision. Given a hand and the
# trump suit, there's exactly one correct point value.
# ---------------------------------------------------------------------------

RUN_VALUE = 150
DOUBLE_RUN_VALUE = 1500  # replaces single Run, not 2x150 — same convention as Double Pinochle / Arounds
ROYAL_MARRIAGE_VALUE = 40
COMMON_MARRIAGE_VALUE = 20
DIX_VALUE = 10
PINOCHLE_SINGLE_VALUE = 40
PINOCHLE_DOUBLE_VALUE = 300
AROUND_VALUES = {"A": 100, "K": 80, "Q": 60, "J": 40}
AROUND_DOUBLE_MULTIPLIER = 10


def score_melds(hand, trump_suit):
    """
    Returns (total_points, breakdown) where breakdown is a dict of
    meld_name -> points, for debugging/testing visibility.

    Key rule: a card can count toward multiple *different* meld types at
    once (the trump Q is part of both a Run and a Pinochle), but within a
    single meld type you can't reuse a physical card — you need a second
    copy for a second instance of the same meld.

    The Royal Marriage is the one exception, and it is not an extra rule
    so much as the same rule stated exactly (#273): a meld scores on top
    of a Run only if it needs at least one card the Run does not use. A
    Pinochle needs the Q♠ or the J♦, one of which is always outside the
    run; an Around needs three cards in other suits; the Dix needs the
    trump 9, which is never in a run. The trump K+Q needs nothing the run
    has not already consumed, so a bare Run scores 150 and not 190. A
    *second* K+Q does need cards the run has not used, so it pays — which
    is why the count below is `royal_count - run_count`.

    Doubles (Double Run, Double Pinochle, Arounds doubles) REPLACE the
    single value, they are not simple multiplication.
    """
    counts = {}
    for card in hand:
        counts[(card.suit, card.rank)] = counts.get((card.suit, card.rank), 0) + 1

    def n(suit, rank):
        return counts.get((suit, rank), 0)

    breakdown = {}

    # -- Class A: trump/marriage melds --------------------------------
    run_count = min(n(trump_suit, r) for r in ("A", "10", "K", "Q", "J"))
    if run_count == 2:
        breakdown["Double Run"] = DOUBLE_RUN_VALUE
    elif run_count == 1:
        breakdown["Run"] = RUN_VALUE

    # A Run consumes one trump K and one trump Q; a Double Run consumes both
    # of each and leaves no marriage at all (#273).
    royal_count = min(n(trump_suit, "K"), n(trump_suit, "Q"))
    payable_royals = max(0, royal_count - run_count)
    if payable_royals:
        breakdown["Royal Marriage"] = payable_royals * ROYAL_MARRIAGE_VALUE

    common_total = 0
    for suit in Suit:
        if suit == trump_suit:
            continue
        common_total += min(n(suit, "K"), n(suit, "Q"))
    if common_total:
        breakdown["Common Marriage"] = common_total * COMMON_MARRIAGE_VALUE

    dix_count = n(trump_suit, "9")
    if dix_count:
        breakdown["Dix"] = dix_count * DIX_VALUE

    # -- Class B: pinochle -------------------------------------------
    pinochle_count = min(n(Suit.SPADES, "Q"), n(Suit.DIAMONDS, "J"))
    if pinochle_count == 2:
        breakdown["Double Pinochle"] = PINOCHLE_DOUBLE_VALUE
    elif pinochle_count == 1:
        breakdown["Pinochle"] = PINOCHLE_SINGLE_VALUE

    # -- Class C: arounds ----------------------------------------------
    for rank, base_value in AROUND_VALUES.items():
        around_count = min(n(suit, rank) for suit in Suit)
        if around_count == 2:
            breakdown[f"{rank}s Around (double)"] = base_value * AROUND_DOUBLE_MULTIPLIER
        elif around_count == 1:
            breakdown[f"{rank}s Around"] = base_value

    total = sum(breakdown.values())
    return total, breakdown


# ---------------------------------------------------------------------------
# Hand-shape predicates — shared by the valuation and the pass.
#
# These say something about the *cards* rather than about a decision, so they
# are homed above both consumers instead of inside either. #276 put
# `_is_protected_ten` in the passing section because passing was the only
# caller; #277 gave the same rule a price in `compute_trick_potential`, and a
# bidding predicate reached for out of the passing module is exactly the shape
# that lets two statements of one rule drift apart. One definition, two
# readers.
# ---------------------------------------------------------------------------

def _is_protected_ten(hand, trump, card):
    """Is this a non-trump 10 that the hand's own Aces make a winner?

    Paul's ruling, 2026-09-02, from live play: a non-trump 10 is
    **protected** when the hand holds BOTH Aces of that suit. Two reasons,
    either of which is sufficient:

      - **Held**: with both Aces of the suit in this hand, the suit can be
        played out last and the 10 takes the trick behind them.
      - **Passed**: a 10 delivered to a partner holding the Ace becomes a
        20-point trick when the Ace is led and the 10 falls on it.

    Two consequences, and they are one ruling read at two moments. At a
    *pass* (#276) a protected 10 must not be shed ahead of ordinary
    filler; which of the two reasons applies there is worth being precise
    about, because it settles where the card belongs. If *this* hand holds
    both Aces then the other hand holds none, so passing this 10 cannot
    buy the drop-on-partner's-Ace trick. All of the value is in keeping
    the suit intact and cashing it late, which is why every pass path
    ranks a protected 10 *behind* ordinary filler rather than ahead of it.
    At a *bid* (#277) the same card is worth PROTECTED_TEN_VALUE, for the
    first of those two reasons: it is a trick this hand can cash.

    Deliberately narrow, per issue #276. A 10 behind a single Ace is only
    partially protected and is NOT covered here; trump 10s are run cards
    and were never in scope. This is a different notion from the
    `is_protected` lambda in `_bidder_pass_selection`, which means "trump,
    or Q(S), or J(D)" - i.e. meld significance - and the two must not be
    folded together.
    """
    return (
        card.rank == "10"
        and card.suit != trump
        and _n_of(hand, card.suit, "A") == 2
    )


# ---------------------------------------------------------------------------
# Base Bid — the hand-strength number bidding decisions are built on, and the
# two stages that sit on top of it.
#
# Distinct from score_melds: this is a *speculative* valuation (near-run,
# near-double-pinochle), not the actual guaranteed meld. Three stages, in
# order, each answering a different question about the same hand:
#
#   compute_base_bid              what will this hand meld?
#   compute_trick_potential       what will it take in tricks?  (#277)
#   compute_competitive_adjustment what is the scoreboard asking for?
#
# compute_max_bid sums the three and capped_bid applies the 400-cap /
# >300-meld-uncap rule to the sum.
# ---------------------------------------------------------------------------

RUN_RANKS = ("A", "10", "K", "Q", "J")
NEAR_RUN_VALUE = 120
NEAR_DOUBLE_PINOCHLE_VALUE = 225
# A Queen of Spades that no spade marriage is asking for is a freer pinochle
# card, so a hand holding a pinochle and NO King of Spades at all is worth a
# little more (#277). Paid once for the hand, never per copy: a double
# pinochle with no K(S) adds 20 and not 40.
PINOCHLE_NO_KING_OF_SPADES_BONUS = 20

# -- Trick potential (#277). The stage between the Base Bid and the
# competitive adjustment: what the hand can win with cards rather than meld.
# `compute_base_bid`'s docstring has always said this belongs somewhere else
# and named the competitive adjustment as its home, but that layer only ever
# read the score, so until now nothing priced the tricks at all. It does now,
# and it is its own stage rather than more lines inside the Base Bid because
# the two answer different questions - what will this hand meld, and what will
# it take.
ACE_VALUE = 20              # every Ace, any suit, flat
TRUMP_ACE_VALUE = 20        # per copy, ON TOP of the flat Ace above, so a
                            # trump Ace is worth 40 in total
TRUMP_LENGTH_BASELINE = 4   # trump beyond the fourth card is length, not shape
EXTRA_TRUMP_VALUE = 20
PROTECTED_TEN_VALUE = 20    # see `_is_protected_ten`
LOOSE_KING_VALUE = 30       # non-trump K with no Queen of its suit behind it
LOOSE_QUEEN_VALUE = 20      # non-trump Q with no King of its suit behind it
PARTNER_ESTIMATE_RANGE = (50, 100)  # Proficient draws randomly in this range each bid
MAX_BID_DEFAULT = 400
MAX_BID_MELD_THRESHOLD = 300
OPENER_THRESHOLD = 320  # minimum Base Bid to justify opening at all
# Minimum ceiling to justify a defensive push against an opening bid of 300.
# Hands at or above this floor should almost always raise a 300 opener,
# since even moderate hands can contribute toward making 300 with partner's
# help, and pushing deprives the opponent of a cheap contract. "Truly
# hopeless" hands (no meld, no aces — ceiling ~130) fall below this floor.
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
# the table while the trigger holds. This is the Max Bid *ceiling* (Base Bid
# plus the competitive adjustment, capped), not the Base Bid: in the score
# band this rule fires in `compute_competitive_adjustment` returns +100, so
# the effective bar is a Base Bid a little over 100 and few hands fail it.
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
# is once again the one that was measured. What #273 did change under these
# figures is `max_bid`'s >300-meld uncap, since the scorer now pays 40 less on
# a run. The two mechanisms are independent and the gap between the arms is far
# larger than either shift, so the direction stands; the exact figures are of
# the valuation as it was that day.
THIRD_BIDDER_FLOOR = 200


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


def compute_base_bid(hand, trump):
    """
    Pure hand-value Base Bid: the meld you have, plus the Run and
    Double-Pinochle proximity bonuses. Every line here is about *meld* -
    what the hand will put face up. What the hand can win in tricks is
    priced one stage later, in compute_trick_potential, and the score
    context one stage after that in compute_competitive_adjustment.

    #277 moved the flat Ace line out to that middle stage and deleted the
    "3 different Aces" bonus, which paid 60 with hearts or clubs trump and
    50 otherwise. No rule of pinochle makes three Aces worth more when
    hearts are trump than when spades are, nothing in the repo ever
    explained the asymmetry, and Paul's rewrite of the valuation omits it.

    Returns (base_bid_total, breakdown_dict, leftover_pool).
    """
    def n(suit, rank):
        return _hand_count(hand, suit, rank)

    pool = list(hand)
    breakdown = {}

    def claim(suit, rank, count=1):
        removed = 0
        for c in list(pool):
            if removed >= count:
                break
            if c.suit == suit and c.rank == rank:
                pool.remove(c)
                removed += 1
        return removed

    # -- Run / near-run ---------------------------------------------------
    run_count = min(n(trump, r) for r in RUN_RANKS)
    missing_ranks = [r for r in RUN_RANKS if n(trump, r) == 0]
    near_run = (run_count == 0 and len(missing_ranks) == 1)

    run_value = 0
    if run_count == 2:
        run_value = DOUBLE_RUN_VALUE
        for r in RUN_RANKS:
            claim(trump, r, 2)
    elif run_count == 1:
        run_value = RUN_VALUE
        for r in RUN_RANKS:
            claim(trump, r, 1)
    elif near_run:
        run_value = NEAR_RUN_VALUE
        for r in RUN_RANKS:
            claim(trump, r, 1)
    if run_value:
        breakdown["Run/near-run"] = run_value

    # -- Royal marriage: only the marriages a run has not already absorbed ---
    # A Run needs the trump K and Q to exist at all, so it consumes them and
    # only a *second* K+Q pays on top (#273 - see `score_melds`, which now
    # applies the same subtraction, and `pinochle_rules.md`'s Phase 3 note for
    # why the Royal Marriage is the one meld that works this way). A Double
    # Run consumes both copies of each and leaves nothing.
    #
    # The near-run estimate counts as one run in waiting for this purpose: it
    # is priced as though the missing card arrives, and a run that arrives
    # would take a K and a Q with it. #268 confirmed that branch was right all
    # along and it is unchanged here.
    royal_count = min(n(trump, "K"), n(trump, "Q"))
    consumed_by_run = run_count if run_count else (1 if near_run else 0)
    extra_royals = max(0, royal_count - consumed_by_run)
    marriage_value = extra_royals * ROYAL_MARRIAGE_VALUE
    # Cards inside the run were already claimed above; this takes any
    # King/Queen beyond it out of the leftover pool.
    claim(trump, "K", extra_royals)
    claim(trump, "Q", extra_royals)
    if marriage_value:
        breakdown["Royal Marriage"] = marriage_value

    # -- Common marriage ----------------------------------------------------
    common_value = 0
    for suit in Suit:
        if suit == trump:
            continue
        cm = min(n(suit, "K"), n(suit, "Q"))
        if cm:
            common_value += cm * COMMON_MARRIAGE_VALUE
            claim(suit, "K", cm)
            claim(suit, "Q", cm)
    if common_value:
        breakdown["Common Marriage"] = common_value

    # -- Dix -----------------------------------------------------------------
    dix_count = n(trump, "9")
    if dix_count:
        breakdown["Dix"] = dix_count * DIX_VALUE
        claim(trump, "9", dix_count)

    # -- Pinochle / near-double-pinochle -------------------------------------
    qs_count = n(Suit.SPADES, "Q")
    jd_count = n(Suit.DIAMONDS, "J")
    pin_count = min(qs_count, jd_count)
    total_pieces = qs_count + jd_count
    pinochle_value = 0

    if pin_count == 2:
        pinochle_value = PINOCHLE_DOUBLE_VALUE
        claim(Suit.SPADES, "Q", 2)
        claim(Suit.DIAMONDS, "J", 2)
    elif total_pieces == 3:
        pinochle_value = NEAR_DOUBLE_PINOCHLE_VALUE
        claim(Suit.SPADES, "Q", qs_count)
        claim(Suit.DIAMONDS, "J", jd_count)
    elif pin_count == 1:
        pinochle_value = PINOCHLE_SINGLE_VALUE
        claim(Suit.SPADES, "Q", 1)
        claim(Suit.DIAMONDS, "J", 1)
    if pinochle_value:
        breakdown["Pinochle/near-double"] = pinochle_value

    # A Queen of Spades doing no marriage work is a freer pinochle card, so a
    # hand that holds a pinochle at all and has no King of Spades to pair
    # against gets a little more (#277). Once for the hand: the reason is
    # about the absent King, and there is only one absence however many
    # Queens sit behind it. `pinochle_value` is the "holds a pinochle" test
    # rather than `pin_count`, and the two agree - the near-double branch
    # needs three of the four pieces, which cannot be reached without at
    # least one of each.
    no_ks_bonus = 0
    if pinochle_value and n(Suit.SPADES, "K") == 0:
        no_ks_bonus = PINOCHLE_NO_KING_OF_SPADES_BONUS
        breakdown["Pinochle (no King of Spades)"] = no_ks_bonus

    # -- Arounds ---------------------------------------------------------------
    around_value = 0
    for rank, base in AROUND_VALUES.items():
        c = min(n(s, rank) for s in Suit)
        if c == 2:
            around_value += base * AROUND_DOUBLE_MULTIPLIER
            for s in Suit:
                claim(s, rank, 2)
        elif c == 1:
            around_value += base
            for s in Suit:
                claim(s, rank, 1)
    if around_value:
        breakdown["Arounds"] = around_value

    total = (run_value + marriage_value + common_value + dix_count * DIX_VALUE
             + pinochle_value + no_ks_bonus + around_value)
    return total, breakdown, pool  # pool = leftover cards, handed to the adjustment layer


def compute_trick_potential(hand, trump):
    """
    What this hand can win with cards rather than with meld - the stage
    between the Base Bid and the competitive adjustment (#277). Six lines,
    all additive, all counted per card unless said otherwise:

      +ACE_VALUE          per Ace, any suit
      +TRUMP_ACE_VALUE    per Ace of trump, ON TOP of the line above
      +EXTRA_TRUMP_VALUE  per trump card past TRUMP_LENGTH_BASELINE
      +PROTECTED_TEN_VALUE per non-trump 10 with both Aces of its suit in hand
      +LOOSE_KING_VALUE   per non-trump King with no Queen of its suit
      +LOOSE_QUEEN_VALUE  per non-trump Queen with no King of its suit

    A trump Ace collecting both Ace lines, and so being worth 40, is
    deliberate: Paul kept the two as separate rules and the card really is
    doing two jobs - it is a certain trick like any Ace, and it is the
    card that controls the trump suit.

    "Not part of a marriage" is read exactly as Paul defined it: no
    matching K/Q of the same suit anywhere in the hand. It is a property
    of the suit rather than of the individual card, so K-K-Q of one suit
    pays the marriage and nothing here - the spare King has a Queen behind
    it and is not loose by this test. Arounds are not consulted: a King
    with no Queen of its suit is loose whether or not it is also part of
    Kings Around, because the Around already paid for a different thing.

    Trump honours are excluded from the last two lines because the Run and
    Royal Marriage lines in the Base Bid have already priced them, and
    trump 10s from the protected-10 line for the same reason.

    Returns (total, breakdown_dict).
    """
    breakdown = {}

    ace_count = sum(1 for c in hand if c.rank == "A")
    if ace_count:
        breakdown["Aces (flat, 20/ea)"] = ace_count * ACE_VALUE

    trump_aces = _hand_count(hand, trump, "A")
    if trump_aces:
        breakdown["Ace of trump"] = trump_aces * TRUMP_ACE_VALUE

    extra_trump = max(0, _suit_length(hand, trump) - TRUMP_LENGTH_BASELINE)
    if extra_trump:
        breakdown["Trump length (beyond 4)"] = extra_trump * EXTRA_TRUMP_VALUE

    protected_tens = sum(1 for c in hand if _is_protected_ten(hand, trump, c))
    if protected_tens:
        breakdown["10 behind both Aces"] = protected_tens * PROTECTED_TEN_VALUE

    loose_kings = 0
    loose_queens = 0
    for suit in Suit:
        if suit == trump:
            continue
        kings = _hand_count(hand, suit, "K")
        queens = _hand_count(hand, suit, "Q")
        if kings and not queens:
            loose_kings += kings
        if queens and not kings:
            loose_queens += queens
    if loose_kings:
        breakdown["Unmarried Kings"] = loose_kings * LOOSE_KING_VALUE
    if loose_queens:
        breakdown["Unmarried Queens"] = loose_queens * LOOSE_QUEEN_VALUE

    return sum(breakdown.values()), breakdown


def compute_competitive_adjustment(hand, trump, my_score=0, opp_score=0):
    """
    Score-context-driven adjustment on top of Base Bid, meant to protect
    the FINAL score clearing the bid - not a hand-shape estimate.

      +160 if: behind by 600+ points, OR the hand has a rare double-payoff
               shape (missing only the trump Ace for a Run, while already
               holding an Ace in each of the other 3 suits - landing that
               one card would complete BOTH the Run and Aces Around at once,
               worth pushing harder for)
      +100 if: within 300 of winning AND opponent is 500+ from winning
               (push to close the game out while they're far behind)
      +130 otherwise (baseline)
    """
    breakdown = {}

    missing_ranks = [r for r in RUN_RANKS if _hand_count(hand, trump, r) == 0]
    near_run_missing_ace = (
        len(missing_ranks) == 1 and missing_ranks[0] == "A"
        and all(_hand_count(hand, trump, r) >= 1 for r in RUN_RANKS if r != "A")
    )
    has_other_3_aces = sum(1 for s in Suit if s != trump and _hand_count(hand, s, "A") >= 1) == 3
    double_payoff_shape = near_run_missing_ace and has_other_3_aces

    behind_600 = (opp_score - my_score) >= 600

    if behind_600 or double_payoff_shape:
        value = 160
        breakdown["Competitive adj (behind 600+ / Run+AcesAround double-payoff)"] = value
    elif (my_score >= GAME_WIN_SCORE - 300) and (opp_score <= GAME_WIN_SCORE - 500):
        value = 100
        breakdown["Competitive adj (closing out the game)"] = value
    else:
        value = 130
        breakdown["Competitive adj (baseline)"] = value

    return value, breakdown


def compute_max_bid(hand, trump, my_score=0, opp_score=0):
    """Base Bid + trick potential + competitive adjustment = Max Bid (the
    ceiling), before the 400-cap / >300-meld-uncap rule is applied. The
    three stages are what the hand melds, what it takes, and what the
    scoreboard is asking for; only the last of them is not about the
    cards."""
    base_total, base_breakdown, pool = compute_base_bid(hand, trump)
    trick_total, trick_breakdown = compute_trick_potential(hand, trump)
    adj_total, adj_breakdown = compute_competitive_adjustment(hand, trump, my_score, opp_score)
    breakdown = dict(base_breakdown)
    breakdown.update(trick_breakdown)
    breakdown.update(adj_breakdown)
    return base_total + trick_total + adj_total, breakdown


def max_bid(hand, trump):
    """Bid ceiling for this hand/trump: 400 by default, uncapped (None) if
    actual guaranteed meld (score_melds, not the padded Base Bid) exceeds 300."""
    actual_meld, _ = score_melds(hand, trump)
    if actual_meld > MAX_BID_MELD_THRESHOLD:
        return None
    return MAX_BID_DEFAULT


def capped_bid(hand, trump, base_bid_value):
    cap = max_bid(hand, trump)
    if cap is None:
        return base_bid_value
    return min(base_bid_value, cap)


def best_base_bid(hand, my_score=0, opp_score=0):
    """Searches all 4 trump candidates, returns (trump, capped_ceiling, breakdown).
    Ceiling = Base Bid + Competitive adjustment, then the 400-cap /
    >300-meld-uncap rule is applied."""
    best_trump, best_total, best_breakdown = None, -1, None
    for t in Suit:
        total, b = compute_max_bid(hand, t, my_score, opp_score)
        capped = capped_bid(hand, t, total)
        if capped > best_total:
            best_trump, best_total, best_breakdown = t, capped, b
    return best_trump, best_total, best_breakdown


# ---------------------------------------------------------------------------
# Trick-play strategy — card counting, safe-card cascade, feed/withhold logic.
# Shared by all four seats; role only matters via which team-set gets passed.
# ---------------------------------------------------------------------------

POINT_RANKS = {"A", "10", "K"}


class PlayTracker:
    """Tracks cards played so far this round, across all 4 hands."""

    def __init__(self):
        self.played = {}  # (suit, rank) -> count played (0, 1, or 2)

    def record(self, card):
        key = (card.suit, card.rank)
        self.played[key] = self.played.get(key, 0) + 1

    def played_count(self, suit, rank):
        return self.played.get((suit, rank), 0)


def _hand_count(hand, suit, rank):
    return sum(1 for c in hand if c.suit == suit and c.rank == rank)


def _suit_length(hand, suit):
    return sum(1 for c in hand if c.suit == suit)


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
    partner_winning = winner_player in my_team_players if winner_player else False

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

    # sluff - free choice across suits, work toward a void in the shortest suit
    legal_sorted = sorted(legal_moves, key=lambda c: (_suit_length(hand, c.suit), RANK_VALUE[c.rank]))
    return legal_sorted[0]


# ---------------------------------------------------------------------------
# Shared pass/trick-play phase runners — used by Round for a real game, and
# reused as-is by the Monte Carlo rollout sampler (pinochle_rollout.py, issue
# #59) so there is exactly one implementation of "how passing/trick-play
# actually happens," not two that can drift apart. Free functions (not Round
# methods) so the rollout module can call them without a live Round/Deck.
# ---------------------------------------------------------------------------

def run_forward_pass(bid_winner, partner, trump_suit):
    """Partner -> bidder, PASS_COUNT cards, via the real
    Player.choose_pass_cards. Mutates both players' hands in place."""
    to_bidder = partner.choose_pass_cards(PASS_COUNT, trump_suit, is_bid_winner=False)
    for c in to_bidder:
        partner.hand.remove(c)
    bid_winner.hand.extend(to_bidder)


def run_return_pass(bid_winner, partner, trump_suit):
    """Bidder -> partner, PASS_COUNT cards, via the real
    Player.choose_pass_cards. Mutates both players' hands in place."""
    back_to_partner = bid_winner.choose_pass_cards(PASS_COUNT, trump_suit, is_bid_winner=True)
    for c in back_to_partner:
        bid_winner.hand.remove(c)
    partner.hand.extend(back_to_partner)


def run_simultaneous_pass(bid_winner, partner, trump_suit):
    """Simultaneous PASS_COUNT exchange (#80): both players choose their
    cards independently; once both selections are made the cards move
    atomically so neither sees what they will receive before committing
    their own selection. Mutates both players' hands in place."""
    to_bidder = partner.choose_pass_cards(PASS_COUNT, trump_suit, is_bid_winner=False)
    back_to_partner = bid_winner.choose_pass_cards(PASS_COUNT, trump_suit, is_bid_winner=True)
    for c in to_bidder:
        partner.hand.remove(c)
    bid_winner.hand.extend(to_bidder)
    for c in back_to_partner:
        bid_winner.hand.remove(c)
    partner.hand.extend(back_to_partner)


def play_tricks(players, trump, leader_index, tracker, num_tricks=12, trick_num_offset=0,
                 forced_lead_card=None):
    """
    Plays `num_tricks` tricks starting with players[leader_index] on lead,
    via each player's real choose_card (-> choose_lead_card/
    choose_follow_card). Mutates player hands and `tracker` in place.

    `trick_num_offset` is the overall trick number (0-11) of the first
    trick played here - only overall trick 11 gets the +10 last-trick
    bonus, so a caller resuming mid-round (rollout sampler picking up
    partway through a round) must pass the right offset to still award
    it in the correct trick.

    `forced_lead_card`, if given, is played as the leader's card for the
    very first trick of this call instead of asking that player's own
    choose_card - every other play (this trick's followers, and every
    later trick) still goes through the real choose_card as usual. Default
    None preserves the exact prior behavior for every existing caller
    (Round, the rollout sampler's own full-round rollouts). This exists so
    a caller (issue #63's GeneralStrategy, evaluating "what if I lead
    THIS specific candidate card") can force one hypothetical lead through
    the real rollout machinery without duplicating play_tricks' trick-loop
    logic just to inject a single card.

    Returns {team: trick_points} for just the tricks played here.
    """
    trick_points = {}
    for p in players:
        trick_points.setdefault(p.team, 0)

    for i in range(num_tricks):
        trick = Trick(trump)
        idx = leader_index
        for play_pos in range(4):
            player = players[idx]
            legal = trick.legal_moves(player.hand)
            is_bidder_first_lead_this_play = (
                trick_num_offset == 0 and i == 0 and play_pos == 0
            )
            if i == 0 and play_pos == 0 and forced_lead_card is not None:
                card = forced_lead_card
            else:
                card = player.choose_card(
                    legal, trick=trick, trump=trump,
                    tracker=tracker, my_team_players=set(player.team.players),
                    is_bidder_first_lead=is_bidder_first_lead_this_play,
                )
            player.hand.remove(card)
            trick.play(player, card)
            tracker.record(card)
            idx = (idx + 1) % 4

        winner = trick.winner()
        points = trick.points()
        if trick_num_offset + i == 11:
            points += 10  # last trick bonus
        trick_points[winner.team] += points
        leader_index = players.index(winner)

    return trick_points


# ---------------------------------------------------------------------------
# Trick — owns lead suit, trump, legal-move filtering, and winner resolution.
# ---------------------------------------------------------------------------

class Trick:
    def __init__(self, trump_suit):
        self.trump_suit = trump_suit
        self.plays = []  # list of (player, card)

    @property
    def lead_suit(self):
        return self.plays[0][1].suit if self.plays else None

    def legal_moves(self, hand):
        if not self.plays:
            return list(hand)  # leading: anything goes

        lead_suit = self.lead_suit
        lead_cards_on_table = [c for _, c in self.plays if c.suit == lead_suit]
        trump_cards_on_table = [c for _, c in self.plays if c.suit == self.trump_suit]

        has_lead_suit = [c for c in hand if c.suit == lead_suit]
        if has_lead_suit:
            best_on_table = max(lead_cards_on_table, key=lambda c: c.rank_value)
            beaters = [c for c in has_lead_suit if c.rank_value > best_on_table.rank_value]
            return beaters if beaters else has_lead_suit

        has_trump = [c for c in hand if c.suit == self.trump_suit]
        if has_trump:
            if trump_cards_on_table:
                best_trump = max(trump_cards_on_table, key=lambda c: c.rank_value)
                beaters = [c for c in has_trump if c.rank_value > best_trump.rank_value]
                return beaters if beaters else has_trump
            return has_trump

        return list(hand)  # sluff — nothing of lead suit or trump

    def play(self, player, card):
        self.plays.append((player, card))

    def winner(self):
        trump_plays = [(p, c) for p, c in self.plays if c.suit == self.trump_suit]
        pool = trump_plays if trump_plays else [(p, c) for p, c in self.plays if c.suit == self.lead_suit]
        # max() keeps the first maximal element on ties -> "first copy played wins" falls out for free
        winner_player, _ = max(pool, key=lambda pc: pc[1].rank_value)
        return winner_player

    def points(self):
        counting_ranks = {"A", "10", "K"}
        return sum(10 for _, c in self.plays if c.rank in counting_ranks)


# ---------------------------------------------------------------------------
# Passing strategy — skill-level-proficient, split by trump category
# (Diamonds/Spades vs Hearts/Clubs) and role (bidder vs partner).
# ---------------------------------------------------------------------------

def _n_of(hand, suit, rank):
    return sum(1 for c in hand if c.suit == suit and c.rank == rank)


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
_PARTNER_FILLER_ORDER = {"J": 0, "10": 1, "Q": 2, "K": 3}


def _partner_filler_order(hand, trump, card):
    # The protected 10 is the exception, and it is a reading of #280 rather
    # than something Paul stated: a 10 with both Aces of its suit behind it
    # is a trick this hand can still cash (#276), and the Ace tier above has
    # already declined to break that group up, so shipping the 10 out from
    # under the pair produces exactly the bare-10 outcome #276 exists to
    # prevent. It sorts behind the King instead of with the ordinary 10s.
    if card.rank == "10" and _is_protected_ten(hand, trump, card):
        return 4
    # 5 is unreachable in practice - trump, Aces and 9s are all gone by the
    # time this tier runs. It is here so the tier can double as the
    # catch-all that guarantees `count` gets filled.
    return _PARTNER_FILLER_ORDER.get(card.rank, 5)


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
    `_partner_filler_order` for tier 9's order.
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
          sort_key=lambda c: _partner_filler_order(hand, trump, c))

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

TOTAL_TRUMP_COPIES = 12  # 6 ranks x 2 copies each


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
    partner_winning = winner_player in my_team_players if winner_player else False

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

    # Free sluff - no lead-suit card, no trump forced. Protect count cards
    # first, then build toward a void in the shortest suit among whatever
    # is left, same tie-break as the Proficient-tier choose_follow_card.
    non_points = [c for c in legal_moves if c.rank not in POINT_RANKS]
    pool = non_points if non_points else legal_moves
    legal_sorted = sorted(pool, key=lambda c: (_suit_length(hand, c.suit), RANK_VALUE[c.rank]))
    return legal_sorted[0]


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

        trump, base_bid, _ = best_base_bid(self.hand, my_score, opp_score)
        cap = max_bid(self.hand, trump)
        ceiling = base_bid if cap is None else min(base_bid, cap)

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
            # The floor is deliberately well below OPENER_THRESHOLD. Paul's
            # house rule is 320; measured against this rule, 320 cost 57 points
            # a deal and 200 costs nothing detectable. The constant carries the
            # numbers.
            #
            # The >800 sub-case is gone: it applied OPENER_THRESHOLD, which is
            # no longer this rule's floor, and a seat near the end of the game
            # has #256's endgame protection in front of it doing that job with
            # thresholds chosen for it.
            if context["passes_so_far"] == 2:
                return OPENING_BID if ceiling >= THIRD_BIDDER_FLOOR else None

            # Normal opener threshold
            return OPENING_BID if ceiling >= OPENER_THRESHOLD else None

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
                return None if ceiling < 340 else current_bid + min_increment

            return None  # our own bid already stands, no need to raise ourselves

        # Opponent currently holds the bid.
        partner_has_bid = any(p is partner for p, _ in context["bid_history"])
        effective_ceiling = max(ceiling, 330) if partner_has_bid else ceiling
        if cap is not None:
            effective_ceiling = min(effective_ceiling, cap)

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
        trump, _, _ = best_base_bid(self.hand)
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
# imports FROM this module, and pinochle_engine.py is scoped (per issue
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
        trump, base_bid, _ = best_base_bid(self.hand, my_score, opp_score)

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
            cap = max_bid(self.hand, trump)
            ceiling = base_bid if cap is None else min(base_bid, cap)
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
        if base_bid < FORCED_BID:
            return None

        next_bid = OPENING_BID if not context["ever_bid"] else current_bid + min_increment
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


class Team:
    def __init__(self, name, players):
        self.name = name
        self.players = players  # list of 2 Player objects
        self.score = 0
        self.meld_points = 0
        self.trick_points = 0
        # Per-round bookkeeping, stamped by Round.run() (see below) right
        # after the bid winner/trump are determined and before passing -
        # existing tiers (Player/EasyPlayer) never read these, but
        # GeneralStrategy (issue #63) needs a channel to learn "am I on
        # the bidding team" and "what's the contract" at decision points
        # (choose_pass_cards/choose_card) whose call signatures are fixed
        # by Player's own contract and can't be extended with new
        # required args without touching Player/EasyPlayer. Defaults here
        # keep isolated/no-Round usage (e.g. hand-built Team objects in
        # tests) safe - GeneralStrategy treats an unset opponent/round_bid
        # as "no real round context available" and falls back to static
        # (non-rollout) behavior rather than guessing.
        self.is_bidding_team = False
        self.round_bid = None
        self.opponent = None


# ---------------------------------------------------------------------------
# Round — everything that happens in a single hand: deal through scoring.
# ---------------------------------------------------------------------------

PASS_COUNT = 3


class Round:
    def __init__(self, players, teams, dealer_index, deal_rng=None):
        self.players = players
        self.teams = teams
        self.dealer_index = dealer_index
        self.deck = Deck()
        # Optional dedicated RNG for the shuffle only (issue #105) - see
        # Deck.shuffle. None keeps the previous global-RNG behaviour.
        self.deal_rng = deal_rng

        self.current_bid = OPENING_BID
        self.bid_winner = None
        self.trump_suit = None
        self.tracker = PlayTracker()
        self.conceded = False  # set by _concede_phase (issue #100)
        # True when this round's concession was forced by the auto-SET rule
        # rather than chosen by the bid winner (issue #178). A strict subset of
        # `conceded`, kept separate so harnesses can report how often the rule
        # actually fires - the frequency is what says whether the rule matters,
        # and it is not recoverable from `conceded` alone once the fold model
        # also concedes hands.
        self.auto_set = False

    def run(self):
        self._deal()
        self._bidding_loop()
        if self.bid_winner is None:
            # everyone passed with no bid — dealer forced to take it at FORCED_BID
            self.bid_winner = self.players[self.dealer_index]
            self.current_bid = FORCED_BID

        self.trump_suit = self.bid_winner.choose_trump()
        self._stamp_team_round_context()
        self._passing_phase()
        self._meld_phase()

        if self._concede_phase():
            self._discard_hands()
            return self._score_conceded_round()

        trick_points = self._trick_taking_loop()

        return self._score_round(trick_points)

    def _deal(self):
        self.deck.shuffle(self.deal_rng)
        self.deck.deal(self.players)

    def _left_of_dealer(self):
        return (self.dealer_index + 1) % 4

    def _bidding_loop(self):
        """
        Rotate clockwise from left of dealer. Each active player bids
        >= current_bid + 10, or passes. Passing removes them from
        rotation. Ends when 3 have passed; 4th is bid_winner. Leaves
        self.bid_winner as None if everyone passes without ever bidding.
        """
        active = [True, True, True, True]
        idx = self._left_of_dealer()
        current_bid = 0
        ever_bid = False
        passes = 0
        passes_so_far = 0
        bid_history = []  # list of (player, amount)
        # (player, the minimum bid they declined) - richer than a bare list of
        # who passed, because "declined to bid 340" bounds a hand from above
        # while "declined to bid 300" says something much stronger. Issue #101
        # uses this to reject determinized deals that contradict the auction.
        pass_history = []
        dealer = self.players[self.dealer_index]

        while passes < 3:
            if active[idx]:
                player = self.players[idx]
                min_bid = OPENING_BID if not ever_bid else current_bid + MIN_BID_INCREMENT
                context = {
                    "ever_bid": ever_bid,
                    "passes_so_far": passes_so_far,
                    "bid_history": bid_history,
                    "pass_history": pass_history,
                    "passed_players": [p for p, _ in pass_history],
                    "dealer": dealer,
                    "teams": self.teams,
                }
                bid = player.choose_bid(
                    current_bid if ever_bid else OPENING_BID - MIN_BID_INCREMENT,
                    MIN_BID_INCREMENT,
                    context,
                )
                if bid is not None and bid >= min_bid:
                    current_bid = bid
                    ever_bid = True
                    self.bid_winner = player
                    bid_history.append((player, bid))
                else:
                    active[idx] = False
                    passes += 1
                    passes_so_far += 1
                    pass_history.append((player, min_bid))
                    if sum(active) == 1 and ever_bid:
                        break
            idx = (idx + 1) % 4

        if ever_bid:
            self.current_bid = current_bid
        else:
            self.bid_winner = None

    def _stamp_team_round_context(self):
        """
        Round-global bookkeeping both teams can read for the rest of this
        round, generically (not specific to any AI tier) - same spirit as
        `_meld_phase` setting `team.meld_points` for both teams below.
        `GeneralStrategy` (issue #63) uses this to learn "am I on the
        bidding team" and "what's the contract" at decision points that
        don't otherwise carry that information (`choose_pass_cards`,
        `choose_card`); Player/EasyPlayer never read it. `team.opponent`
        is round-invariant in practice (the same two Team objects persist
        for the whole Game) but is cheap to re-stamp every round rather
        than special-cased at construction time.
        """
        team_a, team_b = self.teams
        team_a.opponent = team_b
        team_b.opponent = team_a
        for team in self.teams:
            team.is_bidding_team = (team is self.bid_winner.team)
            team.round_bid = self.current_bid

    def _passing_phase(self):
        partner = next(p for p in self.bid_winner.team.players if p is not self.bid_winner)
        run_simultaneous_pass(self.bid_winner, partner, self.trump_suit)

    def _meld_phase(self):
        for team in self.teams:
            team.meld_points = 0  # per-round, not cumulative like team.score
        for player in self.players:
            points, _breakdown = score_melds(player.hand, self.trump_suit)
            player.team.meld_points += points

    def _concede_phase(self):
        """
        Offer the bid winner the chance to concede the contract (issue #100),
        once, after meld is declared and before any card is led. Mirrors the
        window the web client already gives the human (#83) rather than
        inventing a second set of concede rules.

        Only the bid winner is asked: their partner cannot concede a contract
        they did not take, and the defending team has nothing to concede.

        Two things can end the round here, in this order:

          1. Auto-SET (issue #178, `pinochle_expert_ai_strategy.md` Section 5).
             When the bidding team's meld plus every trick point in the round
             still falls short of the bid, the contract is arithmetically
             unmakeable: winning all twelve tricks cannot reach it, and playing
             on can only hand the defenders trick points a concession denies
             them. `pinochle_rollout.is_auto_set` has pruned exactly this case
             inside rollouts since #59; #178 is what applies it to a real game.
             Not a decision, so nobody is asked - it fires for every tier,
             including the ones whose `decide_fold` never folds, and it fires
             ahead of `decide_fold` because that is a probabilistic judgement
             and this is not. A hand that cannot be made must never reach an
             evaluator that might talk it into playing on.

          2. The bid winner's own `decide_fold`, for everything else.

        Sets `self.auto_set`, and sets and returns `self.conceded`.
        """
        from pinochle_rollout import is_auto_set

        bidding_team = self.bid_winner.team
        defending_team = next(t for t in self.teams if t is not bidding_team)

        if is_auto_set(bidding_team.meld_points, self.current_bid):
            self.auto_set = True
            self.conceded = True
            return True

        self.conceded = bool(
            self.bid_winner.decide_fold(
                self.trump_suit,
                self.current_bid,
                bidding_team.meld_points,
                defending_team.meld_points,
            )
        )
        return self.conceded

    def _discard_hands(self):
        """
        Throw the four hands in after a concede.

        Necessary because `Player.receive_cards` *extends* the hand rather
        than replacing it - dealing has always relied on trick play having
        emptied all four hands as a side effect of playing 12 tricks. A
        conceded round is the first path that ends without playing those
        tricks, so without this the next `_deal` builds a 24-card hand
        holding every card twice, and the first thing to notice is a
        confusing "duplicate card" error from the rollout sampler several
        rounds later.
        """
        for player in self.players:
            player.hand.clear()

    def _score_conceded_round(self):
        """
        Score a conceded round. The bidding team forfeits its meld and takes
        -bid, exactly as if it had been set. The defenders keep their meld but
        score no trick points, because no trick was played - conceding denies
        them up to 250 points they would otherwise have collected, which is a
        real part of why conceding can be the better move.

        Also zeroes `team.trick_points`, so a caller reading round state after
        a concede sees "no tricks were taken" rather than whatever the
        previous round happened to leave there.
        """
        bidding_team = self.bid_winner.team
        round_scores = {}
        for team in self.teams:
            team.trick_points = 0
            if team is bidding_team:
                round_scores[team] = -self.current_bid
            else:
                round_scores[team] = team.meld_points
        return round_scores

    def _trick_taking_loop(self):
        """Runs 12 tricks, returns {team: trick_points}."""
        leader_index = self.players.index(self.bid_winner)
        trick_points = play_tricks(self.players, self.trump_suit, leader_index, self.tracker)

        for team in self.teams:
            team.trick_points = trick_points[team]

        return trick_points

    def _score_round(self, trick_points):
        """
        Apply contract check: if bid_winner's team total < bid, they
        score -bid; defenders keep their own meld + trick points
        regardless.
        """
        round_scores = {}
        bidding_team = self.bid_winner.team
        for team in self.teams:
            total = team.meld_points + trick_points[team]
            if team is bidding_team and total < self.current_bid:
                round_scores[team] = -self.current_bid
            else:
                round_scores[team] = total
        return round_scores


# ---------------------------------------------------------------------------
# Game — persistent scores across rounds, win condition.
# ---------------------------------------------------------------------------

def determine_winner(teams, bidding_team):
    """
    Decide whether the game has ended, given cumulative team scores that
    already include the round just scored. Returns the winning Team, or
    None if the game continues.

    This is the single home for the rule (issue #6); `Game.play` and
    `play_local.py` both go through it rather than re-deriving it, which
    is how the tie-break below stayed correct in one copy and not the
    other. Per pinochle_rules.md "Game Win / Loss":

      - A team whose cumulative score is at or below GAME_LOSE_SCORE ends
        the game immediately and the OTHER team wins, regardless of that
        team's own score. Busting is checked first.
      - Otherwise, if either team has reached GAME_WIN_SCORE, that team
        wins - and if both crossed it in the same round, the bidding team
        wins the tie.

    Mirrors `checkGameOutcome` in web/src/engine/game.ts, including
    returning None in the degenerate case where every team busted at once.
    """
    busted = [t for t in teams if t.score <= GAME_LOSE_SCORE]
    if busted:
        return next((t for t in teams if t not in busted), None)

    over = [t for t in teams if t.score >= GAME_WIN_SCORE]
    if over:
        return bidding_team if bidding_team in over else over[0]

    return None


class Game:
    def __init__(self, player_names):
        players = [Player(name, None) for name in player_names]
        self._init_from_players(players)

    @classmethod
    def from_players(cls, players):
        """
        Build a Game from 4 already-constructed player objects (any mix of
        Player/EasyPlayer/HumanPlayer/etc.) instead of just
        names - added for issue #53 so tournament-sim harnesses can wire up
        mixed AI tiers per seat. Seating/teams are wired identically to
        __init__ (seats 0&2 = Team A, seats 1&3 = Team B, per
        pinochle_rules.md), so existing callers of Game(player_names) are
        unaffected.
        """
        assert len(players) == 4
        game = cls.__new__(cls)
        game._init_from_players(list(players))
        return game

    def _init_from_players(self, p):
        """Shared team-wiring logic used by both __init__ and from_players."""
        assert len(p) == 4
        team_a = Team("Team A", [p[0], p[2]])
        team_b = Team("Team B", [p[1], p[3]])
        p[0].team = p[2].team = team_a
        p[1].team = p[3].team = team_b

        self.players = p
        self.teams = [team_a, team_b]
        self.dealer_index = 0

    def play(self, deal_seed=None, on_round=None):
        """
        Play rounds until someone wins.

        `deal_seed` makes the *sequence of deals* reproducible independently
        of anything the players do (issue #105). Each round draws its own
        shuffle seed from a master RNG seeded here, so round N's deal depends
        only on `deal_seed` and N - not on how many random values the AI
        happened to consume in rounds 1..N-1. That is what lets two different
        configurations be compared on identical deals. None keeps the
        previous behaviour of shuffling from the global RNG.

        `on_round(round_, round_scores)` is called after each round is scored,
        for harnesses that want per-round detail (bids, sets, concedes)
        without wrapping or monkeypatching Round.
        """
        deal_master = random.Random(deal_seed) if deal_seed is not None else None

        winner = None
        while winner is None:
            deal_rng = (
                random.Random(deal_master.randrange(2 ** 63))
                if deal_master is not None else None
            )
            round_ = Round(self.players, self.teams, self.dealer_index, deal_rng=deal_rng)
            round_scores = round_.run()

            if on_round is not None:
                on_round(round_, round_scores)

            bidding_team = round_.bid_winner.team
            for team in self.teams:
                team.score += round_scores[team]

            winner = determine_winner(self.teams, bidding_team)

            self.dealer_index = (self.dealer_index + 1) % 4

        return winner


if __name__ == "__main__":
    # Sanity checks: meld scoring (including Double Run) and a few full games.
    from itertools import product

    # Double Run check
    trump = Suit.SPADES
    hand = [Card(trump, r, c) for r in ("A", "10", "K", "Q", "J") for c in (1, 2)]
    total, breakdown = score_melds(hand, trump)
    assert breakdown.get("Double Run") == 1500, breakdown
    assert "Run" not in breakdown
    print("Double Run check passed:", breakdown)

    # Single run should NOT get the double value
    hand2 = [Card(trump, r, 1) for r in ("A", "10", "K", "Q", "J")]
    total2, breakdown2 = score_melds(hand2, trump)
    assert breakdown2.get("Run") == 150, breakdown2
    assert "Double Run" not in breakdown2
    print("Single Run check passed:", breakdown2)

    # Full games
    for i in range(10):
        game = Game(["N", "E", "S", "W"])
        winner = game.play()
        loser = next(t for t in game.teams if t is not winner)
        assert winner.score >= GAME_WIN_SCORE or loser.score <= GAME_LOSE_SCORE
    print("10/10 full games completed cleanly with Double Run scoring active.")

    # AI tier sanity checks (issue #53) - EasyPlayer only ever produces
    # legal moves, and Game.from_players() supports mixed tiers across the
    # 4 seats. See test_ai_tiers.py for the full test suite.
    tier_mixes = [
        [EasyPlayer, EasyPlayer, EasyPlayer, EasyPlayer],
        [EasyPlayer, Player, EasyPlayer, Player],
        [Player, EasyPlayer, Player, EasyPlayer],
    ]
    for i, classes in enumerate(tier_mixes):
        names = ["N", "E", "S", "W"]
        players = [cls(name, None) for cls, name in zip(classes, names)]
        game = Game.from_players(players)
        winner = game.play()
        loser = next(t for t in game.teams if t is not winner)
        assert winner.score >= GAME_WIN_SCORE or loser.score <= GAME_LOSE_SCORE
    print(f"{len(tier_mixes)}/{len(tier_mixes)} mixed-tier games (Easy/Proficient) completed cleanly via Game.from_players().")
