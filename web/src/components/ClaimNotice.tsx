import type { Card } from '../engine/card'
import { PlayingCard } from './PlayingCard'

export interface ClaimNoticeProps {
  /** Display name of the seat making the claim. */
  claimerName: string
  /** Display name of the team the tricks go to. */
  teamName: string
  /** True when the human is the one claiming — changes who the message
   *  addresses, not what happened. */
  humanIsClaimer: boolean
  /** The claimer's whole remaining hand, shown face up. This is the evidence,
   *  not decoration: the claim is a statement that none of these can be beaten,
   *  and the player is entitled to check it. */
  cards: readonly Card[]
  /** Trick points transferred, last-trick bonus included. */
  points: number
  /** How many tricks were awarded rather than played. */
  tricks: number
  /** Name of the trump suit, for the one-line reason. */
  trumpName: string
  onDismiss: () => void
}

/**
 * Shown when a seat's remaining hand cannot be beaten and the rest of the tricks
 * are awarded rather than played out (#208, `round.ts`'s `findClaim`).
 *
 * The same reasoning `AutoSetNotice` was written from: the rule alone would skip
 * several tricks and jump to the round summary, and an unexplained jump does not
 * read as a rule, it reads as the game losing cards. So the round does not hand
 * off until this is acknowledged.
 *
 * **The hand is shown face up on purpose, including an AI's.** The claim is a
 * claim — an assertion that every one of these cards wins — and the only way a
 * player can believe it is to see the cards and check. Hiding them would ask for
 * trust at exactly the moment the game takes tricks away without playing them.
 * There is nothing to conceal by then either: the hand is over.
 *
 * A notice rather than a `ConfirmDialog`, for `AutoSetNotice`'s reason. The
 * outcome is forced — `findClaim` only fires where every remaining trick was
 * already decided — so offering a Cancel would imply a choice that does not
 * exist.
 */
export function ClaimNotice({
  claimerName,
  teamName,
  humanIsClaimer,
  cards,
  points,
  tricks,
  trumpName,
  onDismiss,
}: ClaimNoticeProps) {
  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/70 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="claim-title"
        className="w-full max-w-sm rounded-lg bg-white p-6 text-neutral-900 shadow-xl"
      >
        <h2 id="claim-title" className="text-lg font-semibold">
          &ldquo;The rest are mine&rdquo;
        </h2>

        {/* "go to" rather than a possessive: team names are player-editable
            (#186), and "Bosses'" / "Us's" is a coin flip nobody should have to
            think about. */}
        <p className="mt-3 text-sm">
          {humanIsClaimer ? 'You hold' : `${claimerName} holds`} nothing that can
          be beaten, so the last{' '}
          <span className="font-semibold">{tricks}</span> tricks go to{' '}
          {humanIsClaimer ? 'you' : teamName} without playing them out.
        </p>

        <div
          className="mt-4 flex flex-wrap justify-center gap-1"
          aria-label={`${claimerName}'s remaining cards`}
        >
          {cards.map((card, i) => (
            <PlayingCard
              // Two physical copies of a card are genuinely the same card, so
              // there is no id to key on — and this list never reorders.
              key={`${card.suit}${card.rank}-${i}`}
              suit={card.suit}
              rank={card.rank}
              size="sm"
            />
          ))}
        </div>

        <p className="mt-4 text-sm text-neutral-600">
          No one else holds {trumpName}, and nothing outstanding beats the rest,
          so every trick left was already decided.{' '}
          <span className="font-semibold">{teamName}</span> take{' '}
          <span className="font-semibold">{points}</span> trick points,
          last-trick bonus included.
        </p>

        <button
          type="button"
          onClick={onDismiss}
          className="mt-6 w-full rounded bg-green-800 px-4 py-2 font-semibold text-white hover:bg-green-900"
        >
          See the score
        </button>
      </div>
    </div>
  )
}
