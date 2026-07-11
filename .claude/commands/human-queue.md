---
description: Walk through ready-for-human issues one at a time, with a lead's recommendation, and record the user's decision
---

Work through the `ready-for-human` backlog interactively. Follow
`TEAM.md` for label and epic conventions - read it first if you
haven't already this session.

1. `gh issue list --label ready-for-human --state open --json
   number,title,body,labels` to get the full queue. If it's empty, say
   so and stop - nothing to do.

2. Process issues **one at a time**, oldest first. For each:

   a. Determine its `area:*` label. Invoke the matching lead agent
      (`architect` / `design-lead` / `engineering-lead` / `qa-lead`)
      in the foreground with the issue's title, body, and any comments
      (`gh issue view <n> --comments`), and ask it for a short
      recommendation with a one-line rationale - not just "here are
      options," an actual pick. If the issue has no `area:*` label,
      reason about it directly instead of blocking on that.

   b. Present the issue (title + a trimmed summary of the body, not a
      full dump) and the lead's recommendation to the user via
      `AskUserQuestion`, with the recommendation as the first option
      (labeled "Accept recommendation", description = the
      recommendation itself), plus "Skip for now" and "Close - not
      applicable" as other options. The built-in "Other" option
      already covers "give a different answer," so don't add a
      redundant custom-text option yourself.

   c. Act on the answer:
      - **Accept / custom answer**: post a `gh issue comment` recording
        the decision and who/what it came from (user vs. accepted
        recommendation). Swap the label from `ready-for-human` to
        `ready-for-agent` unless the decision fully resolves the issue
        on its own (e.g. it was purely informational) - in that case
        close it instead.
      - **Skip**: leave the issue untouched, move on.
      - **Close - not applicable**: close with a comment explaining
        why.

   d. Move to the next issue. Don't batch multiple issues into one
      `AskUserQuestion` call - one issue, one decision, in sequence,
      so the user isn't asked to hold several open threads in their
      head at once.

3. When the queue is empty, report a short summary: how many resolved,
   how many skipped/closed, and links to anything that moved to
   `ready-for-agent` (those are now eligible for `/work-queue`).
