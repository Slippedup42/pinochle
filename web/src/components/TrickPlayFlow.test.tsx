// TrickPlayFlow (#35) as a mounted component: the wiring between the reducer's
// rules and what a player can see and click. The rules themselves belong to
// `trickPlayReducer.test.ts` and `round.test.ts` and are not re-asserted here —
// what this file defends is the part only a real mount exercises. Legal-move
// highlighting on the human's own hand, the AI turns resolving on their timers,
// the fold/auto-SET/claim notices holding `onComplete` back until the player
// has been told why the hand ended, and (#217) the #54 resume path, where
// `initialState` hands the component a state it did not build and every one of
// those behaviours has to work off a history it never watched happen.

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dealFromRng, makeRng } from '../ab/headlessGame'
import { Card, Deck, Suit } from '../engine/card'
import type { Hands } from '../engine/round'
import type { PlayerIndex } from '../engine/trick'
import { DEFAULT_OPTIONS, type GameOptions } from '../persistence/options'
import { SKILL_PARAMS } from '../engine/skills'
import { AI_PLAY_DELAY_MS, TRICK_SETTLE_MS, TrickPlayFlow } from './TrickPlayFlow'
import { CLAIMABLE_TRUMP, claimableHands } from './claimablePosition.fixture'
import { initTrickPlayState, type TrickPlayState } from './trickPlayReducer'
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

/**
 * A shuffled deal, pinned by seed so every run plays the same hand.
 *
 * `new Deck().deal()` is *unshuffled* — it hands each seat one whole suit — and
 * since #208 that is a position where whoever was dealt trump claims the other
 * eleven tricks at the first boundary. Legal, and fine for the tests above that
 * only need 48 real cards; no use at all to a test that has to watch tricks go
 * by, because only two of them ever get played. Same generator `round.test.ts`
 * deals its 1500 hands from.
 */
function shuffledDeal(seed: number): Hands {
  return dealFromRng(makeRng(seed))
}

/**
 * Pushes a mounted hand forward by one step, the way a player sitting there
 * would: click a legal card if it is the human's turn, dismiss a claim notice
 * (#208) if that is what the hand is waiting on, otherwise let the pending AI
 * delay or post-trick settle pause elapse.
 *
 * Every test here that needs a hand driven uses this one, including the
 * full-round test — a second copy of the loop is how #261 stayed invisible,
 * since the inline one could quietly stop after a single trick with nothing
 * counting. Plain attribute selector rather than `queryAllByRole('button',
 * ...)`: this runs ~60 times per hand and the role query costs ~30% of the
 * runtime (#170).
 *
 * Reports what it did, because for the full-round test *which* steps happened
 * is the assertion, not just that the hand ended.
 */
type StepAction = 'play' | 'claim' | 'wait'

function step(): StepAction {
  const playable = document.querySelector<HTMLButtonElement>(
    'button[aria-label^="Play "]:not([disabled])',
  )
  if (playable) {
    fireEvent.click(playable)
    return 'play'
  }
  if (screen.queryByRole('dialog', { name: /the rest are mine/i })) {
    fireEvent.click(screen.getByRole('button', { name: 'See the score' }))
    return 'claim'
  }
  act(() => vi.advanceTimersByTime(TRICK_SETTLE_MS))
  return 'wait'
}

/** Steps until `done()`, and fails rather than hanging if the hand stalls —
 *  a driver that gave up quietly would make every assertion after it vacuous.
 *  Returns the steps it took, oldest first. */
function driveUntil(done: () => boolean, limit = 600): StepAction[] {
  const actions: StepAction[] = []
  let guard = 0
  while (!done() && guard < limit) {
    guard++
    actions.push(step())
  }
  expect(guard).toBeLessThan(limit)
  return actions
}

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

    // Seeded, not `new Deck().deal()`, and that is what #261 is about. The
    // unshuffled deal hands each seat one whole suit, and since #208 that is a
    // position where whoever holds trump claims the other eleven tricks at the
    // very first boundary — so from #208 until now this test played *one*
    // trick under a name that promises twelve, and stayed green the whole
    // time. Seed 217 is the same hand the resume tests below play out: twelve
    // tricks, forty-eight cards, no claim available at any boundary.
    //
    // Seeded rather than randomly shuffled on purpose. A deal that only
    // sometimes reaches trick twelve leaves the same hole open intermittently,
    // which is worse than a hole you can see, because the run that skipped the
    // coverage is indistinguishable from the run that got it.
    const hands = shuffledDeal(217)
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

    // `driveUntil` carries the stall guard, so a hand that stops making
    // progress fails here rather than hanging.
    const actions = driveUntil(() => onComplete.mock.calls.length > 0)

    expect(onComplete).toHaveBeenCalledOnce()

    // The three assertions that make the title of this test true. None of the
    // ones below them can: `trickWinners` reaches 12 and the points reach 250
    // whether twelve tricks were played or one was played and eleven were
    // claimed, because a claim *awards* the remainder rather than skipping it.
    // That is exactly how a one-trick round passed for as long as it did, so
    // what is checked here is what a claim cannot counterfeit — the human
    // clicked a card twelve times, once per trick, no claim notice was ever
    // put in front of them, and all 48 cards reached the table.
    expect(actions.filter((action) => action === 'play')).toHaveLength(12)
    expect(actions).not.toContain('claim')
    expect(screen.getAllByText(/ (led|played) the /)).toHaveLength(48)

    const result = onComplete.mock.calls[0][0] as TrickPlayResult
    expect(result.claim).toBeUndefined()
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

  // -- Resuming a #54 checkpoint (#217) -------------------------------------
  //
  // Everything above starts a hand from a fresh deal. The saved-game path does
  // not: `initialState` drops the component into a hand already under way, and
  // the notices, the fold window and the checkpoint writer all have to read a
  // history they were handed rather than one they watched happen. That is a
  // path a player only reaches by closing the tab and coming back, which is
  // exactly the kind of path that breaks without anyone noticing.

  it('re-shows the claim notice when the state it resumes into is already claimable', () => {
    vi.useFakeTimers()

    // A live save can never be claimable — #208 runs the check inside
    // CLEAR_TRICK, so a checkpoint is always written *after* it. A checkpoint
    // written before that rule existed can be, and the component re-runs the
    // check on the way in for that reason. Resuming to a finished hand with no
    // explanation is the failure this prevents.
    const onComplete = vi.fn()
    const onCheckpoint = vi.fn()
    const resumed = initTrickPlayState(claimableHands(), CLAIMABLE_TRUMP, 0, SEAT_NAMES)

    render(
      <TrickPlayFlow
        hands={resumed.hands}
        trumpSuit={CLAIMABLE_TRUMP}
        bidWinner={0}
        bid={300}
        meldPointsByTeam={{ 0: LIVE_MELD, 1: 0 }}
        seatNames={SEAT_NAMES}
        humanPlayer={0}
        scoresByTeam={SCORES}
        dealer={0}
        initialState={resumed}
        onCheckpoint={onCheckpoint}
        onComplete={onComplete}
        options={{ ...DEFAULT_OPTIONS, hideTrickLog: false } as GameOptions}
      />,
    )

    const notice = within(screen.getByRole('dialog', { name: /the rest are mine/i }))
    // The human holds the unbeatable hand here, so the notice is addressed to
    // them, and the two numbers are the ones the claim actually transferred:
    // 8 counters at 10 plus the last-trick bonus, over the 2 tricks skipped.
    expect(notice.getByText(/nothing that can be beaten/)).not.toBeNull()
    expect(notice.getByText('2')).not.toBeNull()
    expect(notice.getByText('90')).not.toBeNull()
    // The claim reached the trick log too, so the hand does not just stop.
    expect(screen.getByText(/took the last 2 tricks/)).not.toBeNull()

    // Nothing moves on behind the notice, however long it stands: no card is
    // played, the round does not hand off, and — the guard #217 is about — no
    // checkpoint is written, because resuming from one would land the player
    // on the round summary having silently eaten the last two tricks.
    act(() => vi.advanceTimersByTime(AI_PLAY_DELAY_MS * 5))
    expect(screen.queryByText(/played the /)).toBeNull()
    expect(onComplete).not.toHaveBeenCalled()
    expect(onCheckpoint).not.toHaveBeenCalled()
  })

  it('carries the claimer and the claimed points out to onComplete once the resumed notice is dismissed', () => {
    vi.useFakeTimers()

    const onComplete = vi.fn()
    const resumed = initTrickPlayState(claimableHands(), CLAIMABLE_TRUMP, 0, SEAT_NAMES)

    render(
      <TrickPlayFlow
        hands={resumed.hands}
        trumpSuit={CLAIMABLE_TRUMP}
        bidWinner={0}
        bid={300}
        meldPointsByTeam={{ 0: LIVE_MELD, 1: 0 }}
        seatNames={SEAT_NAMES}
        humanPlayer={0}
        scoresByTeam={SCORES}
        dealer={0}
        initialState={resumed}
        onComplete={onComplete}
      />,
    )

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'See the score' }))
    })

    // `result.claim` is the only route the claim takes out of trick play — the
    // round summary has no other way to say why four cards were never played —
    // so the payload is checked, not just the fact that the round ended.
    expect(onComplete).toHaveBeenCalledOnce()
    const result = onComplete.mock.calls[0][0] as TrickPlayResult
    expect(result.claim?.player).toBe(0)
    expect(result.claim?.name).toBe('You')
    expect(result.claim?.points).toBe(90)
    expect(result.claim?.tricks).toBe(2)
    // A claim is not a concession: the claiming team keeps the points.
    expect(result.conceded).toBeUndefined()
    expect(result.trickWinners).toEqual([0, 0])
    expect(result.trickPointsByTeam).toEqual({ 0: 90, 1: 0 })
  })

  it('resumes a saved mid-hand checkpoint and still finishes at twelve tricks, not twelve more', () => {
    vi.useFakeTimers()
    disableAiFold()

    const hands = shuffledDeal(217)
    const onCheckpoint = vi.fn()

    // The checkpoint is taken from a real run rather than hand-built, so this
    // is the state #54 would actually have saved — if what the component emits
    // and what it can be restarted from ever diverge, that is the bug here.
    const first = render(
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
        onCheckpoint={onCheckpoint}
        options={{ ...DEFAULT_OPTIONS, hideTrickLog: false } as GameOptions}
      />,
    )
    driveUntil(() => onCheckpoint.mock.calls.length >= 3)
    const snapshot = onCheckpoint.mock.calls.at(-1)![0] as TrickPlayState
    expect(snapshot.trickNumber).toBe(2)
    expect(snapshot.trickWinners).toHaveLength(2)
    first.unmount()

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
        initialState={snapshot}
        onComplete={onComplete}
        options={{ ...DEFAULT_OPTIONS, hideTrickLog: false } as GameOptions}
      />,
    )

    // The two tricks played before the save are still on the log, not replayed.
    expect(screen.getAllByText(/won the trick/)).toHaveLength(2)
    // The fold window (#83) closed the moment the human played a card, and it
    // stays closed across a resume — the guard that reads `cardsPlayed` off the
    // restored log rather than assuming a hand starts at zero.
    expect(screen.queryByRole('button', { name: 'Concede hand' })).toBeNull()
    expect(onComplete).not.toHaveBeenCalled()

    driveUntil(() => onComplete.mock.calls.length > 0)

    // A resumed hand is one hand: the restored tricks and the played-on ones
    // add up to a whole round, with every trick point accounted for exactly
    // once. Double-counting or dropping the restored half would show here.
    expect(onComplete).toHaveBeenCalledOnce()
    const result = onComplete.mock.calls[0][0] as TrickPlayResult
    expect(result.trickWinners).toHaveLength(12)
    expect(result.trickWinners.slice(0, 2)).toEqual(snapshot.trickWinners)
    expect(result.trickPointsByTeam[0] + result.trickPointsByTeam[1]).toBe(250)
  })

  it('checkpoints once per trick boundary, never mid-trick and never during the settle pause', () => {
    vi.useFakeTimers()
    disableAiFold()

    // gameSave.ts states the invariant this asserts: trickPlayCheckpoint is a
    // snapshot taken after each completed trick, never mid-trick or
    // mid-AI-delay. It is a promise about resumability — a snapshot holding a
    // half-played trick would restore four hands and a table that disagree
    // about whose turn it is — and until now nothing checked it.
    const onCheckpoint = vi.fn()

    render(
      <TrickPlayFlow
        hands={shuffledDeal(217)}
        trumpSuit={Suit.Hearts}
        bidWinner={0}
        bid={300}
        meldPointsByTeam={{ 0: LIVE_MELD, 1: 0 }}
        seatNames={SEAT_NAMES}
        humanPlayer={0}
        scoresByTeam={SCORES}
        dealer={0}
        onCheckpoint={onCheckpoint}
        options={{ ...DEFAULT_OPTIONS, hideTrickLog: false } as GameOptions}
      />,
    )
    driveUntil(() => onCheckpoint.mock.calls.length >= 4)

    for (const [snapshot] of onCheckpoint.mock.calls as [TrickPlayState][]) {
      expect(snapshot.currentTrick).toHaveLength(0)
      // 'trick-complete' is the settle pause, where all four cards are still
      // face up on the table waiting to be cleared.
      expect(snapshot.phase).not.toBe('trick-complete')
    }
    // One per boundary and no more: a mid-trick write would repeat a trick
    // number, and a missed one would skip it.
    expect((onCheckpoint.mock.calls as [TrickPlayState][]).map(([s]) => s.trickNumber)).toEqual([
      0, 1, 2, 3,
    ])
  })

  it('never checkpoints a hand the auto-SET rule has already decided', () => {
    vi.useFakeTimers()

    // #178's guard, the twin of the claim one. The hand is over the instant the
    // arithmetic runs, but the player has not been told; a checkpoint of that
    // decided state would resume straight past the explanation into the round
    // summary. Leaving it unwritten means a resume re-enters trick play, the
    // rule fires again, and the notice is shown again.
    const onCheckpoint = vi.fn()

    render(
      <TrickPlayFlow
        hands={shuffledDeal(217)}
        trumpSuit={Suit.Hearts}
        bidWinner={0}
        bid={400}
        // 20 meld plus all 250 trick points is 270, short of 400.
        meldPointsByTeam={{ 0: 20, 1: 100 }}
        seatNames={SEAT_NAMES}
        humanPlayer={0}
        scoresByTeam={SCORES}
        dealer={0}
        onCheckpoint={onCheckpoint}
        options={{ ...DEFAULT_OPTIONS, hideTrickLog: false } as GameOptions}
      />,
    )

    expect(screen.getByRole('dialog')).not.toBeNull()
    act(() => vi.advanceTimersByTime(AI_PLAY_DELAY_MS * 5))

    // Asserted as "nothing decided was ever saved" rather than "nothing was
    // ever saved". The mount writes one checkpoint of the *undecided* opening
    // state, in the same commit the rule fires in and before the flag it reads
    // is set — and that one is harmless, because restoring it re-enters trick
    // play from the top, which is what the guard is trying to achieve anyway.
    // What must never be written is the conceded state behind the notice.
    for (const [snapshot] of onCheckpoint.mock.calls as [TrickPlayState][]) {
      expect(snapshot.phase).toBe('playing')
      expect(snapshot.conceded).toBe(false)
    }
  })
})
