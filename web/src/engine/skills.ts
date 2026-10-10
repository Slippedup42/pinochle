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
 * folding — and epic #152 was a queue of changes to it that could not be
 * judged without a dial.
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
 * `PlayPolicy` a one-member union and take the ruler away while a measurement
 * that asks for it is still outstanding: #270, Paul's deferred re-measurement
 * of the shipped AI, whose scope names `playPolicy` among the arms to re-run,
 * and which has not run.
 *
 * That — not the epic — is what keeps the arm now. This docstring cited
 * epic #152 in the present tense until #296; #152 closed on 2026-08-02 with
 * every child closed, and no comment had to be edited for the justification to
 * stop being true. In the terms `CODING_STANDARDS.md` sets out under "Retiring
 * a policy arm", `'simple'` clears conditions 1-3 outright — two seeds,
 * decisively negative at -228 and -221 per deal (#156), selected by no shipped
 * configuration — and survives on condition 4 alone. So its fate is entirely
 * the question of what is baselined against it; the answer today is #270, and
 * when #270 reports, the place to check that is the tracker rather than this
 * paragraph. Removing it before then is a decision to stop measuring card
 * play, not a cleanup.
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

/**
 * What the opener puts on the table, once its policy has said it opens at all.
 *
 * `'floor'` names the lowest legal level - `OPENING_BID`, or the partner-passed
 * floor - which is every opening this engine has ever made. `'valuation'`
 * names a level read off the hand's own ceiling instead, compressed toward the
 * 330-380 band Paul says a normal contract lives in (`openingLevelFor` in
 * `bidding.ts` has the shape and the reasoning).
 *
 * This is the second time the question has had a dial. #204's `'walk'` stepped
 * up rung by rung while the evaluator still tolerated the next one, landed by
 * construction on the marginal contract, lost 52-56 points a deal and was
 * retired by #221. `'valuation'` is not a walk: it is one number, named once,
 * that stops well under the ceiling. The `anchor` A/B first read -13 to -21 a
 * deal for a flat 330, and Paul switched it on for the shipped AI on 2026-09-21
 * with that number in front of him. That number carried the capacity confound
 * `web/README.md` records; equalised, the price is about -30 a deal (-31, CI
 * -36 to -25, at 5000 pairs), and shown that on 2026-09-22 he kept it. The
 * symmetric price - one extra set in ~125 contracts - never carried it and
 * stands. `'floor'` is the A/B control.
 */
export type OpeningAnchor = 'floor' | 'valuation'

/**
 * How a following seat reads "is this partner's trick?" (Paul's two rules:
 * if partner is *likely* to take the trick, put in the lowest point you can;
 * if you can take it, do so).
 *
 * `'current'` is the shipped reading: partner is winning *right now*. It is
 * the whole of what `chooseFollowCard` has ever asked, and it never looks at
 * who is still to play. `'likely'` adds the position: partner still to play
 * and last means the trick is probably theirs, an opponent still behind you
 * means it probably is not yet. The two halves are separately selectable so
 * the A/B can price each:
 *
 *   - `'feedAhead'`  opponent led, this seat is second (partner last), forced
 *                    to beat, and the current winner is not boss in suit: feed
 *                    the King now rather than beat cheaply with a Jack.
 *   - `'holdBack'`   partner is winning but an opponent still sits behind this
 *                    seat and partner's card is not boss: play a non-point
 *                    instead of feeding a King the opponent may collect.
 *   - `'likely'`     both.
 *
 * `'feedAhead'` ships, on Paul's decision of 2026-09-22: +5 a deal (95% CI +2
 * to +9, 5000 pairs) on the capacity-equalised harness. `'holdBack'` measured
 * +0 (CI -1 to +1) - it changes the card played 21 times in 834 rounds - and
 * stays as the recorded null; `'likely'` adds nothing over `'feedAhead'` for
 * that reason. `'current'` is the A/B control. Python carries the same rule
 * (`_feed_ahead`) in both of its follow functions.
 */
export type PartnerRead = 'current' | 'feedAhead' | 'holdBack' | 'likely'

/**
 * What a free sluff spends (void in the lead suit and in trump, any card
 * legal).
 *
 * `'shortest'` is the pre-c897491 `choose_follow_card` rule: work toward a
 * void in the shortest suit, lowest rank within it, point value not consulted -
 * so a lone King in a one-card suit goes ahead of a 9 in a two-card suit.
 * `'protect'` is `_expert_follow_card_honest`'s: the same sort, run over the
 * non-point cards first, so a counter goes out only when nothing else is
 * legal. Paul's ruling is that the expert tier is right, and
 * the `sluff` A/B priced it at +4 / +5 / +2 a deal on three seeds (2000, 2000
 * and 5000 pairs; every CI includes zero, none includes a loss) - a null that
 * leans the right way. `'protect'` ships on that ruling; Python's Proficient
 * tier (`choose_follow_card`) moved to the same rule in the same change
 * (c897491), so both Python follow functions now protect counters and Python
 * has one sluff. `'shortest'` survives only as the A/B control.
 */
export type SluffPolicy = 'shortest' | 'protect'

/**
 * How the trick-potential stage prices an unmarried non-trump King or Queen
 * (#326).
 *
 * `'flat'` is what has shipped since #277: every loose K is worth
 * `LOOSE_KING_VALUE` (30) and every loose Q `LOOSE_QUEEN_VALUE` (20), wherever
 * the card ends up. `'passOnly'` is the literal reading of Paul's written
 * valuation (`pinochle_valuation.md`): "for every K or Q that is not a marriage
 * *and you will pass* - 20". A loose K/Q is worth `LOOSE_KQ_PASSED_VALUE` (20)
 * if `bidderPassSelection` - the bid winner's return pass, run on the dealt
 * hand at the trump being valued - would send it, and 0 if it would be kept.
 * `computeTrickPotential` in `bidding.ts` has the full definition.
 *
 * `'flat'` ships; `'passOnly'` is an A/B arm only, unmeasured, and waiting on
 * #288's valuation arm. `LOOSE_KQ_PASS_ONLY` in `bidding.ts` (paired with
 * Python's constant of the same name) is the engine default this field must
 * agree with in `SHIPPED_PARAMS`. Python carries the same switch as
 * `Player.loose_kq_pass_only`.
 */
export type LooseKqPolicy = 'flat' | 'passOnly'

/**
 * Whether a seat contesting an opponent's bid may bid *past* its own ceiling
 * to push the opponent up a rung, accepting the risk of being stuck with it.
 *
 * `chooseBid` has only ever raised while the next rung stays inside the seat's
 * ceiling (330 once partner has bid), so an opponent is never made to pay for
 * a rung the raiser would not itself want. Paul's framing is that the auction
 * is competitive: each team wants the *other* to go set without going set
 * itself, so a seat with some strength may creep a little higher, and show it
 * when partner has passed, as long as it is not left holding a contract it
 * cannot carry.
 *
 *   `'off'`      the shipped rule: raise only inside the ceiling.
 *   `'slack20'`  the ceiling is lifted by a flat 20 (two rungs).
 *   `'slack40'`  the ceiling is lifted by a flat 40 (four rungs).
 *   `'quality'`  the lift scales with how steady the hand is - trump length
 *                and Aces, the features that carried the mean total in the
 *                2026-10-09 rollout fit - up to `PUSH_QUALITY_MAX_SLACK`. A
 *                short-trump, Ace-light hand gets no lift.
 *
 * Every arm is switched off in the endgame: no push when either team is
 * within reach of going out (`ENDGAME_SCORE_FLOOR`), because there a set or a
 * make is worth a game and not a hand.
 *
 * `'quality'` ships (Paul, 2026-10-10). Paired A/B against `'off'`, 5000 pairs
 * a seed: +21, +13 and +18 a deal on the first three seeds and +10 on average
 * over three fresh ones, every interval above zero, make rate unchanged. The
 * flat arms were mixed: `'slack20'` +4 to +14, `'slack40'` -2 to +4, with
 * `'slack40'` losing make rate. `web/README.md` has the table and the sweep of
 * the cap and the scale, which found a flat surface. `'off'` is the control.
 */
export type PushPolicy = 'off' | 'slack20' | 'slack40' | 'quality'

export interface SkillParams {
  readonly handValuation: HandValuation
  readonly bidPolicy: BidPolicy
  readonly foldPolicy: FoldPolicy
  readonly playPolicy: PlayPolicy
  readonly autoSetPolicy: AutoSetPolicy
  readonly safeCounterPolicy: SafeCounterPolicy
  readonly openingAnchor: OpeningAnchor
  readonly partnerRead: PartnerRead
  readonly sluffPolicy: SluffPolicy
  readonly looseKqPolicy: LooseKqPolicy
  readonly pushPolicy: PushPolicy
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
 * | `openingAnchor`     | `valuation` | `floor`                                |
 * | `partnerRead`       | `feedAhead` | `current`, `holdBack`, `likely`        |
 * | `sluffPolicy`       | `protect`   | `shortest`                             |
 * | `looseKqPolicy`     | `flat`      | `passOnly`                             |
 * | `pushPolicy`        | `quality`   | `off`, `slack20`, `slack40`            |
 *
 * Read as prose: distilled bidding that opens at the 330 anchor, cascade card
 * play, `model` folding, `forced` auto-SET, `counted` safe counters, and —
 * since the shipped seat is `SHIPPED_SKILL` — trump memory of 10 of the 12
 * trump.
 *
 * Every one of those but the anchor is the arm that measured better; the anchor
 * is the arm that measured *worse* on score and was chosen anyway for the
 * distribution it buys — the one house-rules call in the table, recorded on
 * `OpeningAnchor`. `looseKqPolicy` is the other exception, in a different way:
 * neither of its arms has been measured, and `'flat'` ships only because it is
 * what shipped before the arm existed (#326, waiting on #288). This configuration is
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
  openingAnchor: 'valuation',
  partnerRead: 'feedAhead',
  sluffPolicy: 'protect',
  looseKqPolicy: 'flat',
  pushPolicy: 'quality',
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
