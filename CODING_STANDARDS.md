# Coding Standards

This documents patterns already established in the codebase, not
aspirational rules. If you're adding code and unsure how to structure
it, match what's here. If a new pattern is genuinely better, update
this doc in the same PR rather than leaving the code inconsistent with
it.

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

No test framework is wired up yet. `pinochle_engine.py`'s `__main__`
block runs assertion-based sanity checks (meld scoring edge cases, full
games to completion) as a stand-in. This is a known gap, not a
pattern to replicate as the codebase grows — see QA's lens for
follow-up.

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
