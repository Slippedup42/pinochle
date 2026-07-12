// 200-name pool for randomizing AI opponent names (#73). Ported verbatim
// from names.py's NAME_POOL — same 200 names, same order, so the two
// engines stay in sync if the pool is ever revised. Themed in blocks of 20
// (dog names, high fantasy, birds, elvish, Victorian, biblical,
// aristocratic, modern, sci-fi, ocean); see names.py's docstring / the
// repo's name_pool.md for the breakdown.

export const NAME_POOL: readonly string[] = [
  'Buster', 'Cooper', 'Baxter', 'Duncan', 'Marley', 'Gunner', 'Bandit', 'Diesel', 'Ranger', 'Maddox',
  'Bailey', 'Willow', 'Ginger', 'Harley', 'Sadie', 'Roxie', 'Daisy', 'Maggie', 'Bella', 'Molly',
  'Zorvan', 'Kaelor', 'Threxis', 'Bendrix', 'Xandor', 'Vanteus', 'Korrath', 'Jaxeon', 'Renthar', 'Drayven',
  'Seraya', 'Vantha', 'Kyrelle', 'Nyxara', 'Thessia', 'Zerina', 'Aveline', 'Corvana', 'Zylenne', 'Xandrie',
  'Robin', 'Falcon', 'Raven', 'Heron', 'Kestrel', 'Osprey', 'Merlin', 'Talon', 'Sparrow', 'Corvin',
  'Paloma', 'Wrenna', 'Larkspur', 'Robyn', 'Starling', 'Skylar', 'Aviana', 'Ravenna', 'Merla', 'Falcona',
  'Faendril', 'Lorathon', 'Sylnoril', 'Eldrian', 'Thaewyn', 'Caelthir', 'Ravendel', 'Sindolen', 'Aramyth', 'Velthorn',
  'Lorathien', 'Sylvara', 'Aeliana', 'Faelora', 'Nyriel', 'Thalindra', 'Celestrin', 'Eldara', 'Sindril', 'Vaelora',
  'Beauregard', 'Jefferson', 'Nathaniel', 'Ambrose', 'Silas', 'Clayton', 'Wendell', 'Garland', 'Sherman', 'Ellison',
  'Scarlett', 'Magnolia', 'Adelaide', 'Beulah', 'Josephine', 'Charlotte', 'Eudora', 'Delphine', 'Loretta', 'Savannah',
  'Jeremiah', 'Solomon', 'Zachariah', 'Abraham', 'Malachi', 'Obadiah', 'Ezekiel', 'Jedidiah', 'Elijah', 'Nehemiah',
  'Rebekah', 'Deborah', 'Jezebel', 'Delilah', 'Bathsheba', 'Miriam', 'Abigail', 'Hadassah', 'Naomi', 'Susanna',
  'Reginald', 'Frederick', 'Maximilian', 'Alexander', 'Leopold', 'Augustus', 'Theodore', 'William', 'Edmund', 'Richard',
  'Isabella', 'Victoria', 'Eleanora', 'Anastasia', 'Genevieve', 'Marguerite', 'Beatrice', 'Theodora', 'Cordelia', 'Rosalind',
  'Michael', 'Jonathan', 'Matthew', 'Anthony', 'Benjamin', 'Nicholas', 'Kenneth', 'Timothy', 'Douglas', 'Raymond',
  'Jennifer', 'Michelle', 'Rebecca', 'Amanda', 'Kimberly', 'Stephanie', 'Melissa', 'Vanessa', 'Cynthia', 'Danielle',
  'Zynthar', 'Qorvex', 'Xantiel', 'Vroxnar', 'Thexlon', 'Krevash', 'Nyxoran', 'Zeltrix', 'Quorven', 'Ithracon',
  'Xylessa', 'Vexanya', 'Qintara', 'Zorielle', 'Nythera', 'Vaelixi', 'Threxia', 'Zynara', 'Qelvana', 'Xantrel',
  'Marlin', 'Triton', 'Caspian', 'Nereus', 'Pacifico', 'Delmar', 'Marino', 'Oceanus', 'Marner', 'Finnian',
  'Marina', 'Coral', 'Nerida', 'Kaimana', 'Marisol', 'Oceana', 'Nixie', 'Thalassa', 'Naida', 'Pearla',
]

/**
 * Fisher-Yates partial shuffle sample of `count` unique names from
 * NAME_POOL (mirrors Python's `random.sample(NAME_POOL, count)`, used by
 * play_local.py/human_play.py for the 3 AI opponents' names). Same
 * algorithm as passing.ts's sampleRandom, specialized to strings here
 * rather than sharing a generic helper across engine modules that don't
 * otherwise depend on each other.
 */
export function sampleNames(count: number): string[] {
  const copy = [...NAME_POOL]
  const n = Math.min(count, copy.length)
  const result: string[] = []
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(Math.random() * (copy.length - i))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
    result.push(copy[i])
  }
  return result
}
