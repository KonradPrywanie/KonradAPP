import { describe, expect, it } from 'vitest'
import {
  addDays,
  dateRange,
  diffDays,
  endOfWeek,
  isoWeekday,
  startOfWeek,
  toIsoDate,
  weekOrderIndex,
  WEEK_START_DAY,
} from './dates'

describe('dates', () => {
  it('liczy różnicę dni', () => {
    expect(diffDays('2026-01-01', '2026-01-29')).toBe(28)
    expect(diffDays('2026-01-29', '2026-01-01')).toBe(-28)
    expect(diffDays('2026-01-01', '2026-01-01')).toBe(0)
  })

  it('przesuwa datę przez granice miesiąca i roku', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01')
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01') // 2026 nie jest przestępny
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31')
  })

  it('jest odporne na zmianę czasu — parsujemy w południe UTC', () => {
    // Ostatnia niedziela marca 2026 = zmiana na czas letni w PL.
    expect(addDays('2026-03-28', 1)).toBe('2026-03-29')
    expect(addDays('2026-03-29', 1)).toBe('2026-03-30')
    expect(diffDays('2026-03-28', '2026-03-30')).toBe(2)
    // Ostatnia niedziela października = powrót na czas zimowy.
    expect(diffDays('2026-10-24', '2026-10-26')).toBe(2)
  })

  it('zwraca dzień tygodnia w konwencji ISO (1 = poniedziałek)', () => {
    expect(isoWeekday('2026-01-01')).toBe(4) // czwartek
    expect(isoWeekday('2026-01-04')).toBe(7) // niedziela
    expect(isoWeekday('2026-01-05')).toBe(1) // poniedziałek
  })

  it('tydzień zaczyna się w sobotę', () => {
    expect(WEEK_START_DAY).toBe(6)
    // 2026-08-01 to sobota — jest własnym początkiem tygodnia.
    expect(startOfWeek('2026-08-01')).toBe('2026-08-01')
    // Niedziela należy do tygodnia POPRZEDZAJĄCEJ ją soboty, nie do następnej.
    expect(startOfWeek('2026-08-02')).toBe('2026-08-01')
    expect(startOfWeek('2026-08-05')).toBe('2026-08-01') // środa
    expect(startOfWeek('2026-08-07')).toBe('2026-08-01') // piątek — ostatni dzień
    expect(startOfWeek('2026-08-08')).toBe('2026-08-08') // kolejna sobota
  })

  it('tydzień kończy się w piątek', () => {
    expect(endOfWeek('2026-08-01')).toBe('2026-08-07')
    expect(endOfWeek('2026-08-05')).toBe('2026-08-07')
    expect(diffDays(startOfWeek('2026-08-05'), endOfWeek('2026-08-05'))).toBe(6)
  })

  it('weekOrderIndex porządkuje dni od soboty', () => {
    expect(weekOrderIndex(6)).toBe(0) // sobota
    expect(weekOrderIndex(7)).toBe(1) // niedziela
    expect(weekOrderIndex(1)).toBe(2) // poniedziałek
    expect(weekOrderIndex(5)).toBe(6) // piątek
  })

  it('startOfWeek zgadza się z isoWeekday dla każdego dnia', () => {
    // Niezmiennik: początek tygodnia zawsze wypada w dniu WEEK_START_DAY
    // i nigdy nie jest datą z przyszłości.
    for (const date of dateRange('2026-08-01', '2026-09-15')) {
      const start = startOfWeek(date)
      expect(isoWeekday(start)).toBe(WEEK_START_DAY)
      expect(diffDays(start, date)).toBeGreaterThanOrEqual(0)
      expect(diffDays(start, date)).toBeLessThan(7)
    }
  })

  it('generuje zakres dat włącznie z krańcami', () => {
    expect(dateRange('2026-01-01', '2026-01-03')).toEqual([
      '2026-01-01',
      '2026-01-02',
      '2026-01-03',
    ])
    expect(dateRange('2026-01-01', '2026-01-01')).toEqual(['2026-01-01'])
    expect(dateRange('2026-01-03', '2026-01-01')).toEqual([])
  })

  it('odrzuca nieprawidłowy format daty', () => {
    expect(() => diffDays('01-01-2026', '2026-01-02')).toThrow(RangeError)
    expect(() => diffDays('2026-1-1', '2026-01-02')).toThrow(RangeError)
  })

  it('toIsoDate jest odwrotnością parsowania', () => {
    expect(toIsoDate(new Date(Date.UTC(2026, 6, 29, 12)))).toBe('2026-07-29')
  })
})
