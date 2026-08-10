import type { Sex } from '../types'

export type BmrFormula = 'mifflin' | 'katch'

export interface BmrInput {
  sex: Sex
  weightKg: number
  heightCm: number
  age: number
  /** Gdy podany — używamy Katch-McArdle, dokładniejszego przy nietypowej kompozycji ciała. */
  bodyFatPct?: number | undefined
}

export interface BmrResult {
  bmr: number
  formula: BmrFormula
}

/**
 * Mifflin-St Jeor — domyślny wzór.
 * Najlepiej zwalidowany dla populacji ogólnej.
 *
 *   M: 10·W + 6,25·H − 5·A + 5
 *   K: 10·W + 6,25·H − 5·A − 161
 */
export function bmrMifflin({ sex, weightKg, heightCm, age }: Omit<BmrInput, 'bodyFatPct'>): number {
  assertPositive({ weightKg, heightCm, age })
  const base = 10 * weightKg + 6.25 * heightCm - 5 * age
  return Math.round(base + (sex === 'male' ? 5 : -161))
}

/**
 * Katch-McArdle — liczy z masy beztłuszczowej, więc nie potrzebuje płci ani wzrostu.
 *
 *   BMR = 370 + 21,6 · LBM,  LBM = W · (1 − %BF/100)
 */
export function bmrKatchMcArdle(weightKg: number, bodyFatPct: number): number {
  assertPositive({ weightKg })
  if (bodyFatPct < 3 || bodyFatPct > 60) {
    throw new RangeError('Procent tkanki tłuszczowej poza wiarygodnym zakresem 3–60%')
  }
  const leanMassKg = weightKg * (1 - bodyFatPct / 100)
  return Math.round(370 + 21.6 * leanMassKg)
}

/** Wybiera wzór automatycznie: Katch-McArdle gdy znany %BF, inaczej Mifflin. */
export function calcBmr(input: BmrInput): BmrResult {
  if (input.bodyFatPct !== undefined && input.bodyFatPct !== null) {
    return { bmr: bmrKatchMcArdle(input.weightKg, input.bodyFatPct), formula: 'katch' }
  }
  return { bmr: bmrMifflin(input), formula: 'mifflin' }
}

export function ageFromBirthYear(birthYear: number, today = new Date()): number {
  return today.getUTCFullYear() - birthYear
}

function assertPositive(values: Record<string, number>): void {
  for (const [key, value] of Object.entries(values)) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError(`${key} musi być dodatnią liczbą`)
    }
  }
}
