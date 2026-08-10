import type { DietRestrictions, IsoDate, Macros, MealSlot, MealSplit, Recipe } from '../types'
import { addDays } from '../dates'
import { randomInt, rngFromSeed } from '../rng'
import { eligibleRecipes } from './eligibility'
import { scaleRecipe, sumMacros, type ScaledMeal } from './scaling'

/**
 * Sloty, które UKŁADA SOLVER — cztery, w kolejności dnia.
 *
 * Słodkiej przekąski (`snack`) tu nie ma świadomie: jej budżet jest odłożony
 * z celu dziennego (`plannedMealTargets`), a treść wpisuje użytkownik.
 * Solver nie ma jak zaproponować „czegoś słodkiego" z katalogu obiadowego,
 * a udawanie, że ma, kończyłoby się jogurtem w miejscu batonika.
 *
 * Kolejność jest znacząca, nie kosmetyczna: indeks slotu w tej tablicy jest
 * indeksem posiłku w `DietDay.meals` (patrz `findSubstitutes`
 * i `plannedMealsToDietDay`). Przestawienie jej rozjeżdża podmiany posiłków.
 */
export const MEAL_SLOTS = [
  'breakfast',
  'lunch',
  'afternoon',
  'dinner',
] as const satisfies readonly MealSlot[]

export interface DietTolerance {
  /** Dopuszczalne odchylenie kalorii, jako część celu (0,05 = ±5%). */
  kcal: number
  /** Dopuszczalne odchylenie każdego makroskładnika (0,10 = ±10%). */
  macro: number
}

/** Kryteria bramki go/no-go z PLAN.md, Faza 1.5. */
export const DEFAULT_TOLERANCE: DietTolerance = { kcal: 0.05, macro: 0.1 }

export interface DietCatalog {
  recipes: readonly Recipe[]
}

export interface SolveDayInput {
  targets: Macros
  mealSplit: MealSplit
  restrictions: DietRestrictions
  catalog: DietCatalog
  /** Ziarno determinizmu — ten sam ciąg zawsze daje ten sam jadłospis. */
  seed: string
  maxPrepMinutes?: number
  tolerance?: DietTolerance
  /** Przepisy z poprzedniego dnia — miękka kara za powtórzenie, nie zakaz. */
  avoidRecipeIds?: readonly string[]
  /**
   * Przepisy WYKLUCZONE z wyboru — twardo, przez wyjęcie z listy opcji.
   *
   * Miękka kara (`avoidRecipeIds`) nie wystarcza i to nie kwestia jej wagi:
   * gdy cel jest dla bazy nieosiągalny, koszt jest zdominowany przez klif
   * kaloryczny (14 × 12), więc kara 0,4 nie ma jak przeważyć nawet kilku
   * kalorii różnicy. Efekt: solver co dzień wybiera ten sam, najbliższy celowi
   * zestaw — matematycznie poprawnie i kompletnie bezużytecznie jako jadłospis.
   *
   * Gdy wykluczenia opróżniłyby cały slot (wąska baza, ostre wykluczenia,
   * długa historia), wracamy dla tego slotu do pełnej listy: powtórzony posiłek
   * jest lepszy niż dzień bez posiłku.
   */
  excludeRecipeIds?: readonly string[]
  /**
   * Posiłki USTALONE z góry — solver ich nie wybiera, tylko układa wokół nich
   * pozostałe slots.
   *
   * Tym mechanizmem działa gotowanie na zapas: obiad drugiego dnia jest
   * dokładnie tym samym posiłkiem (ten sam przepis, ta sama porcja), co dnia
   * pierwszego, a reszta dnia dopasowuje się do tego, co zostało z budżetu.
   */
  pinnedMeals?: Partial<Record<MealSlot, ScaledMeal>>
}

export interface DietDeviation {
  kcalPct: number
  proteinPct: number
  fatPct: number
  carbsPct: number
}

export interface DietDay {
  /** Zawsze cztery posiłki, w kolejności `MEAL_SLOTS`. */
  meals: ScaledMeal[]
  totals: Macros
  deviation: DietDeviation
  /** Czy dzień spełnia kryteria tolerancji. */
  withinTolerance: boolean
  cost: number
}

/** Rozdzielczość skalowania porcji. 0,05 to i tak więcej, niż przetrwa zaokrąglanie. */
const SCALE_STEP = 0.05
/** Restarty z losowego punktu — spadek współrzędnych sam wpada w minima lokalne. */
const RESTARTS = 8
const MAX_PASSES = 6
const EPS = 1e-6
const DEFAULT_MAX_PREP_MINUTES = 45

/**
 * Wagi funkcji kosztu.
 *
 * Kalorie ważą najwięcej, bo mają najciaśniejszą tolerancję (±5%).
 * Białko ważymy wyżej niż tłuszcz i węglowodany — jest najtrudniejsze do
 * trafienia i ma największe znaczenie dla kompozycji ciała.
 */
const W = {
  kcal: 14,
  protein: 8,
  fat: 4,
  carbs: 4,
  /** Rozkład kalorii na posiłki to preferencja, nie wymóg. */
  slotSplit: 1.2,
  duplicate: 0.8,
  /**
   * Kara za przepis z listy „unikaj" — czyli już zaplanowany gdzie indziej.
   *
   * Podniesiona z 0,4 do 2,0. Przy 0,4 kara ginęła w kosztach makro (suma
   * odchyleń W OBRĘBIE tolerancji dochodzi do ~2,3), więc nie robiła nic:
   * jadłospis powtarzał ten sam zestaw, bo różnica kilku kalorii przeważała.
   * Teraz przeważa różnicę wewnątrz tolerancji, ale nadal ustępuje klifowi
   * poza tolerancją (tam koszt rośnie o kilka jednostek) — dokładnie w tej
   * kolejności, o którą nam chodzi: najpierw makra, potem różnorodność.
   */
  avoided: 2,
  /** Za każdą minutę powyżej budżetu czasowego. */
  prepOverrunPerMinute: 0.02,
  /** Mnożnik kary za wyjście POZA tolerancję — tworzy wyraźny klif. */
  overTolerance: 12,
} as const

interface CostContext {
  targets: Macros
  /** Tylko sloty z `MEAL_SLOTS` — słodka przekąska nie ma celu do trafienia. */
  slotKcalTargets: Partial<Record<MealSlot, number>>
  tolerance: DietTolerance
  maxPrepMinutes: number
  avoid: ReadonlySet<string>
}

/** Cele kaloryczne slotów. Jedno miejsce, żeby solver i zamienniki liczyły tak samo. */
function slotKcalTargets(targets: Macros, split: MealSplit): Partial<Record<MealSlot, number>> {
  return {
    breakfast: targets.kcal * split.breakfast,
    lunch: targets.kcal * split.lunch,
    afternoon: targets.kcal * split.afternoon,
    dinner: targets.kcal * split.dinner,
  }
}

function costContextFrom(input: SolveDayInput): CostContext {
  return {
    targets: input.targets,
    slotKcalTargets: slotKcalTargets(input.targets, input.mealSplit),
    tolerance: input.tolerance ?? DEFAULT_TOLERANCE,
    maxPrepMinutes: input.maxPrepMinutes ?? DEFAULT_MAX_PREP_MINUTES,
    avoid: new Set(input.avoidRecipeIds ?? []),
  }
}

/**
 * Generuje jadłospis na jeden dzień.
 *
 * Metoda: dla każdego slotu budujemy skończoną listę konkretnych,
 * już zaokrąglonych posiłków (przepis × mnożnik porcji). Wybór jednego
 * posiłku na slot to mały problem kombinatoryczny, który rozwiązujemy
 * spadkiem współrzędnych z losowych restartów.
 *
 * Dlaczego nie programowanie liniowe: po zaokrągleniu gramatur problem
 * przestaje być ciągły. LP dałoby 153,7 g kurczaka i 0,7 jajka — czyli
 * dokładnie to, czego nie chcemy. Praca na wstępnie zaokrąglonych opcjach
 * daje gwarancję realnych porcji już w konstrukcji, a nie po fakcie.
 *
 * Zwraca `null`, gdy wykluczenia nie pozostawiają opcji dla któregoś slotu.
 */
export function solveDay(input: SolveDayInput): DietDay | null {
  const pool = eligibleRecipes(input.catalog.recipes, input.restrictions)
  if (pool.length === 0) return null

  const excluded = new Set(input.excludeRecipeIds ?? [])

  // Slot ustalony z góry ma dokładnie jedną opcję — spadek współrzędnych nie ma
  // wtedy czego w nim wybierać, a pozostałe slots układają się wokół niego.
  // Wykluczenia go nie dotyczą: obiad z gotowania na zapas jest powtórzony
  // CELOWO i musi być dokładnie tym samym posiłkiem.
  const slotOptions = MEAL_SLOTS.map((slot) => {
    const pinned = input.pinnedMeals?.[slot]
    if (pinned) return [pinned]

    const all = buildSlotOptions(slot, pool)
    if (excluded.size === 0) return all
    const fresh = all.filter((meal) => !excluded.has(meal.recipeId))
    // Puste po wykluczeniach = wracamy do pełnej listy. Patrz `excludeRecipeIds`.
    return fresh.length > 0 ? fresh : all
  })
  if (slotOptions.some((options) => options.length === 0)) return null

  const ctx = costContextFrom(input)
  const rng = rngFromSeed(input.seed)
  let bestPick: number[] | null = null
  let bestCost = Number.POSITIVE_INFINITY

  for (let restart = 0; restart < RESTARTS; restart++) {
    const start = slotOptions.map((options) => randomInt(rng, options.length))
    const result = descend(start, slotOptions, ctx)
    if (result.cost < bestCost - EPS) {
      bestCost = result.cost
      bestPick = result.pick
    }
  }

  if (!bestPick) return null
  return buildDay(mealsFor(bestPick, slotOptions), ctx, bestCost)
}

/**
 * Zamienniki dla jednego posiłku — rdzeń „nie chcę tego zjeść".
 *
 * Ranking po koszcie CAŁEGO dnia, nie po podobieństwie samego posiłku:
 * zamiennik jest dobry wtedy, gdy dzień nadal trafia w makra.
 * Zwraca najlepszy mnożnik porcji dla każdego alternatywnego przepisu.
 *
 * Domyślnie zwraca WSZYSTKIE dostępne przepisy dla slotu, nie pierwszą piątkę.
 * Powód: ranking odpowiada na pytanie „co najlepiej trafia w makra", a wybór
 * posiłku bywa podejmowany z innego powodu („mam w domu tuńczyka", „nie chcę
 * dziś mięsa"). Przy obcięciu do pięciu pozycji reszta katalogu była
 * nieosiągalna, choć jest w bazie. `limit` zostaje dla wywołań, które
 * potrzebują tylko czołówki.
 */
export function findSubstitutes(
  input: SolveDayInput,
  day: DietDay,
  slot: MealSlot,
  limit = Number.POSITIVE_INFINITY,
): ScaledMeal[] {
  const pool = eligibleRecipes(input.catalog.recipes, input.restrictions)
  const options = buildSlotOptions(slot, pool)

  // Słodkiej przekąski solver nie układa, więc nie ma dla niej zamienników.
  const slotIndex = (MEAL_SLOTS as readonly MealSlot[]).indexOf(slot)
  if (slotIndex < 0) return []

  const current = day.meals[slotIndex]
  const ctx = costContextFrom(input)

  const bestPerRecipe = new Map<string, { meal: ScaledMeal; cost: number }>()
  for (const option of options) {
    if (current && option.recipeId === current.recipeId) continue
    const trial = [...day.meals]
    trial[slotIndex] = option
    const cost = dayCost(trial, ctx)
    const existing = bestPerRecipe.get(option.recipeId)
    if (!existing || cost < existing.cost) {
      bestPerRecipe.set(option.recipeId, { meal: option, cost })
    }
  }

  return [...bestPerRecipe.values()]
    .sort((a, b) => a.cost - b.cost)
    .slice(0, limit)
    .map((entry) => entry.meal)
}

export interface PlannedDietDay {
  date: IsoDate
  day: DietDay | null
}

export interface SolveWeekInput
  extends Omit<SolveDayInput, 'seed' | 'avoidRecipeIds' | 'pinnedMeals' | 'excludeRecipeIds'> {
  startDate: IsoDate
  /** Ziarno bazowe; na każdy dzień doklejamy datę. */
  seedBase: string
  days?: number
  /**
   * Ile kolejnych dni dzieli TEN SAM obiad. 1 = każdy dzień inny, 2 = gotowanie
   * na dwa dni. Patrz `BATCH_LUNCH_DAYS`.
   */
  lunchBatchDays?: number
  /**
   * Przepisy z POPRZEDNICH tygodni — wchodzą jako już zużyte.
   *
   * Bez tego drugi tydzień powtarzałby pierwszy: dla solvera każdy tydzień jest
   * tym samym zadaniem z tym samym optimum. Wywołujący podaje historię, bo
   * tylko on wie, co już było zaplanowane.
   */
  recentRecipeIds?: readonly string[]
}

/**
 * Ile dni „na zapas" gotuje się obiad przy `prepStyle: 'batch'`.
 *
 * Dwa: gotujesz raz, jesz dwa razy. Prośba użytkownika i najczęstszy sposób
 * pracy z jednym garnkiem — trzy dni tego samego obiadu to już nuda, a jeden
 * dzień oznacza gotowanie codziennie.
 */
export const BATCH_LUNCH_DAYS = 2

/**
 * Jadłospis na tydzień.
 *
 * Trzy reguły dnia na dzień:
 *
 *  1. **Posiłek raz użyty nie wraca w tym tygodniu** (`excludeRecipeIds`).
 *     To zasada TWARDA i tak być musi. Solver szuka minimum kosztu, a każdy
 *     dzień tygodnia jest dla niego tym samym zadaniem: te same cele, ta sama
 *     baza. Bez wykluczenia dostaje się siedem identycznych dni — poprawne
 *     minimum i bezużyteczny jadłospis. Miękka kara tego nie ratuje, bo przy
 *     nieosiągalnym celu kalorycznym różnica kosztu między najlepszym
 *     a drugim posiłkiem bywa większa niż jakakolwiek sensowna kara.
 *  2. **Obiad powtarza się przez `lunchBatchDays` kolejnych dni** — dokładnie
 *     ten sam przepis w tej samej porcji, żeby dało się ugotować raz. Drugi
 *     dzień pary dostaje go jako slot USTALONY (`pinnedMeals`), a posiłek po
 *     pracy i kolacja dopasowują się do tego, co zostało z dziennego budżetu.
 *     Dlatego para dni nie jest identyczna — powtarza się obiad, nie dzień.
 *     Kolejna porcja gotowania dostaje INNY obiad, bo poprzedni jest już zużyty.
 *  3. **Miękka kara za przepisy z dnia poprzedniego zostaje** — działa wtedy,
 *     gdy wykluczenia trzeba było odpuścić (wąska baza), więc nadal odpycha
 *     dwa identyczne dni z rzędu.
 *
 * Cena tej zmiany: kolejne dni dostają coraz mniejszy wybór, więc trafiają
 * w makra gorzej niż dzień pierwszy. To świadomy wybór — jadłospis, w którym
 * codziennie jest to samo, i tak nie zostanie zjedzony.
 */
export function solveWeek(input: SolveWeekInput): PlannedDietDay[] {
  const dayCount = input.days ?? 7
  const batch = Math.max(1, Math.floor(input.lunchBatchDays ?? 1))
  const out: PlannedDietDay[] = []
  // Identyfikatory przepisów są unikalne w obrębie slotu, więc jeden zbiór
  // wystarcza dla wszystkich czterech posiłków.
  const used = new Set<string>()
  const carried = new Set<string>(input.recentRecipeIds ?? [])
  let previous: string[] = []
  let batchLunch: ScaledMeal | null = null

  for (let i = 0; i < dayCount; i++) {
    const date = addDays(input.startDate, i)
    // Pierwszy dzień każdej porcji gotowania wybiera obiad; kolejne go dziedziczą.
    const startsBatch = i % batch === 0
    const pinnedLunch: ScaledMeal | null = startsBatch ? null : batchLunch

    // Typ zwracany WPROST: bez niego wnioskowanie chodzi w kółko
    // (`attempt` → `day` → `batchLunch` → `pinnedLunch` → `attempt`).
    const attempt = (exclude: readonly string[], avoid: readonly string[]): DietDay | null =>
      solveDay({
        ...input,
        seed: `${input.seedBase}|${date}`,
        avoidRecipeIds: avoid,
        excludeRecipeIds: exclude,
        ...(pinnedLunch ? { pinnedMeals: { lunch: pinnedLunch } } : {}),
      })

    /**
     * Próby od najbardziej do najmniej ambitnej. Bierzemy PIERWSZĄ, która
     * trafia w tolerancję:
     *
     *  1. nic się nie powtarza (zakaz na wszystko, co już zaplanowane),
     *  2. wolno wrócić do przepisu z poprzednich tygodni — ale kosztuje,
     *  3. wolno powtórzyć przepis z tego tygodnia — też kosztuje,
     *  4. przepis z poprzednich tygodni bez kary, z tego tygodnia nadal z karą,
     *  5. makra ponad wszystko: zostaje tylko kara za dzień poprzedni.
     *
     * Stopień 4 jest tam, gdzie jest, celowo: danie z poprzedniego tygodnia
     * (osiem dni wstecz) jest mniej męczące niż to samo danie dwa razy w tym
     * tygodniu. Bez niego kolacja — najwęższy slot, bo dostaje resztę budżetu
     * po obiedzie i posiłku po pracy — wracała w drugim tygodniu trzy razy.
     *
     * Kolejność jest decyzją, nie szczegółem: kryterium bramki projektu są makra
     * (±5% kalorii, ±10% składników), więc dzień poza tolerancją jest błędem,
     * a powtórzony przepis najwyżej nudą. Wersja bez tych stopni dawała dzień
     * piąty poza makrami tylko po to, żeby nic się nie powtórzyło.
     *
     * W próbach 2 i 3 powtórki są DOZWOLONE, ale kosztowne (`W.avoided`), więc
     * solver bierze tyle powtórzeń, ile trzeba, a nie tyle, ile może — i wraca
     * do dania, które faktycznie ratuje makra, nie do całego starego dnia.
     * Próba 4 istnieje, bo sama kara potrafi zasłonić rozwiązanie: jeśli koszt
     * powtórek przewyższy zysk z wejścia w tolerancję, solver wybierze świeży
     * dzień poza makrami. Wtedy odpuszczamy karę.
     *
     * Gdy tolerancji nie osiąga żadna próba (cel nieosiągalny dla bazy —
     * `belowTargetDays` w `dietRepo`), zostaje pierwsza: skoro makr i tak nie
     * trafimy, nie ma po co oddawać różnorodności.
     */
    const history = [...used, ...carried]
    const stages: { exclude: readonly string[]; avoid: readonly string[] }[] = [
      { exclude: history, avoid: previous },
      // Stopnie z `carried` mają sens tylko wtedy, gdy jest co oddać.
      ...(carried.size > 0 ? [{ exclude: [...used], avoid: history }] : []),
      { exclude: [], avoid: history },
      ...(carried.size > 0 ? [{ exclude: [], avoid: [...used, ...previous] }] : []),
      { exclude: [], avoid: previous },
    ]

    let day: DietDay | null = null
    for (const stage of stages) {
      const candidate = attempt(stage.exclude, stage.avoid)
      // Pierwsza (najbardziej różnorodna) próba jest też wynikiem awaryjnym.
      if (!day) day = candidate
      if (candidate?.withinTolerance) {
        day = candidate
        break
      }
    }

    out.push({ date, day })
    if (startsBatch) batchLunch = day?.meals.find((meal) => meal.slot === 'lunch') ?? null
    if (day) for (const meal of day.meals) used.add(meal.recipeId)
    /**
     * Do listy „unikaj" nie wchodzi obiad z pary.
     *
     * Inaczej drugi dzień pary dostawałby karę za to, o co właśnie prosiliśmy.
     * Wykluczeń to nie dotyczy — tam obiad z pary WCHODZI, bo kolejna porcja
     * gotowania ma być z innego przepisu.
     */
    previous = day ? day.meals.filter((m) => m.slot !== 'lunch').map((m) => m.recipeId) : []
  }

  return out
}

// ─────────────────────────────────────────────────────── Wewnętrzne

/**
 * Wszystkie sensowne warianty posiłku dla slotu.
 *
 * Deduplikacja jest istotna: przy kroku 0,05 wiele mnożników po zaokrągleniu
 * ilości daje identyczny posiłek. Bez niej przestrzeń wyszukiwania rośnie
 * kilkukrotnie bez zysku.
 */
function buildSlotOptions(slot: MealSlot, recipes: readonly Recipe[]): ScaledMeal[] {
  const out: ScaledMeal[] = []
  const seen = new Set<string>()

  for (const recipe of recipes) {
    if (recipe.slot !== slot) continue
    const steps = Math.max(0, Math.round((recipe.maxScale - recipe.minScale) / SCALE_STEP))

    for (let i = 0; i <= steps; i++) {
      const scale = recipe.minScale + i * SCALE_STEP
      const meal = scaleRecipe(recipe, scale)
      const key = `${recipe.id}|${meal.ingredients.map((ing) => ing.amount).join(',')}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(meal)
    }
  }

  return out
}

function mealsFor(pick: readonly number[], slotOptions: readonly ScaledMeal[][]): ScaledMeal[] {
  return pick.map((index, slot) => (slotOptions[slot] as ScaledMeal[])[index] as ScaledMeal)
}

/** Spadek współrzędnych: poprawiaj jeden slot naraz aż do braku poprawy. */
function descend(
  start: readonly number[],
  slotOptions: readonly ScaledMeal[][],
  ctx: CostContext,
): { pick: number[]; cost: number } {
  const pick = [...start]
  let cost = dayCost(mealsFor(pick, slotOptions), ctx)

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let improved = false

    for (let slot = 0; slot < pick.length; slot++) {
      const options = slotOptions[slot] as ScaledMeal[]
      const original = pick[slot] as number
      let bestIndex = original
      let bestCost = cost

      for (let i = 0; i < options.length; i++) {
        if (i === original) continue
        pick[slot] = i
        const trial = dayCost(mealsFor(pick, slotOptions), ctx)
        if (trial < bestCost - EPS) {
          bestCost = trial
          bestIndex = i
        }
      }

      pick[slot] = bestIndex
      if (bestIndex !== original) {
        cost = bestCost
        improved = true
      }
    }

    if (!improved) break
  }

  return { pick, cost }
}

function dayCost(meals: readonly ScaledMeal[], ctx: CostContext): number {
  const totals = sumMacros(meals)

  let cost =
    W.kcal * graded(totals.kcal, ctx.targets.kcal, ctx.tolerance.kcal) +
    W.protein * graded(totals.proteinG, ctx.targets.proteinG, ctx.tolerance.macro) +
    W.fat * graded(totals.fatG, ctx.targets.fatG, ctx.tolerance.macro) +
    W.carbs * graded(totals.carbsG, ctx.targets.carbsG, ctx.tolerance.macro)

  const used = new Set<string>()
  for (const meal of meals) {
    const slotTarget = ctx.slotKcalTargets[meal.slot] ?? 0
    if (slotTarget > 0) {
      cost += W.slotSplit * (Math.abs(meal.macros.kcal - slotTarget) / slotTarget)
    }
    if (used.has(meal.recipeId)) cost += W.duplicate
    used.add(meal.recipeId)
    if (ctx.avoid.has(meal.recipeId)) cost += W.avoided

    const overrun = meal.prepMinutes - ctx.maxPrepMinutes
    if (overrun > 0) cost += W.prepOverrunPerMinute * overrun
  }

  return cost
}

/**
 * Odchylenie z klifem na granicy tolerancji.
 *
 * W obrębie tolerancji koszt rośnie liniowo i wolno. Poza nią mnożymy przez 12,
 * więc solver zawsze woli zejść do tolerancji na jednym składniku, niż
 * nieznacznie poprawić inny. Bez tego klifu optymalizator rozmazuje błąd
 * równomiernie i wychodzi poza limity na wszystkim po trochu.
 */
function graded(actual: number, target: number, tol: number): number {
  if (target <= 0) return 0
  const rel = Math.abs(actual - target) / target
  return rel <= tol ? rel : tol + (rel - tol) * W.overTolerance
}

function buildDay(meals: ScaledMeal[], ctx: CostContext, cost: number): DietDay {
  const totals = sumMacros(meals)
  const deviation: DietDeviation = {
    kcalPct: signedPct(totals.kcal, ctx.targets.kcal),
    proteinPct: signedPct(totals.proteinG, ctx.targets.proteinG),
    fatPct: signedPct(totals.fatG, ctx.targets.fatG),
    carbsPct: signedPct(totals.carbsG, ctx.targets.carbsG),
  }

  const kcalTol = ctx.tolerance.kcal * 100
  const macroTol = ctx.tolerance.macro * 100
  const withinTolerance =
    Math.abs(deviation.kcalPct) <= kcalTol &&
    Math.abs(deviation.proteinPct) <= macroTol &&
    Math.abs(deviation.fatPct) <= macroTol &&
    Math.abs(deviation.carbsPct) <= macroTol

  return { meals, totals, deviation, withinTolerance, cost: Math.round(cost * 1000) / 1000 }
}

function signedPct(actual: number, target: number): number {
  if (target <= 0) return 0
  return Math.round(((actual - target) / target) * 1000) / 10
}
