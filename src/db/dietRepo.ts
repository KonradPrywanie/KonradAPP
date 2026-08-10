import type { IsoDate, Macros, MealSlot, PlannedMeal, Profile, Uuid } from '@/domain/types'
import {
  BATCH_LUNCH_DAYS,
  findSubstitutes,
  MEAL_SLOTS,
  solveDay,
  solveWeek,
  type DietDay,
} from '@/domain/diet/solver'
import { plannedMealTargets } from '@/domain/diet/sweetSnack'
import type { ScaledMeal } from '@/domain/diet/scaling'
import { diffDays, startOfWeek } from '@/domain/dates'
import { DIET_CATALOG } from '@/lib/catalog'
import { alive, db, newId, stamp } from './db'

/**
 * Repozytorium jadłospisu.
 *
 * Solver dostaje cele makro z zewnątrz (z `nutritionTargets`), bo zależą od
 * profilu — czyli od danych, których warstwa diety nie powinna znać.
 *
 * Rezerwa na słodką przekąskę jest odejmowana TUTAJ, w jednym miejscu.
 * Wywołujący podają pełny cel dzienny i nie muszą o rezerwie pamiętać — gdyby
 * każdy odejmował ją sam, pierwszy zapomniany wywołujący dałby jadłospis
 * o 100 kcal za duży i nikt by tego nie zauważył.
 */

/**
 * Ile tygodni wstecz i w przód patrzymy, żeby nie powtórzyć dania.
 *
 * Cztery, czyli miesiąc. Baza ma 40 przepisów na slot, a tydzień zużywa 7
 * (obiad przy gotowaniu na zapas: 4), więc miesiąc historii zabiera najwyżej
 * 28 z 40 — zostaje z czego wybierać. Dłuższe okno wyczerpałoby bazę i wpadło
 * w awaryjny powrót do pełnej listy, czyli w to samo, co chcemy naprawić;
 * krótsze przywraca danie, gdy jeszcze się nie znudziło.
 */
export const DIET_HISTORY_WEEKS = 4

export interface GenerateWeekResult {
  weekStart: IsoDate
  saved: number
  /** Dni, dla których wykluczenia nie pozostawiły rozwiązania. */
  failedDates: IsoDate[]
  /**
   * Dni, w których jadłospis wyszedł ponad 5% PONIŻEJ celu kalorycznego.
   *
   * Nie jest to awaria solvera, tylko sufit bazy: przepisy są pisane pod
   * ~2750 kcal dziennie (cztery posiłki sumują się do ~2550 kcal), a porcje
   * wolno skalować o 25% w każdą stronę — czyli baza sięga od ~2100 do ~3400
   * kcal z rezerwą na przekąskę. Poza tym zakresem solver robi, co może,
   * i mówimy o tym wprost — zamiast pokazywać „wykonany plan", po którym
   * brakuje dwustu kalorii.
   */
  belowTargetDays: IsoDate[]
}

function solverInput(profile: Profile, dailyTargets: Macros, seed: string) {
  return {
    targets: plannedMealTargets(dailyTargets),
    mealSplit: profile.mealSplit,
    restrictions: profile.diet,
    catalog: DIET_CATALOG,
    maxPrepMinutes: profile.cooking.weekdayMinutes,
    seed,
  }
}

function toPlannedMeal(date: IsoDate, meal: ScaledMeal, now: string): PlannedMeal {
  return {
    id: newId(),
    date,
    slot: meal.slot,
    recipeId: meal.recipeId,
    scale: meal.scale,
    ingredients: meal.ingredients.map((ing) => ({ ...ing })),
    computed: { ...meal.macros },
    updatedAt: now,
    deletedAt: null,
  }
}

/** Pusty posiłek dla slotu, którego nie ma w zapisanym dniu. */
function emptyMeal(slot: MealSlot): ScaledMeal {
  return {
    recipeId: '',
    slot,
    scale: 1,
    ingredients: [],
    macros: { kcal: 0, proteinG: 0, fatG: 0, carbsG: 0 },
    prepMinutes: 0,
  }
}

export const dietRepo = {
  async mealsOnDate(date: IsoDate): Promise<PlannedMeal[]> {
    return alive(await db.plannedMeals.where('date').equals(date).toArray())
  },

  async mealsForWeek(weekStart: IsoDate): Promise<PlannedMeal[]> {
    const rows = alive(await db.plannedMeals.toArray())
    const start = startOfWeek(weekStart)
    return rows
      .filter((m) => startOfWeek(m.date) === start)
      .sort((a, b) => a.date.localeCompare(b.date))
  },

  async hasWeek(weekStart: IsoDate): Promise<boolean> {
    return (await dietRepo.mealsForWeek(weekStart)).length > 0
  },

  /**
   * Przepisy, których świeżo ułożony tydzień ma unikać.
   *
   * Trzy źródła i każde z osobnego powodu:
   *
   *  1. **Sąsiednie tygodnie, ±`DIET_HISTORY_WEEKS`.** Wcześniej historia sięgała
   *     JEDNEGO tygodnia wstecz i to był błąd, który użytkownik zgłosił jako
   *     „ciągle to samo na obiad": tydzień 3 nie wiedział o tygodniu 1, więc
   *     wracał do jego optimum. Przez cztery tygodnie wychodziło OSIEM różnych
   *     obiadów na 28 dni, każdy po cztery razy — dwa tygodnie w kółko.
   *     Patrzymy też w PRZÓD, bo tygodnie da się generować w dowolnej kolejności
   *     i tydzień wcześniejszy równie dobrze może powtarzać późniejszy.
   *  2. **Poprzednie podejścia do TEGO tygodnia** (wpisy miękko usunięte).
   *     Bez tego ponowne kliknięcie „wygeneruj" dawało identyczny jadłospis:
   *     solver dostaje to samo zadanie i wraca do tego samego minimum, a ziarno
   *     zmienia tylko punkty startowe spadku współrzędnych, nie wynik. Kto
   *     generuje drugi raz, robi to właśnie dlatego, że nie chce tego samego.
   *  3. Nic więcej — po `DIET_HISTORY_WEEKS` danie może wrócić i to jest
   *     zamierzone. Baza ma 50 przepisów na slot; wykluczanie wszystkiego
   *     na zawsze skończyłoby się pustą listą i awaryjnym powrotem do pełnej.
   */
  async recentRecipeIds(weekStart: IsoDate): Promise<string[]> {
    const start = startOfWeek(weekStart)
    const rows = await db.plannedMeals.toArray()
    const window = DIET_HISTORY_WEEKS * 7

    const ids = new Set<string>()
    for (const meal of rows) {
      const mealWeek = startOfWeek(meal.date)
      if (mealWeek === start) {
        /**
         * Ten tydzień: liczy się WSZYSTKO, co już w nim stoi — i żywe, i miękko
         * usunięte.
         *
         * „Żywe" jest tu istotne i łatwo je przegapić: `generateWeek` czyta
         * historię PRZED skasowaniem starego jadłospisu, więc poprzednie
         * podejście jest w tym momencie jeszcze żywe. Przy warunku „tylko
         * usunięte" pierwsze ponowne generowanie nie widziało niczego i zwracało
         * ten sam tydzień, tylko inaczej poukładany.
         */
        ids.add(meal.recipeId)
        continue
      }
      if (meal.deletedAt) continue
      if (Math.abs(diffDays(start, mealWeek)) <= window) ids.add(meal.recipeId)
    }
    return [...ids]
  },

  /**
   * Generuje i zapisuje jadłospis na tydzień.
   *
   * Istniejące posiłki w tym zakresie dat są usuwane miękko, nie nadpisywane —
   * `mealLogs` mogą się do nich odwoływać przez `plannedMealId`, a log jest
   * nienaruszalny.
   *
   * Przy gotowaniu na zapas (`cooking.prepStyle === 'batch'`) obiad powtarza się
   * przez dwa kolejne dni — ugotowane raz, zjedzone dwa razy. To pole profilu
   * po zmianie katalogu przepisów nie miało żadnego wpływu na aplikację; teraz
   * ma dokładnie ten jeden, za to konkretny.
   */
  async generateWeek(
    profile: Profile,
    weekStart: IsoDate,
    targets: Macros,
  ): Promise<GenerateWeekResult> {
    const start = startOfWeek(weekStart)
    const week = solveWeek({
      ...solverInput(profile, targets, ''),
      seedBase: `${profile.id}|${start}`,
      startDate: start,
      days: 7,
      lunchBatchDays: profile.cooking.prepStyle === 'batch' ? BATCH_LUNCH_DAYS : 1,
      recentRecipeIds: await dietRepo.recentRecipeIds(start),
    })

    const now = stamp()
    const existing = await dietRepo.mealsForWeek(start)
    const meals: PlannedMeal[] = []
    const failedDates: IsoDate[] = []
    const belowTargetDays: IsoDate[] = []

    for (const { date, day } of week) {
      if (!day) {
        failedDates.push(date)
        continue
      }
      if (day.deviation.kcalPct < -5) belowTargetDays.push(date)
      for (const meal of day.meals) meals.push(toPlannedMeal(date, meal, now))
    }

    await db.transaction('rw', db.plannedMeals, async () => {
      for (const old of existing) {
        await db.plannedMeals.put({ ...old, deletedAt: now, updatedAt: now })
      }
      if (meals.length > 0) await db.plannedMeals.bulkAdd(meals)
    })

    return { weekStart: start, saved: meals.length, failedDates, belowTargetDays }
  },

  /**
   * Regeneracja jednego dnia — np. po zmianie celu kalorycznego.
   *
   * Posiłki z pozostałych dni tygodnia wchodzą jako wykluczenia. Inaczej
   * przeliczenie dnia wstawiałoby najlepszy zestaw z bazy — czyli ten sam,
   * który już stoi w dniu obok.
   */
  async regenerateDay(
    profile: Profile,
    date: IsoDate,
    targets: Macros,
  ): Promise<PlannedMeal[]> {
    const week = await dietRepo.mealsForWeek(date)
    const day = solveDay({
      ...solverInput(profile, targets, `${profile.id}|${date}|regen`),
      excludeRecipeIds: week.filter((m) => m.date !== date).map((m) => m.recipeId),
    })
    if (!day) return []

    const now = stamp()
    const existing = await dietRepo.mealsOnDate(date)
    const meals = day.meals.map((meal) => toPlannedMeal(date, meal, now))

    await db.transaction('rw', db.plannedMeals, async () => {
      for (const old of existing) {
        await db.plannedMeals.put({ ...old, deletedAt: now, updatedAt: now })
      }
      await db.plannedMeals.bulkAdd(meals)
    })

    return meals
  },

  /**
   * Zamienniki dla jednego posiłku — PEŁNA lista, nie pierwsza piątka.
   *
   * Ranking uwzględnia pozostałe posiłki dnia, więc podpowiedzi trzymają
   * dzienne makro — nie są tylko „innym daniem w tym samym slocie". Kolejność
   * zostaje rankingowa, ale ekran pokazuje wszystko: wybór posiłku bywa
   * podejmowany z powodu, o którym solver nie wie (co jest w domu, na co jest
   * dziś ochota), a przy pięciu pozycjach reszta katalogu była nieosiągalna.
   */
  async substitutesFor(
    profile: Profile,
    date: IsoDate,
    slot: MealSlot,
    targets: Macros,
    limit?: number,
  ): Promise<ScaledMeal[]> {
    const meals = await dietRepo.mealsOnDate(date)
    // Dzień bez posiłków też dostaje propozycje: po usunięciu wszystkiego trzeba
    // mieć skąd wstawić danie z powrotem. Ranking liczy się wtedy względem
    // pustego dnia, czyli faworyzuje pozycje najbliższe całemu celowi.
    const input = solverInput(profile, targets, `${profile.id}|${date}|sub`)
    // Dzień do wyceny musi być liczony względem TEGO SAMEGO celu, z którego
    // powstał jadłospis — czyli pomniejszonego o rezerwę na przekąskę.
    const day = plannedMealsToDietDay(meals, input.targets)
    return limit === undefined
      ? findSubstitutes(input, day, slot)
      : findSubstitutes(input, day, slot, limit)
  },

  async replaceMeal(mealId: Uuid, replacement: ScaledMeal): Promise<PlannedMeal | undefined> {
    const current = await db.plannedMeals.get(mealId)
    if (!current || current.deletedAt) return undefined

    const now = stamp()
    const updated: PlannedMeal = {
      ...current,
      recipeId: replacement.recipeId,
      scale: replacement.scale,
      ingredients: replacement.ingredients.map((ing) => ({ ...ing })),
      computed: { ...replacement.macros },
      updatedAt: now,
    }
    await db.plannedMeals.put(updated)
    return updated
  },

  /**
   * Usuwa zaplanowany posiłek z jadłospisu.
   *
   * Miękko (`deletedAt`), jak wszystkie dane użytkownika. Zwraca `false`, gdy
   * usunięcie się nie odbyło.
   *
   * ODMAWIA usunięcia posiłku, który jest już ZALOGOWANY jako zjedzony. Log jest
   * nienaruszalny i liczy się do dziennego bilansu, więc po skasowaniu planu
   * kalorie nadal by się liczyły, tylko nie byłoby ich przy czym pokazać —
   * „pozostało dziś" pokazywałoby ubytek bez powodu. Kolejność jest naturalna:
   * najpierw „Cofnij", potem „Usuń".
   */
  async removeMeal(mealId: Uuid): Promise<boolean> {
    const meal = await db.plannedMeals.get(mealId)
    if (!meal || meal.deletedAt) return false

    const logs = alive(await db.mealLogs.where('date').equals(meal.date).toArray())
    if (logs.some((log) => log.plannedMealId === mealId)) return false

    const now = stamp()
    await db.plannedMeals.put({ ...meal, deletedAt: now, updatedAt: now })
    return true
  },

  /**
   * Wstawia posiłek w PUSTY slot dnia — droga powrotna po usunięciu.
   *
   * Bez tego usunięcie posiłku byłoby nieodwracalne inaczej niż przez
   * wygenerowanie całego tygodnia od nowa, co zmieniłoby też pozostałe dni.
   * Zajęty slot zostaje nietknięty (do podmiany jest `replaceMeal`) — dwa
   * posiłki w jednym slocie rozjechałyby sumy dnia i listę zakupów.
   */
  async addMeal(date: IsoDate, slot: MealSlot, meal: ScaledMeal): Promise<PlannedMeal | undefined> {
    const existing = await dietRepo.mealsOnDate(date)
    if (existing.some((m) => m.slot === slot)) return undefined

    const planned = toPlannedMeal(date, { ...meal, slot }, stamp())
    await db.plannedMeals.add(planned)
    return planned
  },

  /**
   * Dopasowuje zaplanowane posiłki do zmienionego profilu.
   *
   * Przelicza dni od `fromDate` w przód, POMIJAJĄC te, na których cokolwiek
   * już zalogowano — zjedzonego obiadu nie da się zmienić, a podmiana planu
   * pod zapisanym wpisem rozjechałaby bilans dnia.
   *
   * Zwraca też tygodnie, których dotknęła zmiana, żeby wywołujący mógł
   * przebudować listy zakupów.
   */
  async resyncFromDate(
    profile: Profile,
    fromDate: IsoDate,
    targets: Macros,
  ): Promise<{ updatedDays: IsoDate[]; keptLoggedDays: IsoDate[]; affectedWeeks: IsoDate[] }> {
    const all = alive(await db.plannedMeals.toArray())
    const dates = [...new Set(all.map((meal) => meal.date))]
      .filter((date) => diffDays(fromDate, date) >= 0)
      .sort((a, b) => a.localeCompare(b))

    const updatedDays: IsoDate[] = []
    const keptLoggedDays: IsoDate[] = []

    for (const date of dates) {
      const logs = alive(await db.mealLogs.where('date').equals(date).toArray())
      if (logs.length > 0) {
        keptLoggedDays.push(date)
        continue
      }
      const meals = await dietRepo.regenerateDay(profile, date, targets)
      if (meals.length > 0) updatedDays.push(date)
    }

    return {
      updatedDays,
      keptLoggedDays,
      affectedWeeks: [...new Set(updatedDays.map((date) => startOfWeek(date)))],
    }
  },

  async byId(id: Uuid): Promise<PlannedMeal | undefined> {
    const row = await db.plannedMeals.get(id)
    return row && !row.deletedAt ? row : undefined
  },
}

/**
 * Kolejność posiłków na ekranie — z przekąską, w rytmie dnia.
 *
 * Różni się od `MEAL_SLOTS` w solverze i to jest zamierzone: solver układa
 * cztery posiłki, ekran pokazuje pięć pozycji, bo słodka przekąska jest
 * miejscem do wpisania ręcznie, nie propozycją.
 *
 * Przekąska stoi między posiłkiem po pracy a kolacją — tam, gdzie realnie
 * wypada, a nie na końcu listy „bo jest inna".
 */
export const MEAL_SLOT_ORDER: readonly MealSlot[] = [
  'breakfast',
  'lunch',
  'afternoon',
  'snack',
  'dinner',
]

/**
 * Zapisane posiłki → struktura, jakiej oczekuje `findSubstitutes`.
 *
 * Solver potrzebuje kompletnego dnia w kolejności SWOICH slotów, żeby policzyć
 * koszt po podmianie. Braki uzupełniamy pustym posiłkiem — inaczej indeksowanie
 * slotów rozjechałoby się przy niepełnym dniu. Słodkiej przekąski tu nie ma:
 * solver jej nie zna, a dodanie jej przesunęłoby indeksy.
 */
export function plannedMealsToDietDay(meals: readonly PlannedMeal[], targets: Macros): DietDay {
  const bySlot = new Map(meals.map((m) => [m.slot, m]))

  const scaled: ScaledMeal[] = MEAL_SLOTS.map((slot) => {
    const meal = bySlot.get(slot)
    if (!meal) return emptyMeal(slot)
    return {
      recipeId: meal.recipeId,
      slot: meal.slot,
      scale: meal.scale,
      ingredients: meal.ingredients,
      macros: meal.computed,
      prepMinutes: 0,
    }
  })

  const totals = scaled.reduce<Macros>(
    (sum, meal) => ({
      kcal: sum.kcal + meal.macros.kcal,
      proteinG: sum.proteinG + meal.macros.proteinG,
      fatG: sum.fatG + meal.macros.fatG,
      carbsG: sum.carbsG + meal.macros.carbsG,
    }),
    { kcal: 0, proteinG: 0, fatG: 0, carbsG: 0 },
  )

  const pct = (actual: number, target: number) =>
    target > 0 ? Math.round(((actual - target) / target) * 1000) / 10 : 0

  return {
    meals: scaled,
    totals,
    deviation: {
      kcalPct: pct(totals.kcal, targets.kcal),
      proteinPct: pct(totals.proteinG, targets.proteinG),
      fatPct: pct(totals.fatG, targets.fatG),
      carbsPct: pct(totals.carbsG, targets.carbsG),
    },
    withinTolerance: Math.abs(pct(totals.kcal, targets.kcal)) <= 5,
    cost: 0,
  }
}
