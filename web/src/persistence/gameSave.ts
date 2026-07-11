// Local autosave (#54): persists enough of gameFlowReducer's state to
// resume a game after a page reload — hands, scores, dealer, phase, trump,
// bid, and trick-in-progress state (GameFlowState.trickPlayCheckpoint, a
// TrickPlayState snapshot taken after each completed trick — never
// mid-trick or mid-AI-delay, see TrickPlayFlow.tsx's onCheckpoint). Saved
// to localStorage on this device only — this is an autosave, not
// cross-device sync.
//
// Card instances don't survive a JSON.stringify/JSON.parse round trip as
// real Card objects: JSON.parse hands back a plain {suit,rank,copyId}
// object, missing Card's rankValue getter and its equals/beats/toString
// methods that engine code (and reference-equality checks like
// trickPlayReducer's PLAY_CARD, which removes a played card from a hand
// via `c !== card`) depend on. Saving is safe as plain JSON.stringify
// (Card's own enumerable fields already serialize correctly); loading
// walks the parsed tree and reconstructs real Card instances everywhere
// one appears, mirroring the exact shapes gameFlowReducer.ts /
// trickPlayReducer.ts produce.

import type { GameFlowState } from '../components/gameFlowReducer'
import type { TrickPlayState } from '../components/trickPlayReducer'
import type { TrickPlayLogEntry } from '../components/trickPlayTypes'
import type { AuctionResult } from '../components/auctionTypes'
import { Card, type Rank, type Suit } from '../engine/card'
import type { Hands } from '../engine/round'
import type { TrickPlay } from '../engine/trick'

const SAVE_KEY = 'pinochle:save:v1'
const SAVE_VERSION = 1

interface SavedGame {
  readonly version: number
  readonly state: GameFlowState
}

/** True if a resumable save is present and parses — the main menu's
 * "Continue" is only enabled when this is true. */
export function hasSavedGame(): boolean {
  return loadGame() !== null
}

/** Persists a checkpoint of `state` to localStorage. Swallows write
 * failures (quota, private-browsing restrictions, no `window`) — a missed
 * autosave is never worth crashing the game over. */
export function saveGame(state: GameFlowState): void {
  try {
    const payload: SavedGame = { version: SAVE_VERSION, state }
    window.localStorage.setItem(SAVE_KEY, JSON.stringify(payload))
  } catch {
    // see above
  }
}

/** Reads and reconstructs the saved game, or null if there isn't one, it's
 * from an incompatible version, or it fails to parse — never throws, so a
 * corrupt/stale save just falls back to "no save" instead of breaking the
 * main menu. */
export function loadGame(): GameFlowState | null {
  try {
    const raw = window.localStorage.getItem(SAVE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!isSavedGameShape(parsed) || parsed.version !== SAVE_VERSION) return null
    return reviveGameFlowState(parsed.state)
  } catch {
    return null
  }
}

/** Clears the save — New Game discards whatever was there. */
export function clearSave(): void {
  try {
    window.localStorage.removeItem(SAVE_KEY)
  } catch {
    // see saveGame
  }
}

function isSavedGameShape(value: unknown): value is SavedGame {
  return typeof value === 'object' && value !== null && 'version' in value && 'state' in value
}

// ---- Card reconstruction ---------------------------------------------
// JSON.parse only ever hands back plain data — these functions are the
// only place a save turns that plain data back into real class instances.

interface PlainCard {
  readonly suit: Suit
  readonly rank: Rank
  readonly copyId: 1 | 2
}

function reviveCard(card: PlainCard): Card {
  return new Card(card.suit, card.rank, card.copyId)
}

function reviveHands(hands: Hands): Hands {
  return hands.map((hand) => hand.map((c) => reviveCard(c as unknown as PlainCard))) as Hands
}

function reviveTrickPlays(plays: readonly TrickPlay[]): TrickPlay[] {
  return plays.map((p) => ({ player: p.player, card: reviveCard(p.card as unknown as PlainCard) }))
}

function reviveTrickPlayLog(log: readonly TrickPlayLogEntry[]): TrickPlayLogEntry[] {
  return log.map((entry) =>
    entry.kind === 'card-play' ? { ...entry, card: reviveCard(entry.card as unknown as PlainCard) } : entry,
  )
}

function reviveTrickPlayState(snapshot: TrickPlayState): TrickPlayState {
  return {
    ...snapshot,
    hands: reviveHands(snapshot.hands),
    currentTrick: reviveTrickPlays(snapshot.currentTrick),
    log: reviveTrickPlayLog(snapshot.log),
  }
}

function reviveAuctionResult(result: AuctionResult): AuctionResult {
  return {
    ...result,
    hands: reviveHands(result.hands as unknown as Hands) as unknown as AuctionResult['hands'],
  }
}

function reviveGameFlowState(state: GameFlowState): GameFlowState {
  return {
    ...state,
    hands: reviveHands(state.hands),
    auctionResult: state.auctionResult ? reviveAuctionResult(state.auctionResult) : null,
    trickPlayCheckpoint: state.trickPlayCheckpoint ? reviveTrickPlayState(state.trickPlayCheckpoint) : null,
  }
}
