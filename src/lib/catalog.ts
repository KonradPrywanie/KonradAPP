import { RECIPES, RECIPES_BY_ID } from '@/data/recipes'
import { EXERCISE_VIDEOS } from '@/data/exerciseVideos'
import {
  WARMUP,
  WORKOUTS,
  WORKOUT_A,
  WORKOUT_B,
  WORKOUT_EXERCISES_BY_ID,
  TEMPO_LEGEND,
} from '@/data/workouts'
import { normalize } from '@/domain/text'
import type { DietCatalog } from '@/domain/diet/solver'
import type { Recipe, Workout, WorkoutExercise, WorkoutSlot } from '@/domain/types'

/**
 * Jedyne miejsce, które spina dane statyczne z silnikami.
 *
 * Silniki w `domain/` przyjmują katalog jako parametr i celowo nie importują
 * `data/` — dzięki temu da się je testować na wstrzykniętych zestawach
 * i podmienić bazę bez dotykania logiki. Ten plik jest tą jedną granicą,
 * w której wiązanie następuje.
 *
 * Oba katalogi — przepisy i treningi — są GENEROWANE z arkuszy w `data-source/`
 * przez `scripts/import/import_workbooks.py`.
 */

/**
 * Składniki wykluczone na poziomie KATALOGU, nie profilu.
 *
 * Rozróżnienie jest istotne i nieprzypadkowe. Wykluczenia w profilu
 * (`diet.dislikedTags`) są danymi użytkownika, więc zmiana presetu NIE dotknie
 * profilu już zapisanego w przeglądarce — nowa reguła zaczęłaby obowiązywać
 * dopiero po założeniu profilu od nowa. Reguła katalogu obowiązuje natychmiast,
 * także dla profilu sprzed zmiany, i dlatego tu jest miejsce na „tego nie jem".
 *
 * **Lista jest PUSTA i to jest stan wyjściowy, nie przeoczenie.** FitPlanner,
 * z którego ta aplikacja wyrosła, miał tu wykluczenia swojej użytkowniczki
 * (kalafior, wszystkie kasze poza pęczakiem). Przepisanie ich do FITKonrada
 * byłoby przeniesieniem cudzego gustu — a wykluczenie, o które nikt nie prosił,
 * po cichu zabiera przepisy z bazy i nikt nie wie, dlaczego jadłospis się zawęził.
 *
 * Dopisanie tu terminu (np. `'kalafior'`) wycina KAŻDY przepis, który ma go
 * w nazwie albo w składnikach. Filtrujemy przepisy, nie składniki: solver
 * operuje przepisami, a przepis z wykluczonym składnikiem jest bezużyteczny
 * jako całość.
 */
export const BANNED_INGREDIENT_TERMS: readonly string[] = []

/** Czy przepis przechodzi filtr katalogu. Eksportowane pod test. */
export function passesCatalogBan(
  recipe: Recipe,
  bannedTerms: readonly string[] = BANNED_INGREDIENT_TERMS,
): boolean {
  const terms = bannedTerms.map(normalize).filter(Boolean)
  if (terms.length === 0) return true

  const texts = [normalize(recipe.name), ...recipe.ingredients.map((ing) => normalize(ing.name))]
  return !terms.some((term) => texts.some((text) => text.includes(term)))
}

const ALLOWED_RECIPES: readonly Recipe[] = RECIPES.filter((recipe) => passesCatalogBan(recipe))

export const DIET_CATALOG: DietCatalog = { recipes: ALLOWED_RECIPES }

export { RECIPES, RECIPES_BY_ID, WARMUP, WORKOUTS, WORKOUT_A, WORKOUT_B, TEMPO_LEGEND }
export { WORKOUT_EXERCISES_BY_ID }

export function exerciseName(exerciseId: string): string {
  return WORKOUT_EXERCISES_BY_ID.get(exerciseId)?.name ?? exerciseId
}

export function workoutById(id: Workout['id']): Workout | undefined {
  return WORKOUTS.find((workout) => workout.id === id)
}

/**
 * Do którego miejsca w treningu należy ćwiczenie.
 *
 * Potrzebne przy podmianie na alternatywę: log i plan pamiętają identyfikator
 * ćwiczenia, a z niego trzeba wrócić do slotu, żeby pokazać pozostałe warianty.
 */
export interface ExercisePlacement {
  workout: Workout
  slot: WorkoutSlot
  exercise: WorkoutExercise
}

const PLACEMENTS: ReadonlyMap<string, ExercisePlacement> = new Map(
  WORKOUTS.flatMap((workout) =>
    workout.slots.flatMap((slot) =>
      [slot.main, ...slot.alternatives].map(
        (exercise) => [exercise.id, { workout, slot, exercise }] as const,
      ),
    ),
  ),
)

export function exercisePlacement(exerciseId: string): ExercisePlacement | undefined {
  return PLACEMENTS.get(exerciseId)
}

export interface ExerciseVideoLink {
  href: string
  /**
   * `video` — konkretny materiał; `search` — wyszukiwanie po nazwie ćwiczenia.
   * Interfejs podpisuje przycisk inaczej w każdym przypadku, żeby nie obiecywać
   * filmu tam, gdzie otworzy się lista wyników.
   */
  kind: 'video' | 'search'
}

/**
 * Link do instruktażu dla ćwiczenia — trzy źródła, w tej kolejności.
 *
 *  1. Kolumna „Wideo Instruktażowe" z arkusza, gdy trener ją uzupełni. To jego
 *     plan, więc jego materiały mają pierwszeństwo.
 *  2. Ręcznie dobrana lista w `data/exerciseVideos.ts`.
 *  3. Wyszukiwanie w YouTube po nazwie ćwiczenia — wyjście awaryjne, dzięki
 *     któremu przycisk działa nawet wtedy, gdy konkretny film zostanie usunięty.
 */
export function exerciseVideo(exerciseId: string): ExerciseVideoLink {
  const exercise = WORKOUT_EXERCISES_BY_ID.get(exerciseId)
  const fromSheet = exercise?.videoUrl
  if (fromSheet) return { href: fromSheet, kind: 'video' }

  const curated = EXERCISE_VIDEOS[exerciseId]
  if (curated) return { href: curated, kind: 'video' }

  const query = encodeURIComponent(`${exercise?.name ?? exerciseId} technika`)
  return { href: `https://www.youtube.com/results?search_query=${query}`, kind: 'search' }
}
