import type {
  PlannedExercise,
  PlannedSet,
  StrengthPayload,
  Workout,
  WorkoutExercise,
  WorkoutSlot,
} from '../types'
import type { WeekLoad } from './mesocycle'
import { deloadWeight } from './progression'

/**
 * Sesja siłowa z GOTOWEGO treningu.
 *
 * Zastąpiła generator, który dobierał ćwiczenia z katalogu pod wzorce ruchowe.
 * Powód jest prosty: trening jest napisany przez trenera pod konkretną osobę
 * i konkretną siłownię — z doborem, kolejnością, tempem i przerwami. Aplikacja
 * nie ma czego tu poprawiać. Zostaje jej to, czego papierowy plan nie umie:
 * kalendarz, ciężary przenoszone z logu, progresja i podmiana na alternatywę.
 *
 * Z tygodnia bierzemy więc TYLKO dwie rzeczy:
 *  - deload zdejmuje jedną serię z każdego ćwiczenia (nie mniej niż dwie),
 *  - deload obniża ciężar przeniesiony z logu o 10%.
 * Powtórzeń, tempa ani przerw nie ruszamy — to zapis trenera, nie parametr.
 */

/** Docelowe RPE, którego arkusz nie podaje. */
const TARGET_RPE = 8
const MIN_SETS = 2
/** Sekundy na powtórzenie — do szacowania czasu sesji. */
const SECONDS_PER_REP = 4
/** Rozgrzewka z arkusza: 5–7 minut. */
export const WARMUP_MINUTES = 6

export interface WorkoutSessionInput {
  workout: Workout
  load: WeekLoad
  /** Ciężary osiągnięte w logu, per `exerciseId`. Wygrywają z ciężarem z arkusza. */
  knownLoads?: ReadonlyMap<string, number>
  /**
   * Wybrane warianty — `slotIndex` → `exerciseId`. Pusta mapa znaczy
   * „ćwiczenia główne". Tak działa podmiana na alternatywę: plan pamięta wybór,
   * a nie kopiuje go do osobnej struktury.
   */
  chosen?: ReadonlyMap<number, string>
}

/** Buduje payload sesji siłowej dla jednego tygodnia planu. */
export function workoutSession(input: WorkoutSessionInput): StrengthPayload {
  const exercises = input.workout.slots.map((slot) =>
    plannedWorkoutExercise(exerciseFor(slot, input.chosen?.get(slot.index)), {
      deload: input.load.phase === 'deload',
      knownWeightKg: input.knownLoads?.get(exerciseFor(slot, input.chosen?.get(slot.index)).id),
    }),
  )

  return {
    kind: 'strength',
    focus: 'full',
    workoutId: input.workout.id,
    exercises,
    estimatedMinutes: Math.round(estimateMinutes(exercises)),
  }
}

/** Ćwiczenie główne albo wybrana alternatywa. */
export function exerciseFor(slot: WorkoutSlot, chosenId?: string): WorkoutExercise {
  if (!chosenId || chosenId === slot.main.id) return slot.main
  return slot.alternatives.find((alt) => alt.id === chosenId) ?? slot.main
}

export interface PlannedExerciseOptions {
  deload?: boolean
  /** Ciężar z logu; wygrywa z ciężarem startowym z arkusza. */
  knownWeightKg?: number | null | undefined
}

/**
 * Jedno ćwiczenie planu z ćwiczenia z arkusza.
 *
 * Eksportowane, bo tej samej ścieżki używa podmiana na alternatywę w trakcie
 * planu (`planRepo.swapExercise`): wariant musi wejść do sesji z własnymi
 * seriami, powtórzeniami, przerwą i ciężarem startowym, a nie odziedziczyć
 * parametry ćwiczenia, które zastępuje.
 */
export function plannedWorkoutExercise(
  exercise: WorkoutExercise,
  options: PlannedExerciseOptions = {},
): PlannedExercise {
  const deload = options.deload === true
  const sets = deload ? Math.max(MIN_SETS, exercise.sets - 1) : exercise.sets

  const carried = options.knownWeightKg
  const base = carried !== undefined && carried !== null && carried > 0 ? carried : exercise.startWeightKg
  const weightKg =
    base === null
      ? null
      : deload
        ? deloadWeight(base)
        : base

  const set: PlannedSet = { reps: exercise.reps, weightKg, targetRpe: TARGET_RPE }

  return {
    exerciseId: exercise.id,
    sets: Array.from({ length: sets }, () => ({ ...set })),
    restSec: exercise.restSec,
  }
}

export function estimateMinutes(exercises: readonly PlannedExercise[]): number {
  const working = exercises.reduce((total, exercise) => {
    const reps = exercise.sets[0]?.reps ?? 10
    return total + exercise.sets.length * (reps * SECONDS_PER_REP + exercise.restSec)
  }, 0)
  return WARMUP_MINUTES + working / 60
}
