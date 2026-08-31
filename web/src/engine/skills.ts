/**
 * The five configurations the engine can be asked for, keyed 1-5 in this order
 * — the same ladder as Python's `GENERAL_STRATEGY_SKILL_PARAMS`
 * (`pinochle_engine.py`) and as `trumpMemory.ts`'s `TRUMP_MEMORY_CAPACITY`
 * (`2 x level`).
 *
 * **These are not a difficulty setting.** #222 removed the dial: the product
 * ships exactly one configuration, `SHIPPED_SKILL`, nothing a player can touch
 * selects another, and `GameOptions` no longer carries a level at all. The type
 * lived in `persistence/options.ts` while it was a stored preference; it lives
 * here now that it is engine configuration and nothing else.
 *
 * What the other four keys are for is measurement, and only measurement. Two
 * mechanisms need a level to be a thing you can name:
 *
 *   - `abRun.ts`'s `installPolicies` sits two rules at one table by overwriting
 *     two entries of `SKILL_PARAMS` and seating one on each side. A comparison
 *     needs two keys that differ in exactly one field, so a single-key map
 *     would end paired A/B measurement outright.
 *   - `TRUMP_MEMORY_CAPACITY` is keyed on the level itself and is deliberately
 *     *not* a `SkillParams` field (#157), so the level a `'counted'` arm sits
 *     on **is** the capacity under test (#158). Collapsing the keys would take
 *     that ruler away as well as the dial.
 *
 * So a level name inside `src/ab/` is a slot, and a level name outside it
 * should be `SHIPPED_SKILL`.
 */
export const SKILL_LEVELS = ['easy', 'medium', 'hard', 'proficient', 'expert'] as const
export type SkillLevel = (typeof SKILL_LEVELS)[number]

/**
 * Which hand-valuation formula the AI uses in bidding. Ported from Python's
 * GENERAL_STRATEGY_SKILL_PARAMS (`pinochle_engine.py`).
 *
 *   `'base_bid'`   the layered valuation in `bidding.ts` — certain meld plus
 *                  speculative meld plus a trick estimate off the hand's shape.
 *                  What `SHIPPED_PARAMS` selects.
 *   `'meld_only'`  `meldOnlyBid`: meld in the best suit plus a flat trick
 *                  estimate and uniform noise, with the same shortcut applied
 *                  to `chooseTrump` and `choosePassCards`.
 *
 * `'meld_only'` is unselected since #222 — it was `easy`'s valuation and there
 * is no `easy` to select it any more. It is kept on the terms every other
 * unselected arm in this file is kept on: `installPolicies` can still seat it,
 * so "bid on meld alone" remains a baseline the distilled bidder can be
 * measured against, and the arm has never been through the retirement rule.
 */
export type HandValuation = 'meld_only' | 'base_bid'

/**
 * Which rule decides "is this hand worth a contract" (#114).
 *
 *   `'static'`    the hand-tuned constants — `OPENER_THRESHOLD`,
 *                 `DEFENSIVE_PUSH_FLOOR` — that shipped before epic #104. No
 *                 longer selected by anything the product runs (#222), but the
 *                 constants themselves are *not* dead: they still decide the
 *                 auction's raise ladder under both policies (see `chooseBid`),
 *                 and this arm is the baseline #115 measured the evaluator
 *                 against and that `BID_AB_POLICIES` still seats.
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
 * This was uniform across all five levels while the dial existed, and the type
 * existed to keep the alternative measurable rather than to give the dial
 * another notch. The reason is that folding is not a matter of taste:
 * conceding and being set cost the bidding team exactly the same (`-bid`, meld
 * forfeited either way), and the only thing a fold changes is that the
 * defenders are denied their trick points. So a fold can never beat making the
 * contract and can never lose to being set - it is strictly dominant over a
 * set. A weak tier declining a free improvement would not read as weak play,
 * it would read as a bug.
 *
 * `'never'` is retained because `abRun.ts` needs two levels differing in
 * exactly one field to measure this, and because the day someone wants an
 * opponent that folds *badly* the honest way to build it is a third policy
 * that folds on the wrong hands - not one that cannot fold at all.
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
 *                is `2 x skill level`, so how well it is answered depends on
 *                the level the seat sits on.
 *
 * This is the only field whose *effect* depends on the level as well as on the
 * value: `'counted'` is the same rule everywhere, but on the `easy` slot it is
 * answered from 2 remembered trump and on `expert` from 10. Every shipped seat
 * is `expert` since #222, so in a real game this is 10 of 12 for all four
 * players and the human. It still matters to `ab/`: `safeCounterAbPolicies`
 * varies the level precisely to vary the recall behind an unchanged rule, which
 * is the comparison #158 exists to make and the reason the level keys survive
 * the dial's removal.
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
 * **The one AI the product ships** (#222), and the single place to read which
 * of this file's policy columns are live behaviour and which are A/B arms.
 *
 * | field               | shipped     | other arms, selectable only from `ab/` |
 * | ---                 | ---         | ---                                    |
 * | `handValuation`     | `base_bid`  | `meld_only`                            |
 * | `bidPolicy`         | `distilled` | `static`                               |
 * | `foldPolicy`        | `model`     | `never`                                |
 * | `playPolicy`        | `cascade`   | `simple`                               |
 * | `autoSetPolicy`     | `forced`    | `off`                                  |
 * | `safeCounterPolicy` | `counted`   | `off`                                  |
 *
 * Read as prose: distilled bidding, cascade card play, `model` folding,
 * `forced` auto-SET, `counted` safe counters, and — since the shipped seat is
 * `SHIPPED_SKILL` — trump memory of 10 of the 12 trump.
 *
 * Every one of those is the arm that measured better, and this configuration is
 * what `hard`, `proficient` and `expert` all already were apart from recall.
 * Epic #215 is where the dial went: three panel rows that were byte-identical
 * except for `TRUMP_MEMORY_CAPACITY` are a control a player cannot feel, and
 * the answer was to stop offering it rather than to manufacture a span. So the
 * table below is one configuration written once and pointed at from every slot,
 * not five rows that happen to agree — which is the state #215 objected to.
 *
 * The right-hand column is the honest cost of the arrangement and is why it is
 * tabulated here rather than left to six separate docstrings: each unselected
 * arm keeps a branch of production code no player can reach. They are retained
 * on purpose — `abRun.ts` compares two rules only by seating two levels that
 * differ in exactly one field, so an arm deleted is a comparison that can no
 * longer be made — and the standing rule for when one is nonetheless retired
 * lives in `CODING_STANDARDS.md`. Each type above says why its own arm stays.
 *
 * The column that is *not* here is `openingPolicy`. #221 retired its `'walk'`
 * arm under that rule and left the one-member field for this change to clear,
 * since removing it touched every row of this table and of the `*_AB_POLICIES`
 * maps. A field with one value is not a dial, so it is gone; the finding it
 * carried is at `chooseBid`'s opening branch in `bidding.ts` and in
 * `web/README.md`, which is where a retired arm's numbers are supposed to live.
 *
 * On the numbers behind `bidPolicy`: #115 measured distilled against static
 * over 1000 paired deals at +227 per deal (95% CI +198 to +257, p < 1e-4),
 * with the mechanism being that the model declines the cheap contracts
 * `DEFENSIVE_PUSH_FLOOR` tells the static rule to buy. #255 re-ran the same
 * comparison on 2026-08-30 and got +18 per deal (CI -3 to +39) with clean
 * self-tests on both arms. That gap is unexplained and open on #227, so treat
 * the magnitude as provisional; the direction has never reversed, and nothing
 * in the record argues for shipping the static rule.
 */
export const SHIPPED_PARAMS: SkillParams = {
  handValuation: 'base_bid',
  bidPolicy: 'distilled',
  foldPolicy: 'model',
  playPolicy: 'cascade',
  autoSetPolicy: 'forced',
  safeCounterPolicy: 'counted',
}

/**
 * The level every seat in a real game plays at, and the default for every
 * engine entry point that takes one.
 *
 * `expert` rather than an arbitrary pick: the level decides
 * `TRUMP_MEMORY_CAPACITY` (#157), which `SkillParams` deliberately does not
 * carry, so this constant is the one remaining thing a level name still means
 * outside `ab/` — 10 of 12 trump remembered, the top of the capacity ladder and
 * the arm #158 measured best.
 */
export const SHIPPED_SKILL: SkillLevel = 'expert'

/**
 * What each level slot is currently configured to play.
 *
 * Every slot holds `SHIPPED_PARAMS`, because the product has one AI and the
 * slots are not tiers — see `SkillLevel`. Nothing outside `src/ab/` should
 * index this with anything but `SHIPPED_SKILL`.
 *
 * Mutable on purpose, and the only mutable export in `src/engine/`.
 * `abRun.ts`'s `installPolicies` overwrites two entries for the duration of a
 * run and restores them in a `finally`; that seam is what lets two policies
 * live in one process, which a mirrored A/B needs because both arms sit at the
 * same table. It survives the dial's removal deliberately (#215's explicit
 * boundary) — collapsing this to a single frozen object would end paired A/B
 * measurement, which is how `CLAUDE.md` says strategy changes are judged.
 */
export const SKILL_PARAMS: Record<SkillLevel, SkillParams> = Object.fromEntries(
  SKILL_LEVELS.map((level) => [level, SHIPPED_PARAMS]),
) as Record<SkillLevel, SkillParams>

/** Flat trick-point estimate for meld-only bidding, matching Python's
 *  `MELD_ONLY_TRICK_ESTIMATE` / `EASY_FLAT_TRICK_ESTIMATE`. Belongs to
 *  `meldOnlyBid`, which since #222 is reachable only through
 *  `installPolicies` — see `HandValuation` for why the arm stays. */
export const MELD_ONLY_TRICK_ESTIMATE = 60

/** Uniform noise range +/- for meld-only bidding ceiling. */
export const MELD_ONLY_BID_NOISE = 30
