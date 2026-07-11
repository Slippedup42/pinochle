---
description: Run a team standup - each lead agent reviews the project from their lens, reports status, and opens/triages GitHub issues
---

Run a standup for the Pinochle project. Follow `TEAM.md` for the
roster, label conventions, and epic rules - read it first if you
haven't already this session.

1. Gather shared context once, don't make each lead re-derive it:
   `git log --oneline -15`, `gh issue list --state open --limit 100`,
   current `ROADMAP.md` phase status.

2. Spawn all four leads in parallel (`architect`, `design-lead`,
   `engineering-lead`, `qa-lead` via the Agent tool) with that shared
   context plus: "Review the project from your lens per your agent
   definition. Report status (what changed, what's healthy, what
   needs attention). For anything actionable, open a GitHub issue
   (`gh issue create`) labeled with your `area:*` label plus exactly
   one of `ready-for-agent` (unblocked, scoped, clear) or
   `ready-for-human` (genuine judgment call or blocked on input) -
   check open issues first so you don't duplicate one that already
   exists. Keep your written report under 150 words."

3. Once all four report back, present a combined standup summary to
   the user: one short section per lead (status + any issues opened,
   with links), not a wall of raw agent output.

4. If any lead's findings conflict with another's (e.g. Design says a
   rule change is needed, Engineering assumed the current rule is
   fixed), surface that conflict explicitly rather than letting one
   silently win.
