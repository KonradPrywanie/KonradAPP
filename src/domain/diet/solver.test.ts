import { describe, expect, it } from 'vitest'
import type { DietRestrictions, MealSplit, Recipe } from '../types'
import { RECIPES } from '@/data/recipes'
import { isRecipeEligible, normalize } from './eligibility'
import { recipeAllergens, recipeDietStyles } from './derive'
import { roundAmount } from './scaling'
import { macros } from '../calc/macros'
import { plannedMealTargets } from './sweetSnack'
import {
  DEFAULT_TOLERANCE,
  MEAL_SLOTS,
  findSubstitutes,
  solveDay,
  solveWeek,
  type DietCatalog,
  type DietDay,
  type SolveDayInput,
} from './solver'

const CATALOG: DietCatalog = { recipes: RECIPES }

const SPLIT: MealSplit = { breakfast: 0.24, lunch: 0.3, afternoon: 0.22, dinner: 0.24 }

function restrictions(patch: Partial<DietRestrictions> = {}): DietRestrictions {
  return {
    style: 'omnivore',
    allergens: [],
    dislikedTags: [],
    excludedProductIds: [],
    ...patch,
  }
}

/**
 * Cele liczone TAK SAMO jak w aplikacji, nie wpisane z ręki.
 *
 * Wcześniej stały tu liczby dobrane pod ówczesną bazę i to był cichy problem:
 * test mierzył solver na budżecie, którego aplikacja nigdy mu nie poda. Teraz
 * droga jest ta sama co w `dietRepo`: makra z profilu (`macros`) minus rezerwa
 * na słodką przekąskę (`plannedMealTargets`).
 *
 * Masa ma znaczenie i dlatego jest parametrem: białko liczy się w gramach na
 * kilogram, a kalorie są podane wprost. Ta sama osoba przy 2500 i 3000 kcal ma
 * ten sam cel białkowy, więc testowanie obu skrajności na jednej wadze mierzyłoby
 * przypadek, który w praktyce nie występuje — 3000 kcal je ktoś cięższy.
 */
function input(
  dailyKcal: number,
  weightKg: number,
  patch: Partial<SolveDayInput> = {},
): SolveDayInput {
  const daily = macros({ kcal: dailyKcal, goal: 'bulk', weightKg, heightCm: 180 }).macros
  return {
    targets: plannedMealTargets(daily),
    mealSplit: SPLIT,
    restrictions: restrictions(),
    catalog: CATALOG,
    seed: 'test',
    maxPrepMinutes: 45,
    ...patch,
  }
}

// ════════════════════════════════════════════════════════════════════
//  BRAMKA GO/NO-GO — kcal ±5%, każde makro ±10%
// ════════════════════════════════════════════════════════════════════

describe('BRAMKA: solver trafia w kalorie i makra', () => {
  /**
   * Oba cele, pod które napisana jest baza, plus środek zakresu i po jednym
   * kroku w bok. Masy dobrane realistycznie: 2500 kcal je ktoś lżejszy niż ten,
   * kto je 3000.
   */
  const cases: { label: string; dailyKcal: number; weightKg: number }[] = [
    { label: '2500 kcal — dolny preset, 75 kg', dailyKcal: 2500, weightKg: 75 },
    { label: '2650 kcal — między presetami, 80 kg', dailyKcal: 2650, weightKg: 80 },
    { label: '2750 kcal — środek, pod który pisana jest baza, 85 kg', dailyKcal: 2750, weightKg: 85 },
    { label: '2900 kcal — między presetami, 90 kg', dailyKcal: 2900, weightKg: 90 },
    { label: '3000 kcal — górny preset, 95 kg', dailyKcal: 3000, weightKg: 95 },
    { label: '3000 kcal przy 85 kg — lżejszy człowiek na nadwyżce', dailyKcal: 3000, weightKg: 85 },
    { label: '2500 kcal przy 95 kg — cięższy człowiek na deficycie', dailyKcal: 2500, weightKg: 95 },
  ]

  for (const testCase of cases) {
    it(testCase.label, () => {
      const args = input(testCase.dailyKcal, testCase.weightKg)
      const day = solveDay(args)

      expect(day, 'solver nie znalazł rozwiązania').not.toBeNull()
      const result = day as DietDay

      // Diagnostyka trafia do komunikatu, żeby po awarii nie trzeba było debugować.
      const report =
        `cel ${args.targets.kcal} kcal / ${args.targets.proteinG}B / ` +
        `${args.targets.fatG}T / ${args.targets.carbsG}W → ` +
        `wyszło ${result.totals.kcal} / ${result.totals.proteinG} / ` +
        `${result.totals.fatG} / ${result.totals.carbsG} ` +
        `(odchylenia: ${result.deviation.kcalPct}% / ${result.deviation.proteinPct}% / ` +
        `${result.deviation.fatPct}% / ${result.deviation.carbsPct}%)`

      expect(Math.abs(result.deviation.kcalPct), report).toBeLessThanOrEqual(5)
      expect(Math.abs(result.deviation.proteinPct), report).toBeLessThanOrEqual(10)
      expect(Math.abs(result.deviation.fatPct), report).toBeLessThanOrEqual(10)
      expect(Math.abs(result.deviation.carbsPct), report).toBeLessThanOrEqual(10)
      expect(result.withinTolerance, report).toBe(true)
    })
  }
})

/**
 * ZAKRES BAZY — przepisy są pisane na 2750 kcal dziennie.
 *
 * Cztery posiłki sumują się do ~2550 kcal, a solver może je przeskalować
 * o 25% w każdą stronę, więc baza sięga od ~1910 do ~3185 kcal na posiłki,
 * czyli od ~2110 do ~3385 kcal dziennie razem z przekąską. Oba presety
 * (2500 i 3000) leżą w środku tego przedziału i to jest cały sens takiego
 * doboru porcji.
 *
 * Poza przedziałem dzień wychodzi poniżej albo powyżej celu i aplikacja mówi to
 * wprost (`dietRepo.generateWeek` zwraca `belowTargetDays`). Nie „naprawiamy"
 * tego poszerzeniem skalowania — porcja ×1,6 to nie jest już ten sam przepis —
 * ani poluzowaniem bramki.
 */
describe('ZAKRES BAZY: poza ~2110–3385 kcal dziennie dzień nie trafia w cel', () => {
  it('3800 kcal jest ponad sufitem — solver daje maksymalne porcje i mówi „mniej"', () => {
    const result = solveDay(input(3800, 105)) as DietDay
    expect(result).not.toBeNull()

    // Solver robi, co może: maksymalna porcja każdego posiłku.
    expect(result.meals.every((meal) => meal.scale === 1.25)).toBe(true)
    expect(result.deviation.kcalPct).toBeLessThan(-5)
    expect(result.withinTolerance).toBe(false)
  })

  it('1800 kcal jest pod podłogą — solver daje minimalne porcje i przekracza cel', () => {
    const result = solveDay(input(1800, 60)) as DietDay
    expect(result).not.toBeNull()

    expect(result.meals.every((meal) => meal.scale === 0.75)).toBe(true)
    expect(result.deviation.kcalPct).toBeGreaterThan(5)
    expect(result.withinTolerance).toBe(false)
  })

  it('sufit jest tam, gdzie liczy go baza — nie niżej', () => {
    const best = solveDay(input(4200, 110)) as DietDay
    // Najcięższy możliwy dzień: ~2550 kcal × 1,25 ≈ 3185.
    expect(best.totals.kcal).toBeGreaterThan(3050)
    expect(best.totals.kcal).toBeLessThan(3250)
  })
})

describe('BRAMKA: porcje są realne', () => {
  const day = solveDay(input(2750, 85)) as DietDay

  it('ilości są wielokrotnościami kroku odmierzania', () => {
    for (const meal of day.meals) {
      for (const ing of meal.ingredients) {
        if (ing.amount === null) continue
        const step = ing.unit === 'piece' ? 0.5 : 5
        expect(
          Math.round((ing.amount / step) * 1000) % 1000,
          `${ing.name}: ${ing.amount} ${ing.unit} nie dzieli się przez ${step}`,
        ).toBe(0)
      }
    }
  })

  it('sztuki występują w połówkach albo całościach — nigdy 0,7 jajka', () => {
    let checked = 0
    for (const meal of day.meals) {
      for (const ing of meal.ingredients) {
        if (ing.unit !== 'piece' || ing.amount === null) continue
        checked++
        expect((ing.amount * 2) % 1, `${ing.name}: ${ing.amount} szt`).toBe(0)
        expect(ing.amount).toBeGreaterThanOrEqual(0.5)
      }
    }
    // Test bez pokrycia nic nie dowodzi — sztuki muszą wystąpić w tygodniu.
    const week = solveWeek({ ...input(2750, 85), startDate: '2026-08-01', seedBase: 'sztuki' })
    const pieces = week
      .flatMap((entry) => entry.day?.meals ?? [])
      .flatMap((meal) => meal.ingredients)
      .filter((ing) => ing.unit === 'piece')
    expect(checked + pieces.length).toBeGreaterThan(0)
  })

  it('żadna ilość nie jest zerowa ani ujemna', () => {
    for (const meal of day.meals) {
      for (const ing of meal.ingredients) {
        if (ing.amount === null) continue
        expect(ing.amount, ing.name).toBeGreaterThan(0)
      }
    }
  })

  it('składniki bez gramatury zostają bez gramatury', () => {
    // „Czosnek" i „Sok z cytryny" nie mają ilości w arkuszu. Dopisanie im
    // liczby przy skalowaniu byłoby wymyślaniem danych.
    const withoutAmount = day.meals
      .flatMap((meal) => meal.ingredients)
      .filter((ing) => ing.amount === null)
    for (const ing of withoutAmount) {
      expect(ing.name).toBeTruthy()
    }
  })

  it('generuje dokładnie cztery posiłki w kolejności slotów', () => {
    // Cztery, nie pięć: słodka przekąska ma odłożony budżet i jest wpisywana
    // ręcznie, więc solver jej nie układa. Kolejność jest znacząca — indeks
    // w tej tablicy jest indeksem slotu w `findSubstitutes`.
    expect(day.meals).toHaveLength(4)
    expect(day.meals.map((m) => m.slot)).toEqual(['breakfast', 'lunch', 'afternoon', 'dinner'])
  })

  it('mnożnik porcji mieści się w granicach przepisu', () => {
    for (const meal of day.meals) {
      const recipe = RECIPES.find((r) => r.id === meal.recipeId) as Recipe
      expect(recipe).toBeDefined()
      expect(meal.scale).toBeGreaterThanOrEqual(recipe.minScale - 1e-9)
      expect(meal.scale).toBeLessThanOrEqual(recipe.maxScale + 1e-9)
    }
  })

  it('makro posiłku to makro przepisu pomnożone przez porcję', () => {
    for (const meal of day.meals) {
      const recipe = RECIPES.find((r) => r.id === meal.recipeId) as Recipe
      expect(meal.macros.kcal).toBe(Math.round(recipe.macros.kcal * meal.scale))
    }
  })
})

// ════════════════════════════════════════════════════════════════════
//  Wykluczenia — warunek konieczny, nie preferencja
// ════════════════════════════════════════════════════════════════════

describe('wykluczenia żywieniowe', () => {
  it('nigdy nie proponuje przepisu z wykluczonym alergenem', () => {
    const day = solveDay(
      input(2600, 80, { restrictions: restrictions({ allergens: ['fish', 'nuts'] }) }),
    )
    expect(day).not.toBeNull()

    for (const meal of (day as DietDay).meals) {
      const recipe = RECIPES.find((r) => r.id === meal.recipeId) as Recipe
      expect(recipeAllergens(recipe), meal.recipeId).not.toContain('fish')
      expect(recipeAllergens(recipe), meal.recipeId).not.toContain('nuts')
    }
  })

  it('ZNANE OGRANICZENIE: laktoza plus gluten kasuje cały slot śniadaniowy', () => {
    /**
     * To właściwość bazy, nie błąd solvera, i lepiej ją mieć zapisaną niż
     * odkrywać przy pierwszym profilu z nietolerancją. Śniadania stoją tu na
     * nabiale i pieczywie: po odjęciu obu zostaje ZERO pozycji, więc dzień nie
     * ma rozwiązania i solver zwraca `null` zamiast udawać, że coś ułożył.
     * Rozbudowa bazy o śniadania bezmleczne i bezglutenowe jest jedynym
     * wyjściem — poluzowanie filtra alergenów nim NIE jest.
     */
    const day = solveDay(
      input(2600, 80, { restrictions: restrictions({ allergens: ['lactose', 'gluten'] }) }),
    )
    expect(day).toBeNull()
  })

  it('dieta wegetariańska używa wyłącznie przepisów wegetariańskich', () => {
    const day = solveDay(input(2600, 80, { restrictions: restrictions({ style: 'vegetarian' }) }))
    expect(day).not.toBeNull()

    for (const meal of (day as DietDay).meals) {
      const recipe = RECIPES.find((r) => r.id === meal.recipeId) as Recipe
      expect(recipeDietStyles(recipe), meal.recipeId).toContain('vegetarian')
    }
  })

  it('respektuje „czego nie jem" po nazwie składnika', () => {
    const day = solveDay(
      input(2600, 80, { restrictions: restrictions({ dislikedTags: ['twaróg', 'łosoś'] }) }),
    ) as DietDay
    const names = day.meals.flatMap((m) => m.ingredients.map((i) => normalize(i.name)))
    expect(names.some((n) => n.includes('twarog'))).toBe(false)
    expect(names.some((n) => n.includes('losos'))).toBe(false)
  })

  it('dopasowuje wykluczenia bez polskich znaków diakrytycznych', () => {
    expect(normalize('Twaróg półtłusty')).toBe('twarog poltlusty')
    const day = solveDay(
      input(2600, 80, { restrictions: restrictions({ dislikedTags: ['twarog'] }) }),
    ) as DietDay
    const names = day.meals.flatMap((m) => m.ingredients.map((i) => normalize(i.name)))
    expect(names.some((n) => n.includes('twarog'))).toBe(false)
  })

  it('zwraca null, gdy wykluczenia nie pozostawiają opcji dla któregoś posiłku', () => {
    // Wegańskich śniadań i obiadów nie ma w tej bazie ani jednego, więc sama
    // dieta wegańska wystarczy, żeby dzień nie miał rozwiązania.
    const day = solveDay(input(2600, 80, { restrictions: restrictions({ style: 'vegan' }) }))
    expect(day).toBeNull()
  })

  it('isRecipeEligible zgadza się z wynikiem solvera', () => {
    const r = restrictions({ style: 'vegetarian' })
    const vegetarian = RECIPES.filter((recipe) => isRecipeEligible(recipe, r))
    expect(vegetarian.length).toBeGreaterThan(0)
    for (const recipe of vegetarian) {
      expect(recipeDietStyles(recipe)).toContain('vegetarian')
    }
  })
})

/**
 * ZNANE OGRANICZENIE: ścieżka roślinna w tej bazie jest cienka.
 *
 * Wegańskich przepisów nie ma praktycznie wcale (0 śniadań, 0 obiadów),
 * a wegetariańskich obiadów jest trzy na czterdzieści dwa. Baza była pisana pod
 * dietę mięsno-rybną przy 2500–3000 kcal i to jest jej właściwość, nie błąd
 * aplikacji. Zapisujemy ją testem, żeby nikt nie założył działania, którego nie ma.
 */
describe('ZNANE OGRANICZENIE: ścieżka roślinna', () => {
  it('wegańska nie ma rozwiązania — brak śniadań i obiadów', () => {
    expect(solveDay(input(2600, 80, { restrictions: restrictions({ style: 'vegan' }) }))).toBeNull()
  })

  it('wegetariańska TRAFIA w makra — cenę płaci różnorodnością, nie bilansem', () => {
    /**
     * Zmierzone, nie założone: pojedynczy dzień wegetariański mieści się
     * w tolerancji co do wszystkich czterech wartości. Ograniczeniem nie jest
     * więc bilans, tylko WYBÓR — obiadów wegetariańskich są trzy na czterdzieści
     * dwa, więc tydzień stoi na trzech obiadach zamiast siedmiu i po miesiącu
     * wykluczenia historii nie mają czego wykluczać.
     *
     * To jest realna wada bazy i lepiej mieć ją zmierzoną niż opisaną z głowy:
     * gdyby ktoś dopisał wegetariańskie obiady, ten test zacznie padać
     * i wymusi podniesienie progu — czyli dokładnie to, o co chodzi.
     */
    const day = solveDay(
      input(2600, 80, { restrictions: restrictions({ style: 'vegetarian' }) }),
    ) as DietDay
    expect(day).not.toBeNull()
    expect(day.withinTolerance).toBe(true)

    const week = solveWeek({
      ...input(2600, 80, { restrictions: restrictions({ style: 'vegetarian' }) }),
      startDate: '2026-08-01',
      seedBase: 'wege',
    })
    const lunches = week.map(
      (entry) => (entry.day as DietDay).meals.find((m) => m.slot === 'lunch')?.recipeId,
    )
    expect(new Set(lunches).size, `różnych obiadów: ${new Set(lunches).size}/7`).toBeLessThanOrEqual(4)
  })
})

// ════════════════════════════════════════════════════════════════════
//  Determinizm i różnorodność
// ════════════════════════════════════════════════════════════════════

describe('determinizm', () => {
  it('to samo ziarno daje identyczny jadłospis', () => {
    const a = solveDay(input(2750, 85, { seed: 'poniedzialek' }))
    const b = solveDay(input(2750, 85, { seed: 'poniedzialek' }))
    expect(a).toEqual(b)
  })

  it('różne ziarna dają różne jadłospisy, gdy cel daje swobodę', () => {
    /**
     * Cel 1300 kcal, nie 1450: przy budżecie blisko sufitu bazy optimum jest
     * JEDNO (najcięższe pozycje w maksymalnej porcji), więc każde ziarno musi
     * do niego dojść — i to jest poprawne zachowanie, nie brak losowości.
     * Ziarno rozstrzyga tylko tam, gdzie kilka dni jest równie dobrych.
     */
    const seeds = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6']
    const signatures = seeds.map((seed) => {
      const day = solveDay(input(2500, 75, { seed })) as DietDay
      return day.meals.map((m) => m.recipeId).join('|')
    })
    expect(new Set(signatures).size).toBeGreaterThan(1)
  })
})

describe('solveWeek', () => {
  const week = solveWeek({
    ...input(2750, 85),
    startDate: '2026-08-01',
    seedBase: 'tydzien-1',
  })

  it('generuje siedem dni z kolejnymi datami', () => {
    expect(week).toHaveLength(7)
    expect(week[0]?.date).toBe('2026-08-01')
    expect(week[6]?.date).toBe('2026-08-07')
  })

  it('każdy dzień trafia w tolerancję', () => {
    for (const entry of week) {
      expect(entry.day, entry.date).not.toBeNull()
      expect((entry.day as DietDay).withinTolerance, entry.date).toBe(true)
    }
  })

  it('kolejne dni nie są identyczne', () => {
    for (let i = 1; i < week.length; i++) {
      const previous = (week[i - 1]?.day as DietDay).meals.map((m) => m.recipeId).join('|')
      const current = (week[i]?.day as DietDay).meals.map((m) => m.recipeId).join('|')
      expect(current, `dzień ${i}`).not.toBe(previous)
    }
  })

  /**
   * REGRESJA: to samo danie wracało cały tydzień.
   *
   * Poprzednia wersja tego testu porównywała tylko dni SĄSIEDNIE, więc
   * przepuszczała układ A-B-A-B-A-B-A — a dokładnie taki wychodził: solver co
   * dzień rozwiązuje to samo zadanie i bez twardych wykluczeń wybiera to samo
   * minimum. Miękka kara (wtedy 0,4 w koszcie) nie miała szans przy koszcie
   * makro rzędu kilkudziesięciu jednostek. Przy 2207 kcal cały tydzień stał na
   * jednym obiedzie.
   *
   * Dlatego mierzymy CAŁY tydzień, per slot. Progu nie stawiamy na siedmiu
   * z siedmiu świadomie: przy celu blisko sufitu bazy (trzy posiłki to
   * 1080–1225 kcal, skalowanie najwyżej ×1,2) w slocie zostaje kilka przepisów,
   * które w makra trafiają, a wtedy tolerancja wygrywa z różnorodnością — patrz
   * kolejny test. Pięć z siedmiu to granica, poniżej której jadłospis znów
   * zaczyna stać na jednym daniu.
   */
  it('KRYTYCZNE: jadłospis nie stoi na jednym daniu przez cały tydzień', () => {
    for (const slot of MEAL_SLOTS) {
      const ids = week.map(
        (entry) => (entry.day as DietDay).meals.find((m) => m.slot === slot)?.recipeId,
      )
      expect(new Set(ids).size, `${slot}: ${ids.join(', ')}`).toBeGreaterThanOrEqual(5)
    }
  })

  it('KRYTYCZNE: żaden posiłek nie wraca dzień po dniu', () => {
    // Bez gotowania na zapas (`lunchBatchDays: 1`) powtórka z dnia na dzień jest
    // najbardziej widoczna i najbardziej męcząca — to samo na obiad dwa dni
    // z rzędu poznaje się bez patrzenia w plan.
    for (let i = 1; i < week.length; i++) {
      for (const slot of MEAL_SLOTS) {
        const mealOf = (index: number) =>
          (week[index]?.day as DietDay).meals.find((m) => m.slot === slot)?.recipeId
        expect(mealOf(i), `${slot}, dzień ${i}`).not.toBe(mealOf(i - 1))
      }
    }
  })

  it('KRYTYCZNE: drugi tydzień nie jest kopią pierwszego', () => {
    // Bez historii poprzedniego tygodnia solver dostaje identyczne zadanie
    // i zwraca identyczny wynik — plan na dwa tygodnie byłby tym samym
    // tygodniem dwa razy, dzień w dzień.
    const first = week.flatMap((entry) => (entry.day as DietDay).meals.map((m) => m.recipeId))
    const second = solveWeek({
      ...input(2750, 85),
      startDate: '2026-08-08',
      seedBase: 'tydzien-1',
      recentRecipeIds: first,
    })

    const secondIds = second.flatMap((entry) => (entry.day as DietDay).meals.map((m) => m.recipeId))
    const fresh = secondIds.filter((id) => !first.includes(id))
    // Połowa drugiego tygodnia to dania, których w pierwszym nie było. Reszta
    // wraca tylko tam, gdzie ratuje makra — nigdy jako cały tydzień.
    expect(fresh.length, `świeżych: ${fresh.length}/21`).toBeGreaterThanOrEqual(10)
  })

  it('różnorodność ustępuje tolerancji, nie odwrotnie', () => {
    /**
     * Historia „zużyj wszystko" — wykluczamy najlepiej dopasowane przepisy
     * pierwszego tygodnia. Dzień, który po wykluczeniach wypadałby poza makra,
     * ma wrócić do przepisu z historii, bo bramką projektu są makra.
     */
    const first = week.flatMap((entry) => (entry.day as DietDay).meals.map((m) => m.recipeId))
    const second = solveWeek({
      ...input(2750, 85),
      startDate: '2026-08-08',
      seedBase: 'tydzien-2',
      recentRecipeIds: first,
    })

    for (const entry of second) {
      expect((entry.day as DietDay).withinTolerance, entry.date).toBe(true)
    }
  })

  it('wykluczenia odpuszczają, gdy zabrałyby cały slot', () => {
    // Wąska baza: jeden przepis na slot. Wykluczenie go zostawiłoby dzień bez
    // posiłku — a powtórzony obiad jest lepszy niż brak obiadu.
    const oneEach = MEAL_SLOTS.map(
      (slot) => RECIPES.find((recipe) => recipe.slot === slot) as Recipe,
    )
    const narrow = solveWeek({
      ...input(2750, 85, { catalog: { recipes: oneEach } }),
      startDate: '2026-08-01',
      seedBase: 'waska-baza',
    })

    expect(narrow).toHaveLength(7)
    for (const entry of narrow) {
      expect(entry.day, entry.date).not.toBeNull()
      expect((entry.day as DietDay).meals).toHaveLength(4)
    }
  })

  it('KRYTYCZNE: obiad powtarza się przez dwa kolejne dni — gotowanie na zapas', () => {
    const batch = solveWeek({
      ...input(2750, 85),
      startDate: '2026-08-01',
      seedBase: 'zapas',
      lunchBatchDays: 2,
    })

    const lunchOf = (index: number) =>
      (batch[index]?.day as DietDay).meals.find((m) => m.slot === 'lunch')

    // Pary: (0,1), (2,3), (4,5); dzień 6 zostaje sam, bo tydzień ma siedem dni.
    for (const [first, second] of [
      [0, 1],
      [2, 3],
      [4, 5],
    ]) {
      const a = lunchOf(first as number)
      const b = lunchOf(second as number)
      expect(b?.recipeId, `dni ${first}/${second}`).toBe(a?.recipeId)
      // Ta sama porcja, nie tylko ten sam przepis — inaczej nie da się ugotować raz.
      expect(b?.scale, `dni ${first}/${second}`).toBe(a?.scale)
      expect(b?.ingredients, `dni ${first}/${second}`).toEqual(a?.ingredients)
    }

    // Kolejne PARY mają RÓŻNE obiady — powtarza się obiad, nie tydzień.
    // Wcześniej wystarczyło „więcej niż jeden różny": przy czterech porcjach
    // gotowania to przechodziło nawet wtedy, gdy trzy z nich były tym samym daniem.
    const perBatch = [0, 2, 4, 6].map((index) => lunchOf(index)?.recipeId)
    expect(new Set(perBatch).size, perBatch.join(', ')).toBe(4)
  })

  it('powtarza się OBIAD, nie cały dzień', () => {
    const batch = solveWeek({
      ...input(2750, 85),
      startDate: '2026-08-01',
      seedBase: 'zapas',
      lunchBatchDays: 2,
    })
    const dayOne = batch[0]?.day as DietDay
    const dayTwo = batch[1]?.day as DietDay

    const others = (day: DietDay) =>
      day.meals.filter((m) => m.slot !== 'lunch').map((m) => m.recipeId).join('|')
    expect(others(dayTwo)).not.toBe(others(dayOne))
  })

  it('bez gotowania na zapas każdy dzień ma własny obiad', () => {
    const daily = solveWeek({
      ...input(2750, 85),
      startDate: '2026-08-01',
      seedBase: 'zapas',
      lunchBatchDays: 1,
    })
    const lunches = daily.map(
      (entry) => (entry.day as DietDay).meals.find((m) => m.slot === 'lunch')?.recipeId,
    )
    // Siedem dni, siedem różnych obiadów — nie tylko „dzień drugi inny niż pierwszy".
    expect(new Set(lunches).size, lunches.join(', ')).toBe(7)
  })

  it('dzień z ustalonym posiłkiem dostaje dokładnie ten posiłek', () => {
    const base = solveDay(input(2750, 85)) as DietDay
    const pinned = base.meals.find((m) => m.slot === 'lunch')

    const pinnedDay = solveDay({
      ...input(2750, 85, { seed: 'inne-ziarno' }),
      pinnedMeals: { lunch: pinned },
    }) as DietDay

    expect(pinnedDay.meals.find((m) => m.slot === 'lunch')).toEqual(pinned)
  })

  it('KRYTYCZNE: różnorodność tygodnia zależy od tego, jak ciasny jest cel', () => {
    /**
     * To nie jest ograniczenie katalogu — 167 przepisów jest z zapasem. To
     * ograniczenie CELU: im bliżej sufitu bazy (kcal i białko), tym mniej
     * zestawów mieści się w tolerancji, więc solver wraca do tych samych
     * najcięższych pozycji. Zmierzone przy budżecie 45 min na gotowanie:
     *  - cel 1450 kcal / 116 g B (górna granica) → 6 różnych pozycji na 21,
     *  - cel 1300 kcal / 100 g B (ze swobodą)   → 12 różnych pozycji na 21.
     *
     * Aplikacja mówi o tym wprost przy generowaniu jadłospisu — patrz
     * `dietRepo.generateWeek` i `belowTargetDays`.
     */
    const distinctAt = (kcal: number, proteinG: number) =>
      new Set(
        solveWeek({
          ...input(kcal, proteinG),
          startDate: '2026-08-01',
          seedBase: 'roznorodnosc',
        })
          .flatMap((entry) => (entry.day as DietDay | null)?.meals ?? [])
          .map((meal) => meal.recipeId),
      ).size

    expect(distinctAt(1450, 116)).toBeGreaterThanOrEqual(5)
    expect(distinctAt(1300, 100)).toBeGreaterThanOrEqual(10)
  })
})

// ════════════════════════════════════════════════════════════════════
//  Zamienniki posiłków — rdzeń „nie chcę tego zjeść"
// ════════════════════════════════════════════════════════════════════

describe('findSubstitutes', () => {
  const args = input(2750, 85)
  const day = solveDay(args) as DietDay

  it('proponuje alternatywy o innym przepisie', () => {
    const subs = findSubstitutes(args, day, 'lunch')
    expect(subs.length).toBeGreaterThan(0)
    const currentRecipe = day.meals[0]?.recipeId
    for (const sub of subs) {
      expect(sub.recipeId).not.toBe(currentRecipe)
      expect(sub.slot).toBe('lunch')
    }
  })

  it('domyślnie zwraca CAŁY slot, nie pierwszą piątkę', () => {
    const subs = findSubstitutes(args, day, 'lunch')
    // Wszystkie obiady z bazy minus ten już zaplanowany.
    const lunches = RECIPES.filter((r) => r.slot === 'lunch').length
    expect(subs).toHaveLength(lunches - 1)
  })

  it('zwraca każdy przepis najwyżej raz — najlepszy mnożnik porcji', () => {
    const subs = findSubstitutes(args, day, 'dinner', 10)
    expect(subs).toHaveLength(10)
    expect(new Set(subs.map((s) => s.recipeId)).size).toBe(subs.length)
  })

  it('najlepszy zamiennik utrzymuje dzień w tolerancji kalorycznej', () => {
    const subs = findSubstitutes(args, day, 'dinner')
    const best = subs[0]
    expect(best).toBeDefined()

    const swapped = [...day.meals]
    // Kolacja to CZWARTY slot (`MEAL_SLOTS`), nie trzeci — od dodania śniadania.
    swapped[3] = best as (typeof swapped)[number]
    const kcal = swapped.reduce((sum, meal) => sum + meal.macros.kcal, 0)
    const devPct = Math.abs((kcal - args.targets.kcal) / args.targets.kcal) * 100
    expect(devPct).toBeLessThanOrEqual(DEFAULT_TOLERANCE.kcal * 100 + 3)
  })

  it('zamienniki respektują wykluczenia', () => {
    const restricted = input(2600, 80, {
      restrictions: restrictions({ allergens: ['nuts'] }),
    })
    const base = solveDay(restricted) as DietDay
    const subs = findSubstitutes(restricted, base, 'afternoon', 10)
    expect(subs.length).toBeGreaterThan(0)
    for (const sub of subs) {
      const recipe = RECIPES.find((r) => r.id === sub.recipeId) as Recipe
      expect(recipeAllergens(recipe), sub.recipeId).not.toContain('nuts')
    }
  })
})

// ════════════════════════════════════════════════════════════════════
//  Skalowanie i zaokrąglanie
// ════════════════════════════════════════════════════════════════════

describe('roundAmount', () => {
  it('gramy i mililitry idą co 5', () => {
    expect(roundAmount(153.7, 'g')).toBe(155)
    expect(roundAmount(156, 'g')).toBe(155)
    expect(roundAmount(158, 'g')).toBe(160)
    expect(roundAmount(27, 'ml')).toBe(25)
  })

  it('sztuki idą co pół — arkusz sam używa połówek jajka', () => {
    expect(roundAmount(1.2, 'piece')).toBe(1)
    expect(roundAmount(1.3, 'piece')).toBe(1.5)
    expect(roundAmount(0.6, 'piece')).toBe(0.5)
  })

  it('nigdy nie zwraca zera — składnik za 0 g nie ma sensu', () => {
    expect(roundAmount(0, 'g')).toBe(5)
    expect(roundAmount(0.4, 'piece')).toBe(0.5)
    expect(roundAmount(1, 'ml')).toBe(5)
  })
})
