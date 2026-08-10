import type { Profile, RunBaseline, SwimBaseline } from '../types'

/**
 * Warunki konieczne do zbudowania planu.
 *
 * Wcześniej brak punktu wyjścia w cardio był tylko niedogodnością: generator
 * podstawiał preset dla poziomu doświadczenia i milczał. Efekt był gorszy niż
 * błąd — plan wyglądał wiarygodnie, a dystanse i tempo dotyczyły kogoś innego.
 * Dwie osoby oznaczone jako „początkująca" mogą różnić się o dwie minuty na
 * kilometrze, więc preset dawał albo trening nie do wykonania, albo spacer.
 *
 * Dlatego dane są teraz WARUNKIEM: gdy wśród sprzętu jest bieganie albo basen,
 * a punktu wyjścia nie ma, plan się nie tworzy. Odmowa jest lepsza od planu
 * zbudowanego na zgadywanych liczbach.
 */
export type PlanInputGap = 'runBaseline' | 'swimBaseline'

export const PLAN_INPUT_GAP_LABELS: Record<PlanInputGap, string> = {
  runBaseline: 'maksymalny dystans biegu i tempo, w jakim go pokonujesz',
  swimBaseline: 'maksymalna liczba długości basenu przepływana bez przerwy',
}

export function isRunBaselineComplete(baseline: RunBaseline | undefined): boolean {
  if (!baseline) return false
  return (
    Number.isFinite(baseline.distanceM) &&
    baseline.distanceM > 0 &&
    Number.isFinite(baseline.paceSecPerKm) &&
    baseline.paceSecPerKm > 0
  )
}

export function isSwimBaselineComplete(baseline: SwimBaseline | undefined): boolean {
  if (!baseline) return false
  return (
    Number.isFinite(baseline.laps) &&
    baseline.laps > 0 &&
    (baseline.poolLengthM === 25 || baseline.poolLengthM === 50)
  )
}

/**
 * Czego brakuje, żeby plan dało się zbudować.
 *
 * Pytamy tylko o dyscypliny, które użytkownik zgłosił jako dostępne —
 * wymaganie tempa biegu od osoby trenującej wyłącznie w domu byłoby absurdem.
 * Pusta lista znaczy „można generować".
 */
export function missingPlanInputs(profile: Profile): PlanInputGap[] {
  const gaps: PlanInputGap[] = []
  if (profile.equipment.includes('running') && !isRunBaselineComplete(profile.runBaseline)) {
    gaps.push('runBaseline')
  }
  if (profile.equipment.includes('pool') && !isSwimBaselineComplete(profile.swimBaseline)) {
    gaps.push('swimBaseline')
  }
  return gaps
}

/** Rzucany przez repozytorium planu — plan nie powstaje bez tych danych. */
export class MissingPlanInputsError extends Error {
  readonly gaps: PlanInputGap[]

  constructor(gaps: PlanInputGap[]) {
    super(
      'Nie da się zbudować planu bez punktu wyjścia w cardio. Brakuje: ' +
        gaps.map((gap) => PLAN_INPUT_GAP_LABELS[gap]).join('; ') + '.',
    )
    this.name = 'MissingPlanInputsError'
    this.gaps = gaps
  }
}
