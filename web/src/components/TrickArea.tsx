import type { PlayerIndex, TrickPlay } from '../engine/trick'
import { PlayingCard } from './PlayingCard'
import { seatPosition, type SeatCall, type SeatPosition } from './tableTypes'

/** One seat's auction call, placed on the board the same way a played card is. */
export interface SeatCallAt {
  readonly player: PlayerIndex
  readonly name: string
  readonly call: SeatCall
}

/**
 * The call as a phrase, for the accessible name.
 *
 * Rendered, a call is a bare "300" or "PASS" whose meaning comes entirely from
 * *where on the circle it sits* — which is exactly the information that does not
 * survive being read aloud.
 *
 * `name: call` rather than `formatAuctionLogEntry`'s "West bid 320" sentence,
 * because the human's seat is literally named **"You"** and two of these four
 * cases need a copula: "You is waiting" and "You is deciding". Reaching for
 * "are" on one name is a special case waiting to break on the next one, and the
 * mixed alternative ("You passed" but "Waiting: You") is worse to listen to. The
 * colon form is grammatical for every seat name including that one, and reads as
 * the label it is.
 */
function describeCall(name: string, call: SeatCall): string {
  switch (call.kind) {
    case 'bid':
      return `${name}: bid ${call.amount}`
    case 'pass':
      return `${name}: passed`
    case 'turn':
      return `${name}: to bid`
    case 'waiting':
      return `${name}: waiting`
  }
}

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
  /** Auction (#191): each seat's call, placed at that seat's side of the circle
   * exactly as `trick` places its cards. Omitted outside the auction, where
   * `trick` occupies the same cells. */
  calls?: readonly SeatCallAt[]
}

const POSITION_CLASS: Record<SeatPosition, string> = {
  top: 'col-start-2 row-start-1',
  left: 'col-start-1 row-start-2',
  right: 'col-start-3 row-start-2',
  bottom: 'col-start-2 row-start-3',
}

/**
 * One seat's call, sized by what it is rather than uniformly (#191).
 *
 * A bid is the only one that carries a number, so it gets the weight: it is the
 * thing a player is actually tracking, and at `text-3xl` a three-digit bid is
 * ~55px inside a ~69px cell. Pass and waiting are deliberately quieter and in
 * two different registers — a pass is a decision and stays legible in white, a
 * wait is the absence of one and recedes to 45% — so the board can be read at a
 * glance for "who is still in" without reading any words.
 *
 * Nothing here animates. The seat being asked shows a static ellipsis rather
 * than a pulsing one: the auction already paces itself at `AI_BID_DELAY_MS`, and
 * a second moving thing on a board that is otherwise still reads as a bug.
 */
function CallLabel({ call }: { call: SeatCall }) {
  switch (call.kind) {
    case 'bid':
      return (
        <span className="text-3xl leading-none font-extrabold text-amber-300 tabular-nums drop-shadow">
          {call.amount}
        </span>
      )
    case 'pass':
      return <span className="text-xl leading-none font-bold tracking-wide text-white/80">PASS</span>
    case 'turn':
      return <span className="text-2xl leading-none font-bold text-amber-200/80">…</span>
    case 'waiting':
      return <span className="text-[10px] leading-none font-semibold tracking-[0.14em] text-white/45">WAITING</span>
  }
}

/**
 * Center-of-table area: during trick play, the cards played so far in the
 * current trick; during the auction, each seat's call. Both are placed on the
 * side of the center matching that player's seat, which is the point — the
 * auction now reads the same way the play does (#191), instead of as a list in
 * a corner box that named seats the board was already showing.
 *
 * The two never overlap in practice (`trick` is empty until the auction is
 * settled), so they share the same 3x3 placement grid rather than each getting
 * their own layout to keep in sync.
 */
export function TrickArea({ trick, humanPlayer, winningPlayer, trickNumber, calls }: TrickAreaProps) {
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
        {calls?.map(({ player, name, call }) => (
          <div
            key={`call-${player}`}
            // `role="img"` with a sentence for a name, the same shape
            // `PlayingCard` uses: the visible content is a fragment whose meaning
            // is positional, so the node is labelled as a whole rather than read
            // as loose text.
            role="img"
            aria-label={describeCall(name, call)}
            className={`flex items-center justify-center text-center ${POSITION_CLASS[seatPosition(player, humanPlayer)]}`}
          >
            <CallLabel call={call} />
          </div>
        ))}
      </div>
    </div>
  )
}
