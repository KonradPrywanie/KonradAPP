import { describe, expect, it } from 'vitest'
import type { WeightEntry, WeightTrendPoint } from '../types'
import { addDays } from '../dates'
import { currentTrendKg, trendRateKgPerWeek, weightTrend } from './weightTrend'
import { MIN_COVERAGE, adaptiveTdee } from './adaptiveTdee'

function entry(date: string, weightKg: number, deleted = false): WeightEntry {
  return {
    id: `w-${date}`,
    date,
    weightKg,
    createdAt: `${date}T08:00:00.000Z`,
    updatedAt: `${date}T08:00:00.000Z`,
    deletedAt: deleted ? `${date}T09:00:00.000Z` : null,
  }
}

function dailyEntries(start: string, weights: number[]): WeightEntry[] {
  return weights.map((w, i) => entry(addDays(start, i), w))
}

describe('weightTrend', () => {
  it('pierwszy punkt trendu równa się pierwszemu pomiarowi', () => {
    const points = weightTrend([entry('2026-01-01', 80)])
    expect(points).toHaveLength(1)
    expect(points[0]?.trendKg).toBe(80)
  })

  it('przy odstępie równym półokresowi waży pomiary dokładnie pół na pół', () => {
    // α = 1 − exp(−ln2 · 7/7) = 0,5  →  trend = 0,5·84 + 0,5·80 = 82
    const points = weightTrend([entry('2026-01-01', 80), entry('2026-01-08', 84)], 7)
    expect(points[1]?.trendKg).toBeCloseTo(82, 2)
  })

  it('trend tłumi pojedynczy odstający pomiar', () => {
    // Skok o 2 kg jednego dnia (retencja wody) nie może przesunąć trendu o 2 kg.
    const points = weightTrend(dailyEntries('2026-01-01', [80, 80, 80, 82, 80]))
    const spike = points[3]
    expect(spike?.weightKg).toBe(82)
    expect(spike?.trendKg).toBeLessThan(80.5)
    expect(spike?.trendKg).toBeGreaterThan(80)
  })

  it('dłuższa przerwa daje nowemu pomiarowi większą wagę', () => {
    const shortGap = weightTrend([entry('2026-01-01', 80), entry('2026-01-02', 84)], 7)
    const longGap = weightTrend([entry('2026-01-01', 80), entry('2026-02-01', 84)], 7)
    const shortTrend = shortGap[1]?.trendKg ?? 0
    const longTrend = longGap[1]?.trendKg ?? 0
    expect(longTrend).toBeGreaterThan(shortTrend)
    // Po 31 dniach α = 1 − exp(−ln2 · 31/7) = 0,954, więc trend niemal dogonił
    // pomiar: 0,954·84 + 0,046·80 = 83,81.
    expect(longTrend).toBeCloseTo(83.81, 1)
    // Przy odstępie 1 dnia α = 0,094 — nowy pomiar prawie nie rusza trendu.
    expect(shortTrend).toBeLessThan(80.5)
  })

  it('sortuje wpisy po dacie niezależnie od kolejności wejścia', () => {
    const points = weightTrend([entry('2026-01-08', 84), entry('2026-01-01', 80)], 7)
    expect(points.map((p) => p.date)).toEqual(['2026-01-01', '2026-01-08'])
    expect(points[0]?.trendKg).toBe(80)
  })

  it('pomija wpisy usunięte miękko', () => {
    const points = weightTrend([entry('2026-01-01', 80), entry('2026-01-02', 120, true)])
    expect(points).toHaveLength(1)
  })

  it('trend zawsze mieści się między najmniejszym i największym pomiarem', () => {
    const weights = [80, 81.5, 79.2, 80.4, 78.9, 79.8]
    const points = weightTrend(dailyEntries('2026-01-01', weights))
    const min = Math.min(...weights)
    const max = Math.max(...weights)
    for (const p of points) {
      expect(p.trendKg).toBeGreaterThanOrEqual(min)
      expect(p.trendKg).toBeLessThanOrEqual(max)
    }
  })

  it('currentTrendKg zwraca null dla pustej historii', () => {
    expect(currentTrendKg([])).toBeNull()
  })

  it('odrzuca niedodatni półokres', () => {
    expect(() => weightTrend([entry('2026-01-01', 80)], 0)).toThrow(RangeError)
  })
})

describe('trendRateKgPerWeek', () => {
  function point(date: string, trendKg: number): WeightTrendPoint {
    return { date, weightKg: trendKg, trendKg }
  }

  it('liczy nachylenie regresją — spadek 1 kg/tydzień', () => {
    const points = [
      point('2026-01-01', 80),
      point('2026-01-08', 79),
      point('2026-01-15', 78),
      point('2026-01-22', 77),
    ]
    expect(trendRateKgPerWeek(points)).toBeCloseTo(-1, 2)
  })

  it('zwraca 0 dla stabilnej masy', () => {
    const points = [point('2026-01-01', 80), point('2026-01-08', 80), point('2026-01-15', 80)]
    expect(trendRateKgPerWeek(points)).toBeCloseTo(0, 2)
  })

  it('zwraca null gdy w oknie jest mniej niż dwa punkty', () => {
    expect(trendRateKgPerWeek([point('2026-01-01', 80)])).toBeNull()
    expect(trendRateKgPerWeek([])).toBeNull()
  })
})

describe('adaptiveTdee', () => {
  /** 29 punktów trendu: liniowy spadek `from` → `to`. */
  function linearTrend(start: string, days: number, from: number, to: number): WeightTrendPoint[] {
    return Array.from({ length: days }, (_, i) => {
      const trendKg = from + ((to - from) * i) / (days - 1)
      return { date: addDays(start, i), weightKg: trendKg, trendKg }
    })
  }

  function flatIntake(start: string, days: number, kcal: number) {
    return Array.from({ length: days }, (_, i) => ({ date: addDays(start, i), kcal }))
  }

  it('liczy realny TDEE ze zmiany trendu i średniego spożycia', () => {
    // Spadek 1 kg w 28 dni = 275 kcal/dzień deficytu.  2200 + 275 = 2475
    const result = adaptiveTdee({
      trend: linearTrend('2026-01-01', 29, 80, 79),
      intake: flatIntake('2026-01-01', 29, 2200),
      bmr: 1780,
    })
    expect(result).not.toBeNull()
    expect(result?.tdee).toBe(2475)
    expect(result?.daysUsed).toBe(28)
    expect(result?.trendChangeKg).toBe(-1)
    expect(result?.confidence).toBe('high')
    expect(result?.warnings).toHaveLength(0)
  })

  it('przy stabilnej masie TDEE równa się spożyciu', () => {
    const result = adaptiveTdee({
      trend: linearTrend('2026-01-01', 29, 80, 80),
      intake: flatIntake('2026-01-01', 29, 2600),
      bmr: 1780,
    })
    expect(result?.tdee).toBe(2600)
  })

  it('przy wzroście masy TDEE jest niższe od spożycia', () => {
    const result = adaptiveTdee({
      trend: linearTrend('2026-01-01', 29, 80, 81),
      intake: flatIntake('2026-01-01', 29, 3000),
      bmr: 1780,
    })
    expect(result?.tdee).toBe(3000 - 275)
  })

  it('zwraca null gdy okno jest krótsze niż 14 dni', () => {
    const result = adaptiveTdee({
      trend: linearTrend('2026-01-01', 10, 80, 79.5),
      intake: flatIntake('2026-01-01', 10, 2200),
      bmr: 1780,
    })
    expect(result).toBeNull()
  })

  it('zwraca null gdy logowanie jedzenia ma zbyt małe pokrycie', () => {
    const result = adaptiveTdee({
      trend: linearTrend('2026-01-01', 29, 80, 79),
      intake: flatIntake('2026-01-01', 15, 2200), // 15/29 ≈ 0,52
      bmr: 1780,
    })
    expect(15 / 29).toBeLessThan(MIN_COVERAGE)
    expect(result).toBeNull()
  })

  it('nie liczy dni z zerowym spożyciem jako pokrytych', () => {
    const intake = flatIntake('2026-01-01', 29, 2200).map((d, i) =>
      i % 2 === 0 ? { ...d, kcal: 0 } : d,
    )
    const result = adaptiveTdee({
      trend: linearTrend('2026-01-01', 29, 80, 79),
      intake,
      bmr: 1780,
    })
    expect(result).toBeNull()
  })

  it('ogranicza absurdalny wynik i ostrzega — objaw niepełnego logowania', () => {
    const result = adaptiveTdee({
      trend: linearTrend('2026-01-01', 29, 80, 80),
      intake: flatIntake('2026-01-01', 29, 900),
      bmr: 1780,
    })
    expect(result?.tdee).toBe(1780)
    expect(result?.warnings.map((w) => w.code)).toContain('insufficientData')
  })

  it('obniża pewność przy słabszym pokryciu', () => {
    const intake = flatIntake('2026-01-01', 29, 2200).filter((_, i) => i % 5 !== 0) // ~80%
    const result = adaptiveTdee({
      trend: linearTrend('2026-01-01', 29, 80, 79),
      intake,
      bmr: 1780,
    })
    expect(result?.confidence).not.toBe('high')
  })
})
