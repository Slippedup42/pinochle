import type { SkillLevel } from '../persistence/options'

/** Ported from Python's GENERAL_STRATEGY_SKILL_PARAMS (pinochle_engine.py:1917).
 *  Controls which hand-valuation formula the AI uses in bidding. */
export type HandValuation = 'meld_only' | 'base_bid'

/**
 * Which rule decides "is this hand worth a contract at this level" (#114).
 *
 *   `'static'`    the hand-tuned constants — `OPENER_THRESHOLD`,
 *                 `DEFENSIVE_PUSH_FLOOR` — that shipped before epic #104. Still
 *                 live: `medium` runs them, and they still decide the auction's
 *                 raise ladder on every level (see `chooseBid`).
 *   `'distilled'` the evaluator fitted to 2000 measured rollout decisions
 *                 (`evaluator.ts`), which reads the bid level, the auction
 *                 state and the hand's shape rather than one number against
 *                 one threshold.
 *
 * This is the same dial `GeneralStrategy` uses in Python, where the parameter
 * being spent is rollout budget: `choose_forward_pass_cards` already takes a
 * `rollout_evaluator` callback that is `None` for the static levels.
 */
export type BidPolicy = 'static' | 'distilled'

/**
 * Whether an AI bid winner is asked to concede (#123).
 *
 *   `'never'`  play every contract out, whatever the arithmetic says. What
 *              every level did before #123, and what `Player.decide_fold`
 *              still does in Python for skill 1-3.
 *   `'model'`  ask `shouldConcede` (`evaluator.ts`) in the same window the
 *              human's fold button gets: after meld, before the first lead.
 *
 * Unlike `bidPolicy` this is **deliberately uniform across all five levels**,
 * and the type exists to keep the alternative measurable rather than to give
 * the dial another notch. The reason is that folding is not a matter of taste:
 * conceding and being set cost the bidding team exactly the same (`-bid`, meld
 * forfeited either way), and the only thing a fold changes is that the
 * defenders are denied their trick points. So a fold can never beat making the
 * contract and can never lose to being set - it is strictly dominant over a
 * set. A weak tier declining a free improvement would not read as weak play,
 * it would read as a bug.
 *
 * `'never'` is retained because `abRun.ts` needs two levels differing in
 * exactly one field to measure this, and because the day someone wants a tier
 * that folds *badly* the honest way to build it is a third policy that folds
 * on the wrong hands - not a tier that cannot fold at all.
 */
export type FoldPolicy = 'never' | 'model'

/**
 * Which rule picks a card during trick play (#153).
 *
 *   `'simple'`   the skill-1 shortcut: lead the lowest non-trump non-counter
 *                held, and when following play the lowest legal card, always.
 *   `'cascade'`  the ported Proficient strategy in `tracker.ts` —
 *                `chooseLeadCard`'s safe-card cascade behind the offense/
 *                defender split, and `chooseFollowCard`'s tiered forced-beat /
 *                feed-partner / dump-low logic.
 *
 * Both arms already shipped before this field existed. It is a straight
 * extraction of the `handValuation === 'meld_only'` test that gated card play
 * inside `tracker.ts`, and `SKILL_PARAMS` reproduces that mapping exactly, so
 * naming it changed no behaviour. What it changed is that the choice is now
 * *addressable*: `abRun.ts` can put two card-play rules at one table, which is
 * what makes trick play measurable at all.
 *
 * That mattered enough to be its own issue because trick play is the one phase
 * of this AI never A/B'd — #105, #115, #123 and #126 all measured bidding or
 * folding — and epic #152 is a queue of changes to it that cannot be judged
 * without a dial.
 *
 * Splitting it off `handValuation` also unblocks the epic rather than merely
 * tidying. `meld_only` gates *bidding* valuation too (`bidding.ts`,
 * `passing.ts`), so while one flag carried both, "give easy the same card play
 * as everyone else" (#156) was not expressible without also changing how easy
 * bids — two effects in one measurement, and no way to attribute the result.
 *
 * **`'simple'` is retained deliberately and is not dead code.** #156 moved
 * `easy` onto `'cascade'`, so no `SKILL_PARAMS` row selects it and neither
 * branch in `tracker.ts` is reachable in a real game. It stays for the reason
 * `FoldPolicy` keeps `'never'`: `abRun.ts` needs two levels differing in
 * exactly one field to measure this, and `PLAY_AB_POLICIES` is the only reason
 * the trick-play dial has a span at all. Deleting the arm would leave
 * `PlayPolicy` a one-member union and take the ruler away from epic #152 days
 * after #153 built it — every child of that epic is judged against the
 * `simple` baseline. Removing it is a decision to stop measuring card play,
 * not a cleanup.
 */
export type PlayPolicy = 'simple' | 'cascade'

/**
 * Whether the auto-SET rule (#178) forces a fold on a dead contract.
 *
 *   `'forced'`  when `isAutoSet` (`round.ts`) says the bid cannot be reached
 *               even by taking all 250 trick points, the round ends there.
 *   `'off'`     play the dead contract out, as every level did before #178.
 *
 * Read the `FoldPolicy` note above and then read this one the same way, only
 * more so. Auto-SET is not a difficulty setting and not a judgement call — it
 * is arithmetic, it applies to the human bid winner who has no skill level at
 * all, and `TrickPlayFlow` therefore applies it unconditionally rather than
 * consulting this field. No `SKILL_PARAMS` row selects `'off'`.
 *
 * `'off'` exists for exactly one reason: `abRun.ts` mirrors two policies at
 * one table, so measuring a rule requires two levels that differ in it and in
 * nothing else. `AUTO_SET_AB_POLICIES` is the only thing that selects it, and
 * `headlessGame.ts` is the only reader. Deleting the arm would leave the rule
 * unmeasurable, which is the same trade `FoldPolicy` documents for `'never'`.
 */
export type AutoSetPolicy = 'forced' | 'off'

/**
 * Whether a seat forced to take a trick works out which counter is *safe* to
 * take it with, or just spends the cheapest one (#158).
 *
 *   `'off'`      the state after #155: a forced beat goes to a non-counter if
 *                one is legal, otherwise to the lowest counter, whatever is
 *                still outstanding. Trump safety, where `chooseLeadCard` asks
 *                it, is read from `PlayTracker`'s exact count.
 *   `'counted'`  the lowest counter that **cannot itself be beaten in suit** —
 *                every higher card of that suit already seen or held — falling
 *                back to the lowest counter when nothing qualifies. Side-suit
 *                safety comes from `PlayTracker` and is exact at every level;
 *                trump safety comes from #157's `TrumpMemory`, whose capacity
 *                is `2 x skill level`, so it is the one thing in trick play a
 *                weak seat is genuinely worse at.
 *
 * This is the only field whose *effect* varies with the skill level rather than
 * with the row: `'counted'` is the same rule everywhere, but at `easy` it is
 * answered from 2 remembered trump and at `expert` from 10. That is deliberate
 * and it is #157's whole point — same reasoning, worse recall — so it does not
 * contradict #156's "identical rules at every level". A seat that cannot
 * remember does not play a different rule, it plays the same rule
 * conservatively, and conservative here means "assume the card can be beaten".
 */
export type SafeCounterPolicy = 'off' | 'counted'

export interface SkillParams {
  readonly handValuation: HandValuation
  readonly bidPolicy: BidPolicy
  readonly foldPolicy: FoldPolicy
  readonly playPolicy: PlayPolicy
  readonly autoSetPolicy: AutoSetPolicy
  readonly safeCounterPolicy: SafeCounterPolicy
}

/**
 * The dial.
 *
 * #114 landed the evaluator wired but switched on for nobody. At the time a
 * push to `main` deployed straight to GitHub Pages, and `DEFAULT_OPTIONS` puts
 * both AI seats on `hard`, so enabling it there would have changed every seat
 * of the default game on merge — and #114 could describe the behaviour change
 * without judging it. #115 measured it, and the gate is now open for `hard`
 * and above. (The Pages deployment was removed on 2026-08-01; the reasoning
 * stands on its own, since merging is still what makes a change real.)
 *
 * What #115 found, over 1000 paired deals played twice with the seats mirrored
 * (2000 headless games, `src/ab/`):
 *
 *   distilled swept 211 deals, static 50, 739 split. 95% CI on distilled's
 *   share of the 261 decisive deals: 75.6%–85.2%, exact two-sided binomial
 *   p < 1e-4. Score margin +227 per deal, 95% CI +198 to +257.
 *
 * The mechanism is the one #114 flagged and could not evaluate.
 * `DEFENSIVE_PUSH_FLOOR = 200` tells a seat to raise a 300 opener on almost any
 * hand — a ceiling of 200 is barely above the "no meld, no aces" floor — so the
 * static side buys a great many cheap contracts and is set on 45.4% of them.
 * The model declines most of those pushes: it takes a third fewer contracts and
 * makes 63.7% of them against static's 54.6%. Declining a contract you cannot
 * make is worth more than the contract.
 *
 * That effect survives the harness's own control: the same policy against
 * itself splits every pair with a paired margin of exactly zero, so the
 * mirroring really is cancelling the seat advantage rather than hiding a bug.
 * It is also not a quirk of playing *against* the static rule — an all-
 * distilled table is set on 38.8% of its contracts where an all-static table is
 * set on 42.3%.
 *
 * Cost, since a model that thinks visibly is a regression however well it
 * plays: +1.9 kB raw / +872 B gzipped on the shipped bundle (255.1 kB -> 253.2
 * kB with it removed), and p95 per-decision latency of 72us against static's
 * 41us in Node, 495us against 313us in Chrome at a 375x812 viewport. Even
 * multiplied by a 6x mobile-CPU emulation factor that is ~3 ms, against the
 * 600 ms `AI_BID_DELAY_MS` the auction already waits before each AI bid.
 *
 * Why the levels land where they do:
 *
 *   easy stays 'static' — its bidding never reaches the Base Bid path
 *   (`handValuation: 'meld_only'` short-circuits into `meldOnlyBid`), and the
 *   evaluator distils *skill 5*, so wiring it in would not make easy
 *   better-calibrated, it would make easy the strongest bidder and delete the
 *   tier.
 *
 *   medium stays 'static', unchanged from what it plays today. Before this
 *   change medium, hard, proficient and expert were byte-identical, so the dial
 *   had exactly two settings; leaving medium on the thresholds gives it a real
 *   third one — a bidder that opens on a rule of thumb and pushes every cheap
 *   contract is a fair description of a middling player.
 *
 *   proficient and expert take 'distilled' rather than staying on the
 *   thresholds. Epic #104's sketch was the other way round — evaluator for
 *   skills 1-3, real rollouts for 4-5 — but that mapping assumed 4-5 would
 *   *have* rollouts, and in the browser they do not and will not until the Web
 *   Worker work exists. Between the two policies that do exist here, distilled
 *   is the measurably stronger one, so leaving the top tiers on the weaker rule
 *   would rank them below `hard`. When real rollouts land they replace this on
 *   4-5; until then it is the floor, not the ceiling.
 *
 * `foldPolicy` reads `'model'` on every row on purpose (#123) and is not a
 * second dial — see `FoldPolicy` for why folding is shared competence rather
 * than a difficulty setting. The dial this table exists to express is
 * `bidPolicy`; a level's strength is meant to come from what it is willing to
 * bid, not from whether it is allowed to notice a dead contract.
 *
 * `playPolicy` (#153) reads `'cascade'` on every row, and that column is the
 * one place the table deliberately does *not* express a difficulty setting
 * (#156). Paul's reasoning, which is about what a player can see rather than
 * about strength: *"humans get really mad if you play this last part wrong,
 * but bidding they never know what you have."* A weak bid is invisible — the
 * other three seats never see the hand it was made on — while a weak card is
 * face up on the table, and it does not read as an easy opponent, it reads as
 * a partner who is broken. So trick play is shared competence, like
 * `foldPolicy`, and a level's strength comes from what it is willing to bid.
 *
 * `easy` was the one row on `'simple'`, inherited from the
 * `handValuation === 'meld_only'` card-play gate that used to live in
 * `tracker.ts`. That shortcut cost **+121 points per deal** measured against
 * the cascade on identical deals (#153, confirmed at 5000 pairs in #156) — the
 * largest effect epic #152 has found, and far too large to be a difficulty
 * notch even if it were an invisible one.
 *
 * Note what did *not* change: `easy` keeps `handValuation: 'meld_only'`, so it
 * still bids on meld alone. Easy bids like easy and plays cards like everyone
 * else, and that separation is precisely what #153 split the two fields apart
 * to allow — while one flag carried both, this change was not expressible
 * without also rewriting how easy bids.
 *
 * `'simple'` itself survives as an A/B arm and must not be deleted as dead
 * code — see `PlayPolicy` for why.
 *
 * `autoSetPolicy` (#178) reads `'forced'` on every row for a stronger reason
 * than either of those: it is not a policy at all in a real game, it is a rule
 * of arithmetic that the human bid winner gets too. See `AutoSetPolicy`.
 *
 * `safeCounterPolicy` (#158) reads `'counted'` on every row, and is the one
 * column where a uniform value still produces different play at different
 * levels — the rule is identical everywhere and only the trump recall behind it
 * scales (#157's `2 x skill level`). So it does not reopen #156: nobody plays a
 * worse rule, a weak seat just answers the same question off less information.
 * It ships enabled because it measured positive at every capacity; the rows
 * grew a line each here rather than staying on one, because five fields no
 * longer fit one readable line. See `SafeCounterPolicy` and `web/README.md`.
 */
export const SKILL_PARAMS: Record<SkillLevel, SkillParams> = {
  easy: {
    handValuation: 'meld_only',
    bidPolicy: 'static',
    foldPolicy: 'model',
    playPolicy: 'cascade',
    autoSetPolicy: 'forced',
    safeCounterPolicy: 'counted',
  },
  medium: {
    handValuation: 'base_bid',
    bidPolicy: 'static',
    foldPolicy: 'model',
    playPolicy: 'cascade',
    autoSetPolicy: 'forced',
    safeCounterPolicy: 'counted',
  },
  hard: {
    handValuation: 'base_bid',
    bidPolicy: 'distilled',
    foldPolicy: 'model',
    playPolicy: 'cascade',
    autoSetPolicy: 'forced',
    safeCounterPolicy: 'counted',
  },
  proficient: {
    handValuation: 'base_bid',
    bidPolicy: 'distilled',
    foldPolicy: 'model',
    playPolicy: 'cascade',
    autoSetPolicy: 'forced',
    safeCounterPolicy: 'counted',
  },
  expert: {
    handValuation: 'base_bid',
    bidPolicy: 'distilled',
    foldPolicy: 'model',
    playPolicy: 'cascade',
    autoSetPolicy: 'forced',
    safeCounterPolicy: 'counted',
  },
}

/** Flat trick-point estimate for meld-only bidding (skill 1), matching
 *  Python's `MELD_ONLY_TRICK_ESTIMATE` / `EASY_FLAT_TRICK_ESTIMATE`. Survives
 *  #114: it belongs to `meldOnlyBid`, the deliberately-weak skill-1 path the
 *  evaluator does not replace (see `SKILL_PARAMS` above). */
export const MELD_ONLY_TRICK_ESTIMATE = 60

/** Uniform noise range +/- for meld-only bidding ceiling. */
export const MELD_ONLY_BID_NOISE = 30
