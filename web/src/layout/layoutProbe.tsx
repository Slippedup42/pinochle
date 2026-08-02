// Dev-only portrait-fit probe for #161.
//
// #161's acceptance criterion is a measurement, not a look: at a phone-sized
// viewport, in every phase, the document must not scroll. Driving a real game
// to each phase by hand is slow and non-reproducible (AI bids are random, and
// game-over needs a full game), so this page mounts each phase's *actual*
// component tree from fixed, seeded data and measures it.
//
// Two modes, both served from layout/index.html:
//
//   /layout/                      the runner — loads every (phase, viewport)
//                                 pair in an exactly-sized iframe and prints
//                                 the overflow numbers as a table + JSON.
//   /layout/?frame=1&phase=meld   one phase, rendered alone. What the runner
//                                 puts in its iframes; also useful to open
//                                 directly and look at.
//
// Notes on what the numbers mean:
//
//   An iframe of width W gives its document a viewport of exactly W CSS px,
//   which is the point — `resize`-ing a desktop browser window cannot produce
//   a 390px viewport without also involving the device pixel ratio. Classic
//   desktop scrollbars would steal ~15px of that, which a phone's overlay
//   scrollbars do not, so frame mode hides them; the frame is measuring what
//   the phone sees, not what a Windows Chrome window sees.
//
//   `env(safe-area-inset-*)` is always 0 in a browser tab, so `?insets=1`
//   overrides index.css's --safe-* variables with an iPhone-14-Pro-class
//   portrait inset set. That is the real height budget for an installed
//   instance (index.html sets viewport-fit=cover + apple-mobile-web-app-capable),
//   and it is smaller than the nominal viewport.
//
//   Overlays are `position: fixed`, which by spec contributes nothing to the
//   document's scrollable overflow — a modal taller than the screen would be
//   clipped and unreachable while still measuring 0 overflow. So the runner
//   also reports the overlay panel's own rect against the viewport.

import { StrictMode, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import '../index.css'
import { Deck, Suit, type Card } from '../engine/card'
import type { Hands, TeamId } from '../engine/round'
import { Trick, type PlayerIndex } from '../engine/trick'
import { AuctionLog } from '../components/AuctionLog'
import type { AuctionLogEntry } from '../components/auctionTypes'
import { BiddingControls } from '../components/BiddingControls'
import { GameOverScreen } from '../components/GameOverScreen'
import { MeldFlow } from '../components/MeldFlow'
import { PassSelector } from '../components/PassSelector'
import { RoundSummary } from '../components/RoundSummary'
import { Table } from '../components/Table'
import type { TableState } from '../components/tableTypes'
import { TrickLog } from '../components/TrickLog'
import type { TrickPlayLogEntry } from '../components/trickPlayTypes'

// ---------------------------------------------------------------------------
// Fixed worst-case fixtures — deliberately the longest names in the pools
// (names.ts / teamNames.ts) and a full 12-card human hand, since name length
// is what the narrow side seats have to survive and hand size is what the
// bottom seat has to survive.
// ---------------------------------------------------------------------------

const HUMAN: PlayerIndex = 0
const SEAT_NAMES: Record<PlayerIndex, string> = {
  0: 'You',
  1: 'Maximilian',
  2: 'Beauregard',
  3: 'Lorathien',
}
const TEAM_NAMES: Record<TeamId, string> = {
  0: 'Wyrmscale Brotherhood',
  1: 'Thornveil Ascendancy',
}
const SCORES: Record<TeamId, number> = { 0: 480, 1: 520 }
const TRUMP = Suit.Hearts
const BID = 340
const BID_WINNER: PlayerIndex = 1

/** Seeded deal, so every run of the probe measures the same cards. */
function seededHands(seed: number): Hands {
  const realRandom = Math.random
  let s = seed >>> 0
  Math.random = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
  try {
    const deck = new Deck()
    deck.shuffle()
    return deck.deal()
  } finally {
    Math.random = realRandom
  }
}

const HANDS = seededHands(161)

const AUCTION_LOG: readonly AuctionLogEntry[] = [
  { kind: 'pass-bid', player: 3, name: SEAT_NAMES[3] },
  { kind: 'bid', player: 0, name: SEAT_NAMES[0], amount: 300 },
  { kind: 'bid', player: 1, name: SEAT_NAMES[1], amount: 310 },
  { kind: 'bid', player: 2, name: SEAT_NAMES[2], amount: 320 },
  { kind: 'bid', player: 1, name: SEAT_NAMES[1], amount: 340 },
  { kind: 'pass-bid', player: 0, name: SEAT_NAMES[0] },
  { kind: 'pass-bid', player: 2, name: SEAT_NAMES[2] },
  { kind: 'trump', player: 1, name: SEAT_NAMES[1], suit: TRUMP },
  { kind: 'card-pass', fromPlayer: 3, fromName: SEAT_NAMES[3], toPlayer: 1, toName: SEAT_NAMES[1], count: 3 },
]

function baseSeats(hands: Hands, statusText?: (p: PlayerIndex) => string | undefined): TableState['seats'] {
  const seat = (p: PlayerIndex) => ({
    player: p,
    name: SEAT_NAMES[p],
    hand: hands[p] as readonly Card[],
    statusText: statusText?.(p),
  })
  return [seat(0), seat(1), seat(2), seat(3)]
}

const noop = () => {}

// ---------------------------------------------------------------------------
// Phases — each is the same composition its real flow component builds, so
// what the probe measures is what a player gets.
// ---------------------------------------------------------------------------

export const PHASES = ['auction', 'pass', 'meld', 'trick', 'summary', 'gameover'] as const
export type PhaseId = (typeof PHASES)[number]

function auctionPhase() {
  // AuctionFlow's bidding composition: table + BiddingControls overlay + log.
  const state: TableState = {
    seats: baseSeats(HANDS, (p) => (p === 3 ? 'Pass' : p === 1 ? '(310)' : p === 2 ? '(Waiting)' : undefined)),
    humanPlayer: HUMAN,
    trick: [],
    trumpSuit: null,
    currentBid: 310,
    bidWinner: null,
    scoresByTeam: SCORES,
    teamNames: TEAM_NAMES,
    dealer: 3,
  }
  return (
    <Table
      state={state}
      overlay={
        <BiddingControls minBid={320} currentBid={310} suggestedCeiling={330} onBid={noop} onPass={noop} />
      }
      logPanel={
        <AuctionLog
          entries={AUCTION_LOG.slice(0, 5)}
          currentBid={310}
          bidWinnerName={SEAT_NAMES[1]}
          dealerName={SEAT_NAMES[3]}
        />
      }
      onOpenMenu={noop}
    />
  )
}

function passPhase() {
  // AuctionFlow's passing composition: table + PassSelector overlay + log.
  const state: TableState = {
    seats: baseSeats(HANDS),
    humanPlayer: HUMAN,
    trick: [],
    trumpSuit: TRUMP,
    currentBid: BID,
    bidWinner: BID_WINNER,
    scoresByTeam: SCORES,
    teamNames: TEAM_NAMES,
    dealer: 3,
  }
  return (
    <Table
      state={state}
      overlay={<PassSelector hand={HANDS[HUMAN]} count={3} trumpSuit={TRUMP} onConfirm={noop} />}
      logPanel={<AuctionLog entries={AUCTION_LOG} currentBid={BID} bidWinnerName={SEAT_NAMES[1]} dealerName={SEAT_NAMES[3]} />}
      onOpenMenu={noop}
    />
  )
}

function meldPhase() {
  // The real MeldFlow — it is deterministic given hands + trump, and it is the
  // phase that puts every seat's cards on the table at once (exposeCards) with
  // both teams' meld columns over the top.
  return (
    <MeldFlow
      hands={HANDS.map((h) => [...h]) as Hands}
      trumpSuit={TRUMP}
      bidWinner={BID_WINNER}
      bid={BID}
      seatNames={SEAT_NAMES}
      humanPlayer={HUMAN}
      scoresByTeam={SCORES}
      teamNames={TEAM_NAMES}
      dealer={3}
      onOpenMenu={noop}
      onComplete={noop}
      onConcede={noop}
    />
  )
}

function trickPhase() {
  // TrickPlayFlow's composition at the tightest moment of a hand: the human
  // still holds all 12 cards, three opponents' cards are already on the table,
  // and both logs are up.
  const hands = HANDS.map((h) => [...h]) as Hands
  const trick = new Trick(TRUMP)
  for (const p of [1, 2, 3] as PlayerIndex[]) {
    const card = hands[p].pop()
    if (card) trick.play(p, card)
  }
  const log: TrickPlayLogEntry[] = trick.plays.map((play, i) => ({
    kind: 'card-play',
    player: play.player,
    name: SEAT_NAMES[play.player],
    card: play.card,
    isLead: i === 0,
  }))
  const state: TableState = {
    seats: baseSeats(hands),
    humanPlayer: HUMAN,
    trick: trick.plays,
    trumpSuit: TRUMP,
    currentBid: BID,
    bidWinner: BID_WINNER,
    scoresByTeam: SCORES,
    teamNames: TEAM_NAMES,
    humanPlayable: { legalCards: hands[HUMAN], onPlay: noop },
    trickWinner: null,
    dealer: 3,
    meldPoints: 60,
  }
  return (
    <Table
      state={state}
      logPanel={
        <div className="flex flex-col gap-2">
          <AuctionLog entries={AUCTION_LOG} />
          <TrickLog entries={log} />
        </div>
      }
      onOpenMenu={noop}
      trickNumber={1}
    />
  )
}

function summaryPhase() {
  return (
    <RoundSummary
      data={{
        meldPointsByTeam: { 0: 60, 1: 140 },
        trickPointsByTeam: { 0: 110, 1: 140 },
        roundScoreByTeam: { 0: 170, 1: 280 },
        bidWinnerTeam: 1,
        bid: BID,
        cumulativeScoresByTeam: { 0: 650, 1: 800 },
        teamNames: TEAM_NAMES,
      }}
      onContinue={noop}
    />
  )
}

function gameOverPhase() {
  return (
    <GameOverScreen
      data={{ winningTeam: 1, finalScoresByTeam: { 0: 880, 1: 1030 }, teamNames: TEAM_NAMES }}
      onNewGame={noop}
    />
  )
}

const PHASE_RENDERERS: Record<PhaseId, () => ReactElement> = {
  auction: auctionPhase,
  pass: passPhase,
  meld: meldPhase,
  trick: trickPhase,
  summary: summaryPhase,
  gameover: gameOverPhase,
}

// ---------------------------------------------------------------------------
// Runner — loads each phase in an exactly-sized iframe and reads the numbers
// out of it. Same-origin, so the parent can measure the child directly.
// ---------------------------------------------------------------------------

/** iPhone 14 Pro portrait insets, the case index.html's viewport-fit=cover buys. */
const SIM_INSETS = { top: '59px', right: '0px', bottom: '34px', left: '0px' }

const VIEWPORTS: readonly { label: string; w: number; h: number }[] = [
  { label: '390x844', w: 390, h: 844 },
  { label: '360x640', w: 360, h: 640 },
  { label: '430x932', w: 430, h: 932 },
]

interface Measurement {
  phase: PhaseId
  viewport: string
  insets: boolean
  overflowY: number
  overflowX: number
  /** Overlay/modal panel bottom and right relative to the viewport — positive
   * means part of the panel is off-screen and unreachable (fixed elements do
   * not show up in the document overflow numbers above). */
  panelOverflowY: number
  panelOverflowX: number
}

function measureFrame(win: Window, doc: Document): Omit<Measurement, 'phase' | 'viewport' | 'insets'> {
  const de = doc.documentElement
  const panel = doc.querySelector('.fixed.inset-0')?.firstElementChild
  const rect = panel?.getBoundingClientRect()
  return {
    overflowY: de.scrollHeight - win.innerHeight,
    overflowX: de.scrollWidth - win.innerWidth,
    panelOverflowY: rect ? Math.round(Math.max(rect.bottom - win.innerHeight, -rect.top)) : 0,
    panelOverflowX: rect ? Math.round(Math.max(rect.right - win.innerWidth, -rect.left)) : 0,
  }
}

function frameUrl(phase: PhaseId, insets: boolean): string {
  return `?frame=1&phase=${phase}${insets ? '&insets=1' : ''}`
}

async function runOne(phase: PhaseId, w: number, h: number, insets: boolean): Promise<Measurement> {
  const frame = document.createElement('iframe')
  frame.setAttribute('style', `width:${w}px;height:${h}px;border:0;display:block;position:absolute;left:-9999px`)
  frame.src = frameUrl(phase, insets)
  document.body.appendChild(frame)
  await new Promise((resolve) => frame.addEventListener('load', resolve, { once: true }))
  // React mounts in an effect; give it a couple of frames plus a beat for
  // fonts/layout to settle before reading rects.
  await new Promise((resolve) => setTimeout(resolve, 250))
  const measurement = measureFrame(frame.contentWindow!, frame.contentDocument!)
  frame.remove()
  return { phase, viewport: `${w}x${h}`, insets, ...measurement }
}

async function runAll(out: HTMLElement, insets: boolean): Promise<void> {
  const rows: Measurement[] = []
  const lines = [
    `viewport   phase     insets  overflowY  overflowX  panelY  panelX  verdict`,
  ]
  out.textContent = 'measuring…'
  for (const vp of VIEWPORTS) {
    for (const phase of PHASES) {
      const m = await runOne(phase, vp.w, vp.h, insets)
      rows.push(m)
      const ok = m.overflowY <= 0 && m.overflowX <= 0 && m.panelOverflowY <= 0 && m.panelOverflowX <= 0
      lines.push(
        [
          vp.label.padEnd(10),
          phase.padEnd(9),
          String(insets).padEnd(7),
          String(m.overflowY).padStart(9),
          String(m.overflowX).padStart(10),
          String(m.panelOverflowY).padStart(7),
          String(m.panelOverflowX).padStart(7),
          '  ' + (ok ? 'PASS' : 'FAIL'),
        ].join(''),
      )
      out.textContent = lines.join('\n')
    }
  }
  const failures = rows.filter(
    (m) => m.overflowY > 0 || m.overflowX > 0 || m.panelOverflowY > 0 || m.panelOverflowX > 0,
  )
  lines.push('')
  lines.push(failures.length === 0 ? 'ALL PASS' : `${failures.length} FAILING`)
  lines.push('')
  lines.push(JSON.stringify(rows))
  out.textContent = lines.join('\n')
}

function mountRunner(): void {
  document.body.innerHTML = `
    <div style="font:12px/1.5 ui-monospace,monospace;margin:12px">
      <h1 style="font-size:14px">Portrait fit probe (#161)</h1>
      <p>Each row loads one phase in an iframe sized to a real phone viewport and reads
         <code>scrollHeight - innerHeight</code> / <code>scrollWidth - innerWidth</code>.
         Non-positive is a pass. <code>panelY/panelX</code> is the modal overlay's own rect
         against the viewport, since <code>position: fixed</code> never shows up in document overflow.</p>
      <button id="run">run (no insets)</button>
      <button id="run-insets">run (simulated notch/home-indicator insets)</button>
      <pre id="out" style="white-space:pre">idle</pre>
    </div>
  `
  const out = document.getElementById('out') as HTMLElement
  document.getElementById('run')!.addEventListener('click', () => void runAll(out, false))
  document.getElementById('run-insets')!.addEventListener('click', () => void runAll(out, true))
}

function mountFrame(phase: PhaseId, insets: boolean): void {
  // Desktop scrollbars take layout width; phone overlay scrollbars do not, and
  // it is the phone we are measuring for.
  const style = document.createElement('style')
  style.textContent = 'html{scrollbar-width:none}html::-webkit-scrollbar{display:none}'
  document.head.appendChild(style)
  if (insets) {
    const root = document.documentElement
    root.style.setProperty('--safe-top', SIM_INSETS.top)
    root.style.setProperty('--safe-right', SIM_INSETS.right)
    root.style.setProperty('--safe-bottom', SIM_INSETS.bottom)
    root.style.setProperty('--safe-left', SIM_INSETS.left)
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>{PHASE_RENDERERS[phase]()}</StrictMode>,
  )
}

const params = new URLSearchParams(location.search)
if (params.get('frame') === '1') {
  const phase = (params.get('phase') ?? 'trick') as PhaseId
  mountFrame(PHASES.includes(phase) ? phase : 'trick', params.get('insets') === '1')
} else {
  mountRunner()
}
