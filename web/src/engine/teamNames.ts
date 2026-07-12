// 50-name pool for randomizing team display names (#73), split across 4
// themes (15 medieval, 15 fantasy, 10 sci-fi, 10 normal/casual). Curated
// list from the issue — not derived from names.py (that pool is
// individual-name-shaped, this one is team-name-shaped).

export const TEAM_NAME_POOL: readonly string[] = [
  // Medieval (15)
  'Ironclad Vanguard', 'Crimson Knights', 'Silver Lions', 'Iron Wardens', 'Golden Halberds',
  'Stonegate Guardians', 'Ravenkeep Sentinels', 'Blackthorn Legion', 'Ashen Crusaders', 'Wolfsbane Company',
  'Thornwood Rangers', "Gryphon's Watch", 'Ironhold Banners', 'Crownguard Regiment', 'Oakshield Company',
  // Fantasy (15)
  'Dragonfire Order', 'Moonveil Wanderers', 'Emberfall Coven', 'Shadowmere Pact', 'Starforge Guild',
  'Wraithbound Circle', 'Sylvan Wardens', 'Duskwhisper Clan', 'Frostspire Legion', 'Thornveil Ascendancy',
  'Netherglow Syndicate', 'Wyrmscale Brotherhood', 'Runecarved Vanguard', 'Nightbloom Coven', 'Stormcaller Enclave',
  // Sci-fi (10)
  'Nova Squadron', 'Quantum Drifters', 'Voidrunner Fleet', 'Ironstar Collective', 'Photon Vanguard',
  'Nebula Task Force', 'Cryo Raiders', 'Orbital Sentinels', 'Fusion Reactants', 'Starforge Division',
  // Normal / casual (10)
  'The Card Sharks', 'Trump Tight', 'Meld Squad', 'The Bid Bandits', 'Table Talk',
  'Deal Breakers', 'The Aces High', 'Suit Yourselves', 'Full House Crew', 'Pinochle Posse',
]

/**
 * Fisher-Yates partial shuffle sample of `count` unique names from
 * TEAM_NAME_POOL (same algorithm as names.ts's sampleNames — kept as a
 * separate function rather than a shared generic helper since the two
 * pools don't otherwise depend on each other). Only 2 draws are needed
 * (one per team), but kept general like sampleNames.
 */
export function sampleTeamNames(count: number): string[] {
  const copy = [...TEAM_NAME_POOL]
  const n = Math.min(count, copy.length)
  const result: string[] = []
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(Math.random() * (copy.length - i))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
    result.push(copy[i])
  }
  return result
}
