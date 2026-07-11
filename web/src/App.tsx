import { Table } from './components/Table'
import { buildMockTableState } from './mock/tableState'

// buildMockTableState() is called once per module load (not per render) so
// the demo table doesn't reshuffle every time App re-renders.
const mockState = buildMockTableState()

function App() {
  return <Table state={mockState} />
}

export default App
