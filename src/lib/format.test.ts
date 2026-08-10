import { describe, expect, it } from 'vitest'
import { countLabel, formatIngredientAmount, sessionsLabel, weeksLabel } from './format'

describe('formatIngredientAmount', () => {
  it('REGRESJA: nie obcina końcowych zer — 240 ml to nie 24 ml', () => {
    // Pierwsza wersja liczyła to przez `pl(value, 0)`, które po `toFixed(0)`
    // usuwało końcowe zera. Jadłospis pokazywał „24 ml mleka" i „6 g makaronu".
    // Wyszło z podglądu w konsoli, nie z testów.
    expect(formatIngredientAmount({ amount: 240, unit: 'ml' })).toBe('240 ml')
    expect(formatIngredientAmount({ amount: 60, unit: 'g' })).toBe('60 g')
    expect(formatIngredientAmount({ amount: 100, unit: 'g' })).toBe('100 g')
    expect(formatIngredientAmount({ amount: 1000, unit: 'g' })).toBe('1000 g')
  })

  it('sztuki i połówki po polsku', () => {
    expect(formatIngredientAmount({ amount: 2, unit: 'piece' })).toBe('2 szt')
    expect(formatIngredientAmount({ amount: 0.5, unit: 'piece' })).toBe('0,5 szt')
    expect(formatIngredientAmount({ amount: 1.5, unit: 'piece' })).toBe('1,5 szt')
  })

  it('bez ilości pokazuje zapis ze źródła albo „do smaku"', () => {
    expect(formatIngredientAmount({ amount: null, unit: 'g', label: '2 ząbki' })).toBe('2 ząbki')
    expect(formatIngredientAmount({ amount: null, unit: 'g' })).toBe('do smaku')
  })
})

/**
 * Odmiana po liczebniku ma własny test, bo trzeciej formy („5 tygodni") i wyjątku
 * nastek („12 tygodni", nie „12 tygodnie") nie widać w kodzie na pierwszy rzut
 * oka, a błąd wychodzi dopiero na ekranie użytkownika — przy jednej z wielu
 * liczb, których nikt nie sprawdza ręcznie.
 */
describe('countLabel', () => {
  const weeks = (n: number) => countLabel(n, ['tydzień', 'tygodnie', 'tygodni'])

  it('daje trzy formy polskiego liczebnika', () => {
    expect(weeks(1)).toBe('1 tydzień')
    expect(weeks(2)).toBe('2 tygodnie')
    expect(weeks(4)).toBe('4 tygodnie')
    expect(weeks(5)).toBe('5 tygodni')
    expect(weeks(21)).toBe('21 tygodni')
    expect(weeks(22)).toBe('22 tygodnie')
  })

  it('nastki idą do formy „wielu" — 12, nie 12 tygodnie', () => {
    for (const n of [12, 13, 14]) {
      expect(weeks(n), `${n}`).toBe(`${n} tygodni`)
    }
  })

  it('zero też ma swoją formę', () => {
    expect(weeks(0)).toBe('0 tygodni')
    expect(sessionsLabel(0)).toBe('0 sesji')
  })

  it('etykiety pochodne używają tej samej reguły', () => {
    expect(weeksLabel(2)).toBe('2 tygodnie')
    expect(sessionsLabel(1)).toBe('1 sesja')
    expect(sessionsLabel(3)).toBe('3 sesje')
    expect(sessionsLabel(14)).toBe('14 sesji')
  })
})
