import type { PlayerIndex, TrickPlay } from '../engine/trick'
import { PlayingCard } from './PlayingCard'
import { seatPosition, type SeatPosition } from './tableTypes'

export interface TrickAreaProps {
  trick: readonly TrickPlay[]
  humanPlayer: PlayerIndex
  /** Trick-play (#35): highlights the just-completed trick's winning card
   * while it settles, before TrickPlayFlow clears it for the next trick.
   * null/undefined outside that pause (nothing highlighted). */
  winningPlayer?: PlayerIndex | null
  /** Trick counter display: e.g. 1-based trick number so "Trick 3 of 12"
   * renders above the trick circle. Omitted outside trick-play. */
  trickNumber?: number
}

const POSITION_CLASS: Record<SeatPosition, string> = {
  top: 'col-start-2 row-start-1',
  left: 'col-start-1 row-start-2',
  right: 'col-start-3 row-start-2',
  bottom: 'col-start-2 row-start-3',
}

/**
 * Center-of-table area: the cards played so far in the current trick,
 * each placed on the side of the center matching its player's seat. Empty
 * until a seat has played, so a trick in progress shows 1-3 cards and a
 * completed-but-not-yet-cleared trick shows all 4.
 */
export function TrickArea({ trick, humanPlayer, winningPlayer, trickNumber }: TrickAreaProps) {
  return (
    <div className="flex flex-col items-center gap-1">
      {trickNumber !== undefined && (
        <span className="text-xs font-semibold text-white/70">Trick {trickNumber} of 12</span>
      )}
      {/* 13rem (208px) rather than the old 18rem (288px), which was 74% of a
          390px phone viewport on its own and left ~100px for the two side
          seats put together (#161). The old `min-h-[12rem]` is gone with it: it
          existed to stop `max-w-full` collapsing the circle on a narrow screen,
          but it did that by letting the box go taller than it is wide — at 208
          the aspect ratio holds the height on its own, and a floor above the
          width would only re-introduce a non-circular circle.

          208 was three 64px cards across. The cards are 80px now, so three of
          them are 240 and each of the four played cards, centred in a 69px
          column, hangs 5px past the circle. **That is deliberate, and 15rem was
          measured and rejected.** The board is `1fr auto 1fr` rows (#187), so
          the top row mirrors the bottom seat's height; with a two-row 80px hand
          that already spends 844px of a 390x844 phone exactly, and widening the
          circle to 240 pushed the board to 858 and started it scrolling
          vertically. A 5px overhang on a felt circle is a cosmetic rounding; a
          hand you have to scroll to see is the bug #187 just fixed.

          The overhang is bounded and does not collide: at 390px the side seat
          columns end at 83 and start at 307, and the outermost card edges land
          at 85.7 and 304.3. Re-measure both if the card width, the column cap,
          or the board gutters change. */}
      <div className="grid aspect-square w-52 max-w-full grid-cols-3 grid-rows-3 items-center justify-items-center rounded-full bg-green-950/40">
      {trick.map((play) => (
        <div
          key={play.player}
          className={`rounded-lg ${POSITION_CLASS[seatPosition(play.player, humanPlayer)]} ${
            play.player === winningPlayer ? 'ring-4 ring-amber-400' : ''
          }`}
        >
          <PlayingCard suit={play.card.suit} rank={play.card.rank} />
        </div>
      ))}
    </div>
    </div>
  )
}
