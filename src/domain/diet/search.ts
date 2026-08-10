import { normalize } from '../text'

/**
 * Wyszukiwanie przepisu po wpisanym tekście.
 *
 * Powód istnienia: lista zamienników pokazuje CAŁY katalog na dany slot —
 * ponad czterdzieści pozycji w pięciu grupach. To była świadoma zmiana (ranking
 * odpowiada tylko na pytanie „co najlepiej trafia w makra", a posiłek wybiera
 * się też dlatego, że coś jest w lodówce), ale przewijanie czterdziestu kart
 * w poszukiwaniu „tego dania z łososiem" jest gorsze niż wpisanie „losos".
 *
 * Szukamy w nazwie I w składnikach, bo obie drogi są naturalne: „placki"
 * to pytanie o danie, „kurczak" to pytanie o to, co trzeba zużyć. Przypraw
 * w wyszukiwaniu NIE MA — „curry" wyrzuciłoby dania, w których jest ono tylko
 * doprawieniem, a nie tym, czego się szuka.
 */

/** Tyle wystarczy, żeby przepis dało się wyszukać. */
export interface SearchableRecipe {
  name: string
  ingredients: readonly { name: string }[]
}

/**
 * Wpisany tekst → słowa do dopasowania.
 *
 * Normalizacja zdejmuje polskie znaki, więc „lekki twarozek" znajduje
 * „Lekki twarożek" — nikt nie przełącza klawiatury w trakcie szukania.
 */
export function searchTerms(query: string): string[] {
  return normalize(query).split(/\s+/).filter(Boolean)
}

/**
 * Czy przepis pasuje do WSZYSTKICH wpisanych słów.
 *
 * Koniunkcja, nie alternatywa: „kurczak ryz" ma znaleźć danie z jednym
 * i drugim, a nie wszystko, co ma kurczaka LUB ryż — przy alternatywie drugie
 * słowo poszerzałoby wynik zamiast go zawężać, czyli działałoby odwrotnie
 * do tego, po co się je dopisuje. Każde słowo dopasowujemy jako FRAGMENT,
 * żeby „twaroz" trafiało w „twarożek" bez znajomości odmiany.
 */
export function recipeMatches(recipe: SearchableRecipe, terms: readonly string[]): boolean {
  if (terms.length === 0) return true
  const haystack = [recipe.name, ...recipe.ingredients.map((ing) => ing.name)].map(normalize)
  return terms.every((term) => haystack.some((text) => text.includes(term)))
}
