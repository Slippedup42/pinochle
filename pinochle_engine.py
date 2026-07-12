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
OPENING_BID = 300
FORCED_BID = 250  # what the dealer is stuck with if everyone passes without ever bidding


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

    def shuffle(self):
        random.shuffle(self.cards)

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
    once (a trump King is part of both a Run and a Royal Marriage), but
    within a single meld type you can't reuse a physical card — you need
    a second copy for a second instance of the same meld.

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

    royal_count = min(n(trump_suit, "K"), n(trump_suit, "Q"))
    if royal_count:
        breakdown["Royal Marriage"] = royal_count * ROYAL_MARRIAGE_VALUE

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
# Base Bid — the hand-strength number bidding decisions are built on.
# Distinct from score_melds: this is a *speculative* valuation (near-run,
# near-double-pinochle, remaining-card trick-taking potential, partner
# estimate), not the actual guaranteed meld.
# ---------------------------------------------------------------------------

RUN_RANKS = ("A", "10", "K", "Q", "J")
NEAR_RUN_VALUE = 120
NEAR_DOUBLE_PINOCHLE_VALUE = 225
ACE_VALUE = 20
PARTNER_ESTIMATE_RANGE = (50, 100)  # Proficient draws randomly in this range each bid
MAX_BID_DEFAULT = 400
MAX_BID_MELD_THRESHOLD = 300
OPENER_THRESHOLD = 320  # minimum Base Bid to justify opening at all


def compute_base_bid(hand, trump):
    """
    Pure hand-value Base Bid: meld you have, plus the Run/Double-Pinochle
    proximity bonuses, plus flat Ace value. Deliberately excludes
    remaining-card trick-taking potential and partner estimate - those
    live in compute_competitive_adjustment instead, since they're about
    context/speculation rather than what the hand itself guarantees.
    Returns (base_bid_total, breakdown_dict).
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

    # -- Royal marriage: only the "extra" (2nd) marriage beyond run/near-run
    royal_count = min(n(trump, "K"), n(trump, "Q"))
    marriage_value = 0
    if run_value > 0:
        if royal_count == 2:
            marriage_value = ROYAL_MARRIAGE_VALUE
            claim(trump, "K", 1)
            claim(trump, "Q", 1)
    else:
        marriage_value = royal_count * ROYAL_MARRIAGE_VALUE
        claim(trump, "K", royal_count)
        claim(trump, "Q", royal_count)
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

    # -- Aces, flat, ~2 tricks worth each -----------------------------------
    ace_count = sum(1 for c in hand if c.rank == "A")
    ace_value = ace_count * ACE_VALUE
    breakdown["Aces (flat, 20/ea)"] = ace_value

    # -- 3 different Aces bonus (near-Aces-Around, suit diversity) -----------
    distinct_ace_suits = sum(1 for s in Suit if n(s, "A") >= 1)
    three_aces_value = 0
    if distinct_ace_suits == 3:
        three_aces_value = 60 if trump in (Suit.HEARTS, Suit.CLUBS) else 50
        breakdown["3 different Aces bonus"] = three_aces_value

    total = (run_value + marriage_value + common_value + dix_count * DIX_VALUE
             + pinochle_value + around_value + ace_value + three_aces_value)
    return total, breakdown, pool  # pool = leftover cards, handed to the adjustment layer


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
    """Base Bid + Competitive adjustment = Max Bid (the ceiling), before
    the 400-cap / >300-meld-uncap rule is applied."""
    base_total, base_breakdown, pool = compute_base_bid(hand, trump)
    adj_total, adj_breakdown = compute_competitive_adjustment(hand, trump, my_score, opp_score)
    breakdown = dict(base_breakdown)
    breakdown.update(adj_breakdown)
    return base_total + adj_total, breakdown


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


def choose_lead_card(hand, trump, tracker):
    """
    Choose what to lead when you have control. Priority:
      1. Unsecured trump Ace
      2. Other unsecured Aces (longest suit first)
      3. Safe cards, cascading top-down by rank (longest suit first within a rank)
      4. Junk lead (non-point, non-trump) to surrender - shortest suit first
      5. Non-point trump as a last resort before giving up a point card
    """
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


def _current_winner(trick_plays, trump):
    trump_plays = [(p, c) for p, c in trick_plays if c.suit == trump]
    pool = trump_plays if trump_plays else [(p, c) for p, c in trick_plays if c.suit == trick_plays[0][1].suit]
    return max(pool, key=lambda pc: RANK_VALUE[pc[1].rank])


def choose_follow_card(hand, legal_moves, trick_plays, trump, my_team_players, tracker=None):
    """
    Choose which legal card to play when following (not leading).
    `legal_moves` already has the mandatory beat-if-possible / trump-if-void
    rules applied by Trick.legal_moves - this only picks which one to use.
    """
    if len(legal_moves) == 1:
        return legal_moves[0]

    lead_suit = trick_plays[0][1].suit if trick_plays else None
    winner_player, winner_card = _current_winner(trick_plays, trump) if trick_plays else (None, None)
    partner_winning = winner_player in my_team_players if winner_player else False

    all_lead_suit = lead_suit is not None and all(c.suit == lead_suit for c in legal_moves)
    all_trump = all(c.suit == trump for c in legal_moves)

    if all_lead_suit and lead_suit != trump:
        forced_beat = winner_card is not None and all(
            RANK_VALUE[c.rank] > RANK_VALUE[winner_card.rank] for c in legal_moves
        )
        if forced_beat:
            return min(legal_moves, key=lambda c: RANK_VALUE[c.rank])
        if partner_winning:
            feed_cards = [c for c in legal_moves if c.rank in ("K", "10")]
            if feed_cards:
                return max(feed_cards, key=lambda c: RANK_VALUE[c.rank])
            return min(legal_moves, key=lambda c: RANK_VALUE[c.rank])  # avoid donating a live Ace unless forced
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


def play_tricks(players, trump, leader_index, tracker, num_tricks=12, trick_num_offset=0):
    """
    Plays `num_tricks` tricks starting with players[leader_index] on lead,
    via each player's real choose_card (-> choose_lead_card/
    choose_follow_card). Mutates player hands and `tracker` in place.

    `trick_num_offset` is the overall trick number (0-11) of the first
    trick played here - only overall trick 11 gets the +10 last-trick
    bonus, so a caller resuming mid-round (rollout sampler picking up
    partway through a round) must pass the right offset to still award
    it in the correct trick.

    Returns {team: trick_points} for just the tricks played here.
    """
    trick_points = {}
    for p in players:
        trick_points.setdefault(p.team, 0)

    for i in range(num_tricks):
        trick = Trick(trump)
        idx = leader_index
        for _ in range(4):
            player = players[idx]
            legal = trick.legal_moves(player.hand)
            card = player.choose_card(
                legal, trick=trick, trump=trump,
                tracker=tracker, my_team_players=set(player.team.players),
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


def _take(pool, chosen, count, predicate, sort_key=lambda c: 0):
    """Move matching cards from pool into chosen (in place) until count is hit."""
    cands = sorted([c for c in pool if predicate(c)], key=sort_key)
    for c in cands:
        if len(chosen) >= count:
            return
        chosen.append(c)
        pool.remove(c)


def _partner_pass_selection(hand, trump, category, count):
    """
    Partner's send-to-bidder priority:
      D/S: QS, JD -> K/Q trump -> trump A/10/J -> non-trump aces
           (non-duplicate first) -> 9 of trump -> other 9s
      H/C: K/Q trump -> trump A/10/J -> non-trump aces
           (non-duplicate first) -> 9 of trump -> other 9s
    """
    pool = list(hand)
    chosen = []

    if category == "DS":
        _take(pool, chosen, count,
              lambda c: (c.suit == Suit.SPADES and c.rank == "Q")
              or (c.suit == Suit.DIAMONDS and c.rank == "J"))

    _take(pool, chosen, count, lambda c: c.suit == trump and c.rank in ("K", "Q"))

    trump_order = {"A": 0, "10": 1, "J": 2}
    _take(pool, chosen, count, lambda c: c.suit == trump and c.rank in ("A", "10", "J"),
          sort_key=lambda c: trump_order[c.rank])

    _take(pool, chosen, count, lambda c: c.suit != trump and c.rank == "A",
          sort_key=lambda c: 0 if _n_of(hand, c.suit, "A") == 1 else 1)

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
    _take(pool, chosen, count, lambda c: True)  # fallback

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
    Bidder's send-back-to-partner priority, matching the documented tiers:

      D/S: (protect trump/JD/QS) -> safe non-trump J/9 filler (not
           breaking marriage/around) -> non-trump 10s -> duplicate AS/AD
           (pro move) -> random non-trump J/9, no safety check (true
           last resort before touching anything else) -> spare K/Q ->
           any unprotected non-ace -> any unprotected -> protected

      H/C: QS/JD (unless the 60-queens+pinochle+1-run-card pro move
           applies) -> safe non-trump J/9 filler -> non-trump 10s ->
           random non-trump J/9 -> spare K/Q -> any unprotected non-ace
           -> any unprotected -> protected

    Aces are never passed except via the explicit pro-move tier (D/S
    only) - they're too valuable to give away speculatively.
    """
    pool = list(hand)
    chosen = []

    is_protected = lambda c: (
        c.suit == trump
        or (c.suit == Suit.SPADES and c.rank == "Q")
        or (c.suit == Suit.DIAMONDS and c.rank == "J")
    )

    if category == "HC":
        _, breakdown = score_melds(hand, trump)
        has_queens_around = any(k.startswith("Q") and "Around" in k for k in breakdown)
        has_pinochle = "Pinochle" in breakdown or "Double Pinochle" in breakdown
        has_run_card = any(_n_of(hand, trump, r) >= 1 for r in ("A", "10", "K", "Q", "J"))
        pro_move = has_queens_around and has_pinochle and has_run_card

        if not pro_move:
            _take(pool, chosen, count,
                  lambda c: (c.suit == Suit.SPADES and c.rank == "Q")
                  or (c.suit == Suit.DIAMONDS and c.rank == "J"))

    # Void opportunity: fully emptying a suit unlocks immediate trump
    # control, which beats scattering the same number of cards - check
    # this before falling into the generic rank tiers.
    if len(chosen) < count:
        void_cards = _find_void_opportunity(pool, trump, is_protected, count - len(chosen))
        if void_cards:
            for c in void_cards:
                if len(chosen) >= count:
                    break
                chosen.append(c)
                pool.remove(c)

    # Safe filler: non-trump J/9, only if it doesn't break a marriage/around
    _take(pool, chosen, count,
          lambda c: not is_protected(c) and c.rank in ("J", "9")
          and not _breaks_marriage(hand, c) and not _breaks_around(hand, c))

    # Non-trump 10s
    _take(pool, chosen, count, lambda c: not is_protected(c) and c.rank == "10")

    if category == "DS":
        # Pro move: duplicate AS/AD
        _take(pool, chosen, count,
              lambda c: c.rank == "A" and c.suit in (Suit.SPADES, Suit.DIAMONDS)
              and _n_of(hand, c.suit, "A") == 2)

    # Random J/9 - true last resort within this family, no safety check
    _take(pool, chosen, count, lambda c: not is_protected(c) and c.rank in ("J", "9"))

    # Spare K/Q not currently doing meld work (only QS is inherently
    # protected - KS and other K/Q are fair game here)
    _take(pool, chosen, count,
          lambda c: not is_protected(c) and c.rank in ("K", "Q")
          and not _breaks_marriage(hand, c) and not _breaks_around(hand, c))

    # Any unprotected non-ace (Aces stay off-limits outside the pro move)
    _take(pool, chosen, count, lambda c: not is_protected(c) and c.rank != "A")

    # Any unprotected card at all, including Aces if truly nothing else is left
    _take(pool, chosen, count, lambda c: not is_protected(c))

    # True last resort: protected cards
    _take(pool, chosen, count, lambda c: True)

    return chosen[:count]


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

        if not context["ever_bid"]:
            # Dealer-protection: partner is dealer, score makes them a
            # target for a "pass out and stick them with FORCED_BID" play -
            # always open regardless of hand.
            if partner_is_dealer and my_score >= 850 and opp_score < 500:
                return OPENING_BID

            # 3rd bidder (2 passes already, no one's bid) - always open
            # to deny the last player a cheap contract, unless our score
            # is high enough (>800) that we'd rather play it safe.
            if context["passes_so_far"] == 2:
                if my_score > 800:
                    return OPENING_BID if ceiling >= OPENER_THRESHOLD else None
                return OPENING_BID

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

    def choose_card(self, legal_moves, trick=None, trump=None, tracker=None, my_team_players=None):
        """
        Uses the real trick-play strategy (safe-card cascade when leading,
        feed/withhold/conserve logic when following) if given full context.
        Falls back to first-legal-move if called in isolation (e.g. old
        call sites, or tests that don't set up a Round).
        """
        if trick is None or trump is None:
            return legal_moves[0]

        if not trick.plays:
            return choose_lead_card(self.hand, trump, tracker if tracker else PlayTracker())

        team_set = my_team_players if my_team_players is not None else set(self.team.players)
        return choose_follow_card(self.hand, legal_moves, trick.plays, trump, team_set, tracker)


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
        # Remaining slots fall back to lowest-worth filler, same as the
        # partner branch above.
        pool = list(self.hand)
        chosen = [c for c in pool if c.suit != trump_suit and c.rank == "10"][:count]
        for c in chosen:
            pool.remove(c)
        if len(chosen) < count:
            ranked = sorted(pool, key=lambda c: _easy_card_worth(c, trump_suit))
            chosen += ranked[:count - len(chosen)]
        return chosen[:count]

    def choose_card(self, legal_moves, trick=None, trump=None, tracker=None, my_team_players=None):
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


class Team:
    def __init__(self, name, players):
        self.name = name
        self.players = players  # list of 2 Player objects
        self.score = 0
        self.meld_points = 0
        self.trick_points = 0


# ---------------------------------------------------------------------------
# Round — everything that happens in a single hand: deal through scoring.
# ---------------------------------------------------------------------------

PASS_COUNT = 3


class Round:
    def __init__(self, players, teams, dealer_index):
        self.players = players
        self.teams = teams
        self.dealer_index = dealer_index
        self.deck = Deck()

        self.current_bid = OPENING_BID
        self.bid_winner = None
        self.trump_suit = None
        self.tracker = PlayTracker()

    def run(self):
        self._deal()
        self._bidding_loop()
        if self.bid_winner is None:
            # everyone passed with no bid — dealer forced to take it at FORCED_BID
            self.bid_winner = self.players[self.dealer_index]
            self.current_bid = FORCED_BID

        self.trump_suit = self.bid_winner.choose_trump()
        self._passing_phase()
        self._meld_phase()
        trick_points = self._trick_taking_loop()

        return self._score_round(trick_points)

    def _deal(self):
        self.deck.shuffle()
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
        dealer = self.players[self.dealer_index]

        while passes < 3:
            if active[idx]:
                player = self.players[idx]
                min_bid = OPENING_BID if not ever_bid else current_bid + 10
                context = {
                    "ever_bid": ever_bid,
                    "passes_so_far": passes_so_far,
                    "bid_history": bid_history,
                    "dealer": dealer,
                    "teams": self.teams,
                }
                bid = player.choose_bid(current_bid if ever_bid else OPENING_BID - 10, 10, context)
                if bid is not None and bid >= min_bid:
                    current_bid = bid
                    ever_bid = True
                    self.bid_winner = player
                    bid_history.append((player, bid))
                else:
                    active[idx] = False
                    passes += 1
                    passes_so_far += 1
                    if sum(active) == 1 and ever_bid:
                        break
            idx = (idx + 1) % 4

        if ever_bid:
            self.current_bid = current_bid
        else:
            self.bid_winner = None

    def _passing_phase(self):
        partner = next(p for p in self.bid_winner.team.players if p is not self.bid_winner)
        run_forward_pass(self.bid_winner, partner, self.trump_suit)
        run_return_pass(self.bid_winner, partner, self.trump_suit)

    def _meld_phase(self):
        for team in self.teams:
            team.meld_points = 0  # per-round, not cumulative like team.score
        for player in self.players:
            points, _breakdown = score_melds(player.hand, self.trump_suit)
            player.team.meld_points += points

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

    def play(self):
        winner = None
        while winner is None:
            round_ = Round(self.players, self.teams, self.dealer_index)
            round_scores = round_.run()

            bidding_team = round_.bid_winner.team
            for team in self.teams:
                team.score += round_scores[team]

            busted = [t for t in self.teams if t.score <= GAME_LOSE_SCORE]
            if busted:
                winner = next(t for t in self.teams if t not in busted)
            else:
                over = [t for t in self.teams if t.score >= GAME_WIN_SCORE]
                if over:
                    winner = bidding_team if bidding_team in over else over[0]

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
