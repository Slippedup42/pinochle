"""
Monte Carlo determinization sampler + Auto-SET guard (issue #59).

Foundation piece for the Expert AI epic (#57) - implements
`pinochle_expert_ai_strategy.md` Section 0 (the shared determinization +
rollout machinery that underlies bid-time EV, pass selection, and the
"realistic ceiling" problem) and Section 5 (the Auto-SET hard prune).

This module is infrastructure only. It is deliberately NOT wired into any
Player subclass's decision-making yet - that's issue #63 (GeneralStrategy).
What lives here is the shared machinery later issues will call:

  - Determinization: randomly deal the *currently unseen* cards into the
    unseen hands appropriate to a decision point (bidding / return-pass /
    trick-play - see Section 0's table), never touching cards that are
    actually known.
  - Rollout: given a fully-determinized sample, run the REAL pass logic
    (`Player.choose_pass_cards`) and REAL trick-play logic
    (`Player.choose_card` -> `choose_lead_card`/`choose_follow_card`) to
    completion and score the result - not simplified stand-ins, per
    Section 0's fidelity requirement. Reuses `PlayTracker` for per-copy
    card tracking rather than building a second mechanism (already
    consumed by `choose_lead_card`/`choose_follow_card`).
  - Auto-SET guard (Section 5): a hard mathematical prune checked before
    any 12-trick rollout, so a sample that's already a guaranteed set
    skips the expensive trick-play simulation entirely.

Sample counts are always a caller-supplied parameter (never hardcoded) -
the doc suggests ~100-150 for bid-time and ~300+ for the one-time
post-pass evaluation, but that's just a starting point for later issues
to tune.
"""

import random

from pinochle_engine import (
    Card,
    PlayTracker,
    Player,
    RANKS,
    Suit,
    Team,
    play_tricks,
    run_forward_pass,
    run_return_pass,
    score_melds,
)


# ---------------------------------------------------------------------------
# Determinization: deal the currently-unseen cards into the unseen hands.
# ---------------------------------------------------------------------------

def unseen_cards_for(known_cards, known_counts=None):
    """
    The full 48-card deck minus what's known, split into two kinds of
    "known" because they're tracked differently:

      `known_cards` - exact Card objects known by identity (e.g. my own
      hand) - removed by (suit, rank, copy_id) match.

      `known_counts` - optional dict of (suit, rank) -> count for cards
      that are known to be gone but whose exact copy_id isn't tracked
      (e.g. cards already played this round, from PlayTracker.
      played_count - both copies of a suit/rank are interchangeable for
      gameplay purposes, so only the count matters). Whichever remaining
      copy_id(s) happen to still be in the pool are removed.

      Deliberately NOT done by reconstructing guessed Card objects for
      the count-only side and unioning them with `known_cards`: two
      "known" sources that don't track exact copy_id the same way can
      easily guess the *same* copy_id for two actually-different physical
      cards, which would silently make one of them vanish from the
      unseen pool while leaving a real card unaccounted for. Decrementing
      counts directly from what's left avoids that collision entirely.

    Raises ValueError if `known_cards` itself contains a duplicate, or if
    `known_counts` asks to remove more of a suit/rank than remain - both
    are caller bugs (e.g. a card double-counted as known), not runtime
    conditions to silently paper over.
    """
    known_list = list(known_cards)
    known_set = set(known_list)
    if len(known_set) != len(known_list):
        raise ValueError("known_cards contains a duplicate card")

    full_deck = [
        Card(suit, rank, copy_id)
        for suit in Suit
        for rank in RANKS
        for copy_id in (1, 2)
    ]
    remaining = [c for c in full_deck if c not in known_set]

    if known_counts:
        for (suit, rank), count in known_counts.items():
            if count <= 0:
                continue
            removed = 0
            kept = []
            for c in remaining:
                if removed < count and c.suit == suit and c.rank == rank:
                    removed += 1
                    continue
                kept.append(c)
            if removed != count:
                raise ValueError(
                    f"known_counts asks for {count} known {rank}{suit.value} "
                    f"but only {removed} remained unaccounted for"
                )
            remaining = kept

    return remaining


def deal_unseen_cards(unseen_cards, hand_sizes, rng=None):
    """
    Randomly partition `unseen_cards` into groups of the given sizes.

    `hand_sizes` is an ordered sequence of (key, count) pairs (a list
    rather than a dict, so callers control iteration/assignment order
    explicitly instead of relying on dict ordering as an implementation
    detail). Returns a dict of key -> list[Card].

    Raises ValueError if the sizes don't sum to len(unseen_cards) - a
    mismatched unseen pool is a caller bug, not something to deal
    partially and hope nobody notices.
    """
    hand_sizes = list(hand_sizes)
    total = sum(count for _, count in hand_sizes)
    if total != len(unseen_cards):
        raise ValueError(
            f"hand_sizes sum to {total} but there are {len(unseen_cards)} unseen cards"
        )

    rng = rng if rng is not None else random
    pool = list(unseen_cards)
    rng.shuffle(pool)

    result = {}
    i = 0
    for key, count in hand_sizes:
        result[key] = pool[i:i + count]
        i += count
    return result


def played_counts_from_tracker(tracker):
    """
    Reads everything a PlayTracker has recorded as played so far this
    round into a {(suit, rank): count} dict - the shape `unseen_cards_for`
    wants for its `known_counts` argument, since exact copy_id was never
    tracked (and doesn't matter - both copies of a suit/rank are
    functionally interchangeable) and reconstructing guessed Card objects
    for them risks colliding with a real card known by exact identity
    elsewhere (e.g. the deciding player's own hand).
    """
    counts = {}
    for suit in Suit:
        for rank in RANKS:
            count = tracker.played_count(suit, rank)
            if count:
                counts[(suit, rank)] = count
    return counts


def sample_bid_time_deal(my_hand, rng=None):
    """
    Bidding decision point (Section 0 table, row 1): only my own 12 cards
    are known. Deals the other 36 cards uniformly at random into
    partner/opp_left/opp_right, 12 each.
    """
    unseen = unseen_cards_for(my_hand)
    return deal_unseen_cards(
        unseen, [("partner", 12), ("opp_left", 12), ("opp_right", 12)], rng=rng,
    )


def sample_return_pass_deal(my_hand, partner_known_count=9, rng=None):
    """
    Return-pass decision point (Section 0 table, row 2): the bidder knows
    their own 15 cards (12 dealt + 3 already received for real from the
    partner's forward pass). Deals the remaining 33 cards into partner's
    other `partner_known_count` (9 by default: partner's 12 minus the 3
    already sent) / opp_left 12 / opp_right 12.
    """
    unseen = unseen_cards_for(my_hand)
    return deal_unseen_cards(
        unseen,
        [("partner", partner_known_count), ("opp_left", 12), ("opp_right", 12)],
        rng=rng,
    )


def sample_trick_play_deal(my_hand, tracker, remaining_hand_sizes, rng=None):
    """
    Trick-play decision point (Section 0 table, row 3): everything played
    so far (via PlayTracker - reused, not re-tracked) plus my own current
    hand is known. `remaining_hand_sizes` is an ordered (key, count)
    sequence giving the other three seats' current hand sizes. Deals the
    unseen remainder into those seats.
    """
    unseen = unseen_cards_for(my_hand, known_counts=played_counts_from_tracker(tracker))
    return deal_unseen_cards(unseen, remaining_hand_sizes, rng=rng)


# ---------------------------------------------------------------------------
# Auto-SET guard (Section 5) - a hard mathematical prune, not a heuristic.
# ---------------------------------------------------------------------------

MAX_TRICK_POINTS = 250  # max possible trick points in any round (pinochle_rules.md)


def is_auto_set(bidding_team_meld, bid):
    """
    True if the bidding team cannot possibly reach `bid` even if they took
    every single trick point available (all 250) - the literal inequality
    from Section 5, run before any 12-trick rollout so a guaranteed-set
    sample can skip the expensive trick-play simulation entirely.
    """
    return bidding_team_meld + MAX_TRICK_POINTS < bid


# ---------------------------------------------------------------------------
# Rollout: run one fully-determinized sample to completion via the REAL
# pass/trick-play logic, and score it.
# ---------------------------------------------------------------------------

def rollout_deal(players, trump, bid, bid_winner, tracker=None,
                  leader_index=None, tricks_already_played=0, passing="none",
                  bidding_meld=None, defending_meld=None):
    """
    Roll out one Monte Carlo sample to completion and score it.

    `players` is the 4 Player objects in table (turn) order, each already
    carrying a determinized `.hand` (known cards + this sample's dealt
    unseen cards) and wired to its `.team`. `bid_winner` must be one of
    `players`.

    `passing` controls which real pass-logic steps run before melding,
    mirroring Section 0's per-decision-point table:
      "both"        - forward pass (partner -> bidder) then return pass
                       (bidder -> partner). Use for bid-time rollouts,
                       where neither pass has happened yet.
      "return_only" - just the return pass. Use for return-pass rollouts,
                       where the forward pass already happened for real
                       (baked into the hands passed in).
      "none"        - no passing. Use for trick-play rollouts, where
                       passing is long since resolved.

    `tracker` continues an in-progress PlayTracker for a trick-play
    rollout; a fresh one is created when None (correct for bid-time /
    return-pass rollouts, where no card has been played yet this round).

    `leader_index` / `tricks_already_played` let a rollout resume
    mid-round for the trick-play decision point. `leader_index` defaults
    to bid_winner's seat (correct for bid-time/return-pass, where the
    auction winner always leads the first trick).

    `bidding_meld` / `defending_meld`: when `tricks_already_played == 0`,
    these are computed from the (still-full) hands after passing - meld
    is fixed at the real meld phase and can't be recomputed once cards
    have already been played out of a hand, so callers resuming mid-round
    (tricks_already_played > 0) MUST supply both explicitly.

    Returns a dict: auto_set, made (bidding team reached `bid`),
    bidding_meld, defending_meld, bidding_trick_points,
    defending_trick_points, bidding_total, defending_total.
    """
    partner = next(p for p in bid_winner.team.players if p is not bid_winner)
    bidding_team = bid_winner.team
    all_teams = {p.team for p in players}
    defending_team = next(t for t in all_teams if t is not bidding_team)

    if passing == "both":
        run_forward_pass(bid_winner, partner, trump)
        run_return_pass(bid_winner, partner, trump)
    elif passing == "return_only":
        run_return_pass(bid_winner, partner, trump)
    elif passing != "none":
        raise ValueError(f"unknown passing mode: {passing!r}")

    if tricks_already_played == 0:
        if bidding_meld is None:
            bidding_meld = sum(score_melds(p.hand, trump)[0] for p in bidding_team.players)
        if defending_meld is None:
            defending_meld = sum(score_melds(p.hand, trump)[0] for p in defending_team.players)
    elif bidding_meld is None or defending_meld is None:
        raise ValueError(
            "bidding_meld/defending_meld must be supplied explicitly when "
            "tricks_already_played > 0 - meld is fixed at the real meld "
            "phase and can't be recomputed from a hand that already has "
            "cards played out of it"
        )

    if is_auto_set(bidding_meld, bid):
        # Hard prune (Section 5): skip the 12-trick rollout entirely.
        return {
            "auto_set": True,
            "made": False,
            "bidding_meld": bidding_meld,
            "defending_meld": defending_meld,
            "bidding_trick_points": 0,
            "defending_trick_points": 0,
            "bidding_total": bidding_meld,
            "defending_total": defending_meld,
        }

    tracker = tracker if tracker is not None else PlayTracker()
    if leader_index is None:
        leader_index = players.index(bid_winner)
    num_tricks = 12 - tricks_already_played

    trick_points = play_tricks(
        players, trump, leader_index, tracker,
        num_tricks=num_tricks, trick_num_offset=tricks_already_played,
    )

    bidding_trick_points = trick_points[bidding_team]
    defending_trick_points = trick_points[defending_team]
    bidding_total = bidding_meld + bidding_trick_points
    defending_total = defending_meld + defending_trick_points

    return {
        "auto_set": False,
        "made": bidding_total >= bid,
        "bidding_meld": bidding_meld,
        "defending_meld": defending_meld,
        "bidding_trick_points": bidding_trick_points,
        "defending_trick_points": defending_trick_points,
        "bidding_total": bidding_total,
        "defending_total": defending_total,
    }


# ---------------------------------------------------------------------------
# Monte Carlo orchestration - run N samples, average the outcome.
# ---------------------------------------------------------------------------

def monte_carlo_rollout(sample_fn, build_players_fn, trump, bid, num_samples,
                         rollout_kwargs=None, rng=None):
    """
    Runs `num_samples` independent determinize-then-rollout samples and
    aggregates them into P(make)/E[points] (Section 0's closing step:
    "average across samples"). `num_samples` is always caller-supplied,
    never hardcoded.

    `sample_fn(rng) -> dealt` produces one determinized deal (e.g.
    `sample_bid_time_deal`). `build_players_fn(dealt) -> (players,
    bid_winner)` turns that sample into fully-wired Player objects ready
    for `rollout_deal`. `rollout_kwargs` is passed through to
    `rollout_deal` unchanged (passing mode, tracker, tricks_already_played,
    etc).
    """
    rng = rng if rng is not None else random
    rollout_kwargs = rollout_kwargs or {}

    results = []
    for _ in range(num_samples):
        dealt = sample_fn(rng)
        players, bid_winner = build_players_fn(dealt)
        results.append(rollout_deal(players, trump, bid, bid_winner, **rollout_kwargs))

    made_count = sum(1 for r in results if r["made"])
    return {
        "samples": results,
        "p_make": made_count / num_samples,
        "expected_bidding_points": sum(r["bidding_total"] for r in results) / num_samples,
        "expected_defending_points": sum(r["defending_total"] for r in results) / num_samples,
        "auto_set_rate": sum(1 for r in results if r["auto_set"]) / num_samples,
    }


def _build_rollout_players(seat_names, hands):
    """
    Wires 4 fresh, disposable Player objects (Proficient tier - the REAL
    pass/trick-play logic per Section 0, regardless of which AI tier is
    asking) into 2 Teams, seats 0&2 vs 1&3 (matching
    Game._init_from_players' convention), with the given hands.

    Always builds new Player/Team objects rather than reusing the
    caller's own long-lived ones, and copies each hand list - a rollout
    sample must never be able to mutate real game state.
    """
    players = [Player(name, None) for name in seat_names]
    team_a = Team("Rollout Team A", [players[0], players[2]])
    team_b = Team("Rollout Team B", [players[1], players[3]])
    players[0].team = players[2].team = team_a
    players[1].team = players[3].team = team_b
    for player, hand in zip(players, hands):
        player.hand = list(hand)
    return players


def estimate_bid_time(hand, trump, bid, num_samples=150, rng=None):
    """
    Bid-time Monte Carlo estimate (Section 0/1). `hand` (12 known cards)
    is seated as the bid winner; partner and both opponents get randomly
    determinized 12-card hands each sample. Runs the real forward pass,
    real return pass, and real trick play for every sample, applying the
    Auto-SET guard before any 12-trick rollout.

    Returns the aggregate dict from `monte_carlo_rollout` (p_make,
    expected_bidding_points, expected_defending_points, auto_set_rate,
    plus the raw per-sample results).
    """
    rng = rng if rng is not None else random

    def sample_fn(active_rng):
        return sample_bid_time_deal(hand, rng=active_rng)

    def build_fn(dealt):
        players = _build_rollout_players(
            ["me", "opp_left", "partner", "opp_right"],
            [hand, dealt["opp_left"], dealt["partner"], dealt["opp_right"]],
        )
        return players, players[0]

    return monte_carlo_rollout(
        sample_fn, build_fn, trump, bid, num_samples,
        rollout_kwargs={"passing": "both"}, rng=rng,
    )


def estimate_return_pass(hand, trump, bid, num_samples=300, rng=None):
    """
    Return-pass Monte Carlo estimate (Section 0/3). `hand` is the
    bidder's known 15 cards (12 dealt + 3 already received for real from
    partner's forward pass). Partner's other 9 cards and both opponents'
    12 each are determinized per sample; only the real return pass is
    simulated (the forward pass already happened for real).

    Returns the aggregate dict from `monte_carlo_rollout`.
    """
    rng = rng if rng is not None else random

    def sample_fn(active_rng):
        return sample_return_pass_deal(hand, rng=active_rng)

    def build_fn(dealt):
        players = _build_rollout_players(
            ["me", "opp_left", "partner", "opp_right"],
            [hand, dealt["opp_left"], dealt["partner"], dealt["opp_right"]],
        )
        return players, players[0]

    return monte_carlo_rollout(
        sample_fn, build_fn, trump, bid, num_samples,
        rollout_kwargs={"passing": "return_only"}, rng=rng,
    )
