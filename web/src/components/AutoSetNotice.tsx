import { MAX_TRICK_POINTS } from '../engine/round'

export interface AutoSetNoticeProps {
  /** Display name of the team that took the contract. */
  biddingTeamName: string
  /** Display name of the defending team. */
  defendingTeamName: string
  bid: number
  /** The bidding team's meld — the number that, plus every trick point on the
   *  table, still falls short of `bid`. */
  biddingMeld: number
  /** The defending team's meld, which they keep. */
  defendingMeld: number
  /** True when the human is the bid winner — the case #178 was reported for.
   *  Changes nothing about the arithmetic, only who the message addresses. */
  humanIsBidder: boolean
  onDismiss: () => void
}

/**
 * Shown when the auto-SET rule (#178, `round.ts`'s `isAutoSet`) ends a round
 * before a card is led.
 *
 * This exists because of the failure mode, not the rule. The rule alone would
 * jump the player straight from "your hand, trump chosen, meld counted" to the
 * round summary with twelve unplayed tricks — which does not read as a rule,
 * it reads as the game breaking. So the round does not hand off until this has
 * been acknowledged, and it shows the three numbers that make the verdict
 * checkable by hand: the bid, the meld, and the ceiling the two add up to.
 *
 * A notice rather than a `ConfirmDialog`: there is nothing to confirm. The fold
 * is forced arithmetic, and offering a Cancel would imply a choice that does
 * not exist.
 */
export function AutoSetNotice({
  biddingTeamName,
  defendingTeamName,
  bid,
  biddingMeld,
  defendingMeld,
  humanIsBidder,
  onDismiss,
}: AutoSetNoticeProps) {
  const ceiling = biddingMeld + MAX_TRICK_POINTS

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/70 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="auto-set-title"
        className="w-full max-w-sm rounded-lg bg-white p-6 text-neutral-900 shadow-xl"
      >
        <h2 id="auto-set-title" className="text-lg font-semibold">
          This contract can&apos;t be made
        </h2>

        <p className="mt-3 text-sm">
          {humanIsBidder ? 'You bid' : `${biddingTeamName} bid`}{' '}
          <span className="font-semibold">{bid}</span>, and{' '}
          {humanIsBidder ? 'your team' : 'they'} melded{' '}
          <span className="font-semibold">{biddingMeld}</span>.
        </p>

        <table className="mt-3 w-full text-sm">
          <tbody>
            <tr>
              <td className="py-1 text-neutral-500">Meld</td>
              <td className="pl-4 text-right tabular-nums">{biddingMeld}</td>
            </tr>
            <tr>
              <td className="py-1 text-neutral-500">
                Every trick point in the round
              </td>
              <td className="pl-4 text-right tabular-nums">+{MAX_TRICK_POINTS}</td>
            </tr>
            <tr className="border-t border-neutral-200 font-semibold">
              <td className="py-1 font-normal text-neutral-500">Best possible total</td>
              <td className="pl-4 text-right tabular-nums">{ceiling}</td>
            </tr>
            <tr>
              <td className="py-1 text-neutral-500">Needed</td>
              <td className="pl-4 text-right tabular-nums">{bid}</td>
            </tr>
          </tbody>
        </table>

        <p className="mt-3 text-sm text-neutral-600">
          Winning all twelve tricks would still leave {biddingTeamName}{' '}
          {bid - ceiling} short, so the hand is already set and there is nothing
          left to play for. {biddingTeamName} score{' '}
          <span className="font-semibold">-{bid}</span> and forfeit their meld;{' '}
          {defendingTeamName} keep their {defendingMeld} meld and take no trick
          points.
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
