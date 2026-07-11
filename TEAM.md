# Team

Pinochle is run like a small game studio: a set of team-lead agents,
each with a specific lens, plus two recurring commands that drive
issue tracking. This doc is the source of truth for the roster, label
conventions, and workflow - agent definitions and commands reference
it rather than duplicating it.

## Roster

Defined in `.claude/agents/`:

| Lead | Lens | File |
|---|---|---|
| Architect | Cross-cutting structure, ROADMAP.md, Python/JS split, dev specs | `architect.md` |
| Design | Rules accuracy, balance, AI strategy design decisions | `design-lead.md` |
| Engineering | Implementation quality, coding standards | `engineering-lead.md` |
| QA | Test coverage, AI-change validation, bug triage | `qa-lead.md` |

Each lead's `.md` file has the full detail on what's in and out of
scope for that role.

## Labels

| Label | Meaning |
|---|---|
| `ready-for-agent` | Unblocked, scoped, actionable without a human decision |
| `ready-for-human` | Blocked on a human decision, judgment call, or input |
| `epic` | Tracking issue with linked child issues (title also prefixed `[epic]`) |
| `area:architecture` | Owned by Architect |
| `area:design` | Owned by Design |
| `area:engineering` | Owned by Engineering |
| `area:qa` | Owned by QA |

Every issue gets exactly one `area:*` label and exactly one of
`ready-for-agent` / `ready-for-human`. An issue can flip from
`ready-for-human` to `ready-for-agent` once the blocking decision is
made - don't open a duplicate issue for that.

## Epics

- Title prefixed `[epic] `, labeled `epic`.
- Body contains a checklist of linked child issues (`- [ ] #123`).
- Child issues reference the epic in their body (`Part of #100`).
- An epic closes when every linked child issue is closed - the
  `/work-queue` command checks this and closes epics that qualify. It
  is not auto-closed by GitHub itself (no CI wiring for this yet).

## Commands

- `/standup` - each lead reviews the project from their lens, reports
  status, and opens issues for anything actionable. Auto-triages
  labels on the way; anything genuinely blocked gets `ready-for-human`
  instead of guessed at.
- `/work-queue` - drains the open-issue backlog: prioritizes
  unblocked/small (`ready-for-agent`, no epic) issues as low-hanging
  fruit, converts larger scoped-out items into `[epic]` issues with
  linked children, and closes epics whose children are all closed.

See `.claude/commands/standup.md` and `.claude/commands/work-queue.md`
for the exact procedure each one follows.
