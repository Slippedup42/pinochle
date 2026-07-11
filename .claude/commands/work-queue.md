---
description: Drain the issue queue - close finished epics, prioritize low-hanging fruit, and break oversized issues into linked epics
---

Work the open-issue backlog for the Pinochle project. Follow
`TEAM.md` for label and epic conventions - read it first if you
haven't already this session.

1. **Close finished epics first.** `gh issue list --label epic --state open`.
   For each, check whether every linked child issue (from its
   checklist body) is closed. If so, close the epic with a comment
   summarizing what shipped. If not, leave it and note how many
   children remain open.

2. **Triage the rest.** `gh issue list --state open` (excluding
   epics). For each open issue not already labeled `ready-for-agent`
   or `ready-for-human`, decide which it is and label it - if it's
   genuinely unclear, default to `ready-for-human` rather than
   guessing.

3. **Identify low-hanging fruit.** Among `ready-for-agent` issues not
   already part of an epic: which are small, unblocked, and clearly
   scoped? Rank them - these get worked first.

4. **Break up anything oversized.** For any open issue (epic or not)
   that's actually multiple pieces of work bundled together, or too
   large for a single agent session: retitle it `[epic] <name>` (or
   create a new epic issue if the original should stay as-is), label
   it `epic`, and create child issues for each piece - scoped so a
   single agent can complete one in one session. Link children back
   with `Part of #<epic>` in their body, and list them as a checklist
   in the epic's body. Label each child normally (`area:*` +
   `ready-for-agent`/`ready-for-human`).

5. **Report the queue.** Show the user: epics closed this run, the
   prioritized low-hanging-fruit list, and any new epics/children
   created.

6. **Start work.** For the top 2-3 low-hanging-fruit issues, dispatch
   a background agent per issue (Agent tool, `run_in_background: true`)
   to implement it on its own branch and open a PR per the project's
   established branch -> PR -> merge convention. Tell the user which
   issues are now in progress and where to expect the PRs.

7. **Merge when ready.** "Draining the queue" means landing the work,
   not just opening PRs and stopping. As each dispatched agent's PR
   comes back, check it's mergeable (`gh pr view --json
   mergeable,mergeStateStatus`) and merge it (`gh pr merge --merge
   --delete-branch`) rather than leaving it for manual review, unless
   something about the PR looks genuinely wrong (failing checks,
   conflicts, a change that looks off - in which case flag it to the
   user instead of merging). If multiple PRs from the same run touch
   overlapping code, merge one at a time and re-check mergeability on
   the rest before merging the next.
