import { useEffect, useRef } from 'react'
import type { TeamId } from '../engine/round'
import type { HandLedgerEntry } from './scoreTypes'
import { RED_SUITS, SUIT_GLYPH } from './suitGlyphs'

export interface HandLedgerProps {
  entries: readonly HandLedgerEntry[]
  teamNames: Record<TeamId, string>
}

const TEAM_IDS: readonly TeamId[] = [0, 1]

/** `+260` / `-340` — the sign is the whole point of this table, so a
 * positive delta carries an explicit `+` rather than a bare number. */
function formatDelta(points: number): string {
  return points > 0 ? `+${points}` : String(points)
}

/**
 * Hand-by-hand game ledger (#198), shown under the round-summary and
 * game-over screens: one row per completed hand with who bid what, each
 * team's delta for that hand, and their running total afterward. The two
 * screens above it only ever show one round's numbers and the current
 * totals — this is the answer to "we played 6 hands, up, down, up, up,
 * down, up", which neither of them could give.
 *
 * Scrolls rather than growing: a game to 1000 usually takes 4-8 hands but
 * has no bound, and both screens are fixed overlays on a phone. The body
 * is capped and auto-scrolled to the bottom so the hand just played — the
 * one the surrounding screen is about — is what's on screen when it opens,
 * with the earlier hands a scroll up.
 *
 * Renders nothing before the first hand completes, so a caller can pass its
 * ledger unconditionally.
 */
export function HandLedger({ entries, teamNames }: HandLedgerProps) {
  const scrollRef = useRef<HTMLDivElement>(null)

  // Pin to the latest hand (see above). Depends on the count, not the
  // array identity, so a re-render with an equivalent-but-new array doesn't
  // yank a player's scroll position back down while they're reading up.
  const handCount = entries.length
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [handCount])

  if (handCount === 0) return null

  return (
    <div className="mt-4 text-left">
      <h3 className="text-sm font-semibold text-neutral-900">Game ledger</h3>
      {/* max-h-48 fits about 6 hands — a typical game to 1000 — without
          scrolling, so the scroll only appears once a game runs long. */}
      <div ref={scrollRef} className="mt-1 max-h-48 overflow-y-auto rounded border border-neutral-200">
        <table className="w-full text-xs">
          <caption className="sr-only">
            Every hand played this game: the bid, each team&apos;s points for the hand, and their running total.
          </caption>
          <thead>
            {/* Sticky inside the scroll box above — with 8 hands on screen
                the team names would otherwise scroll away from the columns
                they label. */}
            <tr className="sticky top-0 bg-neutral-100 text-left text-neutral-500">
              <th scope="col" className="px-2 py-1 font-medium">
                #
              </th>
              {TEAM_IDS.map((team) => (
                <th key={team} scope="col" className="px-2 py-1 font-medium text-neutral-900">
                  {teamNames[team]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.hand} className="border-t border-neutral-200">
                <th scope="row" className="px-2 py-1 text-left font-normal text-neutral-500">
                  {entry.hand}
                </th>
                {TEAM_IDS.map((team) => {
                  const delta = entry.roundScoreByTeam[team]
                  return (
                    <td key={team} className="px-2 py-1 whitespace-nowrap">
                      {/* The bid rides in the bidding team's own column, so
                          who bid is readable without a separate column and
                          a name to abbreviate (team names run long — see
                          teamNames.ts's pool). */}
                      {team === entry.bidWinnerTeam && (
                        <span className="mr-1 text-neutral-500">
                          {entry.bid}
                          <span className={RED_SUITS.includes(entry.trumpSuit) ? 'text-red-600' : 'text-neutral-900'}>
                            {SUIT_GLYPH[entry.trumpSuit]}
                          </span>
                        </span>
                      )}
                      {/* Space, not just the margin above: without it the bid
                          and the delta run together as one word for a screen
                          reader ("250♠+280"). */}
                      {team === entry.bidWinnerTeam && ' '}
                      <span className={delta < 0 ? 'font-semibold text-red-700' : 'font-semibold text-green-700'}>
                        {formatDelta(delta)}
                      </span>{' '}
                      <span className="text-neutral-600">{entry.cumulativeScoresByTeam[team]}</span>
                      {team === entry.bidWinnerTeam && entry.wentSet && (
                        <span className="text-red-700"> {entry.conceded ? '(folded)' : '(set)'}</span>
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
