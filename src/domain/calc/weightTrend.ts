import type { WeightEntry, WeightTrendPoint } from '../types'
import { diffDays } from '../dates'

/** Domyślny półokres wygładzania. 7 dni działa dobrze i przy ważeniu codziennym, i tygodniowym. */
export const DEFAULT_HALF_LIFE_DAYS = 7

/**
 * Wygładzanie wykładnicze wagi (EWMA) odporne na nieregularne odstępy.
 *
 * Po co: dobowe wahania nawodnienia to ±1,5 kg. Surowy wykres wagi jest
 * szumem, który demoluje motywację i uniemożliwia policzenie realnego TDEE.
 * Wszystkie decyzje (adaptacja kalorii, wykresy, ocena postępu) opierają się
 * na trendzie, nigdy na ostatnim pomiarze.
 *
 * Współczynnik wygładzania liczymy z faktycznej luki między pomiarami:
 *
 *   α = 1 − exp(−ln2 · Δdni / półokres)
 *
 * Dzięki temu pomiar po dwóch tygodniach przerwy waży więcej niż pomiar
 * z dnia na dzień — czego naiwne EWMA ze stałą α nie potrafi.
 */
export function weightTrend(
  entries: readonly WeightEntry[],
  halfLifeDays = DEFAULT_HALF_LIFE_DAYS,
): WeightTrendPoint[] {
  if (halfLifeDays <= 0) throw new RangeError('Półokres musi być dodatni')

  const sorted = [...entries]
    .filter((e) => !e.deletedAt && Number.isFinite(e.weightKg) && e.weightKg > 0)
    .sort((a, b) => a.date.localeCompare(b.date))

  const out: WeightTrendPoint[] = []
  let trend: number | null = null
  let prevDate: string | null = null

  for (const entry of sorted) {
    if (trend === null || prevDate === null) {
      trend = entry.weightKg
    } else {
      const gapDays = Math.max(1, diffDays(prevDate, entry.date))
      const alpha = 1 - Math.exp((-Math.LN2 * gapDays) / halfLifeDays)
      trend = alpha * entry.weightKg + (1 - alpha) * trend
    }
    prevDate = entry.date
    out.push({ date: entry.date, weightKg: entry.weightKg, trendKg: round2(trend) })
  }

  return out
}

/** Ostatni punkt trendu — waga, na której opierają się wszystkie decyzje. */
export function currentTrendKg(points: readonly WeightTrendPoint[]): number | null {
  const last = points.at(-1)
  return last ? last.trendKg : null
}

/**
 * Tempo zmiany trendu w kg/tydzień, liczone regresją liniową po punktach
 * z ostatnich `windowDays` dni. Regresja, nie „ostatni minus pierwszy" —
 * pojedynczy odstający pomiar na krańcu okna nie może zdominować wyniku.
 */
export function trendRateKgPerWeek(
  points: readonly WeightTrendPoint[],
  windowDays = 28,
): number | null {
  const last = points.at(-1)
  if (!last) return null

  const window = points.filter((p) => diffDays(p.date, last.date) <= windowDays)
  if (window.length < 2) return null

  const first = window[0]
  if (!first) return null

  const xs = window.map((p) => diffDays(first.date, p.date))
  const ys = window.map((p) => p.trendKg)
  const n = window.length
  const meanX = xs.reduce((a, b) => a + b, 0) / n
  const meanY = ys.reduce((a, b) => a + b, 0) / n

  let numerator = 0
  let denominator = 0
  for (let i = 0; i < n; i++) {
    const dx = (xs[i] ?? 0) - meanX
    numerator += dx * ((ys[i] ?? 0) - meanY)
    denominator += dx * dx
  }
  if (denominator === 0) return null

  const slopePerDay = numerator / denominator
  return round2(slopePerDay * 7)
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
