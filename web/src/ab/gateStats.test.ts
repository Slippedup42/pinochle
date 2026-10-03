// The gate-statistics instrument (#282) is only worth reading if its
// attribution is right. `classifyBid` mirrors `chooseBid`'s tiers rather than
// hooking into them, so the property that matters is that the mirror has not
// drifted: on every decision of real shipped-config auctions it must answer
// exactly what `chooseBid` answered. If `chooseBid` gains or reorders a tier,
// this fails before a stale table gets posted.

import { describe, expect, it } from 'vitest'
import { Card, Suit } from '../engine/card'
import type { AuctionContext } from '../engine/bidding'
import { aggregate, classifyBid, collectGateRounds, formatGateReport } from './gateStats'
import { type RoundRecord, playHeadlessGame } from './headlessGame'

describe('gate statistics', () => {
  const rounds = collectGateRounds(12, 7)

  it('attributes every decision to the bid chooseBid actually made', () => {
    const decisions = rounds.flatMap((r) => r.decisions)
    expect(decisions.length).toBeGreaterThan(200)
    for (const d of decisions) expect(d.trace.decision).toBe(d.played)
  })

  it('reaches the gates the report is about', () => {
    const branches = new Set(rounds.flatMap((r) => r.decisions.map((d) => d.trace.branch)))
    for (const b of ['open', 'open-decline', 'ladder-raise', 'ladder-pass']) expect(branches).toContain(b)
  })

  it('aggregates without losing a contract and formats a table', () => {
    const report = aggregate(rounds)
    expect(report.mismatches).toBe(0)
    expect(report.overall.n).toBe(rounds.length)
    const bySource = Object.values(report.outcomesBySource).reduce((s, t) => s + t.n, 0)
    expect(bySource).toBe(rounds.length)
    const o = report.overall
    expect(o.made + o.set + o.conceded + o.autoSet).toBe(o.n)
    expect(formatGateReport(report)).toContain('PARTNER_RAISE_FLOOR')
  })

  it('does not change the game it observes', () => {
    const seats = { 0: 'expert', 1: 'expert', 2: 'expert', 3: 'expert' } as const
    const log: RoundRecord[] = []
    const watched = playHeadlessGame({ seatSkills: seats, dealSeed: 99, roundLog: log })
    const plain = playHeadlessGame({ seatSkills: seats, dealSeed: 99 })
    expect(watched.scoresByTeam).toEqual(plain.scoresByTeam)
    expect(log.length).toBe(watched.rounds)
  })

  it('reports the endgame rescue gate on a dealing partner', () => {
    // Seat 2's partner (seat 0) deals; seat 1 passed; team 0 is at 800-100.
    const context: AuctionContext = {
      everBid: false,
      passesSoFar: 1,
      bidHistory: [],
      dealer: 0,
      scores: { 0: 800, 1: 100 },
      passedPlayers: [1],
    }
    const nines = [Suit.Hearts, Suit.Clubs, Suit.Diamonds].flatMap((s) => [new Card(s, '9', 1), new Card(s, '9', 2)])
    const hopeless = [...nines, ...[Suit.Hearts, Suit.Clubs, Suit.Diamonds].flatMap((s) => [new Card(s, 'J', 1), new Card(s, 'J', 2)])]
    expect(classifyBid(2, hopeless, 0, 10, context).branch).toBe('endgame-rescue-gated')
  })
})
