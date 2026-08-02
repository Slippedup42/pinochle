import type { Card } from '../engine/card'
import { sortHandForDisplay } from '../engine/card'
import { splitHandIntoRows } from './handRows'
import { PlayingCard } from './PlayingCard'
import type { SeatPosition, SeatState } from './tableTypes'

export interface SeatProps {
  seat: SeatState
  position: SeatPosition
  isHuman: boolean
  isBidWinner: boolean
  isDealer: boolean
  /** Trick-play (#35): legal cards for the human's turn to play, and the
   * callback to fire on a legal card's click/tap. Legal cards render
   * highlighted and clickable; illegal ones render dimmed and disabled.
   * Omit entirely to render the hand as plain, non-interactive cards (the
   * auction phases, or any AI seat). */
  playable?: { legalCards: readonly Card[]; onPlay: (card: Card) => void }
  /** Meld phase (#??): when true, a non-human seat renders its cards face-up
   * (meld cards laid on the table) instead of just its name/card count. Meld
   * is public information in Pinochle — it is laid down for everyone to see —
   * so this is a rules requirement, not a display preference. */
  exposeCards?: boolean
}

const POSITION_LAYOUT: Record<SeatPosition, string> = {
  bottom: 'flex-col items-center',
  top: 'flex-col-reverse items-center',
  left: 'flex-col items-center',
  right: 'flex-col items-center',
}

/**
 * One seat at the table. The human seat renders its full hand face-up with
 * the real `PlayingCard` component. AI seats render no fan at all (#142) —
 * just the name and card count in the header, which is the public
 * information a player needs to track how many tricks are left. The one
 * exception is `exposeCards` during the meld phase, where an AI's cards are
 * laid face-up because meld is public.
 */
export function Seat({ seat, position, isHuman, isBidWinner, isDealer, playable, exposeCards }: SeatProps) {
  return (
    <div className={`flex gap-1 ${POSITION_LAYOUT[position]}`}>
      {/* Wraps and breaks (#161): the left/right seats live in columns that are
          allowed to fall to zero width, and a nowrap header of "Beauregard" +
          badges + "12 cards" would otherwise set a min-content floor under the
          column and widen the whole board on a phone. */}
      <div className="flex flex-wrap items-center justify-center gap-x-2 text-center text-sm font-medium [overflow-wrap:anywhere]">
        <span>{seat.name}</span>
        {isDealer && (
          <span className="rounded bg-neutral-700/80 px-1.5 py-0.5 text-xs font-bold text-amber-300">
            D
          </span>
        )}
        {isBidWinner && (
          <span className="rounded bg-amber-500/90 px-1.5 py-0.5 text-xs font-semibold text-amber-950">
            Bid
          </span>
        )}
        {!isHuman && (
          <span className="text-xs text-white/70">{seat.hand.length} cards</span>
        )}
      </div>
      {seat.statusText && (
        <div className="text-xs text-white/60">{seat.statusText}</div>
      )}
      {isHuman ? (
        // Explicit rows, never `flex-wrap` (#187, and the #161 note it replaces).
        // The fanned-overlap look relies on `first:ml-0` to zero the leading
        // card's negative margin, and `first:` only matches the first child of
        // its own container — under `flex-wrap` a visual second row is still mid-
        // list in the DOM, so its leading card kept the negative margin and hung
        // left of the row above it. Giving each row its own flex container is
        // what makes `first:` mean "first of this row" and the two line up.
        //
        // Pitch is `card + gap + margin = 64 + 4 - 24 = 44px`, so six cards span
        // `5 * 44 + 64 = 284px` — inside the ~304px a 320px viewport leaves after
        // the board's padding, and comfortably inside a 390px phone. The reveal
        // goes from 24px (a corner index) to 44px (most of the card).
        //
        // The overlap is paired with the card width: change `w-16` on
        // `PlayingCard` without changing `-ml-6` here and this either re-overflows
        // or buries the indices again.
        //
        // `w-full` is what makes `overflow-x-auto` mean anything — it resolves
        // against the seat's stretched width (Table.tsx) so a row is as wide as
        // the column and scrolls, instead of sizing itself to its cards. It is a
        // backstop now rather than the mechanism: at 320px and up nothing scrolls.
        <div className="flex w-full flex-col items-center gap-1">
          {splitHandIntoRows(sortHandForDisplay(seat.hand)).map((row, rowIndex) => (
            <div key={rowIndex} className="flex w-full justify-center gap-1 overflow-x-auto">
              {row.map((card) => {
                const cardFace = <PlayingCard suit={card.suit} rank={card.rank} />
                if (!playable) {
                  return (
                    <div key={card.toString()} className="-ml-6 first:ml-0">
                      {cardFace}
                    </div>
                  )
                }
                const isLegal = playable.legalCards.includes(card)
                return (
                  <button
                    key={card.toString()}
                    type="button"
                    disabled={!isLegal}
                    onClick={() => playable.onPlay(card)}
                    aria-label={`Play ${card.rank} of ${card.suit}`}
                    className={`-ml-6 first:ml-0 rounded-lg transition-transform ${
                      isLegal
                        ? 'cursor-pointer ring-2 ring-amber-400 hover:-translate-y-2'
                        : 'cursor-not-allowed opacity-40'
                    }`}
                  >
                    {cardFace}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      ) : exposeCards ? (
        <div className="flex w-full justify-center gap-1 overflow-x-auto">
          {/* Same 24px reveal as the human fan above, against a 48px `md` card. */}
          {sortHandForDisplay(seat.hand).map((card, i) => (
            <div key={i} className="-ml-7 first:ml-0">
              <PlayingCard suit={card.suit} rank={card.rank} size="md" />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
