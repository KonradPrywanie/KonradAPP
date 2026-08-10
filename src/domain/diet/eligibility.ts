import type { DietRestrictions, Recipe } from '../types'
import { normalize } from '../text'
import { recipeAllergens, recipeDietStyles } from './derive'

/**
 * Filtr twardych wykluczeń.
 *
 * Alergeny i styl diety NIE są preferencją do zważenia w funkcji kosztu —
 * są warunkiem koniecznym. Przepis albo wolno zaproponować, albo nie.
 * Dlatego ten filtr jest osobno od solvera i działa przed nim.
 *
 * Dane, na których pracuje, są WYLICZANE z nazw składników (`derive.ts`),
 * bo arkusz przepisów nie deklaruje ani alergenów, ani stylu diety.
 */

/** Re-eksport dla wygody wywołujących — definicja żyje w `domain/text.ts`. */
export { normalize }

export interface IneligibleReason {
  recipeId: string
  reason: 'dietStyle' | 'allergen' | 'disliked'
  detail: string
}

export function recipeEligibility(
  recipe: Recipe,
  restrictions: DietRestrictions,
): IneligibleReason | null {
  if (!recipeDietStyles(recipe).includes(restrictions.style)) {
    return { recipeId: recipe.id, reason: 'dietStyle', detail: restrictions.style }
  }

  const allergens = new Set(restrictions.allergens)
  if (allergens.size > 0) {
    const conflict = recipeAllergens(recipe).find((a) => allergens.has(a))
    if (conflict) {
      return { recipeId: recipe.id, reason: 'allergen', detail: conflict }
    }
  }

  /**
   * „Czego nie jem" dopasowujemy do nazwy przepisu i nazw składników.
   *
   * Wcześniej terminy szły po tagach produktów i przepisów. Tagów nie ma —
   * arkusz ich nie zawiera — a nazwy składników są dokładniejsze: „twaróg"
   * wyklucza konkretnie te przepisy, w których twaróg występuje, a nie
   * wszystko, co ktoś kiedyś otagował jako nabiał.
   */
  const disliked = [...restrictions.dislikedTags, ...restrictions.excludedProductIds]
    .map(normalize)
    .filter(Boolean)

  if (disliked.length > 0) {
    const texts = [
      normalize(recipe.name),
      ...recipe.ingredients.map((ing) => normalize(ing.name)),
      ...recipe.spices.map(normalize),
    ]
    for (const term of disliked) {
      const hit = texts.find((text) => text.includes(term))
      if (hit) return { recipeId: recipe.id, reason: 'disliked', detail: term }
    }
  }

  return null
}

export function isRecipeEligible(recipe: Recipe, restrictions: DietRestrictions): boolean {
  return recipeEligibility(recipe, restrictions) === null
}

export function eligibleRecipes(
  recipes: readonly Recipe[],
  restrictions: DietRestrictions,
): Recipe[] {
  return recipes.filter((r) => isRecipeEligible(r, restrictions))
}
