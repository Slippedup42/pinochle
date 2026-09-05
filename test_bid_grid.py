"""
Tests for issue #297 - the multiple-of-10 bid grid, at the two Python human
seats. Plain assert-based, pytest-discoverable.

The rule under test is one line of `pinochle_rules.md`: "every bid falls on the
multiple-of-10 grid that raise implies - 300, 310, 320, never 305". The browser
gated its Bid button on it from the start; neither Python human seat checked
anything but the minimum, so a human on either CLI could bid 305 and be taken
at it.

This is input validation on the human seat and not a rules-engine fix, which is
what shapes the tests. There is no AI path here to check - the AI raises by
MIN_BID_INCREMENT from a grid-aligned opener and cannot leave the grid - and
nothing asserts anything about `_bidding_loop`'s acceptance test, which is
deliberately unchanged.

What is covered here:

  1. `HumanPlayer.choose_bid` - the seat both `Round` and `InteractiveRound`
     call. An off-grid answer is dropped and the same decision point re-raised
     carrying a reason; the on-grid bid one rung away is returned.
  2. `play_local.prompt_and_get_answer` - the terminal driver's own input
     loop, re-prompting in the register the rest of that function already uses.
  3. The rejection survives a resume. `InteractiveRound` is where an off-grid
     bid would have done its damage, and the fix works by raising out of a
     half-finished auction, so a full round is driven through the rejection to
     show the auction picks up unmoved rather than losing or double-counting
     the seat's turn.

Every threshold is read from MIN_BID_INCREMENT rather than written as 10, for
the same reason the code is: if the rung size moves, these tests should move
with it instead of failing.
"""

import builtins
import contextlib
import io
import random

import human_play
from human_play import HumanPlayer, InteractiveRound, NeedsHumanInput, _NO_ANSWER
from pinochle_engine import MIN_BID_INCREMENT, OPENING_BID, Player, Team


# The bid the whole issue is named for, and the legal bid one point-grid rung
# away from it. 305 is over OPENING_BID, so "rejected" here can only mean the
# grid check - a seat that turned it away for being too low would look the same
# from outside.
OFF_GRID_BID = OPENING_BID + MIN_BID_INCREMENT // 2
ON_GRID_BID = OPENING_BID + MIN_BID_INCREMENT


def _seated_human():
    """A HumanPlayer wired up enough to be asked for a bid: `choose_bid` reads
    team scores and the seating order out of its context."""
    human = HumanPlayer("You")
    others = [Player(n, None) for n in ("E", "S", "W")]
    team_a = Team("Your Team", [human, others[1]])
    team_b = Team("Opponents", [others[0], others[2]])
    human.team = others[1].team = team_a
    others[0].team = others[2].team = team_b
    players = [human, others[0], others[1], others[2]]
    context = {
        "ever_bid": False,
        "passes_so_far": 0,
        "bid_history": [],
        "dealer": players[3],
        "teams": [team_a, team_b],
        "players": players,
    }
    return human, context


# ---------------------------------------------------------------------------
# 1. The seat itself: human_play.HumanPlayer.choose_bid
# ---------------------------------------------------------------------------

def test_off_grid_answer_is_turned_away_with_a_reason():
    human, context = _seated_human()
    human.pending_answer = OFF_GRID_BID

    try:
        human.choose_bid(OPENING_BID - MIN_BID_INCREMENT, MIN_BID_INCREMENT, context)
        assert False, f"{OFF_GRID_BID} was accepted as a bid"
    except NeedsHumanInput as e:
        assert e.kind == "bid"
        assert str(OFF_GRID_BID) in e.prompt_data["error"]
        assert str(MIN_BID_INCREMENT) in e.prompt_data["error"]

    # The rejected answer is consumed, not left sitting in the seat. Were it
    # kept, the driver's next resume would re-submit the same 305 and the
    # prompt would repeat forever with the human answering it each time.
    assert human.pending_answer == _NO_ANSWER


def test_on_grid_bid_at_the_same_rung_is_accepted():
    human, context = _seated_human()
    human.pending_answer = ON_GRID_BID
    assert human.choose_bid(OPENING_BID - MIN_BID_INCREMENT, MIN_BID_INCREMENT, context) == ON_GRID_BID


def test_passing_still_passes():
    """None is a pass, not a number, and must not be measured against the grid
    - `None % 10` is a TypeError and would crash the seat on the commonest
    answer in any auction."""
    human, context = _seated_human()
    human.pending_answer = None
    assert human.choose_bid(OPENING_BID - MIN_BID_INCREMENT, MIN_BID_INCREMENT, context) is None


def test_an_ordinary_prompt_carries_no_error():
    """The reason is attached only when there is one. A driver that prints
    `error` unconditionally would otherwise accuse the human of an off-grid bid
    on their first turn."""
    human, context = _seated_human()
    try:
        human.choose_bid(OPENING_BID - MIN_BID_INCREMENT, MIN_BID_INCREMENT, context)
        assert False, "seat returned a bid without being given one"
    except NeedsHumanInput as e:
        assert "error" not in e.prompt_data


# ---------------------------------------------------------------------------
# 2. The terminal driver: play_local.prompt_and_get_answer
# ---------------------------------------------------------------------------

BID_PROMPT_DATA = {
    "scores": {"Your Team": 0, "Opponents": 0},
    "players_clockwise": [],
    "hand_grouped": {},
    "current_bid": OPENING_BID - MIN_BID_INCREMENT,
    "min_legal_bid": OPENING_BID,
}


def _answer_bid_prompt(typed):
    """Run play_local's bid prompt against a scripted keyboard, returning what
    it hands back to the auction and everything it printed on the way."""
    import play_local

    replies = iter(typed)
    real_input = builtins.input
    builtins.input = lambda *_args: next(replies)
    out = io.StringIO()
    try:
        with contextlib.redirect_stdout(out):
            answer = play_local.prompt_and_get_answer("bid", dict(BID_PROMPT_DATA))
    finally:
        builtins.input = real_input
    return answer, out.getvalue()


def test_driver_re_prompts_after_an_off_grid_bid():
    answer, printed = _answer_bid_prompt([str(OFF_GRID_BID), str(ON_GRID_BID)])
    assert answer == ON_GRID_BID
    assert human_play.off_grid_bid_message(OFF_GRID_BID) in printed
    # In the register the rest of this function uses - a two-space indent and
    # the same "try again" the "Not a number" branch ends on.
    assert f"  {OFF_GRID_BID} is off" in printed


def test_driver_takes_the_on_grid_bid_without_comment():
    answer, printed = _answer_bid_prompt([str(ON_GRID_BID)])
    assert answer == ON_GRID_BID
    assert "off the" not in printed


def test_driver_still_parses_and_still_passes():
    """The grid check is added to the existing loop rather than replacing it,
    so the two answers that loop already handled must still behave."""
    answer, printed = _answer_bid_prompt(["three hundred", str(ON_GRID_BID)])
    assert answer == ON_GRID_BID
    assert "Not a number - try again." in printed

    assert _answer_bid_prompt(["pass"])[0] is None


def test_both_seats_reject_in_the_same_words():
    """One wording, from `off_grid_bid_message`. Two copies of a sentence this
    small would drift, and a human moving between the two CLIs should not have
    to learn the rejection twice."""
    _, printed = _answer_bid_prompt([str(OFF_GRID_BID), str(ON_GRID_BID)])
    human, context = _seated_human()
    human.pending_answer = OFF_GRID_BID
    try:
        human.choose_bid(OPENING_BID - MIN_BID_INCREMENT, MIN_BID_INCREMENT, context)
        assert False, "seat accepted an off-grid bid"
    except NeedsHumanInput as e:
        assert e.prompt_data["error"].strip() in printed


# ---------------------------------------------------------------------------
# 3. The rejection inside a live auction, across the resume boundary
# ---------------------------------------------------------------------------

def test_rejected_bid_leaves_the_auction_where_it_was():
    """`InteractiveRound` resumes by re-entering `run()` and replaying from
    instance state, so a rejection is only safe if nothing moved before it. The
    seat is left of the dealer, so the human opens: it answers off-grid once,
    on-grid once, then passes whatever else it is asked."""
    # Seated by hand rather than through `_seated_human`, which builds a
    # context dict for a bare `choose_bid` call and not a table to deal to.
    human = HumanPlayer("You")
    e, s, w = Player("E", None), Player("S", None), Player("W", None)
    team_a, team_b = Team("Your Team", [human, s]), Team("Opponents", [e, w])
    human.team = s.team = team_a
    e.team = w.team = team_b
    players = [human, e, s, w]
    round_ = InteractiveRound(players, [team_a, team_b], dealer_index=3,
                              deal_rng=random.Random(297))

    answers = [OFF_GRID_BID, ON_GRID_BID]
    prompts = []
    for _ in range(60):
        try:
            round_.run()
            break
        except NeedsHumanInput as exc:
            prompts.append(exc)
            if exc.kind == "bid":
                human.pending_answer = answers.pop(0) if answers else None
            elif exc.kind == "trump":
                human.pending_answer = "S"
            elif exc.kind == "pass":
                human.pending_answer = exc.prompt_data["hand"].split()[:exc.prompt_data["count"]]
            elif exc.kind == "card":
                human.pending_answer = exc.prompt_data["legal_moves"][0]
            elif exc.kind == "misdeal":
                human.pending_answer = False
            else:
                assert False, f"unexpected prompt kind {exc.kind}"
    else:
        assert False, "round never finished"

    bid_prompts = [p for p in prompts if p.kind == "bid"]
    # Exactly one re-prompt, carrying the reason: the rejection cost the seat
    # its answer and not its turn.
    assert len(bid_prompts) >= 2
    assert "error" not in bid_prompts[0].prompt_data
    assert bid_prompts[1].prompt_data["error"] == human_play.off_grid_bid_message(OFF_GRID_BID)
    # Both prompts describe the same position - the auction did not advance
    # past the seat and come back round to it.
    assert bid_prompts[0].prompt_data["min_legal_bid"] == bid_prompts[1].prompt_data["min_legal_bid"]
    assert bid_prompts[0].prompt_data["hand"] == bid_prompts[1].prompt_data["hand"]

    # And nothing off-grid reached the auction, from any seat.
    assert (human, ON_GRID_BID) in round_._bid_history
    for _player, amount in round_._bid_history:
        assert amount % MIN_BID_INCREMENT == 0
