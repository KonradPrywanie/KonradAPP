import { describe, expect, it } from 'vitest'
import { RECIPES } from '@/data/recipes'
import { normalize } from '../text'
import { recipeMatches, searchTerms } from './search'

/** Skrót: czy przepis pasuje do wpisanego tekstu. */
function matches(recipe: Parameters<typeof recipeMatches>[0], query: string): boolean {
  return recipeMatches(recipe, searchTerms(query))
}

const SALMON = {
  name: 'Łosoś pieczony z ryżem',
  ingredients: [{ name: 'Łosoś świeży' }, { name: 'Ryż basmati' }, { name: 'Cytryna' }],
}

describe('wyszukiwanie przepisów', () => {
  it('pusty tekst przepuszcza wszystko', () => {
    // Zamknięcie wyszukiwania ma pokazać CAŁĄ listę, nie zero pozycji.
    expect(searchTerms('   ')).toEqual([])
    expect(matches(SALMON, '')).toBe(true)
    expect(matches(SALMON, '   ')).toBe(true)
  })

  it('KRYTYCZNE: polskie znaki nie decydują o wyniku', () => {
    // Nikt nie przełącza klawiatury w trakcie szukania, a część nazw ma
    // diakrytyki w środku wyrazu („Łosoś", „Twarożek", „Ryż").
    expect(matches(SALMON, 'losos')).toBe(true)
    expect(matches(SALMON, 'łosoś')).toBe(true)
    expect(matches(SALMON, 'RYZ')).toBe(true)
  })

  it('szuka też w składnikach, nie tylko w nazwie dania', () => {
    // „Cytryna" nie występuje w nazwie — a to pełnoprawny powód wyboru dania
    // („co mam zużyć z lodówki").
    expect(matches(SALMON, 'cytryna')).toBe(true)
    expect(matches(SALMON, 'kurczak')).toBe(false)
  })

  it('dopasowuje fragment, więc odmiana nie ma znaczenia', () => {
    expect(matches(SALMON, 'piecz')).toBe(true)
    expect(matches(SALMON, 'basmat')).toBe(true)
  })

  it('KRYTYCZNE: kilka słów ZAWĘŻA wynik, nie poszerza', () => {
    /**
     * Koniunkcja, nie alternatywa. Przy alternatywie dopisanie drugiego słowa
     * dawałoby WIĘCEJ wyników niż jedno — czyli działałoby odwrotnie do tego,
     * po co się je dopisuje.
     */
    expect(matches(SALMON, 'losos ryz')).toBe(true)
    expect(matches(SALMON, 'losos kurczak')).toBe(false)
  })

  it('na prawdziwej bazie znajduje po składniku i nic więcej', () => {
    const terms = searchTerms('kurczak')
    const found = RECIPES.filter((recipe) => recipeMatches(recipe, terms))

    expect(found.length).toBeGreaterThan(0)
    expect(found.length).toBeLessThan(RECIPES.length)
    for (const recipe of found) {
      const text = [recipe.name, ...recipe.ingredients.map((i) => i.name)].map(normalize).join(' ')
      expect(text, recipe.name).toContain('kurczak')
    }
  })

  it('tekst spoza bazy daje pustkę, a nie całą listę', () => {
    // Zero wyników to poprawna odpowiedź; ekran mówi o tym wprost zamiast
    // pokazywać wszystko tak, jakby filtr nie zadziałał.
    expect(RECIPES.filter((r) => recipeMatches(r, searchTerms('wegorz w galarecie')))).toEqual([])
  })
})
