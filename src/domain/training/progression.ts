import type { MovementPattern, PlannedSet, SetLog } from '../types'

export type ProgressionVerdict = 'advance' | 'hold' | 'regress'

export interface ProgressionResult {
  verdict: ProgressionVerdict
  /** Sugerowany ciężar na kolejną sesję. Null dla masy własnej lub braku danych. */
  suggestedWeightKg: number | null
  reason: string
}

/** Najmniejszy praktyczny skok obciążenia (para talerzy 1,25 kg). */
export const WEIGHT_STEP_KG = 2.5
/**
 * O ile obniżamy obciążenie w tygodniu deloadu.
 *
 * Mieszka TUTAJ, a nie w `workout.ts`, bo to reguła o obciążeniu i potrzebują
 * jej trzy drogi: budowanie sesji z arkusza, progresja z logu i aktualizacja
 * tygodnia z historii. Wcześniej liczba żyła tylko w pierwszej z nich, więc
 * dwie pozostałe deload po cichu KASOWAŁY — patrz `deloadWeight`.
 */
export const DELOAD_LOAD_FACTOR = 0.9
/** Powyżej tego RPE serie były zbyt ciężkie, żeby dokładać obciążenie. */
export const RPE_CEILING_FOR_ADVANCE = 8
/** Niedobór powtórzeń, przy którym cofamy obciążenie. */
const REGRESS_REP_SHORTFALL = 2
/** Dolne partie znoszą większe skoki procentowe. */
const LOWER_BODY_PATTERNS: readonly MovementPattern[] = ['squat', 'hinge']
const LOWER_BODY_INCREMENT_PCT = 0.05
const REGRESS_PCT = 0.9

export interface ProgressionInput {
  planned: readonly PlannedSet[]
  logged: readonly SetLog[]
  pattern: MovementPattern
}

/**
 * Decyzja o obciążeniu na kolejny tydzień — z DANYCH, nie z kalendarza.
 *
 * To najważniejsza różnica między generatorem planów a trenerem. Pierwotna
 * wizja podnosiła obciążenie co tydzień z góry, niezależnie od tego, czy
 * poprzedni tydzień został wykonany. Taki plan po miesiącu rozjeżdża się
 * z rzeczywistością: albo jest za lekki, albo niewykonalny.
 *
 * Reguła: wszystkie zaplanowane serie wykonane w zakresie powtórzeń przy
 * RPE ≤ 8 → dokładamy. Cokolwiek mniej → powtarzamy tydzień. Wyraźny
 * niedobór powtórzeń → cofamy obciążenie.
 */
export function evaluateProgression(input: ProgressionInput): ProgressionResult {
  const { planned, logged, pattern } = input

  if (logged.length === 0) {
    return { verdict: 'hold', suggestedWeightKg: null, reason: 'Brak zalogowanych serii.' }
  }

  const maxWeight = maxLoggedWeight(logged)
  const rpes = logged.map((s) => s.rpe).filter((r): r is number => typeof r === 'number')
  const avgRpe = rpes.length > 0 ? rpes.reduce((a, b) => a + b, 0) / rpes.length : null

  const targetRepsFor = (index: number): number =>
    planned[index]?.reps ?? planned.at(-1)?.reps ?? 0

  const shortfall = logged.some((set, i) => set.reps < targetRepsFor(i) - REGRESS_REP_SHORTFALL)
  if (shortfall) {
    return {
      verdict: 'regress',
      suggestedWeightKg: maxWeight === null ? null : roundToStep(maxWeight * REGRESS_PCT),
      reason: 'Powtórzenia wyraźnie poniżej planu — obciążenie było za duże.',
    }
  }

  const allSetsDone = logged.length >= planned.length
  const repsMet = logged.every((set, i) => set.reps >= targetRepsFor(i))

  if (!allSetsDone) {
    return {
      verdict: 'hold',
      suggestedWeightKg: maxWeight,
      reason: `Wykonano ${logged.length} z ${planned.length} serii — powtórz ten tydzień.`,
    }
  }

  if (!repsMet) {
    return {
      verdict: 'hold',
      suggestedWeightKg: maxWeight,
      reason: 'Nie wszystkie serie w docelowym zakresie powtórzeń.',
    }
  }

  if (avgRpe !== null && avgRpe > RPE_CEILING_FOR_ADVANCE) {
    return {
      verdict: 'hold',
      suggestedWeightKg: maxWeight,
      reason: `Średnie RPE ${round1(avgRpe)} — plan wykonany, ale zbyt dużym kosztem.`,
    }
  }

  if (maxWeight === null) {
    return {
      verdict: 'advance',
      suggestedWeightKg: null,
      reason: 'Plan wykonany. Ćwiczenie z masą własną — dodaj powtórzenia lub utrudnij wariant.',
    }
  }

  const increment = LOWER_BODY_PATTERNS.includes(pattern)
    ? Math.max(WEIGHT_STEP_KG, roundToStep(maxWeight * LOWER_BODY_INCREMENT_PCT))
    : WEIGHT_STEP_KG

  return {
    verdict: 'advance',
    suggestedWeightKg: roundToStep(maxWeight + increment),
    reason:
      avgRpe === null
        ? `Plan wykonany w pełni — dokładamy ${increment} kg.`
        : `Plan wykonany przy RPE ${round1(avgRpe)} — dokładamy ${increment} kg.`,
  }
}

/**
 * Ciężar tygodnia deloadu z ciężaru roboczego.
 *
 * Jedno miejsce na to przeliczenie, żeby każda droga ustawiania obciążenia
 * (arkusz, progresja, historia) obniżała je tak samo.
 *
 * Zaokrąglamy W DÓŁ, nie do najbliższego kroku, i to nie jest drobiazg:
 * przy 32,5 kg dziewięćdziesiąt procent to 29,25 kg, a najbliższy krok to
 * 30 kg — dokładnie tyle, ile było w tygodniu akumulacji. Deload wychodził
 * wtedy „lżejszy" o zero kilogramów. W dół daje 27,5 kg, czyli tydzień
 * faktycznie lżejszy.
 *
 * Podłoga to jeden krok: przy hantlach 2,5 kg nie ma czego zdejmować, a zero
 * kilogramów nie jest deloadem, tylko brakiem ćwiczenia.
 */
export function deloadWeight(weightKg: number): number {
  const reduced = Math.floor((weightKg * DELOAD_LOAD_FACTOR) / WEIGHT_STEP_KG) * WEIGHT_STEP_KG
  return Math.max(WEIGHT_STEP_KG, reduced)
}

export interface ApplyProgressionOptions {
  /**
   * Czy tydzień docelowy jest deloadem.
   *
   * KLUCZOWE, a wcześniej tego nie było: progresja wpisywała podniesiony ciężar
   * także w tydzień deloadu, więc „tydzień lżejszy" wychodził CIĘŻSZY niż
   * poprzedni (przy 40 kg i skoku o 2,5 kg deload dostawał 42,5 kg zamiast
   * 35 kg). Rytm 3 + 1 przestawał wtedy istnieć — zostawała mu jedna seria
   * mniej, a to nie jest deload, tylko krótszy trening z rekordowym ciężarem.
   */
  deload?: boolean
}

/**
 * Nakłada wynik progresji na serie kolejnego tygodnia.
 *
 * Przy `advance` z masą własną (brak sugerowanego ciężaru) dokładamy jedno
 * powtórzenie — inaczej postęp nie miałby gdzie się zapisać. W deloadzie
 * powtórzeń NIE dokładamy z tego samego powodu, dla którego zdejmujemy ciężar.
 */
export function applyProgression(
  nextPlanned: readonly PlannedSet[],
  result: ProgressionResult,
  options: ApplyProgressionOptions = {},
): PlannedSet[] {
  const deload = options.deload === true

  return nextPlanned.map((set) => {
    if (result.suggestedWeightKg !== null) {
      const weightKg = deload ? deloadWeight(result.suggestedWeightKg) : result.suggestedWeightKg
      return { ...set, weightKg }
    }
    if (result.verdict === 'advance' && !deload) {
      return { ...set, reps: set.reps + 1 }
    }
    return { ...set }
  })
}

/** Objętość treningowa: suma ciężar × powtórzenia. Podstawa statystyk. */
export function trainingVolumeKg(logged: readonly SetLog[]): number {
  return Math.round(
    logged.reduce((total, set) => total + (set.weightKg ?? 0) * set.reps, 0),
  )
}

function maxLoggedWeight(logged: readonly SetLog[]): number | null {
  const weights = logged
    .map((s) => s.weightKg)
    .filter((w): w is number => typeof w === 'number' && w > 0)
  return weights.length > 0 ? Math.max(...weights) : null
}

/** Zaokrąglenie do najmniejszego praktycznego skoku obciążenia. */
export function roundToWeightStep(weightKg: number): number {
  return Math.round(weightKg / WEIGHT_STEP_KG) * WEIGHT_STEP_KG
}

const roundToStep = roundToWeightStep

function round1(n: number): number {
  return Math.round(n * 10) / 10
}
