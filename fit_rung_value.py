"""
The rung-value model: what a raise is worth, as numbers, so the AI can say why.

Why this exists. The raise ladder in `web/src/engine/bidding.ts` used to be a
number against a number: bid the next rung while it sits under the hand's Max
Bid ceiling, plus a few hardcoded floors (320, 330, 340). That says nothing
about what a rung is *worth*. The distilled evaluator does ask that, but its
question is "does taking this contract at this level beat defending against it
at the same level", and as a ladder it drops out of auctions and loses (-33 to
-39 a deal, paired A/B). It has no notion of what a raise does to the other
side. This model has one.

Two value functions, both in score-differential points from our side, for a
hand with features x and a contract level b:

    T(x, b)  we hold the contract at b           (we bid it and the table passes)
    D(x, b)  an opponent holds it at b, we defend

and one probability:

    s(r)     given an opponent bid r - 10, the chance they cannot answer a
             bid of r (their own ceiling is under r)

A seat facing an opponent's bid c may raise to r = c + 10. If the opponent
cannot answer it holds the contract at r (T). If they can, it will hold the
contract at r + 10 against us (D), which is *better* for us than defending at c
because every rung they take costs them. The raise is worth taking when

    s(r) * T(x, r) + (1 - s(r)) * D(x, r + 10)  >  D(x, c)

Pushing is therefore not a number but a trade: what being left holding the
contract costs against what each rung costs the other side.

How it is built. Rollouts (the same real pass and trick-play logic the rest of
the Python research harness uses) over random 12-card hands, bid = 0 so every
deal plays out and can be re-scored at any level without re-running it:

  take    our hand is the bid winner at its best trump, partner and opponents
          random. Stored: (our total, their total) per sample.
  defend  an opponent (the better of the two) holds the contract at its own best
          trump. Stored: (their total, our total, their Max Bid ceiling) per
          sample. A sample counts at level b only if the bidder's ceiling
          reaches b - that is the condition under which they bid b at all.

T and D are fitted per level by least squares on seven hand features (Base Bid,
trick potential, trump length, Aces, trump Aces, nines). `s` is read straight
off the opponent ceiling distribution.

Usage:
    python fit_rung_value.py generate --hands 1000 --samples 200 --seed 101 --out data_101.jsonl
    python fit_rung_value.py fit data_*.jsonl            # writes the JSON and the TS
    python fit_rung_value.py generate-third --hands 500 --samples 150 --seed 201 --out third_201.jsonl
    python fit_rung_value.py fit-third third_*.jsonl     # adds the third-seat open to the JSON and TS
    python fit_rung_value.py check                       # TS matches the JSON

The third-seat open (`fit-third`) uses the same tables' idea on a different
decision. The third seat to speak - two passes in, nobody having bid - can
open at 300 or pass. Passing leaves the dealer holding the contract: it opens
at the 330 anchor if its ceiling reaches 320, and is stuck at the forced 250
otherwise. Opening leaves us holding 300 unless the dealer pushes over it, in
which case the dealer holds 310. Per sampled deal (our partner and the second
seat conditioned on having passed - a ceiling under 320) both playouts of the
same cards are run, and the value of opening minus the value of passing is
regressed on the same seven hand features. A hand opens when that difference
reaches a threshold set so the open rate equals the 320 floor's (its measured
peak, `web/README.md`).
"""

import argparse
import glob
import json
import os
import random
import re
import sys

REPO_ROOT = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH = os.path.join(REPO_ROOT, "rung_value_model.json")
TS_PATH = os.path.join(REPO_ROOT, "web", "src", "engine", "rungValueModel.ts")

FEATURES = ["const", "base", "trick", "trumpLength", "aces", "trumpAces", "nines"]
# Above 440 the defend samples are too thin to fit (a bidder ceiling of 450+ is
# about 3% of deals) and the table is held flat there; see rungValue.ts.
LEVELS = list(range(300, 441, 10))
MIN_DEFEND_SAMPLES = 10


# -- data generation ---------------------------------------------------------

def _random_hand(rng):
    from pinochle_rules_engine import Deck
    while True:
        deck = Deck()
        deck.shuffle(rng)
        hand = deck.cards[:12]
        if sum(1 for c in hand if c.rank == "9") < 5:
            return hand


def _take_samples(hand, trump, n, rng):
    from pinochle_rollout import _build_rollout_players, rollout_deal, sample_bid_time_deal
    out = []
    for _ in range(n):
        dealt = sample_bid_time_deal(hand, rng=rng)
        players = _build_rollout_players(
            ["me", "opp_left", "partner", "opp_right"],
            [hand, dealt["opp_left"], dealt["partner"], dealt["opp_right"]],
        )
        r = rollout_deal(players, trump, 0, players[0], passing="both")
        out.append((r["bidding_total"], r["defending_total"]))
    return out


def _defend_samples(hand, n, rng):
    from pinochle_rules_engine import best_base_bid
    from pinochle_rollout import _build_rollout_players, rollout_deal, sample_bid_time_deal
    out = []
    for _ in range(n):
        dealt = sample_bid_time_deal(hand, rng=rng)
        lt, lc, _ = best_base_bid(dealt["opp_left"])
        rt, rc, _ = best_base_bid(dealt["opp_right"])
        key, trump, ceiling = ("opp_left", lt, lc) if lc >= rc else ("opp_right", rt, rc)
        players = _build_rollout_players(
            ["me", "opp_left", "partner", "opp_right"],
            [hand, dealt["opp_left"], dealt["partner"], dealt["opp_right"]],
        )
        winner = players[1] if key == "opp_left" else players[3]
        r = rollout_deal(players, trump, 0, winner, passing="both")
        out.append((r["bidding_total"], r["defending_total"], ceiling))
    return out


def generate(hands, samples, seed, out_path):
    from pinochle_rules_engine import best_base_bid, compute_base_bid, compute_trick_potential
    rng = random.Random(seed)
    with open(out_path, "w") as f:
        for _ in range(hands):
            hand = _random_hand(rng)
            trump, ceiling, _ = best_base_bid(hand)
            base, _, _ = compute_base_bid(hand, trump)
            trick, _ = compute_trick_potential(hand, trump)
            f.write(json.dumps({
                "hand": " ".join(map(repr, hand)),
                "trump": trump.value,
                "ceiling": ceiling,
                "base": base,
                "trick": trick,
                "take": _take_samples(hand, trump, samples, rng),
                "defend": _defend_samples(hand, samples, rng),
            }) + "\n")


# -- third-seat data ----------------------------------------------------------

THIRD_PASS_CEILING = 320     # a first or second seat at or over this would have opened
THIRD_DEALER_OPEN_CEILING = 320
THIRD_DEALER_OPEN_LEVEL = 330   # the opening anchor
THIRD_FORCED_LEVEL = 250
THIRD_OPEN_LEVEL = 300
THIRD_PUSH_LEVEL = 310
THIRD_DEALER_PUSH_CEILING = 260  # a dealer this strong answers a 300 with a 310


def generate_third(hands, deals, seed, out_path):
    from pinochle_rules_engine import best_base_bid, compute_base_bid, compute_trick_potential
    from pinochle_rollout import _build_rollout_players, rollout_deal, sample_bid_time_deal
    rng = random.Random(seed)
    with open(out_path, "w") as f:
        for _ in range(hands):
            hand = _random_hand(rng)
            trump, ceiling, _ = best_base_bid(hand)
            base, _, _ = compute_base_bid(hand, trump)
            trick, _ = compute_trick_potential(hand, trump)
            samples = []
            tries = 0
            while len(samples) < deals and tries < deals * 40:
                tries += 1
                dealt = sample_bid_time_deal(hand, rng=rng)
                if (best_base_bid(dealt["partner"])[1] >= THIRD_PASS_CEILING
                        or best_base_bid(dealt["opp_right"])[1] >= THIRD_PASS_CEILING):
                    continue  # that seat would have opened; this auction did not happen
                dealer_trump, dealer_ceiling, _ = best_base_bid(dealt["opp_left"])
                seats = ["me", "opp_left", "partner", "opp_right"]
                cards = [hand, dealt["opp_left"], dealt["partner"], dealt["opp_right"]]
                ours = _build_rollout_players(seats, cards)
                a = rollout_deal(ours, trump, 0, ours[0], passing="both")
                theirs = _build_rollout_players(seats, cards)
                b = rollout_deal(theirs, dealer_trump, 0, theirs[1], passing="both")
                samples.append([dealer_ceiling, a["bidding_total"], a["defending_total"],
                                b["bidding_total"], b["defending_total"]])
            f.write(json.dumps({
                "hand": " ".join(map(repr, hand)),
                "trump": trump.value,
                "ceiling": ceiling,
                "base": base,
                "trick": trick,
                "deals": samples,
            }) + "\n")


# -- fitting -----------------------------------------------------------------

def _features(row):
    cards = [re.match(r"(10|9|J|Q|K|A)([HCDS])_", t).groups() for t in row["hand"].split()]
    trump = row["trump"]
    return [
        1.0, row["base"], row["trick"],
        sum(s == trump for _, s in cards),
        sum(k == "A" for k, _ in cards),
        sum(k == "A" and s == trump for k, s in cards),
        sum(k == "9" for k, _ in cards),
    ]


def fit(paths):
    import numpy as np
    rows = []
    for path in paths:
        with open(path) as f:
            rows.extend(json.loads(line) for line in f if line.strip())
    X = np.array([_features(r) for r in rows])
    take = [np.array(r["take"], float) for r in rows]
    defend = [np.array(r["defend"], float) for r in rows]
    all_ceilings = np.concatenate([d[:, 2] for d in defend])

    model = {
        "features": FEATURES,
        "levels": LEVELS,
        "hands": len(rows),
        "take": {},
        "defend": {},
        "stop": {},
    }
    for b in LEVELS:
        y_take = np.array([
            np.mean(np.where(t[:, 0] >= b, t[:, 0], -b) - t[:, 1]) for t in take
        ])
        beta_take, *_ = np.linalg.lstsq(X, y_take, rcond=None)

        y_def, w = [], []
        keep = []
        for i, d in enumerate(defend):
            d = d[d[:, 2] >= b]
            if len(d) >= MIN_DEFEND_SAMPLES:
                y_def.append(np.mean(d[:, 1] - np.where(d[:, 0] >= b, d[:, 0], -b)))
                w.append(np.sqrt(len(d)))
                keep.append(i)
        w = np.array(w)
        beta_def, *_ = np.linalg.lstsq(X[keep] * w[:, None], np.array(y_def) * w, rcond=None)

        bidding_at = all_ceilings >= b - 10
        model["take"][str(b)] = [round(float(v), 4) for v in beta_take]
        model["defend"][str(b)] = [round(float(v), 4) for v in beta_def]
        model["stop"][str(b)] = round(float((all_ceilings[bidding_at] < b).mean()), 4)
    return model


def fit_third(paths):
    """Open-minus-pass value as a linear score of the hand, and the threshold."""
    import numpy as np
    rows = []
    for path in paths:
        with open(path) as f:
            rows.extend(json.loads(line) for line in f if line.strip())
    X = np.array([_features(r) for r in rows])
    ceilings = np.array([r["ceiling"] for r in rows])

    def difference(row):
        d = np.array(row["deals"], float)
        dealer_ceiling, bt_me, dt_me, bt_d, dt_d = d.T
        held = np.where(bt_me >= THIRD_OPEN_LEVEL, bt_me, -THIRD_OPEN_LEVEL) - dt_me
        pushed = dt_d - np.where(bt_d >= THIRD_PUSH_LEVEL, bt_d, -THIRD_PUSH_LEVEL)
        value_open = np.where(dealer_ceiling >= THIRD_DEALER_PUSH_CEILING, pushed, held)
        level = np.where(dealer_ceiling >= THIRD_DEALER_OPEN_CEILING,
                         THIRD_DEALER_OPEN_LEVEL, THIRD_FORCED_LEVEL)
        value_pass = dt_d - np.where(bt_d >= level, bt_d, -level)
        return float((value_open - value_pass).mean())

    y = np.array([difference(r) for r in rows])
    beta, *_ = np.linalg.lstsq(X, y, rcond=None)
    score = X @ beta
    share = float((ceilings >= OPENER_FLOOR_FOR_THETA).mean())
    theta = float(np.quantile(score, 1.0 - share))
    r2 = 1.0 - float(((y - score) ** 2).sum() / ((y - y.mean()) ** 2).sum())
    return {
        "hands": len(rows),
        "coef": [round(float(v), 4) for v in beta],
        "theta": round(theta, 3),
        "open_share": round(share, 4),
        "r2": round(r2, 3),
    }


# The open rate the threshold is matched to: hands whose ceiling reaches the
# 320 floor, which measured best (`web/README.md`).
OPENER_FLOOR_FOR_THETA = 320


# -- export ------------------------------------------------------------------

TS_HEADER = """\
// GENERATED FILE - do not edit by hand.
//
// Produced by `fit_rung_value.py` from `rung_value_model.json`. Re-run
// `python fit_rung_value.py fit <data...>` after any refit;
// `test_fit_rung_value.py` fails the Python suite if this file has drifted
// from the model it claims to carry.
//
// The rung-value model: what holding a contract, and what defending one, is
// worth at each bid level, as least-squares tables over seven hand features.
// `rungValue.ts` is the consumer and `fit_rung_value.py` says how it was built
// and why.

"""


def build_ts(model):
    def table(name, entries):
        lines = [f"export const {name}: Readonly<Record<number, readonly number[]>> = {{"]
        for level in model["levels"]:
            lines.append(f"  {level}: [{', '.join(repr(v) for v in entries[str(level)])}],")
        lines.append("}")
        return "\n".join(lines)

    stop = ["export const RUNG_STOP: Readonly<Record<number, number>> = {"]
    for level in model["levels"]:
        stop.append(f"  {level}: {model['stop'][str(level)]!r},")
    stop.append("}")

    third = model.get("third_open")
    third_ts = ""
    if third:
        third_ts = (
            "\n"
            + f"export const THIRD_OPEN_HANDS = {third['hands']}\n"
            + f"export const THIRD_OPEN_COEF: readonly number[] = {json.dumps(third['coef'])}\n"
            + f"export const THIRD_OPEN_THETA = {third['theta']!r}\n"
        )
    return (
        TS_HEADER
        + f"export const RUNG_FEATURES = {json.dumps(model['features'])} as const\n"
        + f"export const RUNG_LEVELS: readonly number[] = {json.dumps(model['levels'])}\n"
        + f"export const RUNG_FIT_HANDS = {model['hands']}\n\n"
        + table("RUNG_TAKE", model["take"]) + "\n\n"
        + table("RUNG_DEFEND", model["defend"]) + "\n\n"
        + "\n".join(stop) + "\n"
        + third_ts
    )


def write_outputs(model):
    with open(MODEL_PATH, "w") as f:
        json.dump(model, f, indent=1)
        f.write("\n")
    with open(TS_PATH, "w", newline="\n") as f:
        f.write(build_ts(model))


def check():
    with open(MODEL_PATH) as f:
        model = json.load(f)
    with open(TS_PATH, newline="") as f:
        current = f.read().replace("\r\n", "\n")
    return current == build_ts(model)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    g = sub.add_parser("generate")
    g.add_argument("--hands", type=int, default=1000)
    g.add_argument("--samples", type=int, default=200)
    g.add_argument("--seed", type=int, default=1)
    g.add_argument("--out", required=True)
    f = sub.add_parser("fit")
    f.add_argument("data", nargs="+")
    g3 = sub.add_parser("generate-third")
    g3.add_argument("--hands", type=int, default=500)
    g3.add_argument("--samples", type=int, default=150)
    g3.add_argument("--seed", type=int, default=1)
    g3.add_argument("--out", required=True)
    f3 = sub.add_parser("fit-third")
    f3.add_argument("data", nargs="+")
    sub.add_parser("check")
    args = parser.parse_args(argv)

    if args.command == "generate":
        sys.path.insert(0, REPO_ROOT)
        generate(args.hands, args.samples, args.seed, args.out)
    elif args.command == "generate-third":
        sys.path.insert(0, REPO_ROOT)
        generate_third(args.hands, args.samples, args.seed, args.out)
    elif args.command == "fit":
        paths = [p for pattern in args.data for p in glob.glob(pattern)]
        model = fit(paths)
        if os.path.exists(MODEL_PATH):
            with open(MODEL_PATH) as handle:
                previous = json.load(handle)
            if "third_open" in previous:
                model["third_open"] = previous["third_open"]
        write_outputs(model)
        print(f"fitted on {len(paths)} files; wrote {MODEL_PATH} and {TS_PATH}")
    elif args.command == "fit-third":
        paths = [p for pattern in args.data for p in glob.glob(pattern)]
        with open(MODEL_PATH) as handle:
            model = json.load(handle)
        model["third_open"] = fit_third(paths)
        write_outputs(model)
        t = model["third_open"]
        print(f"third-seat open fitted on {t['hands']} hands: R2 {t['r2']}, theta {t['theta']}, "
              f"open share {t['open_share']}")
    else:
        ok = check()
        print("rungValueModel.ts matches rung_value_model.json" if ok else "DRIFTED")
        return 0 if ok else 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
