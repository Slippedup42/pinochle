// Descriptive statistics at the six auction gates (#282).
//
// #282's 2026-09-18 decision: before re-cutting any of `OPENER_THRESHOLD`,
// `THIRD_BIDDER_FLOOR`, `DEFENSIVE_PUSH_FLOOR`, `ENDGAME_RESCUE_CEILING`,
// `PARTNER_PASSED_FLOOR` or `PARTNER_RAISE_FLOOR`, measure where each one
// actually binds on the shipped configuration — how often a hand arrives near
// it, how often it fires, what it lets through and what those contracts then
// do. This is that instrument. It is not an A/B and it changes nothing: every
// seat plays `SHIPPED_SKILL`, and the numbers describe the game as shipped.
//
// Why TypeScript and not Python: the questions are about `chooseBid`'s gates,
// and the shipped auction is this one. `PARTNER_PASSED_FLOOR` and
// `PARTNER_RAISE_FLOOR` exist only here (#213), the opener is the distilled
// evaluator rather than a threshold, and #315's 330 opening anchor changes
// which rung the defensive push can ever see. A Python run would measure a
// different auction.
//
// How a decision is attributed to a gate: `classifyBid` walks `chooseBid`'s
// tiers in the same order and reports which one answered, plus the
// counterfactual verdicts the shipped policy does not consult (the static
// `OPENER_THRESHOLD` / `DEFENSIVE_PUSH_FLOOR` comparisons). It is a mirror, so
// it can drift; `gateStats.test.ts` replays real auctions and requires its
// `decision` to equal `chooseBid`'s on every one, which is the net for that.
//
//   node node_modules/jiti/lib/jiti-cli.mjs src/ab/cli.ts gates --games 2000 --seed 1

import {
  type AuctionContext,
  COMPETITIVE_CEILING_FLOOR,
  DEFENSIVE_PUSH_FLOOR,
  ENDGAME_OPP_SCORE_CAP,
  ENDGAME_RESCUE_CEILING,
  ENDGAME_SCORE_FLOOR,
  OPENER_THRESHOLD,
  PARTNER_PASSED_FLOOR,
  PARTNER_RAISE_FLOOR,
  THIRD_BIDDER_FLOOR,
  bestBaseBid,
  openingLevelFor,
  pushSlackFor,
} from '../engine/bidding'
import { MIN_BID_INCREMENT, OPENING_BID } from '../engine/card'
import { shouldBid } from '../engine/evaluator'
import { partnerOf, type TeamId, teamOf } from '../engine/round'
import { SHIPPED_SKILL, SKILL_PARAMS, type SkillLevel } from '../engine/skills'
import type { PlayerIndex } from '../engine/trick'
import { type ContractOutcome, type RoundRecord, playHeadlessGame } from './headlessGame'

/** Which `chooseBid` tier answered. Disjoint and exhaustive for `base_bid`. */
export type Branch =
  | 'endgame-pass' // #256 trigger holds, no rescue
  | 'endgame-rescue' // #256 rescue of a dealing partner, ceiling > ENDGAME_RESCUE_CEILING
  | 'endgame-rescue-gated' // rescue situation, ceiling <= ENDGAME_RESCUE_CEILING
  | 'open' // nobody has bid; the policy opens (any seat, incl. 3rd)
  | 'open-decline' // nobody has bid; the policy declines (not 3rd seat)
  | 'third-positional' // 3rd seat, policy declined, ceiling >= THIRD_BIDDER_FLOOR
  | 'third-decline' // 3rd seat, policy declined, ceiling < THIRD_BIDDER_FLOOR
  | 'partner-carrying' // partner has bid twice
  | 'partner-raise' // over own partner, ceiling >= PARTNER_RAISE_FLOOR
  | 'partner-raise-gated' // over own partner, ceiling < PARTNER_RAISE_FLOOR
  | 'own-bid-stands'
  | 'push' // defensive push fired
  | 'partner-passed-floor' // partner out, ladder below 320: jumps to PARTNER_PASSED_FLOOR
  | 'partner-passed-gated' // same, competitive ceiling < PARTNER_PASSED_FLOOR
  | 'ladder-raise'
  | 'ladder-pass'

export interface GateTrace {
  readonly branch: Branch
  readonly decision: number | null
  readonly ceiling: number
  readonly competitiveCeiling: number
  readonly partnerPassed: boolean
  readonly partnerHasBid: boolean
  /** The level the shipped policy was asked about, where one was asked. */
  readonly askedLevel?: number
  /** What the shipped policy answered at `askedLevel`. */
  readonly policyVerdict?: boolean
  /** What the static constant would have answered (OPENER_THRESHOLD for an
   *  open, DEFENSIVE_PUSH_FLOOR for a push). Under `'distilled'` it is not
   *  consulted; it is reported so its agreement with the evaluator is visible. */
  readonly staticVerdict?: boolean
  /** Set on any arrival where the defensive push was considered, whether or
   *  not it fired — the push falls through to the ladder when it declines. */
  readonly pushConsidered?: boolean
}

/**
 * `chooseBid`'s tiers, walked in the same order, reporting which answered.
 * Supports the `base_bid` valuation only — the `meld_only` path has no gates.
 */
export function classifyBid(
  player: PlayerIndex,
  hand: Parameters<typeof bestBaseBid>[0],
  currentBid: number,
  minIncrement: number,
  context: AuctionContext,
  skill: SkillLevel = SHIPPED_SKILL,
): GateTrace {
  const params = SKILL_PARAMS[skill]
  if (params.handValuation !== 'base_bid') throw new Error('classifyBid: base_bid valuation only')

  const myTeam = teamOf(player)
  const oppTeam = (1 - myTeam) as TeamId
  const myScore = context.scores[myTeam]
  const oppScore = context.scores[oppTeam]
  const { total: ceiling, trump: bestTrump } = bestBaseBid(hand, myScore, oppScore)
  const partner = partnerOf(player)
  const partnerIsDealer = partner === context.dealer
  const partnerPassed = context.passedPlayers.includes(partner)
  const partnerHasBid = context.bidHistory.some((b) => b.player === partner)
  const competitiveCeiling = partnerHasBid ? Math.max(ceiling, COMPETITIVE_CEILING_FLOOR) : ceiling
  const base = { ceiling, competitiveCeiling, partnerPassed, partnerHasBid }

  if (myScore >= ENDGAME_SCORE_FLOOR && oppScore < ENDGAME_OPP_SCORE_CAP) {
    const opponentHasBid = context.bidHistory.some((b) => teamOf(b.player) !== myTeam)
    const seatBeforeMe = ((player + 3) % 4) as PlayerIndex
    const situation = partnerIsDealer && !opponentHasBid && context.passedPlayers.includes(seatBeforeMe)
    if (!situation) return { ...base, branch: 'endgame-pass', decision: null }
    return ceiling > ENDGAME_RESCUE_CEILING
      ? { ...base, branch: 'endgame-rescue', decision: OPENING_BID }
      : { ...base, branch: 'endgame-rescue-gated', decision: null }
  }

  const minBidAfterPartnerPass = Math.max(PARTNER_PASSED_FLOOR, currentBid + minIncrement)
  const distilled = params.bidPolicy === 'distilled'
  const ask = (level: number, staticVerdict: boolean): boolean =>
    distilled
      ? shouldBid({ hand, bid: level, ourScore: myScore, theirScore: oppScore, partnerHasBid, partnerHasPassed: partnerPassed })
      : staticVerdict

  if (!context.everBid) {
    const floorLevel = partnerPassed ? minBidAfterPartnerPass : OPENING_BID
    const staticVerdict = ceiling >= OPENER_THRESHOLD
    const opens = ask(floorLevel, staticVerdict)
    const openAt = openingLevelFor(ceiling, floorLevel, params.openingAnchor)
    const asked = { askedLevel: floorLevel, policyVerdict: opens, staticVerdict }
    if (opens) return { ...base, ...asked, branch: 'open', decision: openAt }
    if (context.passesSoFar === 2) {
      return ceiling >= THIRD_BIDDER_FLOOR
        ? { ...base, ...asked, branch: 'third-positional', decision: OPENING_BID }
        : { ...base, ...asked, branch: 'third-decline', decision: null }
    }
    return { ...base, ...asked, branch: 'open-decline', decision: null }
  }

  const lastBidder = context.bidHistory[context.bidHistory.length - 1].player
  if (teamOf(lastBidder) === myTeam) {
    const partnerBidCount = context.bidHistory.filter((b) => b.player === partner).length
    const myOwnBids = context.bidHistory.filter((b) => b.player === player).map((b) => b.amount)
    if (partnerBidCount >= 2) return { ...base, branch: 'partner-carrying', decision: null }
    if (lastBidder === partner && myOwnBids.length > 0 && currentBid > myOwnBids[myOwnBids.length - 1]) {
      return ceiling < PARTNER_RAISE_FLOOR
        ? { ...base, branch: 'partner-raise-gated', decision: null }
        : { ...base, branch: 'partner-raise', decision: Math.max(PARTNER_RAISE_FLOOR, currentBid + minIncrement) }
    }
    return { ...base, branch: 'own-bid-stands', decision: null }
  }

  const nextBid = currentBid + minIncrement
  // `pushPolicy`: the ceiling both raise gates below read is lifted by this.
  const raiseCeiling =
    competitiveCeiling + pushSlackFor(params.pushPolicy, hand, bestTrump, myScore, oppScore, minIncrement)
  let pushFields = {}
  if (currentBid <= OPENING_BID) {
    const pushLevel = partnerPassed ? Math.max(nextBid, PARTNER_PASSED_FLOOR) : nextBid
    const staticVerdict = ceiling >= DEFENSIVE_PUSH_FLOOR
    const verdict = ask(pushLevel, staticVerdict)
    pushFields = { askedLevel: pushLevel, policyVerdict: verdict, staticVerdict, pushConsidered: true }
    if (verdict) return { ...base, ...pushFields, branch: 'push', decision: pushLevel }
  }
  if (partnerPassed && nextBid < PARTNER_PASSED_FLOOR) {
    return raiseCeiling >= PARTNER_PASSED_FLOOR
      ? { ...base, ...pushFields, branch: 'partner-passed-floor', decision: PARTNER_PASSED_FLOOR }
      : { ...base, ...pushFields, branch: 'partner-passed-gated', decision: null }
  }
  return nextBid <= raiseCeiling
    ? { ...base, ...pushFields, branch: 'ladder-raise', decision: nextBid }
    : { ...base, ...pushFields, branch: 'ladder-pass', decision: null }
}

// -- Collection --------------------------------------------------------------

export interface TracedDecision {
  readonly trace: GateTrace
  readonly player: PlayerIndex
  readonly currentBid: number
  readonly passesSoFar: number
  /** The `chooseBid` answer actually played, kept so a mismatch is visible. */
  readonly played: number | null
}

export interface TracedRound {
  readonly decisions: readonly TracedDecision[]
  readonly bid: number
  readonly outcome: ContractOutcome
  readonly bidderNet: number
  /** Branch of the winning bidder's last bid, refined where one branch hides
   *  two mechanisms: see `Source`. */
  readonly source: Source
  /** The winner's own ceiling when it placed the winning bid; null if forced. */
  readonly winnerCeiling: number | null
}

/**
 * A `Branch`, plus two refinements the outcome table needs:
 *
 *   `ladder-raise (lifted)`  a raise over an opponent that only the
 *       `COMPETITIVE_CEILING_FLOOR` lift allowed — the bid is above the
 *       seat's own ceiling because its partner had bid.
 *   `forced (endgame)`       a pass-out onto a dealer whose team was under
 *       endgame protection (#256) — the outcome the rescue exists to avoid.
 */
export type Source = Branch | 'ladder-raise (lifted)' | 'forced' | 'forced (endgame)'

export function traceRound(round: RoundRecord, skill: SkillLevel = SHIPPED_SKILL): TracedRound {
  const decisions = round.decisions.map((d) => ({
    trace: classifyBid(d.player, d.hand, d.currentBid, MIN_BID_INCREMENT, d.context, skill),
    player: d.player,
    currentBid: d.currentBid,
    passesSoFar: d.context.passesSoFar,
    played: d.decision,
  }))
  let winning: TracedDecision | undefined
  for (const d of decisions) {
    if (d.player === round.bidWinner && d.played !== null) winning = d
  }
  let source: Source
  if (winning === undefined) {
    const dealerTeam = teamOf(round.dealer)
    const mine = round.scoresBefore[dealerTeam]
    const theirs = round.scoresBefore[(1 - dealerTeam) as TeamId]
    source = mine >= ENDGAME_SCORE_FLOOR && theirs < ENDGAME_OPP_SCORE_CAP ? 'forced (endgame)' : 'forced'
  } else if (winning.trace.branch === 'ladder-raise' && (winning.played ?? 0) > winning.trace.ceiling) {
    source = 'ladder-raise (lifted)'
  } else {
    source = winning.trace.branch
  }
  return {
    decisions,
    bid: round.bid,
    outcome: round.outcome,
    bidderNet: round.bidderNet,
    source,
    winnerCeiling: winning?.trace.ceiling ?? null,
  }
}

/** Plays `games` shipped-configuration games and traces every auction. */
export function collectGateRounds(games: number, seed: number): TracedRound[] {
  const out: TracedRound[] = []
  const seats = { 0: SHIPPED_SKILL, 1: SHIPPED_SKILL, 2: SHIPPED_SKILL, 3: SHIPPED_SKILL } as const
  for (let g = 0; g < games; g++) {
    const roundLog: RoundRecord[] = []
    playHeadlessGame({ seatSkills: seats, dealSeed: (seed * 1_000_003 + g) >>> 0, roundLog })
    for (const r of roundLog) out.push(traceRound(r))
  }
  return out
}

// -- Aggregation -------------------------------------------------------------

export interface OutcomeTally {
  n: number
  made: number
  set: number
  conceded: number
  autoSet: number
  bidSum: number
  netSum: number
}

const newTally = (): OutcomeTally => ({ n: 0, made: 0, set: 0, conceded: 0, autoSet: 0, bidSum: 0, netSum: 0 })

function addOutcome(t: OutcomeTally, r: TracedRound): void {
  t.n++
  t[r.outcome]++
  t.bidSum += r.bid
  t.netSum += r.bidderNet
}

/** A 2x2 of the shipped verdict against the static constant's. */
export interface Agreement {
  both: number
  policyOnly: number
  staticOnly: number
  neither: number
}

export interface GateReport {
  rounds: number
  decisions: number
  mismatches: number
  branchCounts: Record<string, number>
  outcomesBySource: Record<string, OutcomeTally>
  /** Same, split by the winner's own ceiling band (`CEILING_BANDS`). */
  outcomesBySourceBand: Record<string, Record<string, OutcomeTally>>
  overall: OutcomeTally
  opener: {
    arrivals: number
    agreement: Agreement
    /** Ceilings within 20 of OPENER_THRESHOLD, i.e. [300, 340). */
    near: number
    /** Outcomes of contracts the policy opened, split by ceiling vs 320. */
    contractsBelow: OutcomeTally
    contractsAtOrAbove: OutcomeTally
    /** Open level distribution: how many opens named each level. */
    openLevels: Record<number, number>
  }
  thirdBidder: { arrivals: number; policyOpened: number; positional: number; declined: number; near: number; firedBands: Record<string, number> }
  push: { arrivals: number; fired: number; agreement: Agreement; near: number; currentBids: Record<number, number> }
  endgame: { decisions: number; rescueSituations: number; rescued: number; gated: number; near: number }
  partnerPassed: { opensAsked: number; opensAllowed: number; ladderAsked: number; ladderAllowed: number; ladderGated: number; gatedNear: number }
  partnerRaise: { arrivals: number; allowed: number; gated: number; near: number; gatedBands: Record<string, number> }
}

/** Winner-ceiling bands for the outcome split. */
export const CEILING_BANDS: readonly number[] = [200, 260, 320, 380]

const within = (x: number, t: number, w = 20) => x >= t - w && x < t + w

function band(x: number, edges: readonly number[]): string {
  for (let i = 0; i < edges.length - 1; i++) if (x >= edges[i] && x < edges[i + 1]) return `${edges[i]}-${edges[i + 1] - 1}`
  return x < edges[0] ? `<${edges[0]}` : `${edges[edges.length - 1]}+`
}

export function aggregate(rounds: readonly TracedRound[]): GateReport {
  const agreement = (): Agreement => ({ both: 0, policyOnly: 0, staticOnly: 0, neither: 0 })
  const tally = (a: Agreement, p: boolean, s: boolean) => {
    if (p && s) a.both++
    else if (p) a.policyOnly++
    else if (s) a.staticOnly++
    else a.neither++
  }
  const r: GateReport = {
    rounds: rounds.length,
    decisions: 0,
    mismatches: 0,
    branchCounts: {},
    outcomesBySource: {},
    outcomesBySourceBand: {},
    overall: newTally(),
    opener: { arrivals: 0, agreement: agreement(), near: 0, contractsBelow: newTally(), contractsAtOrAbove: newTally(), openLevels: {} },
    thirdBidder: { arrivals: 0, policyOpened: 0, positional: 0, declined: 0, near: 0, firedBands: {} },
    push: { arrivals: 0, fired: 0, agreement: agreement(), near: 0, currentBids: {} },
    endgame: { decisions: 0, rescueSituations: 0, rescued: 0, gated: 0, near: 0 },
    partnerPassed: { opensAsked: 0, opensAllowed: 0, ladderAsked: 0, ladderAllowed: 0, ladderGated: 0, gatedNear: 0 },
    partnerRaise: { arrivals: 0, allowed: 0, gated: 0, near: 0, gatedBands: {} },
  }

  for (const round of rounds) {
    addOutcome(r.overall, round)
    addOutcome((r.outcomesBySource[round.source] ??= newTally()), round)
    if (round.winnerCeiling !== null) {
      const bands = (r.outcomesBySourceBand[round.source] ??= {})
      addOutcome((bands[band(round.winnerCeiling, CEILING_BANDS)] ??= newTally()), round)
    }
    const winningOpen = round.source === 'open'
    for (const d of round.decisions) {
      const t = d.trace
      r.decisions++
      if (t.decision !== d.played) r.mismatches++
      r.branchCounts[t.branch] = (r.branchCounts[t.branch] ?? 0) + 1

      const isOpenTier = t.branch === 'open' || t.branch === 'open-decline' || t.branch.startsWith('third-')
      if (isOpenTier) {
        r.opener.arrivals++
        tally(r.opener.agreement, t.policyVerdict === true, t.staticVerdict === true)
        if (within(t.ceiling, OPENER_THRESHOLD)) r.opener.near++
        if (t.branch === 'open' && t.decision !== null) r.opener.openLevels[t.decision] = (r.opener.openLevels[t.decision] ?? 0) + 1
        if (t.partnerPassed) {
          r.partnerPassed.opensAsked++
          if (t.branch === 'open') r.partnerPassed.opensAllowed++
        }
      }
      if (d.passesSoFar === 2 && isOpenTier) {
        r.thirdBidder.arrivals++
        if (t.branch === 'open') r.thirdBidder.policyOpened++
        if (t.branch === 'third-positional') {
          r.thirdBidder.positional++
          const b = band(t.ceiling, [200, 260, 320])
          r.thirdBidder.firedBands[b] = (r.thirdBidder.firedBands[b] ?? 0) + 1
        }
        if (t.branch === 'third-decline') r.thirdBidder.declined++
        if (t.branch !== 'open' && within(t.ceiling, THIRD_BIDDER_FLOOR)) r.thirdBidder.near++
      }
      if (t.pushConsidered) {
        r.push.arrivals++
        r.push.currentBids[d.currentBid] = (r.push.currentBids[d.currentBid] ?? 0) + 1
        if (t.branch === 'push') r.push.fired++
        tally(r.push.agreement, t.policyVerdict === true, t.staticVerdict === true)
        if (within(t.ceiling, DEFENSIVE_PUSH_FLOOR)) r.push.near++
      }
      if (t.branch.startsWith('endgame')) {
        r.endgame.decisions++
        if (t.branch !== 'endgame-pass') {
          r.endgame.rescueSituations++
          if (t.branch === 'endgame-rescue') r.endgame.rescued++
          else r.endgame.gated++
          if (within(t.ceiling, ENDGAME_RESCUE_CEILING)) r.endgame.near++
        }
      }
      if (t.branch === 'partner-passed-floor' || t.branch === 'partner-passed-gated') {
        r.partnerPassed.ladderAsked++
        if (t.branch === 'partner-passed-floor') r.partnerPassed.ladderAllowed++
        else {
          r.partnerPassed.ladderGated++
          if (t.competitiveCeiling >= PARTNER_PASSED_FLOOR - 20) r.partnerPassed.gatedNear++
        }
      }
      if (t.branch === 'partner-raise' || t.branch === 'partner-raise-gated') {
        r.partnerRaise.arrivals++
        if (t.branch === 'partner-raise') r.partnerRaise.allowed++
        else {
          r.partnerRaise.gated++
          const b = band(t.ceiling, [300, 320, 340])
          r.partnerRaise.gatedBands[b] = (r.partnerRaise.gatedBands[b] ?? 0) + 1
        }
        if (within(t.ceiling, PARTNER_RAISE_FLOOR)) r.partnerRaise.near++
      }
    }
    // Attribute an opened contract to the opener's ceiling band.
    if (winningOpen) {
      const opener = round.decisions.find((d) => d.trace.branch === 'open' && d.played !== null)
      if (opener) addOutcome(opener.trace.ceiling >= OPENER_THRESHOLD ? r.opener.contractsAtOrAbove : r.opener.contractsBelow, round)
    }
  }
  return r
}

// -- Formatting --------------------------------------------------------------

const pct = (a: number, b: number) => (b === 0 ? '-' : `${((100 * a) / b).toFixed(1)}%`)

function outcomeRow(label: string, t: OutcomeTally, total: number): string {
  if (t.n === 0) return `| ${label} | 0 | - | - | - | - | - | - | - |`
  return (
    `| ${label} | ${t.n} | ${pct(t.n, total)} | ${(t.bidSum / t.n).toFixed(0)} | ${pct(t.made, t.n)} | ` +
    `${pct(t.set, t.n)} | ${pct(t.conceded, t.n)} | ${pct(t.autoSet, t.n)} | ${(t.netSum / t.n).toFixed(0)} |`
  )
}

function agreementLine(a: Agreement, policyName: string, staticName: string): string {
  const n = a.both + a.policyOnly + a.staticOnly + a.neither
  return (
    `both yes ${a.both} (${pct(a.both, n)}), ${policyName} only ${a.policyOnly} (${pct(a.policyOnly, n)}), ` +
    `${staticName} only ${a.staticOnly} (${pct(a.staticOnly, n)}), both no ${a.neither} (${pct(a.neither, n)})`
  )
}

export function formatGateReport(r: GateReport, header = ''): string {
  const lines: string[] = []
  if (header) lines.push(header, '')
  lines.push(
    `${r.rounds} contracts, ${r.decisions} auction decisions; classifier/chooseBid mismatches: ${r.mismatches}`,
    '',
    '### Contracts by the gate that produced the winning bid',
    '',
    '| source | n | share | mean bid | made | set | folded | auto-set | bidder net |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  )
  const sources = Object.keys(r.outcomesBySource).sort((a, b) => r.outcomesBySource[b].n - r.outcomesBySource[a].n)
  for (const s of sources) lines.push(outcomeRow(s, r.outcomesBySource[s], r.rounds))
  lines.push(outcomeRow('**all**', r.overall, r.rounds))
  lines.push(
    '',
    "### The same, split by the winner's own ceiling",
    '',
    '| source / winner ceiling | n | share of source | mean bid | made | set | folded | auto-set | bidder net |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  )
  for (const s of sources) {
    const bands = r.outcomesBySourceBand[s]
    if (bands === undefined) continue
    const total = r.outcomesBySource[s].n
    const order = (k: string) => (k.startsWith('<') ? -1 : Number.parseInt(k, 10))
    for (const b of Object.keys(bands).sort((x, y) => order(x) - order(y))) lines.push(outcomeRow(`${s} / ${b}`, bands[b], total))
  }

  const o = r.opener
  lines.push(
    '',
    `### OPENER_THRESHOLD (${OPENER_THRESHOLD}) — not consulted by the shipped (distilled) opener`,
    '',
    `- ${o.arrivals} opening decisions; ceiling in [300, 340): ${o.near} (${pct(o.near, o.arrivals)})`,
    `- evaluator vs \`ceiling >= ${OPENER_THRESHOLD}\`: ${agreementLine(o.agreement, 'evaluator', 'threshold')}`,
    `- open levels named: ${Object.entries(o.openLevels).map(([k, v]) => `${k}: ${v}`).join(', ')}`,
    '',
    '| opened contracts | n | share | mean bid | made | set | folded | auto-set | bidder net |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    outcomeRow(`ceiling < ${OPENER_THRESHOLD}`, o.contractsBelow, o.contractsBelow.n + o.contractsAtOrAbove.n),
    outcomeRow(`ceiling >= ${OPENER_THRESHOLD}`, o.contractsAtOrAbove, o.contractsBelow.n + o.contractsAtOrAbove.n),
  )

  const t = r.thirdBidder
  lines.push(
    '',
    `### THIRD_BIDDER_FLOOR (${THIRD_BIDDER_FLOOR})`,
    '',
    `- ${t.arrivals} third-seat arrivals with no bid: evaluator opened ${t.policyOpened}, positional open fired ${t.positional} (${pct(t.positional, t.arrivals)}), declined ${t.declined}`,
    `- positional opens by ceiling: ${Object.entries(t.firedBands).map(([k, v]) => `${k}: ${v}`).join(', ')}`,
    `- non-opening hands within 20 of the floor: ${t.near}`,
  )

  const p = r.push
  lines.push(
    '',
    `### DEFENSIVE_PUSH_FLOOR (${DEFENSIVE_PUSH_FLOOR}) — not consulted by the shipped (distilled) push`,
    '',
    `- ${p.arrivals} arrivals facing an opponent bid <= ${OPENING_BID} (current bid: ${Object.entries(p.currentBids).map(([k, v]) => `${k}: ${v}`).join(', ')}); push fired ${p.fired} (${pct(p.fired, p.arrivals)})`,
    `- evaluator vs \`ceiling >= ${DEFENSIVE_PUSH_FLOOR}\`: ${agreementLine(p.agreement, 'evaluator', 'floor')}`,
    `- ceiling within 20 of the floor: ${p.near}`,
  )

  const e = r.endgame
  lines.push(
    '',
    `### ENDGAME_RESCUE_CEILING (${ENDGAME_RESCUE_CEILING})`,
    '',
    `- ${e.decisions} decisions under endgame protection; ${e.rescueSituations} rescue situations (partner dealing, opponent before me passed): rescued ${e.rescued}, gated ${e.gated}; within 20 of the ceiling ${e.near}`,
  )

  const pp = r.partnerPassed
  lines.push(
    '',
    `### PARTNER_PASSED_FLOOR (${PARTNER_PASSED_FLOOR})`,
    '',
    `- opening with partner out (evaluator asked at the floor): ${pp.opensAsked}, opened ${pp.opensAllowed} (${pct(pp.opensAllowed, pp.opensAsked)})`,
    `- ladder jump to the floor over an opponent: ${pp.ladderAsked} arrivals, bid ${pp.ladderAllowed}, gated ${pp.ladderGated} (gated with competitive ceiling in [300, 320): ${pp.gatedNear})`,
  )

  const pr = r.partnerRaise
  lines.push(
    '',
    `### PARTNER_RAISE_FLOOR (${PARTNER_RAISE_FLOOR})`,
    '',
    `- ${pr.arrivals} arrivals over own partner's raise: raised ${pr.allowed} (${pct(pr.allowed, pr.arrivals)}), gated ${pr.gated}; within 20 of the floor ${pr.near}`,
    `- gated by ceiling: ${Object.entries(pr.gatedBands).map(([k, v]) => `${k}: ${v}`).join(', ')}`,
    '',
    '### Every decision by branch',
    '',
    Object.entries(r.branchCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${v} (${pct(v, r.decisions)})`)
      .join(', '),
  )
  return lines.join('\n')
}
