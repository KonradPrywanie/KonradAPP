import { describe, expect, it } from 'vitest'
import { RECIPES } from '@/data/recipes'
import { normalize } from '../text'
import { solveWeek, type DietCatalog, type DietDay } from '../diet/solver'
import { formatShoppingAmount } from '@/lib/format'
import {
  buildShoppingList,
  dietWeekToDays,
  groupByCategory,
  isSeasoning,
  sourceMealKey,
  withoutEatenMeals,
  type DaySource,
} from './aggregate'
import { aisleFor, AISLE_ORDER } from './aisles'
import {
  breadSlices,
  BREAD_SLICE_G,
  canonicalIngredientName,
  CANONICAL_NAMES,
  dropFromShoppingList,
} from './canonical'

const CATALOG: DietCatalog = { recipes: RECIPES }

function weekFor(seedBase: string, kcal = 1450) {
  return solveWeek({
    targets: {
      kcal,
      proteinG: Math.round((kcal * 0.3) / 4),
      fatG: Math.round((kcal * 0.3) / 9),
      carbsG: Math.round((kcal * 0.4) / 4),
    },
    mealSplit: { breakfast: 0.24, lunch: 0.3, afternoon: 0.22, dinner: 0.24 },
    restrictions: { style: 'omnivore', allergens: [], dislikedTags: [], excludedProductIds: [] },
    catalog: CATALOG,
    seedBase,
    startDate: '2026-08-01',
    maxPrepMinutes: 90,
  })
}

/** Dni tygodnia jako wejście agregacji — tak samo jak robi to repozytorium. */
function daysOf(week: ReturnType<typeof weekFor>): DaySource[] {
  const out: DaySource[] = []
  for (const { date, day } of week) {
    if (!day) continue
    out.push({
      date,
      meals: (day as DietDay).meals.map((meal) => ({ ingredients: meal.ingredients })),
    })
  }
  return out
}

describe('działy sklepu', () => {
  it('rozpoznaje dział po nazwie składnika', () => {
    expect(aisleFor('Pierś z kurczaka')).toBe('Mięso i ryby')
    expect(aisleFor('Dorsz filet')).toBe('Mięso i ryby')
    expect(aisleFor('Jogurt naturalny')).toBe('Nabiał i jaja')
    expect(aisleFor('Chleb żytni razowy')).toBe('Pieczywo')
    expect(aisleFor('Ryż basmati')).toBe('Kasze, makarony, płatki')
    expect(aisleFor('Kasza pęczak')).toBe('Kasze, makarony, płatki')
    expect(aisleFor('Ciecierzyca gotowana')).toBe('Strączkowe i orzechy')
    expect(aisleFor('Passata')).toBe('Konserwy i sosy')
    expect(aisleFor('Oliwa z oliwek')).toBe('Tłuszcze')
    expect(aisleFor('Pomidorki koktajlowe')).toBe('Owoce i warzywa')
  })

  it('KRYTYCZNE: dłuższe słowo kluczowe wygrywa — seler nie jest serem', () => {
    // Bez tej reguły „ser" trafiałby w „seler", a „mus" w „musztardę".
    expect(aisleFor('Seler')).toBe('Owoce i warzywa')
    expect(aisleFor('Ser żółty lekki')).toBe('Nabiał i jaja')
    expect(aisleFor('Musztarda francuska')).toBe('Konserwy i sosy')
    // „Mus jabłkowy" ląduje w owocach, bo „jablko" jest dłuższym trafieniem niż
    // „mus " — dopuszczalne: pozycja jest na liście, tylko o dział dalej.
    expect(aisleFor('Mus jabłkowy bez cukru')).toBe('Owoce i warzywa')
  })

  it('nieznana nazwa idzie do „Inne", nic nie znika po cichu', () => {
    expect(aisleFor('Nieistniejący wynalazek kuchenny')).toBe('Inne')
    expect(AISLE_ORDER).toContain('Inne')
  })

  it('KRYTYCZNE: KAŻDY składnik z bazy ma swój dział', () => {
    /**
     * Zero, nie „prawie zero". W FitPlannerze próg był luźny (poniżej 10% nazw
     * bez działu), bo nazwy pisali ludzie w arkuszu i lista była otwarta.
     * Tutaj składniki pochodzą z zamkniętej tabeli produktów, więc pokrycie da
     * się mieć pełne — i trzeba, bo „Inne" to koniec listy zakupów, gdzie
     * pozycja ginie między niczym.
     *
     * Znalezione dokładnie tak: przy pierwszym przejściu przez aplikację
     * w dziale „Inne" wylądowały rzodkiewka, winogrona i sok z limonki.
     * Ostatni pokazuje, dlaczego to jest TEST, a nie jednorazowy przegląd:
     * reguła miała słowo `limonka`, a w przepisach stoi „Sok z limonki".
     */
    const names = new Set(RECIPES.flatMap((r) => r.ingredients.map((i) => i.name)))
    const unknown = [...names].filter((name) => aisleFor(name) === 'Inne')
    expect(unknown, `bez działu: ${unknown.join(', ')}`).toEqual([])
  })
})

describe('buildShoppingList', () => {
  const week = weekFor('zakupy')
  const list = buildShoppingList({ weekStart: '2026-08-01', days: daysOf(week) })

  it('sumuje ten sam składnik z całego tygodnia', () => {
    const expected = new Map<string, number | null>()
    for (const { day } of week) {
      for (const meal of (day as DietDay | null)?.meals ?? []) {
        for (const ing of meal.ingredients) {
          if (isSeasoning(ing.name)) continue
          if (dropFromShoppingList(ing)) continue
          // Klucz po nazwie KANONICZNEJ — tak samo, jak sumuje agregacja.
          const key = `${normalize(canonicalIngredientName(ing.name))}|${ing.unit}`
          const current = expected.get(key)
          if (ing.amount === null) {
            if (!expected.has(key)) expected.set(key, null)
          } else {
            expected.set(key, (current ?? 0) + ing.amount)
          }
        }
      }
    }

    for (const item of list.items) {
      const key = `${normalize(item.name)}|${item.unit}`
      const sum = expected.get(key)
      if (sum === null) expect(item.amount, item.name).toBeNull()
      else expect(item.amount, item.name).toBeCloseTo(sum as number, 1)
    }
    expect(list.items).toHaveLength(expected.size)
  })

  it('KRYTYCZNE: pozycja „do smaku" nie kasuje gramatury pozostałych', () => {
    /**
     * Reguła, która zerowała całą pozycję, gdy choć jeden przepis nie podał
     * ilości, robiła szkodę: „Ogórek świeży 180 g" plus „Ogórek świeży do smaku"
     * pokazywało „do smaku" — mniej, niż wiemy. W tej bazie taki przypadek jest
     * realny, bo część produktów (czosnek, sok z cytryny) stoi w przepisach bez
     * gramatury i może trafić obok tego samego produktu zważonego.
     */
    const mixed = buildShoppingList({
      weekStart: '2026-08-01',
      days: [
        {
          date: '2026-08-01',
          meals: [
            { ingredients: [{ name: 'Ogórek świeży', amount: 180, unit: 'g' as const }] },
            { ingredients: [{ name: 'Ogórek świeży', amount: null, unit: 'g' as const }] },
          ],
        },
      ],
    })

    expect(mixed.items).toHaveLength(1)
    expect(mixed.items[0]?.amount).toBe(180)
    // Oba wystąpienia widać w pochodzeniu, więc nic nie ginie po cichu.
    expect(mixed.items[0]?.sources).toHaveLength(2)
  })

  it('nie dubluje pozycji', () => {
    const keys = list.items.map((i) => `${normalize(i.name)}|${i.unit}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('KRYTYCZNE: przypraw NIE MA na liście zakupów', () => {
    // Kolumna „Pasujące przyprawy i zioła" z arkusza dawała ponad dwadzieścia
    // pozycji „do smaku" — sól, pieprz, oregano, bazylia. Zostają w karcie
    // posiłku, przy instrukcji, bo tam są potrzebne.
    for (const item of list.items) {
      expect(isSeasoning(item.name), item.name).toBe(false)
    }
    const names = list.items.map((i) => normalize(i.name))
    for (const seasoning of ['sol', 'pieprz czarny', 'oregano', 'majeranek', 'cynamon']) {
      expect(names, seasoning).not.toContain(seasoning)
    }
    expect(list.items.some((i) => i.category === 'Przyprawy i zioła')).toBe(false)
  })

  it('KRYTYCZNE: filtr przypraw dopasowuje CAŁE SŁOWA, nie fragmenty', () => {
    /**
     * Wyszło z podglądu listy w przeglądarce: fragment „bazyli" wyrzucał „Pesto
     * zielone bazyliowe" — słoik, który trzeba kupić. Przy dopasowaniu po słowie
     * „bazylia" jest przyprawą, a „bazyliowe" przymiotnikiem w nazwie produktu.
     */
    expect(isSeasoning('Bazylia świeża')).toBe(true)
    expect(isSeasoning('Świeża bazylia')).toBe(true)
    expect(isSeasoning('Pesto zielone bazyliowe')).toBe(false)
    expect(isSeasoning('Papryka czerwona')).toBe(false)
    expect(isSeasoning('Papryka słodka')).toBe(true)
    expect(isSeasoning('Sos sojowy')).toBe(false)
    expect(isSeasoning('Serek wiejski ze szczypiorkiem')).toBe(false)

    /**
     * Na całej bazie filtr nie ma NIC do odsiania i to jest właściwość danych,
     * nie przypadek: przyprawy żyją w osobnym polu `spices`, więc do składników
     * (a tym samym na listę zakupów) nie mają jak wejść. W FitPlannerze było
     * inaczej — arkusz mieszał je ze składnikami i filtr zdejmował z listy
     * ponad dwadzieścia pozycji „do smaku".
     *
     * Filtr zostaje mimo to, bo jest drugą linią obrony: dopisanie „Sól morska"
     * do `produkty.json` byłoby błędem, którego nikt nie zauważy inaczej niż
     * po kilogramie soli na liście zakupów.
     */
    const names = [...new Set(RECIPES.flatMap((r) => r.ingredients.map((i) => i.name)))]
    const dropped = names.filter(isSeasoning)
    expect(dropped, `przyprawa wśród składników: ${dropped.join(', ')}`).toEqual([])
  })

  it('KRYTYCZNE: czosnek „do smaku" wypada, czosnek zważony zostaje', () => {
    /**
     * Prośba użytkownika. Czosnek jest w czternastu przepisach bez gramatury
     * i pozycja „Czosnek — do smaku" nie mówi nic, czego kupujący nie wie.
     * Arkusz podaje też czosnek w ząbkach — ten zostaje, bo to konkretna sztuka.
     * Filtr przypraw go nadal nie dotyczy (granulowany owszem).
     */
    expect(isSeasoning('Czosnek')).toBe(false)
    expect(isSeasoning('czosnek granulowany')).toBe(true)
    expect(aisleFor('Czosnek')).toBe('Owoce i warzywa')

    const garlic = buildShoppingList({
      weekStart: '2026-08-01',
      days: [
        {
          date: '2026-08-01',
          meals: [
            {
              ingredients: [
                { name: 'Czosnek', amount: null, unit: 'g' as const },
                { name: 'Czosnek', amount: 2, unit: 'piece' as const },
              ],
            },
          ],
        },
      ],
    })
    expect(garlic.items).toHaveLength(1)
    expect(garlic.items[0]?.amount).toBe(2)
    expect(garlic.items[0]?.unit).toBe('piece')
    expect(garlic.items[0]?.category).toBe('Owoce i warzywa')

    // Cały tydzień z jadłospisu: żadnej pozycji „czosnek bez ilości".
    const weekGarlic = list.items.filter((i) => normalize(i.name).startsWith('czosnek'))
    for (const item of weekGarlic) expect(item.amount, item.name).not.toBeNull()
  })

  it('inne składniki bez gramatury zostają na liście, w swoim dziale', () => {
    // Reguła dotyczy CZOSNKU, nie wszystkiego bez gramatury: koper czy sok
    // z cytryny „do smaku" to nadal pęczek i butelka, których może nie być w domu.
    const noAmount = buildShoppingList({
      weekStart: '2026-08-01',
      days: [
        {
          date: '2026-08-01',
          meals: [
            {
              ingredients: [
                { name: 'Koperek świeży', amount: null, unit: 'g' as const },
                { name: 'Sos sojowy', amount: null, unit: 'ml' as const },
              ],
            },
          ],
        },
      ],
    })
    expect(noAmount.items.map((i) => i.name).sort()).toEqual(['Koperek świeży', 'Sos sojowy'])
    expect(noAmount.items.every((i) => i.amount === null)).toBe(true)
  })

  it('KRYTYCZNE: pozycja pamięta, z których przepisów się zsumowała', () => {
    // Bez tego lista jest zbiorem liczb bez pochodzenia i nie da się odpowiedzieć
    // na pytanie „po co mi 240 g chleba" ani „czego nie ugotuję bez tego".
    const withSources = buildShoppingList({
      weekStart: '2026-08-01',
      days: [
        {
          date: '2026-08-01',
          meals: [{ recipeId: 'l001', ingredients: [{ name: 'Marchew', amount: 100, unit: 'g' }] }],
        },
        {
          date: '2026-08-03',
          meals: [{ recipeId: 'l002', ingredients: [{ name: 'Marchew', amount: 50, unit: 'g' }] }],
        },
      ],
    })

    const carrot = withSources.items[0]
    expect(carrot?.amount).toBe(150)
    expect(carrot?.sources).toEqual([
      { date: '2026-08-01', recipeId: 'l001', amount: 100 },
      { date: '2026-08-03', recipeId: 'l002', amount: 50 },
    ])

    // Tydzień z jadłospisu: każda pozycja ma pochodzenie i sumy się zgadzają.
    for (const item of list.items) {
      const sources = item.sources ?? []
      expect(sources.length, item.name).toBeGreaterThan(0)
      const known = sources.filter((s) => s.amount !== null)
      if (known.length === 0) {
        expect(item.amount, item.name).toBeNull()
      } else {
        const sum = known.reduce((total, s) => total + (s.amount as number), 0)
        expect(item.amount, item.name).toBeCloseTo(sum, 1)
      }
    }
  })

  it('pusty tydzień daje pustą listę, nie wyjątek', () => {
    const empty = buildShoppingList({
      weekStart: '2026-08-01',
      days: dietWeekToDays([{ date: '2026-08-01', day: null }]),
    })
    expect(empty.items).toEqual([])
  })

  it('lista tygodniowa ma sensowną skalę — kilka kilogramów, nie kilkaset gramów', () => {
    const totalG = list.items
      .filter((i) => i.unit === 'g')
      .reduce((sum, i) => sum + (i.amount ?? 0), 0)
    expect(totalG).toBeGreaterThan(5000)
    expect(totalG).toBeLessThan(40000)
  })

  it('nie miesza jednostek w jednej pozycji', () => {
    for (const item of list.items) {
      expect(['g', 'ml', 'piece'], item.name).toContain(item.unit)
    }
  })
})

describe('ujednolicanie nazw składników', () => {
  /**
   * W FITKonradzie ten mechanizm nie ma nic do roboty i to jest ZAMIERZONE:
   * nazwy składników pochodzą z zamkniętej listy w `data-source/produkty.json`,
   * więc nie ma wariantów do scalania. Testy pilnują dwóch rzeczy: że założenie
   * o zamkniętej liście naprawdę obowiązuje, i że mechanizm nadal działa, gdyby
   * kiedyś stanęły obok siebie „Ryż basmati" i „Ryż ugotowany".
   */

  /** Nazwa → suma pozycji na liście zbudowanej z podanych składników. */
  function listOf(
    ingredients: { name: string; amount: number | null; unit?: 'g' | 'ml' | 'piece' }[],
  ) {
    return buildShoppingList({
      weekStart: '2026-08-01',
      days: [
        {
          date: '2026-08-01',
          meals: ingredients.map((ingredient) => ({
            ingredients: [{ ...ingredient, unit: ingredient.unit ?? ('g' as const) }],
          })),
        },
      ],
    }).items
  }

  it('KRYTYCZNE: nazwy składników pochodzą z zamkniętej listy produktów', () => {
    /**
     * To jest test zastępujący całą tabelę wariantów z FitPlannera. Tam nazwy
     * pisali ludzie w arkuszu i „Oliwa" trafiała na listę osobno od „Oliwy
     * z oliwek", każda z połową tygodniowej ilości. Tutaj importer przerywa
     * pracę na nazwie spoza tabeli produktów, więc problem nie ma jak powstać —
     * pod warunkiem, że nikt nie dopisze przepisu z ręki do generowanego pliku.
     * Dokładnie to sprawdzamy: unikalnych nazw ma być tyle, ile pozycji użytych
     * z tabeli, a każda ma być zapisana IDENTYCZNIE we wszystkich przepisach.
     */
    const names = RECIPES.flatMap((recipe) => recipe.ingredients.map((i) => i.name))
    const byNormalized = new Map<string, Set<string>>()
    for (const name of names) {
      const key = normalize(name)
      const bucket = byNormalized.get(key) ?? new Set<string>()
      bucket.add(name)
      byNormalized.set(key, bucket)
    }

    const inconsistent = [...byNormalized.values()]
      .filter((variants) => variants.size > 1)
      .map((variants) => [...variants].join(' / '))
    expect(inconsistent, `nazwy zapisane różnie: ${inconsistent.join('; ')}`).toEqual([])
    expect(byNormalized.size).toBeGreaterThan(50)
  })

  it('tabela wariantów jest pusta — nie ma czego scalać', () => {
    expect(CANONICAL_NAMES).toEqual([])
    expect(canonicalIngredientName('Oliwa z oliwek')).toBe('Oliwa z oliwek')
    expect(canonicalIngredientName('Wynalazek kuchenny')).toBe('Wynalazek kuchenny')
  })

  it('KRYTYCZNE: pusta tabela NICZEGO nie scala po cichu', () => {
    /**
     * Gdyby `canonicalIngredientName` zaczęło działać „po podobieństwie",
     * to właśnie te pary zostałyby zsumowane w jedną pozycję: ryż ugotowany
     * waży prawie trzy razy tyle co suchy, wędzone to inna półka niż świeże,
     * a kiszone to inny słoik. Test zostaje z FitPlannera, bo szkoda byłaby
     * ta sama, a przy zerowej tabeli jest darmowy.
     */
    const pairs: [string, string][] = [
      ['Ryż basmati', 'Ryż ugotowany'],
      ['Łosoś świeży', 'Łosoś wędzony'],
      ['Pierś z kurczaka', 'Pierś z kurczaka wędzona'],
      ['Ogórek świeży', 'Ogórek kiszony'],
      ['Pomidor', 'Pomidory suszone'],
      ['Chleb żytni razowy', 'Pieczywo chrupkie żytnie'],
      ['Masło', 'Masło orzechowe 100%'],
    ]
    for (const [a, b] of pairs) {
      expect(canonicalIngredientName(a), `${a} / ${b}`).not.toBe(canonicalIngredientName(b))
      expect(listOf([{ name: a, amount: 100 }, { name: b, amount: 100 }]), `${a} / ${b}`)
        .toHaveLength(2)
    }
  })

  it('mechanizm nadal potrafi scalić, gdy poda mu się grupę', () => {
    // Dowód, że pusta tabela to decyzja o DANYCH, a nie martwy kod: ta sama
    // funkcja agregująca sumuje pozycje o identycznej nazwie i jednostce.
    expect(listOf([
      { name: 'Oliwa z oliwek', amount: 10 },
      { name: 'Oliwa z oliwek', amount: 5 },
    ])).toEqual([expect.objectContaining({ name: 'Oliwa z oliwek', amount: 15 })])
  })
})

describe('chleb w kromkach', () => {
  it('KRYTYCZNE: przelicza gramy na kromki po 35 g', () => {
    // Arkuszowe porcje 30, 40 i 70 g to jedna, jedna i dwie kromki — tak, jak
    // te przepisy są napisane.
    expect(BREAD_SLICE_G).toBe(35)
    expect(breadSlices({ name: 'Chleb razowy', amount: 35, unit: 'g' })).toBe(1)
    expect(breadSlices({ name: 'Chleb razowy', amount: 70, unit: 'g' })).toBe(2)
    expect(breadSlices({ name: 'Chleb żytni', amount: 30, unit: 'g' })).toBe(1)
    // Zaokrąglenie do połówek: pół kromki to realna porcja, 1,7 kromki nie.
    expect(breadSlices({ name: 'Chleb razowy', amount: 130, unit: 'g' })).toBe(3.5)
  })

  it('nie przelicza pieczywa, którego nie kroi się na kromki', () => {
    expect(breadSlices({ name: 'Pieczywo chrupkie', amount: 20, unit: 'g' })).toBeNull()
    expect(breadSlices({ name: 'Chleb chrupki żytni', amount: 20, unit: 'g' })).toBeNull()
    expect(breadSlices({ name: 'Bułka grahamka', amount: 60, unit: 'g' })).toBeNull()
    expect(breadSlices({ name: 'Tortilla pełnoziarnista', amount: 60, unit: 'g' })).toBeNull()
    expect(breadSlices({ name: 'Marchew', amount: 100, unit: 'g' })).toBeNull()
    // Bez gramatury nie ma czego przeliczać.
    expect(breadSlices({ name: 'Chleb razowy', amount: null, unit: 'g' })).toBeNull()
  })

  it('pokazuje kromki z gramami w nawiasie, z polską odmianą', () => {
    const bread = (amount: number) =>
      formatShoppingAmount({ name: 'Chleb razowy', amount, unit: 'g' })
    expect(bread(35)).toBe('1 kromka (35 g)')
    expect(bread(105)).toBe('3 kromki (105 g)')
    expect(bread(210)).toBe('6 kromek (210 g)')
    expect(bread(220)).toBe('6,5 kromki (220 g)')
    expect(bread(130)).toBe('3,5 kromki (130 g)')
    // Pozostałe pozycje bez zmian.
    expect(formatShoppingAmount({ name: 'Marchew', amount: 360, unit: 'g' })).toBe('360 g')
    expect(formatShoppingAmount({ name: 'Jajko', amount: 4, unit: 'piece' })).toBe('4 szt')
    expect(formatShoppingAmount({ name: 'Koper świeży', amount: null, unit: 'g' })).toBe('do smaku')
  })

  it('chleb z kilku posiłków to jedna pozycja, pieczywo chrupkie osobna', () => {
    /**
     * Chleb z czterech posiłków sumuje się w jeden bochenek, bo w tej bazie
     * nazywa się wszędzie tak samo. Pieczywo chrupkie zostaje OSOBNO i to jest
     * sedno testu: jego „kromka" waży około dziesięciu gramów, więc przeliczenie
     * na kromki dałoby przy tej samej gramaturze trzy razy większą liczbę.
     */
    const bread = buildShoppingList({
      weekStart: '2026-08-01',
      days: [
        {
          date: '2026-08-01',
          meals: [
            { ingredients: [{ name: 'Chleb żytni razowy', amount: 30, unit: 'g' }] },
            { ingredients: [{ name: 'Chleb żytni razowy', amount: 40, unit: 'g' }] },
            { ingredients: [{ name: 'Chleb żytni razowy', amount: 30, unit: 'g' }] },
            { ingredients: [{ name: 'Chleb żytni razowy', amount: 40, unit: 'g' }] },
            { ingredients: [{ name: 'Pieczywo chrupkie żytnie', amount: 20, unit: 'g' }] },
          ],
        },
      ],
    })

    expect(bread.items).toHaveLength(2)
    expect(bread.items.find((i) => i.name === 'Chleb żytni razowy')?.amount).toBe(140)
    expect(bread.items.find((i) => i.name === 'Pieczywo chrupkie żytnie')?.amount).toBe(20)
    expect(formatShoppingAmount(bread.items.find((i) => i.name === 'Chleb żytni razowy')!)).toBe(
      '4 kromki (140 g)',
    )
  })
})

describe('lista bez posiłków już zjedzonych', () => {
  /**
   * Lista zakupów odpowiada na pytanie „co jeszcze muszę kupić". Składniki
   * obiadu zjedzonego w poniedziałek nie są już odpowiedzią, więc schodzą
   * z listy — a po cofnięciu wpisu wracają, bo filtr działa przy wyświetlaniu
   * i nie rusza zapisanej listy.
   */
  const list = buildShoppingList({
    weekStart: '2026-08-01',
    days: [
      {
        date: '2026-08-01',
        meals: [
          {
            recipeId: 'l001',
            ingredients: [
              { name: 'Marchew', amount: 100, unit: 'g' },
              { name: 'Ryż basmati', amount: 80, unit: 'g' },
            ],
          },
          { recipeId: 'd001', ingredients: [{ name: 'Ryż basmati', amount: 60, unit: 'g' }] },
        ],
      },
      {
        date: '2026-08-02',
        meals: [{ recipeId: 'l001', ingredients: [{ name: 'Marchew', amount: 50, unit: 'g' }] }],
      },
    ],
  })

  const item = (name: string, items = list.items) => items.find((i) => i.name === name)

  it('startowa lista sumuje cały tydzień', () => {
    expect(item('Marchew')?.amount).toBe(150)
    expect(item('Ryż basmati')?.amount).toBe(140)
  })

  it('KRYTYCZNE: zjedzony posiłek odejmuje SWOJĄ ilość, nie całą pozycję', () => {
    // Obiad z 1 sierpnia zjedzony: marchew traci 100 g z tego dnia, ale zostają
    // 50 g z 2 sierpnia. Ryż traci porcję obiadu, zostaje porcja kolacji.
    const left = withoutEatenMeals(list.items, new Set(['2026-08-01|l001']))
    expect(item('Marchew', left)?.amount).toBe(50)
    expect(item('Marchew', left)?.sources).toEqual([
      { date: '2026-08-02', recipeId: 'l001', amount: 50 },
    ])
    expect(item('Ryż basmati', left)?.amount).toBe(60)
  })

  it('KRYTYCZNE: pozycja bez pozostałych źródeł znika z listy', () => {
    const left = withoutEatenMeals(
      list.items,
      new Set(['2026-08-01|l001', '2026-08-02|l001', '2026-08-01|d001']),
    )
    expect(left).toEqual([])
  })

  it('KRYTYCZNE: klucz to data I przepis — ten sam obiad w innym dniu zostaje', () => {
    /**
     * Obiad gotowany na zapas stoi w planie dwa dni z rzędu jako ten sam
     * przepis. Zjedzenie pierwszego dnia nie może zdejmować z listy porcji
     * na dzień drugi — inaczej po sobocie znikałyby zakupy na niedzielę.
     */
    expect(sourceMealKey({ date: '2026-08-01', recipeId: 'l001' })).toBe('2026-08-01|l001')
    const left = withoutEatenMeals(list.items, new Set(['2026-08-01|l001']))
    expect(item('Marchew', left)?.amount).toBe(50)
  })

  it('pusty zbiór zjedzonych nie zmienia niczego', () => {
    expect(withoutEatenMeals(list.items, new Set())).toEqual(list.items)
  })

  it('zachowuje odhaczenie pozycji, która została pomniejszona', () => {
    // Odhaczenia żyją w zapisanej liście i mają przeżyć zawężenie — inaczej
    // kupiona marchewka „odkupywałaby się" po każdym zalogowanym posiłku.
    const checked = list.items.map((i) => ({ ...i, checked: true }))
    const left = withoutEatenMeals(checked, new Set(['2026-08-01|l001']))
    expect(left.every((i) => i.checked)).toBe(true)
  })

  it('„do smaku" zostaje „do smaku", ale nie kasuje znanych gramatur', () => {
    /**
     * Ta sama reguła, co przy budowaniu listy: liczy się suma ilości ZNANYCH.
     * Gdyby po odjęciu zjedzonego posiłku pozycja wracała do „do smaku",
     * wiedzielibyśmy o niej MNIEJ, niż wiemy.
     */
    const mixed = buildShoppingList({
      weekStart: '2026-08-01',
      days: [
        {
          date: '2026-08-01',
          meals: [
            { recipeId: 'l001', ingredients: [{ name: 'Sos sojowy', amount: null, unit: 'ml' }] },
            { recipeId: 'd001', ingredients: [{ name: 'Sos sojowy', amount: 30, unit: 'ml' }] },
          ],
        },
      ],
    })

    expect(item('Sos sojowy', mixed.items)?.amount).toBe(30)
    // Zjedzony obiad („do smaku") — zostaje kolacja z gramaturą.
    const withoutLunch = withoutEatenMeals(mixed.items, new Set(['2026-08-01|l001']))
    expect(item('Sos sojowy', withoutLunch)?.amount).toBe(30)
    // Zjedzona kolacja — zostaje samo „do smaku", bo tyle wiemy.
    const withoutDinner = withoutEatenMeals(mixed.items, new Set(['2026-08-01|d001']))
    expect(item('Sos sojowy', withoutDinner)?.amount).toBeNull()
  })

  it('pozycje ze starych list (bez pochodzenia) zostają nietknięte', () => {
    // Listy zbudowane przed dopisaniem `sources` nie wiedzą, z czego się wzięły.
    // Ukrycie ich byłoby zgadywaniem — wystarczy przebudować listę.
    const legacy = [{ name: 'Marchew', amount: 300, unit: 'g' as const, category: 'Owoce i warzywa', checked: false }]
    expect(withoutEatenMeals(legacy, new Set(['2026-08-01|l001']))).toEqual(legacy)
  })
})

describe('groupByCategory', () => {
  const list = buildShoppingList({
    weekStart: '2026-08-01',
    days: daysOf(weekFor('grupy', 1400)),
  })

  it('grupuje bez gubienia pozycji', () => {
    const groups = groupByCategory(list.items)
    expect(groups.flatMap((g) => g.items)).toHaveLength(list.items.length)
  })

  it('każda pozycja trafia do swojej kategorii', () => {
    for (const group of groupByCategory(list.items)) {
      for (const item of group.items) {
        expect(item.category).toBe(group.category)
      }
    }
  })

  it('kolejność działów odpowiada obchodowi sklepu, nie alfabetowi', () => {
    const categories = groupByCategory(list.items).map((g) => g.category)
    const produce = categories.indexOf('Owoce i warzywa')
    const grains = categories.indexOf('Kasze, makarony, płatki')
    // Alfabetycznie „Kasze" byłyby przed „Owocami" — sprawdzamy, że nie są.
    if (produce !== -1 && grains !== -1) expect(produce).toBeLessThan(grains)
  })
})
