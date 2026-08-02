import { useMemo } from 'react'
import { type Suit, sortHandForDisplay } from '../engine/card'
import { extractMeldCards, type MeldCardsResult } from '../engine/melds'
import { teamOf, type Hands, type TeamId } from '../engine/round'
import type { PlayerIndex } from '../engine/trick'
import { PlayingCard } from './PlayingCard'
import { DEFAULT_TEAM_NAMES } from './scoreTypes'
import { Table } from './Table'
import type { TableState } from './tableTypes'

export interface MeldFlowProps {
  hands: Hands
  trumpSuit: Suit
  bidWinner: PlayerIndex
  bid: number
  seatNames: Record<PlayerIndex, string>
  humanPlayer: PlayerIndex
  scoresByTeam: Record<TeamId, number>
  teamNames?: Record<TeamId, string>
  dealer: PlayerIndex
  onOpenMenu?: () => void
  onComplete: (meldPointsByTeam: Record<TeamId, number>) => void
  onConcede?: () => void
}

function MeldGroupList({ groups }: { groups: MeldCardsResult['groups'] }) {
  return (
    <div className="mt-1 space-y-1.5">
      {groups.map((g, i) => (
        <div key={i} className="text-xs">
          <div className="flex items-baseline gap-1.5">
            <span className="text-neutral-500">{g.name}</span>
            <span className="font-semibold">{g.points}</span>
          </div>
          <div className="mt-0.5 flex flex-wrap gap-0.5">
            {sortHandForDisplay(g.cards).map((c, j) => (
              <PlayingCard key={j} suit={c.suit} rank={c.rank} size="sm" />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

/** One team's column: both partners' melds, stacked under the team total. */
function TeamMeldColumn({
  teamName,
  total,
  players,
  seatNames,
  humanPlayer,
  meldFor,
}: {
  teamName: string
  total: number
  players: readonly PlayerIndex[]
  seatNames: Record<PlayerIndex, string>
  humanPlayer: PlayerIndex
  meldFor: (p: PlayerIndex) => MeldCardsResult
}) {
  return (
    <section className="min-w-0" aria-label={`${teamName} meld`}>
      <h4 className="flex items-baseline justify-between gap-2 border-b border-neutral-300 pb-1 text-sm font-bold">
        <span className="truncate">{teamName}</span>
        <span className="shrink-0 text-green-700">{total}</span>
      </h4>
      {players.map((p) => {
        const md = meldFor(p)
        const playerTotal = md.groups.reduce((s, g) => s + g.points, 0)
        return (
          <div key={p} className="mt-2">
            <p className="flex items-baseline justify-between gap-2 text-xs font-semibold text-neutral-700">
              <span className="truncate">
                {seatNames[p]}
                {p === humanPlayer && ' (you)'}
              </span>
              <span className="shrink-0 text-neutral-500">{playerTotal}</span>
            </p>
            {md.groups.length > 0 ? (
              <MeldGroupList groups={md.groups} />
            ) : (
              <p className="mt-0.5 text-xs text-neutral-400">No melds</p>
            )}
          </div>
        )
      })}
    </section>
  )
}

export function MeldFlow({
  hands,
  trumpSuit,
  bidWinner,
  bid,
  seatNames,
  humanPlayer,
  scoresByTeam,
  teamNames = DEFAULT_TEAM_NAMES,
  dealer,
  onOpenMenu,
  onComplete,
  onConcede,
}: MeldFlowProps) {
  const allMeldData = useMemo(() => {
    const result: Record<PlayerIndex, MeldCardsResult> = {} as Record<PlayerIndex, MeldCardsResult>
    for (let i = 0; i < 4; i++) {
      const player = i as PlayerIndex
      result[player] = extractMeldCards(hands[player], trumpSuit)
    }
    return result
  }, [hands, trumpSuit])

  const humanMeld = allMeldData[humanPlayer]

  const allMeldPoints = useMemo(() => {
    const byTeam: Record<TeamId, number> = { 0: 0, 1: 0 }
    for (let i = 0; i < 4; i++) {
      const player = i as PlayerIndex
      const { meldCards: _mc, groups } = allMeldData[player]
      byTeam[teamOf(player)] += groups.reduce((s, g) => s + g.points, 0)
    }
    return byTeam
  }, [allMeldData])

  const tableState: TableState = useMemo(() => {
    const seatFor = (p: PlayerIndex) => ({
      player: p,
      name: seatNames[p],
      hand: p === humanPlayer ? hands[p] : allMeldData[p].meldCards,
    })
    return {
      seats: [seatFor(0), seatFor(1), seatFor(2), seatFor(3)],
      humanPlayer,
      trick: [],
      trumpSuit,
      currentBid: bid,
      bidWinner,
      scoresByTeam,
      teamNames,
      dealer,
      meldPoints: allMeldPoints[teamOf(bidWinner)],
    }
  }, [hands, allMeldData, seatNames, humanPlayer, trumpSuit, bid, bidWinner, scoresByTeam, teamNames, allMeldPoints, dealer])

  const humanTotal = humanMeld.groups.reduce((s, g) => s + g.points, 0)

  // Two columns, one per team (#94). The meld list scrolls inside the panel
  // rather than growing it, so the panel always fits the viewport and the
  // Continue/Fold buttons stay reachable — previously four stacked players
  // pushed the panel to roughly twice the screen height and put Continue
  // off-screen entirely.
  const overlay = (
    // The Table overlay wrapper is inline-block, so it shrink-wraps its child
    // and `w-full max-w-*` would collapse to the intrinsic width. Give the
    // panel a definite width instead, clamped to the viewport on small screens.
    <div className="flex max-h-[85vh] w-[min(44rem,calc(100vw-2rem))] flex-col rounded-lg bg-white p-4 text-neutral-900 shadow-xl">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-base font-bold">Meld Declaration</h3>
        <p className="text-sm text-neutral-600">
          Your melds: <span className="font-bold text-green-700">{humanTotal}</span>
        </p>
      </div>

      <div className="mt-3 grid min-h-0 flex-1 grid-cols-2 gap-x-4 gap-y-2 overflow-y-auto">
        {([0, 1] as TeamId[]).map((team) => (
          <TeamMeldColumn
            key={team}
            teamName={teamNames[team]}
            total={allMeldPoints[team]}
            players={([0, 1, 2, 3] as PlayerIndex[]).filter((p) => teamOf(p) === team)}
            seatNames={seatNames}
            humanPlayer={humanPlayer}
            meldFor={(p) => allMeldData[p]}
          />
        ))}
      </div>

      <div className="mt-4 flex shrink-0 gap-2">
        <button
          type="button"
          onClick={() => onComplete(allMeldPoints)}
          className="flex-1 rounded bg-green-800 px-4 py-2 font-semibold text-white hover:bg-green-900"
        >
          Continue
        </button>
        {onConcede && bidWinner === humanPlayer && (
          <button
            type="button"
            onClick={onConcede}
            className="rounded bg-red-800 px-4 py-2 font-semibold text-white hover:bg-red-900"
          >
            Fold
          </button>
        )}
      </div>
    </div>
  )

  return (
    <Table
      state={tableState}
      overlay={overlay}
      onOpenMenu={onOpenMenu}
      exposeCards
    />
  )
}
