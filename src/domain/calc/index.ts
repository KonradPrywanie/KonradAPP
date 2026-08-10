import type { NutritionTargets, Profile } from '../types'
import { bmi, bmiCategory } from './bmi'
import { ageFromBirthYear, calcBmr } from './bmr'
import { tdee } from './tdee'
import { kcalTarget } from './kcalTarget'
import { macros } from './macros'

export * from './bmi'
export * from './bmr'
export * from './tdee'
export * from './kcalTarget'
export * from './macros'
export * from './weightTrend'
export * from './adaptiveTdee'

/**
 * Pełny zestaw celów żywieniowych dla profilu.
 *
 * `currentWeightKg` pochodzi z trendu wagi (nie z ostatniego pomiaru!),
 * a gdy historii jeszcze nie ma — z wagi startowej z profilu.
 * `overrideTdee` pozwala wstrzyknąć adaptacyjny TDEE, gdy jest już policzony.
 */
export function nutritionTargets(
  profile: Profile,
  currentWeightKg: number = profile.startWeightKg,
  overrideTdee?: number | null,
): NutritionTargets {
  const age = ageFromBirthYear(profile.birthYear)
  const bmiValue = bmi(currentWeightKg, profile.heightCm)

  const { bmr, formula } = calcBmr({
    sex: profile.sex,
    weightKg: currentWeightKg,
    heightCm: profile.heightCm,
    age,
    bodyFatPct: profile.bodyFatPct,
  })

  const tdeeValue = overrideTdee ?? tdee(bmr, profile.activityLevel)

  const target = kcalTarget({
    tdee: tdeeValue,
    bmr,
    goal: profile.goal,
    sex: profile.sex,
    weightKg: currentWeightKg,
    heightCm: profile.heightCm,
    override: profile.kcalOverride,
  })

  const macroResult = macros({
    kcal: target.kcal,
    goal: profile.goal,
    weightKg: currentWeightKg,
    heightCm: profile.heightCm,
    bodyFatPct: profile.bodyFatPct,
  })

  return {
    bmi: bmiValue,
    bmiCategory: bmiCategory(bmiValue),
    bmr,
    bmrFormula: formula,
    tdee: tdeeValue,
    kcal: target.kcal,
    macros: macroResult.macros,
    warnings: [...target.warnings, ...macroResult.warnings],
  }
}
