# Coding Standards

This documents patterns already established in the codebase, not
aspirational rules. If you're adding code and unsure how to structure
it, match what's here. If a new pattern is genuinely better, update
this doc in the same PR rather than leaving the code inconsistent with
it.

The two engines have genuinely different conventions, and neither is
being converged onto the other. **Part 1 is Python** (`pinochle_engine.py`
and the harnesses around it); **Part 2 is TypeScript** (`web/`). Read the
part that matches the file you are touching. Cross-engine concerns —
which constants Python is authoritative for, what the parity fixtures pin
— live in `CLAUDE.md` and `web/README.md`, not here.

# Part 1 — Python

## Module layout

- Every module opens with a triple-quoted docstring stating what it
  does and, if the module implements a non-obvious pattern, *why* it's
  built that way. `human_play.py`'s docstring explaining the
  resumable-state trick is the model to follow — a future contributor
  should be able to read it and understand the design before touching
  the code.
- Large modules (`pinochle_engine.py`) are broken into sections with a
  banner comment:

  ```python
  # ---------------------------------------------------------------------------
  # Section Name — one-line description of what this section owns.
  # ---------------------------------------------------------------------------
  ```

  Keep related constants, helpers, and classes together under the
  section they belong to rather than grouping "all constants" or "all
  classes" separately.

## Naming

- Classes: `PascalCase` (`Card`, `PlayTracker`, `InteractiveRound`).
- Functions/methods/variables: `snake_case`.
- Module-level constants: `SCREAMING_SNAKE_CASE`, declared near the
  code that uses them (not hoisted to a global constants block), with
  an inline comment when the value itself needs justification:

  ```python
  FORCED_BID = 250  # what the dealer is stuck with if everyone passes without ever bidding
  ```

- Helpers that are internal to a module and not part of its public
  surface get a leading underscore (`_hand_count`, `_take`,
  `_breaks_marriage`). If a function is reusable/meaningful outside
  its module, drop the underscore and export it properly instead of
  reaching across the underscore boundary.

## Docstrings and comments

- Docstrings explain *why*, not just what — restate the rule or design
  rationale a reader would otherwise have to reconstruct
  (`compute_base_bid`'s docstring explaining why trick-taking potential
  lives in a separate function is the model). Trivial one-line helpers
  (`_hand_count`, `_suit_length`) skip the docstring; the name carries
  it.
- For functions that apply a priority-ordered / tiered strategy
  (`choose_lead_card`, `_bidder_pass_selection`), spell out the tiers
  as a numbered or dashed list in the docstring. This is the reference
  a future change to the strategy should be checked against.
- Inline comments call out non-obvious rule quirks at the point they
  matter (`# 10 beats King`, `# doubles replace not multiply`) instead
  of relying on the reader to already know house rules from
  `pinochle_rules.md`.

## Extending existing method signatures

Several `Player` methods (`choose_bid`, `choose_pass_cards`,
`choose_card`) grew new optional parameters over time and fall back to
older, simpler behavior when those parameters aren't supplied:

```python
def choose_pass_cards(self, count, trump_suit=None, is_bid_winner=None):
    if trump_suit is None or is_bid_winner is None:
        return random.sample(self.hand, count)
    ...
```

This is the established way to widen a method's contract without
breaking existing call sites or subclasses (`HumanPlayer` overrides
these too). New optional context should follow the same shape: default
to `None`, branch on its absence, and say in the docstring which older
behavior the fallback preserves.

## Tests

`pytest` is the suite. Twenty-five `test_*.py` modules sit at the repo
root, 409 tests, all passing, run with `python -m pytest -q` at about
2m40s, most of it the dataset and model-fitting modules and the rollout
fingerprint's 40-second re-label. There is no `pytest.ini`,
`conftest.py`, or `pyproject.toml`: collection is stock discovery from
the repo root, so a new file needs nothing but the `test_` prefix and a
home beside the module it covers.

- **One `test_<module>.py` per module under test, at the repo root
  beside the module.** There is no `tests/` package; don't start one
  for a single new file and leave the other seventeen behind.
- **Every module opens with a docstring naming what is under test and
  *why those cases*.** This is the "docstrings explain why" rule above,
  applied to tests, and it is the part most worth copying.
  `test_determine_winner.py` says the tie-break and the bust-before-win
  ordering "were previously stated twice with nothing checking them
  against each other" — that tells a later reader what the file is
  defending, which a list of function names does not.
  `test_ab_harness.py` numbers its five areas and calls out which
  property the whole harness rests on.
- **Plain `assert`, plain module-level `def test_*` functions.** No test
  file imports `pytest` at all: no markers, no fixtures, no
  `parametrize`, no test classes anywhere. Classes do appear in test
  files, but only as test doubles for the code under test
  (`_AlwaysFolds`, `_RiggedRound`, `_ScriptedHumanPlayer`), and they
  take the same leading underscore as any other module-internal helper.
  - There has been exactly one exception, and it has cleared itself.
    `test_rollout_dataset_fingerprint.py` (#225) carried a single
    `pytest.mark.xfail(..., strict=True)` while it guarded a committed
    artefact that was knowingly behind the engine, because a plain
    assert has no way to read as *known* red: it is either green, which
    trains people to ignore the state, or red on `main` from the day it
    lands, which trains people to ignore the suite. `xfailed` in the
    `-q` summary is neither. The condition was keyed on the artefact's
    own stamp rather than on a flag in the test, which is what made the
    marker self-clearing — #226 regenerated the dataset, the stamp came
    back without its `known_mismatch` block, and the marker came out
    with it. Reach for that shape only in the same situation: a guard
    deliberately red against a tracked ticket, with the condition read
    from the artefact so nobody has to remember to delete it. The
    plain-assert rule stands for everything else.
- **Test names state the behaviour being asserted**, not just the
  function being called:
  `test_the_fixture_covers_a_last_trick_taken_by_the_defenders`,
  `test_bid_ev_strong_hand_beats_weak_hand_at_same_bid`. Long is fine —
  the name is what a failure prints.
- Longer modules use the same `# ---` banner comments as the source
  modules to group cases by area.

### The `if __name__ == "__main__":` block is optional

Eight of the seventeen modules end with one, calling their test
functions in order and printing as each passes; nine do not. Treat it
as an affordance you may add, not a requirement:

- It is deliberate where it exists. `test_determine_winner.py`'s
  docstring advertises the path — "Run directly (`python
  test_determine_winner.py`) or via pytest" — and that is the newest
  test module in the repo, so the block is not a vestige nobody has
  cleaned up.
- It does not track runtime, whatever the intuition suggests. The two
  slowest modules by a wide margin, `test_rollout_dataset.py` and
  `test_fit_evaluator.py`, have no block. The eight that do are the
  original batch of strategy and simulation modules, plus
  `test_determine_winner.py`.
- It carries a maintenance cost the pytest path doesn't. Five of the
  eight list their test functions by hand, so adding a test means
  editing two places and forgetting is silent. The other three
  (`test_determine_winner.py`, `test_expert_pass.py`,
  `test_trick_play_strategy.py`) scan `globals()` for `test_`-prefixed
  callables instead — copy that shape, not the hand-written list, if
  you add one.

Add a block when you expect to iterate on that module in isolation,
skip it otherwise, and don't retrofit blocks into the nine that go
without. `python -m pytest -q` is the suite either way.

`pinochle_engine.py`'s own `__main__` block still exists and still
asserts — Double Run scoring, ten full games to completion — but pytest
does not collect it, and it is a demo and smoke run rather than part of
the suite. New coverage goes in a `test_*.py` module.

## Known duplication (intentional, needs care)

`InteractiveRound` in `human_play.py` mirrors `Round`'s
`_bidding_loop` / `_passing_phase` / `_trick_taking_loop` phase for
phase, substituting instance attributes for local variables so a
`NeedsHumanInput` exception can unwind and resume later. This
duplication is a deliberate tradeoff (see `human_play.py`'s module
docstring and `README.md`'s Architecture section), not an oversight —
but it means **a rule or bug fix to those three methods in
`pinochle_engine.py` must be manually mirrored into the matching
`InteractiveRound` method**, and nothing currently enforces that. When
you touch one side, check the other.

# Part 2 — TypeScript (`web/`)

`web/` is the product and is roughly six times the size of the Python
engine. It follows its own conventions throughout; do not carry Python
habits into it.

## Formatting

There is no Prettier and no formatting rule in `.oxlintrc.json`, so
formatting is upheld by matching neighbouring code. In practice it is
completely consistent and worth keeping that way:

- **No semicolons.** Across `web/src` there is not one
  statement-terminating semicolon — the only lines ending in `;` are
  prose inside comments.
- Single quotes for strings; double quotes only in JSX attributes.
- Two-space indent.

`npm run lint` (oxlint) is the only automated check, and it enforces
exactly two rules — `react/rules-of-hooks` and
`react/only-export-components`. Everything else here is on the author.

## TypeScript config constraints

`tsconfig.app.json` turns on flags that change what you are allowed to
write. These are constraints, not preferences:

- **`erasableSyntaxOnly`** — no `enum`, no constructor parameter-property
  shorthand. The replacement for an enum is the const-object-plus-type
  pattern, and `card.ts`'s `Suit` is the reference implementation:

  ```ts
  export const Suit = { Spades: 'S', Diamonds: 'D', Clubs: 'C', Hearts: 'H' } as const
  export type Suit = (typeof Suit)[keyof typeof Suit]
  ```

  A class writes its fields out and assigns them in the constructor body
  (`Card`, `Trick`).
- **`verbatimModuleSyntax`** — type-only imports must say so. Use
  `import type { ... }` when the whole import is types, and the inline
  `type` specifier when a line mixes both:
  `import { type Card, Suit, SUITS } from './card'`.
- **`noUnusedLocals` / `noUnusedParameters`** — an unused import or
  parameter fails `npm run build`, so unreachable code does not
  accumulate silently here the way it can in Python.

## Naming and file layout

- Files: `PascalCase.tsx` for React components (`TrickPlayFlow.tsx`,
  `ClaimNotice.tsx`); `camelCase.ts` for everything else — engine
  modules (`bidding.ts`), reducers (`trickPlayReducer.ts`), shared
  shapes (`trickPlayTypes.ts`), hooks (`useDraggable.ts`).
- Types, interfaces and components: `PascalCase`. Functions, methods,
  variables and object properties: `camelCase`. Module-level constants:
  `SCREAMING_SNAKE_CASE`.
- Constants are declared next to the code that uses them rather than in
  a shared constants module, and carry a comment when the *value* needs
  justifying — the same rule as Part 1. `card.ts`'s `OPENING_BID` and
  `FORCED_BID` are the model: both are 250, and the comments say why
  they are nonetheless two constants.
- Tests are colocated with what they test: `bidding.ts` /
  `bidding.test.ts`, `Seat.tsx` / `Seat.test.tsx`. Large recorded inputs
  go in a separate `*.fixture.ts` (`engineParity.fixture.ts`).

## Shared values live in one module and are imported

A value two modules both need is exported from the module that owns it
and imported — never restated. `card.ts`'s `COPIES_PER_CARD` and
`trick.ts`'s `POINT_RANKS` each carry a comment saying that is why they
are exported at all: so `round.ts` can derive `MAX_TRICK_POINTS` from
the same set that scores a trick, rather than encoding "how many
counters a deck holds" in two places. A comment of the form
`// matches round.ts` is what this rule looks like while it is being
broken; export and import instead.

## Immutable state shapes

Reducer state, engine results, and anything crossing a module boundary
is declared `readonly` field by field, with `readonly T[]` for arrays:

```ts
export interface ClaimResult {
  readonly claimer: PlayerIndex
  readonly cards: readonly Card[]
  ...
}
```

Reducers return a new object via spread and never mutate. Discriminated
unions use a `kind` field (`TrickPlayLogEntry`) and are consumed with an
exhaustive `switch` with no `default`, so adding a variant becomes a
type error at every consumer instead of a silent fallthrough.

## Components, reducers, and shared shapes

A phase of the game is three files, and the split is enforced by
oxlint's `react/only-export-components` — a file exporting both a
component and logic breaks fast refresh:

- `XFlow.tsx` — the component, and the *only* export of that file.
- `xReducer.ts` — the state machine: `XState`, `XAction`, `initXState`,
  `xReducer`, plus pure helpers. Testable without mounting anything.
- `xTypes.ts` — shapes shared between the two, built from engine types
  rather than re-declared, plus pure formatters
  (`formatTrickPlayLogEntry`) so display strings are testable without a
  DOM.

`AuctionFlow` / `auctionReducer` / `auctionTypes` and `TrickPlayFlow` /
`trickPlayReducer` / `trickPlayTypes` both follow it. New phase work
should.

## Where a TypeScript-only rule is allowed to live

`round.ts`'s `playTrickTakingPhase` is the parity-checked port of
Python's `Round._trick_taking_loop`; `engineParity.test.ts` replays
recorded Python rounds through it and asserts the winner and points of
every trick. **A behaviour Python does not have must not go inside that
loop**, because parity would then hold only for as long as the new
behaviour never fires.

The established answer is to expose the decision as a pure exported
function in the engine module and apply it one layer up, in the reducer.
`findClaim` in `round.ts` is the reference: the engine *answers* "can
this seat be beaten", and `trickPlayReducer`'s `applyClaimIfAvailable`
is what acts on it. `round.ts` carries a comment beside
`playTrickTakingPhase` recording that line and the reason for it — keep
that note alive if you add another such rule.

## Doc comments

- Modules open with a `//` block naming what the module owns and, when
  the design is non-obvious, why it is built that way.
  `gameFlowReducer.ts` is the model: it says which phase it sits above,
  what it deliberately does *not* reimplement, and why it is not inside
  `GameFlow.tsx`.
- Exported symbols get `/** */` JSDoc explaining *why*, in the same
  spirit as Part 1 — restate the rule or the measurement a reader would
  otherwise have to reconstruct. `findClaim` and the `SkillParams`
  policy types are the high-water mark.
- Issue numbers are cited inline (`(#208)`) as the pointer to the full
  rationale in `web/README.md`. Cite the issue that *established* the
  behaviour, not whichever one you happen to be working.
- Do not leave forward-looking comments standing after the thing
  arrives. "A future Round orchestrator (once #17 lands)" and "frozen
  Python reference" both outlived their truth in modules nobody re-read.
  If you touch a file whose header describes a state of the world that
  has since changed, fix the header in the same PR.

## AI behaviour goes on a policy field, not behind a constant

New AI behaviour that could plausibly be measured becomes a field on
`SkillParams` (`web/src/engine/skills.ts`) with a string-union type —
not a boolean, not a bare constant. `abRun.ts` can only compare two
rules by sitting two policies at one table that differ in exactly one
field, so a rule with no field is a rule that cannot be measured.

This is a measuring instrument and not a difficulty dial, which it was
also called until #222 removed the difficulty setting from the product.
`SHIPPED_PARAMS` is the one configuration a player ever meets;
`SKILL_PARAMS`' five level keys are slots `installPolicies` writes into,
and `TRUMP_MEMORY_CAPACITY` is keyed on them. Nothing outside
`web/src/ab/` should name a level other than `SHIPPED_SKILL`.

Each policy type carries a docstring stating every arm, which arm
`SHIPPED_PARAMS` selects, and — when the shipped configuration does not
select an arm — why that arm still exists. `PlayPolicy`, `FoldPolicy`
and `AutoSetPolicy` all do this, and `SHIPPED_PARAMS`' own docstring
tabulates the answer for every field at once, so which columns are live
is one read rather than six. A losing arm retained for measurement is
normal here (see `ROADMAP.md` on null results being recorded and shipped
disabled); an arm with no such note is drift. A field left with one
member is neither — `OpeningPolicy` was that after #221 retired its
losing arm, and #222 removed the field, because a field nothing can vary
measures nothing. #223 is writing down when retiring an arm is the right
move.
