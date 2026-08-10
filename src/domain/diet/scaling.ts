import type { Macros, MealIngredient, MealSlot, Recipe, Unit } from '../types'

/** Alias na `MealIngredient` — ta sama struktura, inny kontekst użycia. */
export type ScaledIngredient = MealIngredient

export interface ScaledMeal {
  recipeId: string
  slot: MealSlot
  scale: number
  ingredients: ScaledIngredient[]
  macros: Macros
  prepMinutes: number
}

/**
 * Krok zaokrąglania ilości po przeskalowaniu porcji.
 *
 * Pięć gramów i pięć mililitrów, bo tyle da się odmierzyć w kuchni: „137 g
 * kurczaka" jest liczbą z solvera, nie z przepisu. Sztuki idą co pół, bo
 * arkusz sam używa połówek („Jajko (1/2 szt)").
 */
const STEP: Record<Unit, number> = { g: 5, ml: 5, piece: 0.5 }

/** Zaokrągla ilość do kroku jednostki; nigdy nie schodzi do zera. */
export function roundAmount(amount: number, unit: Unit): number {
  const step = STEP[unit]
  const steps = Math.round(amount / step)
  return round2(Math.max(1, steps) * step)
}

/**
 * Skaluje przepis do zadanego mnożnika porcji.
 *
 * Makro mnożymy przez ten sam współczynnik co ilości i to jest poprawne:
 * kalorie i makroskładniki są liniowe w masie porcji. Wartości bazowe pochodzą
 * z arkusza — nie liczymy ich ponownie ze składników, bo nie mamy (i nie
 * chcemy zgadywać) wartości odżywczych 267 produktów.
 *
 * Rozjazd, o którym warto wiedzieć: ilości są zaokrąglane do 5 g, a makro nie.
 * Przy najgorszym trafieniu daje to ±2,5 g na składniku, czyli ułamek procenta
 * dziennego bilansu — mniej, niż wynosi różnica między dwoma piersiami
 * z kurczaka tej samej wagi. Odwrotna kolejność (liczenie makra z zaokrąglonych
 * gramatur) wymagałaby właśnie tych wartości na 100 g, których nie ma.
 *
 * Składniki bez podanej ilości (czosnek, sok z cytryny, erytrytol) zostają bez
 * zmian — potrojenie „czosnku" nie znaczy nic, a fałszowałoby listę zakupów.
 */
export function scaleRecipe(recipe: Recipe, scale: number): ScaledMeal {
  const ingredients: ScaledIngredient[] = recipe.ingredients.map((ing) => ({
    name: ing.name,
    amount: ing.amount === null ? null : roundAmount(ing.amount * scale, ing.unit),
    unit: ing.unit,
    ...(ing.label === undefined ? {} : { label: ing.label }),
  }))

  return {
    recipeId: recipe.id,
    slot: recipe.slot,
    scale: round2(scale),
    ingredients,
    macros: scaleMacros(recipe.macros, scale),
    prepMinutes: recipe.prepMinutes,
  }
}

export function scaleMacros(macros: Macros, scale: number): Macros {
  return {
    kcal: Math.round(macros.kcal * scale),
    proteinG: round1(macros.proteinG * scale),
    fatG: round1(macros.fatG * scale),
    carbsG: round1(macros.carbsG * scale),
  }
}

export function sumMacros(items: readonly { macros: Macros }[]): Macros {
  let kcal = 0
  let proteinG = 0
  let fatG = 0
  let carbsG = 0
  for (const item of items) {
    kcal += item.macros.kcal
    proteinG += item.macros.proteinG
    fatG += item.macros.fatG
    carbsG += item.macros.carbsG
  }
  return { kcal: Math.round(kcal), proteinG: round1(proteinG), fatG: round1(fatG), carbsG: round1(carbsG) }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
