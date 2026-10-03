"""
Pinochle rules engine - the rules half of the Python engine (#250, epic #214).

AUTHORITY: this file is on the Python-authoritative side of #213's line.
Every constant here is a rules or valuation number that Python owns: if
the TypeScript port in `web/src/engine/` disagrees with one of them, the
TypeScript has drifted (#118's bug class; `test_ported_constants.py`'s
PYTHON pairs). It is also what `export_parity_scenarios.py` records the
TypeScript engine's parity fixture from.

Implements: deal, bidding, 3-card pass, meld scanning, trick-taking,
round scoring, and multi-round game to +1000 / -1000, per
pinochle_rules.md. Also the bid-valuation chain (`compute_base_bid`
through `best_base_bid`), which is Python-authoritative for the
TypeScript port in the same way the rules constants are.

The AI strategy layer - `Player` and its subclasses, the lead/follow and
pass-selection heuristics, the auction-strategy thresholds - lives in
`pinochle_ai.py` (#249), which imports its rules names from here. Nothing
in this file imports `pinochle_ai` at load time: the two places rules code
calls strategy (`Game.__init__`'s default `Player`, the #326 branch of
`compute_trick_potential`) import inside the function, so the only
load-time edge is strategy -> rules.

`pinochle_engine.py` is a re-export shim over this module and
`pinochle_ai.py`; existing `from pinochle_engine import ...` callers go
through it unchanged. Patch rules names on this module, not on the shim -
rebinding a name on the shim is not seen by the functions defined here.
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
# compute_max_bid sums the three, and that sum is the ceiling. Nothing caps
# it (#283).
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
# `compute_base_bid`'s docstring always said this belonged somewhere else and
# named the competitive adjustment as its home, but that layer only ever read
# the score, so until #277 nothing priced the tricks card by card. It does now,
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
# The alternative reading of the same line (#326), OFF by default and not
# shipped. `pinochle_valuation.md` - Paul's written valuation - says "for
# every K or Q that is not a marriage *and you will pass* - 20". Read
# literally, a loose K/Q is worth LOOSE_KQ_PASSED_VALUE when the bidder's own
# return pass (`_bidder_pass_selection`, on the hand as dealt, at the trump
# being valued) would send it to partner, and 0 when it would be kept. With
# the flag off, the two constants above apply to every loose K/Q, which is
# what has shipped since #277. Whether to switch is a paired-A/B question
# (#288's valuation arm), not a judgement call; see compute_trick_potential.
LOOSE_KQ_PASS_ONLY = False
LOOSE_KQ_PASSED_VALUE = 20
# A partner-strength estimate. Nothing reads it: the comment here used to say
# Proficient draws randomly in this range each bid, and no code has ever done
# so. It is kept because it names the quantity the competitive adjustment is
# left standing in for since #308 - see that function's docstring.
PARTNER_ESTIMATE_RANGE = (50, 100)
# There is no cap on the ceiling. MAX_BID_DEFAULT = 400 and
# MAX_BID_MELD_THRESHOLD = 300 used to be the two constants here that made one
# (#283): every hand stopped at 400 unless its *guaranteed* meld (score_melds,
# not the speculative Base Bid) cleared 300, in which case `max_bid` returned
# None and the raw valuation passed through.
#
# The Double Run is the shape that makes that wrong. It is worth 1500, more
# than the whole game - but it only exists if this hand names trump. Lose the
# auction and those ten cards are ten ordinary cards scoring nothing as a run,
# so a hand holding one has to be able to keep bidding until it wins, and a
# flat 400 can hand the contract to an opponent while the AI sits on a game it
# was not allowed to bid for. The cap's other job was to restrain a
# speculative valuation, and Paul's judgement is that this is not worth the
# cost, since there is no bluffing behaviour here for a cap to restrain.
#
# This does not make the AI bid higher on an ordinary hand, and nobody should
# read it as licence to: `choose_bid` raises to `current_bid + min_increment`,
# never to its ceiling. The ceiling is a limit, not a target. What is gone is
# an artificial stop when the opponents push past 400.
#
# The auction-strategy thresholds that used to follow here - OPENER_THRESHOLD,
# the opening anchor, DEFENSIVE_PUSH_FLOOR, endgame protection,
# THIRD_BIDDER_FLOOR and the two #213 partner floors - are strategy, not
# valuation, and live in pinochle_ai.py (#249). Nothing in this module reads
# them.


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


def compute_trick_potential(hand, trump, loose_kq_pass_only=None):
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

    `loose_kq_pass_only` (#326; None means the module's LOOSE_KQ_PASS_ONLY,
    which is False) replaces the last two lines with Paul's written
    "and you will pass" reading: a loose K/Q - same suit-level test as
    above - is worth LOOSE_KQ_PASSED_VALUE if it would go into the pass,
    and 0 if it would be kept. "Into the pass" is defined from the seat
    the valuation speaks for. This number is a ceiling - what the hand is
    worth *as the contract-holder* - so the pass in question is the bid
    winner's return pass, `_bidder_pass_selection(hand, trump, category,
    PASS_COUNT)`, run on the dealt 12 cards at the trump being valued. The
    partner's forward pass never enters: a hand is only valued for a
    contract it would hold. The bidder really passes from 15 cards, after
    partner's three arrive; those three are unknown at bid time, so the
    dealt hand is the only honest input. Loose K/Q of one suit are
    credited per copy actually selected, so K-K with one K passed pays 20.

    Returns (total, breakdown_dict).
    """
    if loose_kq_pass_only is None:
        loose_kq_pass_only = LOOSE_KQ_PASS_ONLY
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

    if loose_kq_pass_only:
        if loose_kings or loose_queens:
            # The valuation's one edge into the strategy layer: the pass
            # this reading prices is the bidder's real return pass. Imported
            # here, not at module scope, because pinochle_ai imports FROM
            # this module - the same lazy idiom as Game.__init__ below.
            from pinochle_ai import _bidder_pass_selection
            category = "DS" if trump in (Suit.SPADES, Suit.DIAMONDS) else "HC"
            passed = _bidder_pass_selection(hand, trump, category, PASS_COUNT)
            passed_loose = sum(
                1 for c in passed
                if c.suit != trump and (
                    (c.rank == "K" and _hand_count(hand, c.suit, "Q") == 0)
                    or (c.rank == "Q" and _hand_count(hand, c.suit, "K") == 0)))
            if passed_loose:
                breakdown["Unmarried K/Q going into the pass"] = (
                    passed_loose * LOOSE_KQ_PASSED_VALUE)
        return sum(breakdown.values()), breakdown

    if loose_kings:
        breakdown["Unmarried Kings"] = loose_kings * LOOSE_KING_VALUE
    if loose_queens:
        breakdown["Unmarried Queens"] = loose_queens * LOOSE_QUEEN_VALUE

    return sum(breakdown.values()), breakdown


def compute_competitive_adjustment(hand, trump, my_score=0, opp_score=0):
    """
    Score-context-driven adjustment, the last of the three stages: added on
    top of what the hand melds (Base Bid) and what it takes (trick
    potential), to cover what the hand cannot see - chiefly partner.

      +120 if: behind by 600+ points, OR the hand has a rare double-payoff
               shape (missing only the trump Ace for a Run, while already
               holding an Ace in each of the other 3 suits - landing that
               one card would complete BOTH the Run and Aces Around at once,
               worth pushing harder for)
      +60  if: within 300 of winning AND opponent is 500+ from winning
               (closing the game out while they're far behind - the most
               cautious of the three)
      +80  otherwise (baseline)

    These were +160 / +100 / +130 until #308, and all three came down by the
    same 40 on Paul's decision of 2026-09-15 (recorded on #282). The baseline
    alone then went 90 -> 80 on Paul's decision of 2026-09-19; the other two
    branches stayed at 120 and 60.

    WHY THEY MOVED. Until #277 this number stood in for two things the rest
    of the valuation did not price, and compute_base_bid's docstring said so
    in as many words: it "deliberately excludes remaining-card trick-taking
    potential and partner estimate - those live in
    compute_competitive_adjustment instead". #277 rewrote that docstring and
    added compute_trick_potential, which prices the trick-taking half
    directly, card by card - and nothing came off here to make room for it.
    So the +130 went on paying for tricks that were now paid for once
    already. That is an argument from the code rather than a measurement,
    but it is the suspected cause of what followed: the scale rose about 60
    a hand with no threshold following it, and on the shipped build auto-set
    (a contract arithmetically impossible before a card is led) went from
    6.6% of contracts to 13.0%.

    With the trick half priced elsewhere, what this stage is left carrying
    is mostly the partner-meld estimate, and
    PARTNER_ESTIMATE_RANGE = (50, 100) is the engine's own name for that
    quantity. The structural argument put the double-counted portion at
    roughly 55, which would leave about the range's midpoint of 75 - the
    reasoning behind the ~70 of #288's `lean` arm. +90 takes 40 of that 55
    rather than all of it, so it sits inside the range and above its
    midpoint: about one generous partner's meld, and no longer that plus a
    hand's worth of tricks. That is a statement of scale, not a derivation -
    nothing reads the range today.

    THE BRANCHES MOVE TOGETHER to keep their order. Lowering the baseline
    alone would have left closing-out at +100, above a +90 baseline, so a
    team nearly home would bid harder than normal - the opposite of what
    that branch is for. Behind still pushes hardest, closing out is still
    the most cautious, and every hand gives up the same 40.

    NO THRESHOLD MOVED WITH IT. Every rule that reads the ceiling -
    OPENER_THRESHOLD, THIRD_BIDDER_FLOOR, DEFENSIVE_PUSH_FLOOR,
    ENDGAME_RESCUE_CEILING and the two partner floors - is now 40 harder for
    the same hand to reach. That is the point of the change and not a side
    effect to compensate for; whether any of those six should move as well
    is still open on #282, to be decided once this change's effect is known.

    THIS IS A VALUE CHOSEN, NOT MEASURED. On 2026-09-02 the plan was to settle
    it with #288's paired A/B; on 2026-09-15 Paul set it directly instead. So
    +90 with #288 never having run is a recorded decision, not an oversight,
    and not a reason to put +130 back.
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
        value = 120
        breakdown["Competitive adj (behind 600+ / Run+AcesAround double-payoff)"] = value
    elif (my_score >= GAME_WIN_SCORE - 300) and (opp_score <= GAME_WIN_SCORE - 500):
        value = 60
        breakdown["Competitive adj (closing out the game)"] = value
    else:
        value = 80
        breakdown["Competitive adj (baseline)"] = value

    return value, breakdown


def compute_max_bid(hand, trump, my_score=0, opp_score=0, loose_kq_pass_only=None):
    """Base Bid + trick potential + competitive adjustment = Max Bid, the
    ceiling, full stop - nothing clamps this number (#283). The three
    stages are what the hand melds, what it takes, and what the scoreboard
    is asking for; only the last of them is not about the cards."""
    base_total, base_breakdown, pool = compute_base_bid(hand, trump)
    trick_total, trick_breakdown = compute_trick_potential(hand, trump, loose_kq_pass_only)
    adj_total, adj_breakdown = compute_competitive_adjustment(hand, trump, my_score, opp_score)
    breakdown = dict(base_breakdown)
    breakdown.update(trick_breakdown)
    breakdown.update(adj_breakdown)
    return base_total + trick_total + adj_total, breakdown


# `max_bid` and `capped_bid` used to sit here, and #283 collapsed both rather
# than hollowing them out: with nothing ever capped, `capped_bid` was a
# function that returned its argument, and `max_bid` was a function that
# returned None whose only remaining effect was a dead `if cap is None` branch
# at each of its three call sites - exactly the shape that invites a later
# reader to restore the cap by filling the branch back in. `compute_max_bid`
# is the ceiling now, and every caller says so in one line.


def best_base_bid(hand, my_score=0, opp_score=0, loose_kq_pass_only=None):
    """Searches all 4 trump candidates, returns (trump, ceiling, breakdown).
    Ceiling = the whole `compute_max_bid` sum for the best trump, unclamped
    (#283) - so the suit named here is the one this hand is genuinely worth
    most in, rather than the first suit that happened to reach a cap."""
    best_trump, best_total, best_breakdown = None, -1, None
    for t in Suit:
        total, b = compute_max_bid(hand, t, my_score, opp_score, loose_kq_pass_only)
        if total > best_total:
            best_trump, best_total, best_breakdown = t, total, b
    return best_trump, best_total, best_breakdown


# ---------------------------------------------------------------------------
# Card-counting primitives shared by both halves. `PlayTracker` is threaded
# through `Round` and `play_tricks` and read by the trick-play strategy in
# pinochle_ai.py; `_hand_count` / `_suit_length` / `_n_of` are counted by the
# valuation chain above as well as by strategy. They stay on the rules side
# because they record and count, and decide nothing (#249).
# ---------------------------------------------------------------------------

POINT_RANKS = {"A", "10", "K"}
TOTAL_TRUMP_COPIES = 12  # 6 ranks x 2 copies each


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


def _n_of(hand, suit, rank):
    return sum(1 for c in hand if c.suit == suit and c.rank == rank)


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
        # Lazy, for the same reason as compute_trick_potential's: the
        # one rules -> strategy edge at construction time, and
        # pinochle_ai imports FROM this module.
        from pinochle_ai import Player
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
