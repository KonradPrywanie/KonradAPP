import { useState } from 'react'
import type { MealLog, PlannedMeal } from '@/domain/types'
import { RECIPES_BY_ID } from '@/lib/catalog'
import { MEAL_SLOT_LABELS } from '@/lib/labels'
import { formatIngredientAmount } from '@/lib/format'
import { Badge, Button } from '@/components/ui'

export function MealCard({
  meal,
  log,
  note,
  onLog,
  onUnlog,
  onSubstitute,
  onRemove,
}: {
  meal: PlannedMeal
  log: MealLog | undefined
  /** Adnotacja nad kartą — dziś używana do gotowania obiadu na dwa dni. */
  note?: string | undefined
  /** Wynik jest ignorowany — interesuje nas tylko moment zakończenia. */
  onLog: () => void | Promise<unknown>
  onUnlog: () => void | Promise<unknown>
  onSubstitute: () => void
  /** Usunięcie posiłku z planu. Bez tego propa przycisku nie ma. */
  onRemove?: () => void | Promise<unknown>
}) {
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(false)
  const recipe = RECIPES_BY_ID.get(meal.recipeId)
  const eaten = log !== undefined

  async function run(action: () => void | Promise<unknown>) {
    setBusy(true)
    try {
      await action()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs tracking-wide text-[var(--color-text-dim)] uppercase">
              {MEAL_SLOT_LABELS[meal.slot]}
            </span>
            {eaten && <Badge tone="ok">zjedzone</Badge>}
          </div>
          <p className="mt-0.5 font-medium">{recipe?.name ?? meal.recipeId}</p>
          <p className="mt-0.5 text-sm text-[var(--color-text-dim)]">
            {meal.computed.kcal} kcal · {meal.computed.proteinG} B · {meal.computed.fatG} T ·{' '}
            {meal.computed.carbsG} W
            {recipe ? ` · ~${recipe.prepMinutes} min` : ''}
          </p>
          {note && <p className="mt-1 text-sm text-[var(--color-accent)]">{note}</p>}
        </div>
        <Button
          variant={eaten ? 'ghost' : 'primary'}
          disabled={busy}
          onClick={() => run(eaten ? onUnlog : onLog)}
        >
          {eaten ? 'Cofnij' : 'Zjadłem'}
        </Button>
      </div>

      <div className="mt-2 flex gap-3 text-sm">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="min-h-11 text-[var(--color-accent)]"
        >
          {expanded ? 'Ukryj składniki' : 'Składniki i przygotowanie'}
        </button>
        <button
          type="button"
          onClick={onSubstitute}
          className="min-h-11 text-[var(--color-text-dim)]"
        >
          Zamień
        </button>
        {/**
         * „Usuń" pojawia się tylko przy posiłku NIEZJEDZONYM.
         *
         * Log jest nienaruszalny i wlicza się do bilansu dnia, więc skasowanie
         * planu pod zapisanym wpisem zostawiłoby kalorie bez pozycji, przy
         * której je widać. Kolejność jest naturalna: najpierw „Cofnij", potem
         * „Usuń" — i tak samo pilnuje tego `dietRepo.removeMeal`.
         */}
        {onRemove && !eaten && (
          <button
            type="button"
            disabled={busy}
            onClick={() => run(onRemove)}
            className="min-h-11 text-[var(--color-danger)] disabled:opacity-50"
          >
            Usuń
          </button>
        )}
      </div>

      {expanded && (
        <div className="mt-2 border-t border-[var(--color-border)] pt-2">
          <ul className="grid gap-1 text-sm">
            {meal.ingredients.map((ing) => (
              <li key={ing.name} className="flex justify-between gap-3">
                <span>{ing.name}</span>
                <span className="shrink-0 text-[var(--color-text-dim)]">
                  {formatIngredientAmount(ing)}
                </span>
              </li>
            ))}
          </ul>

          {/* Przyprawy z przepisu — bez gramatur, tak jak podaje je arkusz.
              Bez nich instrukcja mówi „dopraw", nie mówiąc czym. */}
          {recipe && recipe.spices.length > 0 && (
            <p className="mt-2 text-sm">
              <span className="text-[var(--color-text-dim)]">Przyprawy: </span>
              {recipe.spices.join(', ')}
            </p>
          )}

          {recipe && (
            <ol className="mt-3 grid gap-1 text-sm text-[var(--color-text-dim)]">
              {recipe.steps.map((step, index) => (
                <li key={step}>
                  {index + 1}. {step}
                </li>
              ))}
            </ol>
          )}
          {recipe?.prepNote && (
            <p className="mt-2 text-xs text-[var(--color-text-dim)]">
              Uwaga na czas: {recipe.prepNote}.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
