# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Partnership Pinochle engine + AI, in Python. See [README.md](README.md)
for current status, file contents, and architecture — keep that file in
sync as the project evolves rather than duplicating it here.

## Key references

- `pinochle_rules.md` is the source of truth for game rules. The engine
  should always match it; if they disagree, that's a bug to flag, not a
  cue to silently pick one.
- `pinochle_expert_ai_strategy.md` is a design spec (not yet fully
  implemented) for the next AI tier above the current Proficient
  strategy in `pinochle_engine.py`.
