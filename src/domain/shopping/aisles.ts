import { normalize } from '../text'

/**
 * Dział sklepu dla nazwy składnika.
 *
 * Wcześniej dział brał się z pola `shoppingCategory` w bazie produktów. Bazy
 * nie ma — przepisy podają same nazwy — więc dział wyliczamy ze słów
 * kluczowych. To zgadywanie, ale zgadywanie o KOLEJNOŚCI POZYCJI na liście,
 * nie o zawartości: pozycja trafiona źle nadal jest na liście, tylko o dwie
 * sekcje dalej. Nieznana nazwa idzie do „Inne" i nic nie znika po cichu.
 */
export const AISLE_ORDER: readonly string[] = [
  'Owoce i warzywa',
  'Mięso i ryby',
  'Nabiał i jaja',
  'Pieczywo',
  'Kasze, makarony, płatki',
  'Strączkowe i orzechy',
  'Konserwy i sosy',
  'Tłuszcze',
  'Dodatki i słodycze',
  'Inne',
]

const RULES: readonly (readonly [string, readonly string[]])[] = [
  [
    'Mięso i ryby',
    [
      'kurczak', 'indyk', 'wolowin', 'wolowa', 'schab', 'poledwic', 'cielec', 'krolik',
      'kacz', 'szynka', 'mieso', 'kielbas', 'dorsz', 'losos', 'pstrag', 'sandacz',
      'makrela', 'tunczyk', 'krewetk', 'surimi', 'paluszki krabowe', 'rostbef', 'mintaj',
      // Kuchnia azjatycka: „Chude mielone wieprzowe" nie zawiera słowa „mięso".
      // NIE `mielone`: dopasowanie wygrywa najdłuższym trafieniem, więc siedem
      // znaków „mielone" bije sześć znaków „siemie" i „Siemię lniane mielone"
      // wędrowało z orzechów do mięsa.
      'wieprz',
    ],
  ],
  [
    'Nabiał i jaja',
    [
      'jajk', 'jaja', 'bialko jaja', 'twarog', 'jogurt', 'skyr', 'serek', 'ser', 'feta',
      'mozzarella', 'parmezan', 'mascarpone', 'mleko', 'mleczko', 'kefir', 'maslanka',
      'smietank', 'maslo',
    ],
  ],
  [
    'Pieczywo',
    ['chleb', 'bulka', 'grahamka', 'tortilla', 'pieczywo', 'chrupki', 'biszkopty', 'bulka tarta'],
  ],
  [
    'Kasze, makarony, płatki',
    [
      'kasza', 'ryz', 'makaron', 'penne', 'spaghetti', 'tagliatelle', 'swiderki', 'udon',
      'platki', 'maka', 'komosa', 'proszek budyniowy', 'kuskus', 'bulgur', 'otreby',
      // Skrobia kukurydziana stoi na tej samej półce co mąki, a reguła
      // `kukurydza` jej nie łapie — w nazwie jest „kukurydziana".
      'skrobia', 'soba',
      // Nori to suchy towar z tej samej półki. Wprost, bo bez tego dział brałby
      // się z „(płatki)" w nazwie — czyli z nawiasu, nie z produktu.
      'nori',
    ],
  ],
  [
    'Strączkowe i orzechy',
    [
      'fasola', 'ciecierzyc', 'soczewica', 'edamame', 'tofu', 'hummus', 'orzech', 'orzeszki',
      'migdal', 'sezam', 'slonecznik', 'pestki', 'siemie', 'chia', 'falafel', 'kielki',
      'wiorki kokosowe', 'tempeh',
    ],
  ],
  [
    'Konserwy i sosy',
    [
      'passata', 'przecier', 'pomidory krojone', 'salsa', 'ketchup', 'sos', 'pesto',
      'musztarda', 'majonez', 'zurawina', 'dzem', 'mus ', 'ocet', 'bulion', 'kukurydza',
      // Dłuższe warianty pesto, żeby „bazylia" w nazwie nie przeniosła słoika
      // do warzyw — dopasowanie wygrywa NAJDŁUŻSZYM trafieniem.
      'pesto zielone', 'pesto bazyliowe', 'salsa pomidorowa', 'sos teriyaki', 'ocet jablkowy',
      'oliwki', 'pieprz zielony', 'ogorek kiszony', 'ogorek konserwowy', 'surowka',
      'buraczki', 'burak gotowany', 'teriyaki', 'pasta curry', 'czerwona pasta curry',
      // Kuchnia azjatycka — słoiki i butelki, nie warzywa: kimchi jest kiszone
      // jak ogórek konserwowy, a pasty sojowe stoją obok sosów.
      'kimchi', 'mirin', 'gochujang', 'doubanjiang', 'miso', 'curry',
      // Puszka, nie lodówka: `mleczko` wysyłało kokosowe do nabiału.
      'mleczko kokosowe',
    ],
  ],
  // `olej sezamowy` wprost, bo inaczej `sezam` (5 znaków) bije `olej` (4)
  // i butelka oleju ląduje między orzechami a pestkami.
  ['Tłuszcze', ['oliwa', 'olej', 'awokado', 'olej sezamowy']],
  [
    'Dodatki i słodycze',
    [
      'erytrytol', 'miod', 'kakao', 'cynamon', 'odzywka bialkowa', 'woda', 'lod',
      'ekstrakt', 'przyprawa', 'wanili', 'syrop', 'czekolada', 'cukier',
    ],
  ],
  [
    'Owoce i warzywa',
    [
      'pomidor', 'ogorek', 'papryka', 'cukinia', 'marchew', 'ziemniak', 'batat', 'brokul',
      'szpinak', 'salata', 'rukola', 'roszponka', 'mix salat', 'cebula', 'por', 'seler',
      'burak', 'banan', 'jablko', 'truskawk', 'malin', 'borowk', 'jagod', 'kiwi', 'mango',
      'pomarancz', 'mandarynk', 'brzoskwin', 'ananas', 'limonka', 'cytryn', 'pietruszka',
      // `szczypior`, nie `szczypiorek`: obok „Szczypiorku" stoi teraz
      // „Dymka (szczypior)", a krótszy trzon łapie oba.
      'koper', 'szczypior', 'bazyli', 'imbir', 'czosnek', 'fasolka szparagowa', 'groszek',
      'pieczark', 'baklazan', 'marakuja', 'wisnie', 'sliwki', 'owoce', 'kapust', 'natka',
      'mieszanka warzyw', 'marchewka', 'sok z cytryny',
      // Dopisane po przejrzeniu CAŁEJ tabeli produktów — bez nich te pozycje
      // lądowały w dziale „Inne", czyli na końcu listy, między niczym.
      // `limonk`, nie `limonka`: w przepisach stoi „Sok z limonki".
      'rzodkiew', 'winogron', 'limonk', 'gruszk', 'kalafior', 'dynia', 'rodzynk',
      'daktyl',
      // Warzywa i zioła świeże z kuchni azjatyckiej — dopisane razem z bazą
      // obiadów azjatyckich, tą samą drogą: przez wykaz składników bez działu.
      'dymka', 'kolendra', 'grzyb', 'shiitake', 'pak choi', 'bambus',
    ],
  ],
]

/**
 * Dopasowanie po najdłuższym trafionym słowie kluczowym.
 *
 * Kolejność reguł nie może decydować sama: „ser" trafiłoby w „seler",
 * a „mus " w „musztardę". Wybieramy więc regułę, której słowo pasuje
 * NAJDŁUŻSZYM fragmentem — „seler" (5 znaków) bije „ser" (3 znaki), więc
 * seler ląduje w warzywach, a nie w nabiale.
 */
export function aisleFor(ingredientName: string): string {
  const text = normalize(ingredientName)
  let best: { aisle: string; length: number } | null = null

  for (const [aisle, terms] of RULES) {
    for (const term of terms) {
      if (!text.includes(term)) continue
      if (!best || term.length > best.length) best = { aisle, length: term.length }
    }
  }

  return best?.aisle ?? 'Inne'
}

export function aisleRank(aisle: string): number {
  const index = AISLE_ORDER.indexOf(aisle)
  return index === -1 ? AISLE_ORDER.length : index
}
