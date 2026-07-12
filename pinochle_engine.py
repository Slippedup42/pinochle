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
            if i == 0 and play_pos == 0 and forced_lead_card is not None:
                card = forced_lead_card
            else:
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

      1. Non-trump 10s not already chosen — zero meld value outside a
         trump-only Run/Double Run, pure liability (same reasoning as the
         return-pass rule in Section 3).
      2. Other unprotected non-trump count-cards (A/K) that wouldn't break
         partner's own kept marriage/around.
      3. Void-building filler: a whole non-trump suit that fits the
         remaining slots and contains nothing protected.
      4. Any other non-trump card that doesn't break a kept meld.
      5. True last resort: anything left (surplus trump, or a card that
         would break a kept meld).

    Concrete doc example: partner holds 10-K-Q of a non-trump suit and
    nothing Tier-0 eligible — keeps K+Q (preserves the 20-pt Common
    Marriage), ships the 10 (tier 1). Never proposes a card that would
    break the partner's own kept meld ahead of one that wouldn't.
    """
    pool = [c for c in hand if c not in exclude]
    chosen = []
    limit = len(pool)

    keeps_meld = lambda c: _breaks_marriage(hand, c) or _breaks_around(hand, c)

    _take(pool, chosen, limit,
          lambda c: c.suit != trump and c.rank == "10",
          sort_key=lambda c: _suit_length(hand, c.suit))

    _take(pool, chosen, limit,
          lambda c: c.suit != trump and c.rank in POINT_RANKS and not keeps_meld(c),
          sort_key=lambda c: _suit_length(hand, c.suit))

    if len(chosen) < limit:
        void_cards = _find_void_opportunity(pool, trump, keeps_meld, limit - len(chosen))
        if void_cards:
            for c in void_cards:
                if c in pool and len(chosen) < limit:
                    chosen.append(c)
                    pool.remove(c)

    _take(pool, chosen, limit, lambda c: c.suit != trump and not keeps_meld(c))
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
    deliberately allowed to overlap across groups (e.g. a trump King is
    part of both Run and Royal Marriage using the very same card), since
    `_knapsack_lock_return_pass_melds` below dedupes by tracking what's
    already locked rather than by partitioning cards into disjoint pools.
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

      1. Non-trump 10s — zero meld value outside a trump-only Run/Double
         Run, so any non-trump 10 not needed for a Run is a top ship
         candidate (doc-mandated, tier-agnostic).
      2. Other unprotected non-trump count-cards (A/K) — reduces liability
         the Bidder would otherwise have to protect through 12 tricks.
      3. Void-building filler: a whole non-trump suit that fits the
         remaining slots.
      4. Any other non-trump card.
      5. True last resort: trump (or anything left).
    """
    remaining = list(pool)
    chosen = []
    limit = len(remaining)

    # Everything reaching this pool is already NOT part of a locked meld
    # (that's what makes it pool, not locked), so there's no kept-meld to
    # break here — `_find_void_opportunity` still wants an is_protected
    # callback, so pass a permissive no-op.
    not_protected = lambda c: False

    _take(remaining, chosen, limit,
          lambda c: c.suit != trump and c.rank == "10",
          sort_key=lambda c: _suit_length(hand, c.suit))

    _take(remaining, chosen, limit,
          lambda c: c.suit != trump and c.rank in POINT_RANKS,
          sort_key=lambda c: _suit_length(hand, c.suit))

    if len(chosen) < limit:
        void_cards = _find_void_opportunity(remaining, trump, not_protected, limit - len(chosen))
        if void_cards:
            for c in void_cards:
                if c in remaining and len(chosen) < limit:
                    chosen.append(c)
                    remaining.remove(c)

    _take(remaining, chosen, limit, lambda c: c.suit != trump)
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


def choose_expert_lead_card(hand, trump, tracker, is_bidding_team, rollout_evaluator=None):
    """
    Section 4 entry point for leading (having table control). Order of
    decisions:

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
    """
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
        trick that's already secured; feed K/10 across if doing so is
        free (doesn't cost the trick).
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
        forced_beat = winner_card is not None and all(
            RANK_VALUE[c.rank] > RANK_VALUE[winner_card.rank] for c in legal_moves
        )
        if forced_beat:
            return min(legal_moves, key=lambda c: RANK_VALUE[c.rank])
        if partner_winning:
            feed_cards = [c for c in legal_moves if c.rank in ("K", "10")]
            if feed_cards:
                return max(feed_cards, key=lambda c: RANK_VALUE[c.rank])
            return min(legal_moves, key=lambda c: RANK_VALUE[c.rank])
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
    # use_rollout: the shared static-vs-rollout switch for forward-pass
    #   shedding (#61) and the defender trump-lead question (#62) - must
    #   move together with hand_valuation == "rollout_ev" (both flip at
    #   the same skill threshold), per the issue's consistency note.
    # *_samples: Monte Carlo sample counts fed to the rollout machinery.
    #   Deliberately small even at skill 5 relative to the doc's suggested
    #   ~100-150/~300+ starting point - kept cheap enough for real games
    #   and test suites to run in reasonable time. Treat as a starting
    #   point, not final; the tuning-pass child issue of #57 will adjust
    #   these (and possibly hand_valuation/use_rollout's exact thresholds)
    #   based on simulated win rates, per the doc's Section 8 validation
    #   plan.
    # deception: whether choose_expert_follow_card gets a deception_evaluator.
    1: {"hand_valuation": "meld_only",  "use_rollout": False, "bid_samples": 0,  "pass_samples": 0,  "trick_samples": 0,  "deception": False},
    2: {"hand_valuation": "base_bid",   "use_rollout": False, "bid_samples": 0,  "pass_samples": 0,  "trick_samples": 0,  "deception": False},
    3: {"hand_valuation": "base_bid",   "use_rollout": False, "bid_samples": 0,  "pass_samples": 0,  "trick_samples": 0,  "deception": False},
    4: {"hand_valuation": "rollout_ev", "use_rollout": True,  "bid_samples": 8,  "pass_samples": 8,  "trick_samples": 6,  "deception": False},
    5: {"hand_valuation": "rollout_ev", "use_rollout": True,  "bid_samples": 15, "pass_samples": 15, "trick_samples": 10, "deception": True},
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
        not literally EasyPlayer) - no noise, no positional/score-context
        awareness, matching skill 1's "None" risk column."""
        best_meld_value = max(score_melds(self.hand, t)[0] for t in Suit)
        ceiling = best_meld_value + MELD_ONLY_TRICK_ESTIMATE
        next_bid = current_bid + min_increment
        if not context["ever_bid"]:
            return OPENING_BID if ceiling >= OPENING_BID else None
        return next_bid if next_bid <= ceiling else None

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

        # Cheap hard floor, same "prune before the expensive simulation"
        # spirit as the Auto-SET guard elsewhere in this epic: a hand
        # whose static ceiling can't even clear the game's own
        # forced-bid floor is never going to out-EV a pass.
        if base_bid < FORCED_BID:
            return None

        next_bid = OPENING_BID if not context["ever_bid"] else current_bid + min_increment
        best_bid, _best_ev, _all_evs = choose_bid_by_ev(
            self.hand, trump, [None, next_bid],
            num_samples=params["bid_samples"], rng=self.rng,
        )
        return best_bid

    # -- Passing (doc Sections 2-3) --

    def choose_pass_cards(self, count, trump_suit=None, is_bid_winner=None):
        if trump_suit is None or is_bid_winner is None:
            return random.sample(self.hand, count)

        params = GENERAL_STRATEGY_SKILL_PARAMS[self.skill_level]

        if is_bid_winner:
            # Return pass (Section 3): no static/rollout switch exists for
            # this function (the knapsack triage has no rollout_evaluator
            # hook, per #61) - same logic at every skill level.
            chosen = choose_return_pass_cards(self.hand, trump_suit, count)
        else:
            evaluator = None
            if params["use_rollout"] and self.team is not None and self.team.round_bid is not None:
                evaluator = self._make_forward_pass_evaluator(self.team.round_bid, params["pass_samples"])
            chosen = choose_forward_pass_cards(self.hand, trump_suit, count, rollout_evaluator=evaluator)

        # Fallback safety net, same as Player/EasyPlayer's own.
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

    def choose_card(self, legal_moves, trick=None, trump=None, tracker=None, my_team_players=None):
        if trick is None or trump is None:
            return legal_moves[0]

        tracker = tracker if tracker is not None else PlayTracker()
        params = GENERAL_STRATEGY_SKILL_PARAMS[self.skill_level]

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
            return choose_expert_lead_card(self.hand, trump, tracker, is_bidding_team, rollout_evaluator=evaluator)

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
        self._stamp_team_round_context()
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
