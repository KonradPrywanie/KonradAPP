/**
 * Podgląd wyjścia solvera diety w konsoli.
 *
 * Kryterium bramki „posiłki wyglądają jak jedzenie, a nie jak wynik solvera"
 * nie da się sprawdzić asercją — trzeba je zobaczyć. To narzędzie do tego służy.
 *
 *   npx vite-node scripts/dietReport.ts
 *   npx vite-node scripts/dietReport.ts 3000 bulk 95 180
 */
import { RECIPES_BY_ID } from '@/data/recipes'
import { macros } from '@/domain/calc/macros'
import { BATCH_LUNCH_DAYS, solveWeek, type DietCatalog } from '@/domain/diet/solver'
import { SWEET_SNACK, plannedMealTargets } from '@/domain/diet/sweetSnack'
import { DIET_CATALOG } from '@/lib/catalog'
import { DEFAULT_MEAL_SPLIT } from '@/data/presetProfile'
import { MEAL_SLOT_LABELS } from '@/lib/labels'
import { formatIngredientAmount } from '@/lib/format'
import type { Goal } from '@/domain/types'

const [kcalArg, goalArg, weightArg, heightArg] = process.argv.slice(2)
const kcal = Number(kcalArg ?? 2500)
const goal = (goalArg ?? 'bulk') as Goal
const weightKg = Number(weightArg ?? 85)
const heightCm = Number(heightArg ?? 180)

const dailyTargets = macros({ kcal, goal, weightKg, heightCm }).macros
// Solver dostaje cel POMNIEJSZONY o rezerwę na słodką przekąskę — tak samo,
// jak w aplikacji (patrz `solverInput` w `dietRepo`).
const targets = plannedMealTargets(dailyTargets)
// Katalog przez `lib/catalog`, żeby podgląd widział ten sam filtr,
// co aplikacja (`BANNED_INGREDIENT_TERMS`, dziś pusty).
const catalog: DietCatalog = DIET_CATALOG

console.log(
  `\nCel dzienny: ${dailyTargets.kcal} kcal | ${dailyTargets.proteinG} g B | ` +
    `${dailyTargets.fatG} g T | ${dailyTargets.carbsG} g W  ` +
    `(${goal}, ${weightKg} kg, ${heightCm} cm)`,
)
console.log(
  `Dla posiłków: ${targets.kcal} kcal — reszta (${SWEET_SNACK.kcal} kcal) to słodka ` +
    `przekąska wpisywana ręcznie\n`,
)

const week = solveWeek({
  targets,
  mealSplit: DEFAULT_MEAL_SPLIT,
  restrictions: { style: 'omnivore', allergens: [], dislikedTags: [], excludedProductIds: [] },
  catalog,
  seedBase: 'podglad',
  startDate: '2026-08-03',
  maxPrepMinutes: 90,
  // Tak samo jak aplikacja przy `prepStyle: 'batch'` — obiad na dwa dni.
  lunchBatchDays: BATCH_LUNCH_DAYS,
  days: 4,
})

for (const { date, day } of week) {
  if (!day) {
    console.log(`${date}: brak rozwiązania\n`)
    continue
  }

  console.log(`── ${date} ──────────────────────────────────────────────`)
  for (const meal of day.meals) {
    const recipe = RECIPES_BY_ID.get(meal.recipeId)
    console.log(`\n  ${MEAL_SLOT_LABELS[meal.slot]}: ${recipe?.name ?? meal.recipeId}  (×${meal.scale})`)
    for (const ing of meal.ingredients) {
      console.log(`      ${ing.name.padEnd(38)} ${formatIngredientAmount(ing)}`)
    }
    if (recipe && recipe.spices.length > 0) {
      console.log(`      przyprawy: ${recipe.spices.join(', ')}`)
    }
    console.log(
      `      → ${meal.macros.kcal} kcal | ${meal.macros.proteinG} B | ` +
        `${meal.macros.fatG} T | ${meal.macros.carbsG} W`,
    )
  }

  const d = day.deviation
  console.log(`\n  ${MEAL_SLOT_LABELS.snack}: do wpisania ręcznie (~${SWEET_SNACK.kcal} kcal)`)
  console.log(
    `\n  RAZEM (posiłki): ${day.totals.kcal} kcal | ${day.totals.proteinG} B | ` +
      `${day.totals.fatG} T | ${day.totals.carbsG} W` +
      `   → z przekąską ${day.totals.kcal + SWEET_SNACK.kcal} / ${dailyTargets.kcal} kcal`,
  )
  console.log(
    `  Odchylenia: kcal ${fmt(d.kcalPct)} | B ${fmt(d.proteinPct)} | ` +
      `T ${fmt(d.fatPct)} | W ${fmt(d.carbsPct)}   ` +
      `${day.withinTolerance ? '✓ w tolerancji' : '✗ POZA TOLERANCJĄ'}\n`,
  )
}

function fmt(pct: number): string {
  return `${pct > 0 ? '+' : ''}${pct}%`
}
