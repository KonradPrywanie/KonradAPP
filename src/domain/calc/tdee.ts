import type { ActivityLevel } from '../types'

/**
 * Klasyczne mnożniki aktywności.
 *
 * Uwaga: są bardzo niedokładne — potrafią chybić o 300–500 kcal, bo nie
 * uwzględniają NEAT ani indywidualnej efektywności metabolicznej. Traktujemy
 * je jako PUNKT STARTOWY. Po 14 dniach logowania przełączamy się na
 * `adaptiveTdee()`, który liczy realny wydatek z trendu wagi i spożycia.
 */
export const ACTIVITY_MULTIPLIERS: Record<ActivityLevel, number> = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  high: 1.725,
  veryHigh: 1.9,
}

export const ACTIVITY_LABELS_PL: Record<ActivityLevel, string> = {
  sedentary: 'siedząca — praca biurowa, brak treningów',
  light: 'lekka — 1–3 treningi w tygodniu',
  moderate: 'średnia — 3–5 treningów w tygodniu',
  high: 'wysoka — 6–7 treningów w tygodniu',
  veryHigh: 'bardzo wysoka — praca fizyczna lub 2 treningi dziennie',
}

export function tdee(bmr: number, level: ActivityLevel): number {
  if (!Number.isFinite(bmr) || bmr <= 0) throw new RangeError('BMR musi być dodatnie')
  return Math.round(bmr * ACTIVITY_MULTIPLIERS[level])
}
