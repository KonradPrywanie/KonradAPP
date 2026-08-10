import type { CalcWarning, Goal, Sex } from '../types'
import { bmiCategory } from './bmi'

/**
 * Granice bezpieczeństwa żyją TUTAJ, nie w UI.
 * UI może je pokazać, ale nie może ich obejść.
 */
export const KCAL_FLOOR: Record<Sex, number> = { male: 1500, female: 1200 }

/** Maksymalny dopuszczalny deficyt dobowy — ~0,7 kg tkanki tłuszczowej/tydzień. */
export const MAX_DEFICIT_KCAL = 750

/** Maksymalna dopuszczalna nadwyżka — powyżej rośnie głównie tłuszcz. */
export const MAX_SURPLUS_KCAL = 400

const GOAL_ADJUSTMENT: Record<Goal, number> = {
  cut: -0.2,
  maintain: 0,
  bulk: 0.1,
  conditioning: 0,
  /** Przygotowanie do zawodów: utrzymanie masy, cała adaptacja idzie w trening. */
  event: 0,
}

export interface KcalTargetInput {
  tdee: number
  bmr: number
  goal: Goal
  sex: Sex
  weightKg: number
  heightCm: number
  /** Ręczne nadpisanie — nadal podlega podłodze bezpieczeństwa. */
  override?: number | null | undefined
}

export interface KcalTargetResult {
  kcal: number
  /** Cel przed zastosowaniem ograniczeń — do pokazania „dlaczego inna liczba". */
  rawKcal: number
  warnings: CalcWarning[]
}

export function kcalTarget(input: KcalTargetInput): KcalTargetResult {
  const { tdee, bmr, goal, sex, weightKg, heightCm } = input
  if (!Number.isFinite(tdee) || tdee <= 0) throw new RangeError('TDEE musi być dodatnie')

  const warnings: CalcWarning[] = []
  const category = bmiCategory(bmiOf(weightKg, heightCm))

  let effectiveGoal = goal
  if (goal === 'cut' && category === 'underweight') {
    // Nie proponujemy deficytu osobie z niedowagą, nawet jeśli o to poprosiła.
    effectiveGoal = 'maintain'
    warnings.push({
      code: 'underweightNoDeficit',
      message:
        'BMI wskazuje niedowagę — deficyt kaloryczny nie został zastosowany. ' +
        'Cel ustawiono na utrzymanie masy. Rozważ konsultację z lekarzem lub dietetykiem.',
    })
  }

  const rawKcal = Math.round(tdee * (1 + GOAL_ADJUSTMENT[effectiveGoal]))
  let kcal = rawKcal

  // 1. Ograniczenie wielkości zmiany względem TDEE.
  if (tdee - kcal > MAX_DEFICIT_KCAL) {
    kcal = tdee - MAX_DEFICIT_KCAL
    warnings.push({
      code: 'deficitCapped',
      message: `Deficyt ograniczono do ${MAX_DEFICIT_KCAL} kcal/dzień.`,
    })
  }
  if (kcal - tdee > MAX_SURPLUS_KCAL) {
    kcal = tdee + MAX_SURPLUS_KCAL
  }

  // 2. Ręczne nadpisanie — użytkownik decyduje, ale podłoga obowiązuje.
  if (input.override != null && Number.isFinite(input.override) && input.override > 0) {
    kcal = Math.round(input.override)
  }

  // 3. Podłoga bezpieczeństwa — ostatnia i nieprzekraczalna.
  const floor = KCAL_FLOOR[sex]
  if (kcal < floor) {
    kcal = floor
    warnings.push({
      code: 'kcalFloorApplied',
      message: `Cel podniesiono do minimum bezpieczeństwa ${floor} kcal.`,
    })
  }

  // 4. Ostrzeżenie informacyjne — nie zmieniamy wyniku.
  if (kcal < bmr) {
    warnings.push({
      code: 'belowBmr',
      message:
        `Cel (${kcal} kcal) jest poniżej podstawowej przemiany materii (${bmr} kcal). ` +
        'Długotrwale może to spowolnić metabolizm i utratę masy mięśniowej.',
    })
  }

  return { kcal, rawKcal, warnings }
}

function bmiOf(weightKg: number, heightCm: number): number {
  const m = heightCm / 100
  return weightKg / (m * m)
}
