import type { CalcWarning, IsoDate, WeightTrendPoint } from '../types'
import { diffDays } from '../dates'

/**
 * Energia zmagazynowana w 1 kg tkanki tłuszczowej. Przybliżenie — przy zmianach
 * masy ubywa też wody i glikogenu, dlatego wymagamy okna ≥14 dni, w którym
 * te składniki się stabilizują.
 */
export const KCAL_PER_KG_BODY_MASS = 7700

/** Poniżej tej liczby dni wynik jest zdominowany przez wahania nawodnienia. */
export const MIN_WINDOW_DAYS = 14
/** Dłuższe okno = stabilniejszy wynik, ale słabsza reakcja na zmiany. */
export const DEFAULT_WINDOW_DAYS = 28
/** Minimalny udział dni z zalogowanym jedzeniem. */
export const MIN_COVERAGE = 0.7

/** Zagregowane kalorie na dzień — wejście z `mealLogs`. */
export interface DailyIntake {
  date: IsoDate
  kcal: number
}

export interface AdaptiveTdeeResult {
  tdee: number
  /** Wysoka: pełne okno i dobre pokrycie. Niska: minimum danych. */
  confidence: 'low' | 'medium' | 'high'
  daysUsed: number
  /** Udział dni z zalogowanym jedzeniem, 0–1. */
  coverage: number
  avgIntakeKcal: number
  trendChangeKg: number
  warnings: CalcWarning[]
}

export interface AdaptiveTdeeInput {
  trend: readonly WeightTrendPoint[]
  intake: readonly DailyIntake[]
  /** Do sanity-checku wyniku — realny TDEE nie schodzi poniżej BMR. */
  bmr: number
  windowDays?: number
}

/**
 * Realny TDEE policzony z danych, a nie z mnożnika aktywności.
 *
 *   TDEE = średnie spożycie − (zmiana trendu masy · 7700 / dni)
 *
 * Kluczowe: liczymy ze ZMIANY TRENDU, nie ze zmiany surowej wagi. Surowa waga
 * na krańcach okna potrafi chybić o ±1,5 kg, co przy 28 dniach daje błąd
 * ~400 kcal — czyli więcej niż cały efekt, którego szukamy.
 *
 * Zwraca `null` gdy danych jest za mało; wtedy zostajemy przy TDEE
 * z mnożnika aktywności.
 */
export function adaptiveTdee(input: AdaptiveTdeeInput): AdaptiveTdeeResult | null {
  const windowDays = input.windowDays ?? DEFAULT_WINDOW_DAYS
  const warnings: CalcWarning[] = []

  const lastTrend = input.trend.at(-1)
  if (!lastTrend) return null

  const endDate = lastTrend.date
  const windowTrend = input.trend.filter((p) => diffDays(p.date, endDate) <= windowDays)
  const firstTrend = windowTrend[0]
  if (!firstTrend) return null

  const daysUsed = diffDays(firstTrend.date, endDate)
  if (daysUsed < MIN_WINDOW_DAYS) {
    return null
  }

  // Pokrycie liczymy wyłącznie w oknie i tylko dla dni z niezerowym wpisem.
  const intakeInWindow = input.intake.filter(
    (d) => d.kcal > 0 && d.date <= endDate && diffDays(d.date, endDate) <= daysUsed,
  )
  const coverage = intakeInWindow.length / (daysUsed + 1)
  if (coverage < MIN_COVERAGE) {
    return null
  }

  const avgIntakeKcal = Math.round(
    intakeInWindow.reduce((sum, d) => sum + d.kcal, 0) / intakeInWindow.length,
  )
  const trendChangeKg = round2(lastTrend.trendKg - firstTrend.trendKg)

  const dailyEnergyFromMass = (trendChangeKg * KCAL_PER_KG_BODY_MASS) / daysUsed
  let tdee = Math.round(avgIntakeKcal - dailyEnergyFromMass)

  // Sanity-check: wynik poza tym zakresem oznacza błędne dane wejściowe,
  // najczęściej niedoszacowane logi jedzenia.
  const lowerBound = Math.round(input.bmr)
  const upperBound = Math.round(input.bmr * 2.6)
  if (tdee < lowerBound || tdee > upperBound) {
    warnings.push({
      code: 'insufficientData',
      message:
        `Wyliczony wydatek (${tdee} kcal) wychodzi poza wiarygodny zakres ` +
        `${lowerBound}–${upperBound} kcal. Najczęstsza przyczyna to niepełne ` +
        'logowanie posiłków. Wynik został ograniczony do granicy zakresu.',
    })
    tdee = Math.min(upperBound, Math.max(lowerBound, tdee))
  }

  return {
    tdee,
    confidence: confidenceOf(daysUsed, coverage),
    daysUsed,
    coverage: round2(coverage),
    avgIntakeKcal,
    trendChangeKg,
    warnings,
  }
}

function confidenceOf(daysUsed: number, coverage: number): AdaptiveTdeeResult['confidence'] {
  if (daysUsed >= 21 && coverage >= 0.9) return 'high'
  if (daysUsed >= 17 && coverage >= 0.8) return 'medium'
  return 'low'
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
