import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Card, Deck, Suit } from '../engine/card'
import type { Hands } from '../engine/round'
import type { PlayerIndex } from '../engine/trick'
import { DEFAULT_OPTIONS, type GameOptions } from '../persistence/options'
import { SKILL_PARAMS } from '../engine/skills'
import { AI_PLAY_DELAY_MS, TrickPlayFlow } from './TrickPlayFlow'
import type { TrickPlayResult } from './trickPlayTypes'

const SEAT_NAMES: Record<PlayerIndex, string> = { 0: 'You', 1: 'West', 2: 'Partner', 3: 'East' }
const SCORES = { 0: 0, 1: 0 }

/**
 * #123 wired an AI bid winner to concede before the first lead, which the
 * card-legality tests below trip over: they deal *one card per seat* so every
 * follow is forced, and the fold model — fitted on 12-card hands — correctly
 * reads a 300 contract on a one-card hand with no meld as hopeless and throws
 * it in before anything can be clicked.
 *
 * Those tests are about legal-move highlighting, not folding, so they pin the
 * fold off rather than contriving meld to talk the model out of it. Save and
 * restore of a `SKILL_PARAMS` entry is the same shape `abRun.installPolicies`
 * uses, and the entry that matters is whichever one `DEFAULT_OPTIONS` puts the
 * AI seats on — **read from it, not named**. #194 changed that default from
 * `hard` to `proficient`, and while this file hardcoded `hard` the patch landed
 * on a tier nobody was playing: the fold stayed on, the bid winner conceded
 * before the first lead, and tests about which cards are clickable failed with
 * no cards on the table.
 *
 * This is *not* enough on its own since #178. Auto-SET is arithmetic, not a
 * policy, so it fires whatever the dial says — and the minimum bid is 300
 * against a 250 trick-point ceiling, which makes any contract held on under 50
 * meld auto-set. The zero meld those fixtures used to pass is therefore now a
 * dead contract, and every test that wants cards played has to give the bidding
 * team enough meld to clear the floor. `LIVE_MELD` is that floor with room to
 * spare; see `MAX_TRICK_POINTS` in `round.ts`.
 */
const AI_TIER = DEFAULT_OPTIONS.opponentSkill
const PRISTINE_TIER = SKILL_PARAMS[AI_TIER]
function disableAiFold() {
  SKILL_PARAMS[AI_TIER] = { ...PRISTINE_TIER, foldPolicy: 'never' }
}

/** Meld that keeps a 300 contract reachable, so auto-SET (#178) stays out of
 *  tests that are about something else. */
const LIVE_MELD = 60

afterEach(() => {
  SKILL_PARAMS[AI_TIER] = PRISTINE_TIER
  cleanup()
  vi.useRealTimers()
})

/**
 * #170: vitest's 5 s default `testTimeout` is a *wall-clock* budget, but what
 * these tests spend is *CPU*. That difference is the whole bug.
 *
 * The AI delays are already driven by fake timers (see the
 * `advanceTimersByTime` calls below), so nothing here ever waits on a real
 * clock — the original "it sits on real timers" theory does not apply. What
 * costs time is genuine computation: the full-round test alone drives 48 card
 * plays, which is 48 React commits over a 4-seat table plus 36 real
 * `chooseLeadCard`/`chooseFollowCard` decisions. That measures ~1.3 s on an
 * idle machine — only ~3.8x under the default budget — and a 3-4x slowdown is
 * routine when several agents are building and running sweeps in parallel,
 * which is the normal mode on this project. Measured at 5.4 s median and 11.0 s
 * worst case under that contention, i.e. over budget.
 *
 * A wall-clock budget on CPU-bound work cannot be made load-proof by rewriting
 * the test; it can only be given enough room. So the budget is raised here,
 * per suite, rather than globally: the ~300 pure-logic engine tests stay at the
 * strict 5 s default so a genuine hang there still surfaces fast, and the cost
 * of the jsdom integration tier stays an explicit, reviewed number instead of a
 * suite-wide default nobody looks at again.
 *
 * The same reasoning covers the *first* test of every component file, which
 * additionally absorbs jsdom/React/RTL first-render warmup (~150 ms idle, but
 * 2.5-4.5 s under load) inside its own budget — hence the identical raise in
 * AuctionFlow/GameFlow/GameShell/MeldFlow/PlayingCard.
 */
const COMPONENT_SUITE_TIMEOUT_MS = 20_000

describe('TrickPlayFlow (component)', { timeout: COMPONENT_SUITE_TIMEOUT_MS }, () => {
  it('highlights only legal cards for the human, forcing a follow of the lead suit', () => {
    vi.useFakeTimers()
    disableAiFold()

    const humanHand = [new Card(Suit.Hearts, 'A', 1), new Card(Suit.Spades, '9', 1)]
    const hands: Hands = [
      humanHand,
      [new Card(Suit.Hearts, '9', 1)], // West — leads, single card, forced
      [new Card(Suit.Clubs, '9', 1)], // Partner — sluffs, single card, forced
      [new Card(Suit.Diamonds, '9', 1)], // East — sluffs, single card, forced
    ]
    const onComplete = vi.fn()

    render(
      <TrickPlayFlow
        hands={hands}
        trumpSuit={Suit.Spades}
        bidWinner={1}
        bid={300}
        meldPointsByTeam={{ 0: 0, 1: LIVE_MELD }}
        seatNames={SEAT_NAMES}
        humanPlayer={0}
        scoresByTeam={SCORES}
        dealer={0}
        onComplete={onComplete}
        options={{ ...DEFAULT_OPTIONS, hideTrickLog: false } as GameOptions}
      />,
    )

    // West leads, then Partner and East follow — each is an AI turn with a
    // brief delay before it resolves.
    act(() => vi.advanceTimersByTime(AI_PLAY_DELAY_MS))
    act(() => vi.advanceTimersByTime(AI_PLAY_DELAY_MS))
    act(() => vi.advanceTimersByTime(AI_PLAY_DELAY_MS))

    expect(screen.getByText('West led the 9 of Hearts')).not.toBeNull()
    expect(screen.getByText('Partner played the 9 of Clubs')).not.toBeNull()
    expect(screen.getByText('East played the 9 of Diamonds')).not.toBeNull()

    // Now it's the human's turn: holding the lead suit (Hearts), they must
    // follow it — the Ace is legal/clickable, the Spades 9 is not.
    const aceButton = screen.getByRole('button', { name: 'Play A of H' })
    const nineButton = screen.getByRole('button', { name: 'Play 9 of S' })
    expect(aceButton.hasAttribute('disabled')).toBe(false)
    expect(nineButton.hasAttribute('disabled')).toBe(true)

    fireEvent.click(aceButton)

    expect(screen.getByText('You played the A of Hearts')).not.toBeNull()
    // The human's Ace beats West's 9 of Hearts, and nobody played trump —
    // the human's team (0, since human is player 0) wins the trick.
    expect(screen.getByText('You won the trick (10 points)')).not.toBeNull()
  })

  it('never lets the human play an illegal card by clicking a disabled button', () => {
    vi.useFakeTimers()
    disableAiFold()

    const humanHand = [new Card(Suit.Hearts, 'A', 1), new Card(Suit.Spades, '9', 1)]
    const hands: Hands = [
      humanHand,
      [new Card(Suit.Hearts, '9', 1)],
      [new Card(Suit.Clubs, '9', 1)],
      [new Card(Suit.Diamonds, '9', 1)],
    ]

    render(
      <TrickPlayFlow
        hands={hands}
        trumpSuit={Suit.Spades}
        bidWinner={1}
        bid={300}
        meldPointsByTeam={{ 0: 0, 1: LIVE_MELD }}
        seatNames={SEAT_NAMES}
        humanPlayer={0}
        scoresByTeam={SCORES}
        dealer={0}
        options={{ ...DEFAULT_OPTIONS, hideTrickLog: false } as GameOptions}
      />,
    )

    act(() => vi.advanceTimersByTime(AI_PLAY_DELAY_MS))
    act(() => vi.advanceTimersByTime(AI_PLAY_DELAY_MS))
    act(() => vi.advanceTimersByTime(AI_PLAY_DELAY_MS))

    const nineButton = screen.getByRole('button', { name: 'Play 9 of S' })
    fireEvent.click(nineButton)

    // The illegal Spades 9 is untouched — the trick still only has 3 plays,
    // no card-play entry was logged for it.
    expect(screen.queryByText('You played the 9 of Spades')).toBeNull()
    expect(screen.getByRole('button', { name: 'Play 9 of S' })).not.toBeNull()
  })

  it('plays a full round end-to-end, alternating human clicks with delayed AI auto-play, and reports the trick result', () => {
    vi.useFakeTimers()

    // Full, real 48-card deck (unshuffled — order doesn't matter, only
    // that it's a legitimate deal) so the round can run all 12 tricks to
    // completion without either engine (real Trick.legalMoves) or AI
    // (real chooseLeadCard/chooseFollowCard) ever seeing an empty hand
    // mid-round.
    const hands = new Deck().deal()
    const onComplete = vi.fn()

    render(
      <TrickPlayFlow
        hands={hands}
        trumpSuit={Suit.Hearts}
        bidWinner={0}
        bid={300}
        meldPointsByTeam={{ 0: LIVE_MELD, 1: 0 }}
        seatNames={SEAT_NAMES}
        humanPlayer={0}
        scoresByTeam={SCORES}
        dealer={0}
        onComplete={onComplete}
        options={{ ...DEFAULT_OPTIONS, hideTrickLog: false } as GameOptions}
      />,
    )

    let guard = 0
    while (onComplete.mock.calls.length === 0 && guard < 500) {
      guard++
      // Deliberately a plain attribute selector rather than
      // `queryAllByRole('button', { name: /^Play / })`. This runs ~60 times per
      // round, and the role query computes an accessible name for every
      // candidate and a `getComputedStyle` visibility check for every node in
      // the tree on each call — measured at ~30% of this test's total runtime
      // (#170). Nothing is lost by dropping it: this loop is a *driver*, not an
      // assertion, and the role/accessible-name contract on these buttons is
      // what the two tests above actually assert.
      const playable = document.querySelector<HTMLButtonElement>(
        'button[aria-label^="Play "]:not([disabled])',
      )
      if (playable) {
        fireEvent.click(playable)
      } else {
        // Either an AI turn or the post-trick settle pause is in flight —
        // advancing past the longer of the two delays flushes whichever
        // is pending.
        act(() => vi.advanceTimersByTime(1200))
      }
    }

    expect(guard).toBeLessThan(500) // sanity: the loop actually terminated, not just gave up
    expect(onComplete).toHaveBeenCalledOnce()

    const result = onComplete.mock.calls[0][0] as TrickPlayResult
    expect(result.trickWinners).toHaveLength(12)
    // 24 point-cards (A/10/K x 4 suits x 2 copies) worth 10 each, plus the
    // +10 last-trick bonus — the full round's points always sum to this,
    // regardless of who won which trick.
    expect(result.trickPointsByTeam[0] + result.trickPointsByTeam[1]).toBe(250)
  })

  // -- AI concede (#123) ----------------------------------------------------

  it('concedes a hopeless contract for an AI bid winner before any card is played', () => {
    vi.useFakeTimers()

    const hands = new Deck().deal()
    const onComplete = vi.fn()

    render(
      <TrickPlayFlow
        hands={hands}
        trumpSuit={Suit.Hearts}
        bidWinner={1}
        bid={400}
        // Reachable on paper — 200 meld plus the 250 trick points that exist
        // clears 400 — so auto-SET (#178) does not fire and this stays a test
        // of the *model*'s judgement, which is what #123 built. A fixture the
        // arithmetic already kills would pass whether the model ran or not.
        meldPointsByTeam={{ 0: 0, 1: 200 }}
        seatNames={SEAT_NAMES}
        humanPlayer={0}
        scoresByTeam={SCORES}
        dealer={0}
        onComplete={onComplete}
        options={{ ...DEFAULT_OPTIONS, hideTrickLog: false } as GameOptions}
      />,
    )

    // No timer advance: the fold is decided in the same commit as the mount,
    // before the AI-play delay can elapse. That ordering is the point — a
    // conceded hand must never see a card hit the table first.
    expect(onComplete).toHaveBeenCalledOnce()
    const result = onComplete.mock.calls[0][0] as TrickPlayResult
    expect(result.conceded).toBe(true)
    expect(result.trickWinners).toHaveLength(0)
    // The model decided this, not the arithmetic, so no auto-SET notice.
    expect(screen.queryByText(/can't be made/i)).toBeNull()
  })

  it('plays on when the contract is live, rather than conceding everything', () => {
    vi.useFakeTimers()

    const hands = new Deck().deal()
    const onComplete = vi.fn()

    render(
      <TrickPlayFlow
        hands={hands}
        trumpSuit={Suit.Hearts}
        bidWinner={1}
        bid={300}
        // Meld already covers the bid, so the contract is won before a card is
        // led and there is nothing to concede.
        meldPointsByTeam={{ 0: 0, 1: 320 }}
        seatNames={SEAT_NAMES}
        humanPlayer={0}
        scoresByTeam={SCORES}
        dealer={0}
        onComplete={onComplete}
        options={{ ...DEFAULT_OPTIONS, hideTrickLog: false } as GameOptions}
      />,
    )

    expect(onComplete).not.toHaveBeenCalled()
    // West (the bid winner) leads instead of throwing the hand in. Checking the
    // log rather than the human's playable cards because the human does not act
    // until the lead has gone round to them.
    act(() => vi.advanceTimersByTime(AI_PLAY_DELAY_MS))
    expect(screen.getByText(/^West led the /)).not.toBeNull()
    expect(onComplete).not.toHaveBeenCalled()
  })

  it('never concedes on the human\'s behalf when the human won the bid', () => {
    vi.useFakeTimers()

    const hands = new Deck().deal()
    const onComplete = vi.fn()

    render(
      <TrickPlayFlow
        hands={hands}
        trumpSuit={Suit.Hearts}
        bidWinner={0}
        bid={400}
        // The same contract the model throws in for an AI bid winner above, and
        // still reachable arithmetically so auto-SET (#178) stays out of it.
        // The human owns this decision — the fold button (#83) is offered,
        // never taken for them.
        meldPointsByTeam={{ 0: 200, 1: 0 }}
        seatNames={SEAT_NAMES}
        humanPlayer={0}
        scoresByTeam={SCORES}
        dealer={0}
        onComplete={onComplete}
        options={{ ...DEFAULT_OPTIONS, hideTrickLog: false } as GameOptions}
      />,
    )

    expect(onComplete).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Concede hand' })).not.toBeNull()
  })

  // -- Auto-SET (#178) ------------------------------------------------------

  it('ends the round for a human bid winner who cannot reach their bid, and says why', () => {
    vi.useFakeTimers()

    const hands = new Deck().deal()
    const onComplete = vi.fn()

    render(
      <TrickPlayFlow
        hands={hands}
        trumpSuit={Suit.Hearts}
        bidWinner={0}
        bid={400}
        // 20 meld + every one of the 250 trick points reaches 270, short of
        // 400. The reported case: a human made to play twelve tricks that
        // cannot matter.
        meldPointsByTeam={{ 0: 20, 1: 100 }}
        seatNames={SEAT_NAMES}
        humanPlayer={0}
        scoresByTeam={SCORES}
        dealer={0}
        onComplete={onComplete}
        options={{ ...DEFAULT_OPTIONS, hideTrickLog: false } as GameOptions}
      />,
    )

    // The round is over, but the player has not been told yet, so the summary
    // must not be reached.
    expect(onComplete).not.toHaveBeenCalled()
    const notice = within(screen.getByRole('dialog'))
    expect(notice.getByText(/can't be made/i)).not.toBeNull()
    // The three numbers that make the verdict checkable by hand. Scoped to the
    // notice because the scoreboard behind it shows the bid and meld too.
    expect(notice.getByText(/You bid/)).not.toBeNull()
    expect(notice.getAllByText('400').length).toBeGreaterThan(0)
    expect(notice.getAllByText('20').length).toBeGreaterThan(0)
    expect(notice.getByText('270')).not.toBeNull()

    // No card reaches the table while the notice is up, however long passes.
    act(() => vi.advanceTimersByTime(AI_PLAY_DELAY_MS * 5))
    expect(screen.queryByText(/led the /)).toBeNull()
    expect(onComplete).not.toHaveBeenCalled()

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'See the score' }))
    })

    expect(onComplete).toHaveBeenCalledOnce()
    const result = onComplete.mock.calls[0][0] as TrickPlayResult
    // Reuses the existing concession path — gameFlowReducer's TRICK_COMPLETE
    // does the -bid / forfeited-meld scoring off this one flag.
    expect(result.conceded).toBe(true)
    expect(result.trickWinners).toHaveLength(0)
    expect(result.trickPointsByTeam).toEqual({ 0: 0, 1: 0 })
  })

  it('ends the round on a dead contract even with the AI fold model switched off', () => {
    vi.useFakeTimers()
    // Auto-SET is arithmetic, not a policy: it must fire for a tier that never
    // folds, which is the whole reason it does not live behind `foldPolicy`.
    disableAiFold()

    const hands = new Deck().deal()
    const onComplete = vi.fn()

    render(
      <TrickPlayFlow
        hands={hands}
        trumpSuit={Suit.Hearts}
        bidWinner={1}
        bid={400}
        meldPointsByTeam={{ 0: 100, 1: 20 }}
        seatNames={SEAT_NAMES}
        humanPlayer={0}
        scoresByTeam={SCORES}
        dealer={0}
        onComplete={onComplete}
        options={{ ...DEFAULT_OPTIONS, hideTrickLog: false } as GameOptions}
      />,
    )

    // Named as the team, not as "you" — the human is defending here, and is
    // still owed an explanation for a round that ended before it started.
    const notice = within(screen.getByRole('dialog'))
    expect(notice.getByText(/Team B bid/)).not.toBeNull()
    expect(notice.queryByText(/You bid/)).toBeNull()

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'See the score' }))
    })
    expect(onComplete).toHaveBeenCalledOnce()
    expect((onComplete.mock.calls[0][0] as TrickPlayResult).conceded).toBe(true)
  })
})
