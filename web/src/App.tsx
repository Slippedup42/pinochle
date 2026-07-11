import { AuctionFlow } from './components/AuctionFlow'
import type { AuctionResult } from './components/auctionTypes'
import { buildMockAuctionHands, buildMockAuctionScores, DEALER, HUMAN_PLAYER, SEAT_NAMES } from './mock/auctionState'

// Built once per module load (not per render) so the demo deal doesn't
// reshuffle every time App re-renders.
const initialHands = buildMockAuctionHands()
const scoresByTeam = buildMockAuctionScores()

function App() {
  const handleAuctionComplete = (result: AuctionResult) => {
    // Trick-play (#35) picks up from here — for now just log the outcome
    // so the completed auction/pass is visible while that issue is out of
    // scope, and AuctionFlow keeps rendering the Table with the settled
    // contract and post-pass hands.
    console.log('Auction complete:', result)
  }

  return (
    <AuctionFlow
      initialHands={initialHands}
      seatNames={SEAT_NAMES}
      humanPlayer={HUMAN_PLAYER}
      dealer={DEALER}
      scoresByTeam={scoresByTeam}
      onComplete={handleAuctionComplete}
    />
  )
}

export default App
