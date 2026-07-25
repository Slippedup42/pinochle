import { useMemo } from 'react'
import { type Suit, sortHandForDisplay } from '../engine/card'
import { extractMeldCards, type MeldCardsResult } from '../engine/melds'
import { teamOf, type Hands, type TeamId } from '../engine/round'
import type { PlayerIndex } from '../engine/trick'
import { DEFAULT_OPTIONS, type GameOptions } from '../persistence/options'
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
  options?: GameOptions
  onComplete: (meldPointsByTeam: Record<TeamId, number>) => void
  onConcede?: () => void
}

function MeldGroupList({ groups }: { groups: MeldCardsResult['groups'] }) {
  return (
    <div className="mt-1 space-y-1">
      {groups.map((g, i) => (
        <div key={i} className="flex items-center gap-2 text-sm">
          <span className="text-neutral-500">{g.name}:</span>
          <span className="font-semibold">{g.points}</span>
          <div className="flex gap-0.5">
            {sortHandForDisplay(g.cards).map((c, j) => (
              <PlayingCard key={j} suit={c.suit} rank={c.rank} className="w-6" />
            ))}
          </div>
        </div>
      ))}
    </div>
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
  options = DEFAULT_OPTIONS,
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

  const overlay = (
    <div className="w-full max-w-sm rounded-lg bg-white p-5 text-neutral-900 shadow-xl">
      <h3 className="text-base font-bold">Meld Declaration</h3>

      <p className="mt-2 text-sm text-neutral-600">
        Your melds: <span className="font-bold text-green-700">{humanTotal}</span> points
      </p>
      {humanMeld.groups.length > 0 ? (
        <div className="mt-2">
          <MeldGroupList groups={humanMeld.groups} />
        </div>
      ) : (
        <p className="mt-2 text-sm text-neutral-500">No melds detected in your hand.</p>
      )}

      {[0, 1, 2, 3]
        .filter((p) => p !== humanPlayer)
        .map((p) => {
          const md = allMeldData[p as PlayerIndex]
          return (
            <div key={p} className="mt-4 border-t border-neutral-200 pt-3">
              <p className="text-sm font-semibold text-neutral-700">
                {seatNames[p as PlayerIndex]} — {md.groups.reduce((s, g) => s + g.points, 0)} meld points
              </p>
              {md.groups.length > 0 ? (
                <MeldGroupList groups={md.groups} />
              ) : (
                <p className="text-sm text-neutral-500">No melds</p>
              )}
            </div>
          )
        })}

      <div className="mt-5 flex gap-2">
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
      hideOpponentCards={options.hideOpponentCards}
      exposeCards
    />
  )
}
