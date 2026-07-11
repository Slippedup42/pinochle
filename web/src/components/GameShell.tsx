// Top-level app shell (#54): owns the start-menu / in-game screen split,
// the mid-game menu and Options overlays, and Options state itself — kept
// separate from GameFlow.tsx (rather than folded into it) so GameFlow stays
// exactly what it was before this issue: a pure "play one game" component
// that existing tests can still render with zero props and get the
// original straight-into-a-deal behavior. GameShell is the only thing that
// decides *when* a GameFlow instance exists and what it starts from.
//
// New Game forces a genuinely fresh GameFlow instance via a changing
// `key`, rather than reaching into GameFlow's reducer from outside — same
// "reducer owns its own state" boundary GameFlow/AuctionFlow/TrickPlayFlow
// already keep with each other (they only ever hand a result out through an
// onComplete-style callback, never expose dispatch).

import { useState } from 'react'
import { clearSave, hasSavedGame, loadGame } from '../persistence/gameSave'
import { loadOptions, saveOptions, type GameOptions } from '../persistence/options'
import { GameFlow } from './GameFlow'
import type { GameFlowState } from './gameFlowReducer'
import { MainMenu } from './MainMenu'
import { OptionsPanel } from './OptionsPanel'

type Screen = 'start-menu' | 'game'

export function GameShell() {
  const [screen, setScreen] = useState<Screen>('start-menu')
  // Bumped to force GameFlow to unmount/remount with a fresh reducer
  // instance whenever New Game or Continue (re-)starts play.
  const [mountKey, setMountKey] = useState(0)
  const [resumeState, setResumeState] = useState<GameFlowState | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [optionsOpen, setOptionsOpen] = useState(false)
  const [options, setOptions] = useState<GameOptions>(() => loadOptions())

  function startNewGame(): void {
    if (hasSavedGame() && !window.confirm('Start a new game? Your current saved game will be lost.')) {
      return
    }
    clearSave()
    setResumeState(null)
    setMountKey((k) => k + 1)
    setScreen('game')
    setMenuOpen(false)
  }

  function continueGame(): void {
    if (screen === 'game') {
      // Already playing (the mid-game menu button opened this) — Continue
      // just dismisses the menu back to the game in progress.
      setMenuOpen(false)
      return
    }
    const saved = loadGame()
    if (!saved) return // Continue is disabled without a save; ignore stray calls.
    setResumeState(saved)
    setMountKey((k) => k + 1)
    setScreen('game')
  }

  function updateOptions(next: GameOptions): void {
    setOptions(next)
    saveOptions(next)
  }

  if (screen === 'start-menu') {
    return (
      <>
        <MainMenu
          hasSave={hasSavedGame()}
          onNewGame={startNewGame}
          onContinue={continueGame}
          onOptions={() => setOptionsOpen(true)}
        />
        {optionsOpen && (
          <OptionsPanel options={options} onChange={updateOptions} onClose={() => setOptionsOpen(false)} />
        )}
      </>
    )
  }

  return (
    <>
      <GameFlow
        key={mountKey}
        initialState={resumeState ?? undefined}
        options={options}
        onOpenMenu={() => setMenuOpen(true)}
      />
      {menuOpen && (
        <MainMenu
          hasSave={hasSavedGame()}
          onNewGame={startNewGame}
          onContinue={continueGame}
          onOptions={() => setOptionsOpen(true)}
          onClose={() => setMenuOpen(false)}
        />
      )}
      {optionsOpen && (
        <OptionsPanel options={options} onChange={updateOptions} onClose={() => setOptionsOpen(false)} />
      )}
    </>
  )
}

