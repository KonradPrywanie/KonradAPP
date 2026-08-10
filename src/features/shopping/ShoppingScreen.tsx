import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import type { Recipe, ShoppingItem, ShoppingList } from '@/domain/types'
import {
  groupByCategory,
  sourceMealKey,
  withoutEatenMeals,
} from '@/domain/shopping/aggregate'
import { addDays, startOfWeek, todayIso } from '@/domain/dates'
import { dietRepo } from '@/db/dietRepo'
import { mealLogRepo } from '@/db/repositories'
import { shoppingItemKey, shoppingRepo } from '@/db/shoppingRepo'
import { RECIPES_BY_ID } from '@/lib/catalog'
import { MEAL_SLOT_LABELS } from '@/lib/labels'
import {
  formatDayMonth,
  formatIngredientAmount,
  formatShoppingAmount,
  formatWeekday,
  countLabel,
  mealsLabel,
} from '@/lib/format'
import { Badge, Button, Callout, Card, Checkbox, SectionTitle, Spinner } from '@/components/ui'
import { Screen, ScreenHeader } from '@/app/AppShell'

export function ShoppingScreen() {
  const [weekOffset, setWeekOffset] = useState(0)
  /**
   * Domyślnie lista pokazuje TYLKO to, czego jeszcze nie zjadłeś. Przełącznik
   * jest dla sytuacji odwrotnej: „ile tego było w całym tygodniu" — np. przy
   * planowaniu zakupów z wyprzedzeniem albo przy sprawdzaniu, czy pozycja
   * zniknęła słusznie.
   */
  const [showEaten, setShowEaten] = useState(false)
  const weekStart = startOfWeek(addDays(todayIso(), weekOffset * 7))

  const data = useLiveQuery(async () => {
    const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i))
    const [list, meals, logsByDay] = await Promise.all([
      shoppingRepo.forWeek(weekStart),
      dietRepo.mealsForWeek(weekStart),
      Promise.all(days.map((date) => mealLogRepo.byDate(date))),
    ])

    /**
     * Posiłki zjedzone: te, do których istnieje wpis w logu.
     *
     * Idziemy przez `plannedMealId`, nie przez slot i datę — wpisy ręczne
     * („zjadłem coś innego") mają go pustego i nie mogą zdejmować z listy
     * składników posiłku, którego nie tknąłeś. Odhaczenie „Cofnij" kasuje log
     * miękko, więc pozycja wraca na listę sama.
     */
    const loggedMealIds = new Set(
      logsByDay.flat().flatMap((log) => (log.plannedMealId ? [log.plannedMealId] : [])),
    )
    const eatenMeals = new Set(
      meals.filter((meal) => loggedMealIds.has(meal.id)).map(sourceMealKey),
    )

    return { list, hasMeals: meals.length > 0, eatenMeals, eatenCount: eatenMeals.size }
  }, [weekStart])

  if (!data) return <Spinner />

  /**
   * Tydzień zakupowy liczy się od SOBOTY do piątku — tak samo jak tydzień
   * planu i jadłospisu. Nazwy dni są w etykiecie obok dat, bo sama para
   * „1 sie – 7 sie" nie mówi, że lista otwiera się w weekend, a to decyduje
   * o tym, kiedy trzeba pójść do sklepu.
   */
  const weekLabel = `sob ${formatDayMonth(weekStart)} – pt ${formatDayMonth(addDays(weekStart, 6))}`

  return (
    <Screen>
      <ScreenHeader
        title="Lista zakupów"
        subtitle={weekLabel}
        action={
          <div className="flex gap-1 print:hidden">
            <Button variant="ghost" onClick={() => setWeekOffset((v) => v - 1)}>
              ‹
            </Button>
            <Button variant="ghost" onClick={() => setWeekOffset((v) => v + 1)}>
              ›
            </Button>
          </div>
        }
      />

      {!data.hasMeals ? (
        <Callout tone="warn" title="Brak jadłospisu na ten tydzień">
          Lista zakupów wynika z jadłospisu. Wygeneruj go najpierw w zakładce Dieta.
        </Callout>
      ) : !data.list ? (
        <Card>
          <SectionTitle hint="Ilości są sumowane z całego tygodnia i pokazane tak, jak są potrzebne — bez zaokrąglania do opakowań handlowych. Przypraw na liście nie ma: są w karcie posiłku, przy instrukcji.">
            Lista nie została jeszcze zbudowana
          </SectionTitle>
          <BuildButton weekStart={weekStart} label="Zbuduj listę zakupów" />
        </Card>
      ) : (
        /**
         * Filtr „już zjedzone" liczymy TU, przy wyświetlaniu, a nie przez
         * przebudowę zapisanej listy: zjadłeś obiad — pozycja znika, cofnąłeś
         * wpis — wraca. Przebudowa przy każdym „Zjadłem" byłaby nieodwracalna
         * i gubiłaby odhaczenia pozycji, które zdążyły z listy zniknąć.
         */
        <ShoppingItems
          list={data.list}
          weekStart={weekStart}
          eatenMeals={data.eatenMeals}
          eatenCount={data.eatenCount}
          showEaten={showEaten}
          onToggleEaten={() => setShowEaten((v) => !v)}
        />
      )}
    </Screen>
  )
}

/**
 * Lista zakupów zawężona do posiłków, których jeszcze nie zjadłeś.
 *
 * Osobny komponent, bo zawężenie ma trzy skutki naraz i wszystkie muszą
 * widzieć tę samą liczbę pozycji: sama lista, licznik „x z y" i informacja
 * o tym, ile i dlaczego zniknęło. Bez tej ostatniej pozycja znikająca po
 * kliknięciu „Zjadłem" na innym ekranie wygląda jak zgubiona.
 */
function ShoppingItems({
  list,
  weekStart,
  eatenMeals,
  eatenCount,
  showEaten,
  onToggleEaten,
}: {
  list: ShoppingList
  weekStart: string
  /** Klucze `sourceMealKey` posiłków, które mają wpis w logu. */
  eatenMeals: ReadonlySet<string>
  eatenCount: number
  showEaten: boolean
  onToggleEaten: () => void
}) {
  const remaining = withoutEatenMeals(list.items, eatenMeals)
  const hidden = list.items.length - remaining.length
  const items = showEaten ? list.items : remaining

  return (
    <>
      {eatenCount > 0 && (
        <Callout title={`Zjedzone w tym tygodniu: ${mealsLabel(eatenCount)}`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>
              {showEaten
                ? 'Widać całą listę tygodnia, także składniki posiłków już zjedzonych.'
                : hidden > 0
                  ? // Dopełniacz przy „ukryto", więc formy nie są mianownikiem
                    // z `countLabel` po sąsiedzku (1 pozycję, 2 pozycje, 5 pozycji).
                    `Ukryto ${countLabel(hidden, ['pozycję', 'pozycje', 'pozycji'])} — ` +
                    'ich składniki są już w lodówce albo zjedzone.'
                  : 'Ilości są pomniejszone o to, co już zjedzone.'}
            </span>
            <button
              type="button"
              onClick={onToggleEaten}
              className="min-h-9 text-[var(--color-accent)] print:hidden"
            >
              {showEaten ? 'Pokaż tylko do kupienia' : 'Pokaż całą listę'}
            </button>
          </div>
        </Callout>
      )}

      {items.length === 0 ? (
        <Callout tone="info" title="Nie ma czego kupować">
          Wszystkie posiłki z tego tygodnia są już zjedzone.
        </Callout>
      ) : (
        <>
          <ListProgress items={items} />

          {groupByCategory(items).map((group) => (
            <Card key={group.category}>
              <SectionTitle>{group.category}</SectionTitle>
              <div className="grid">
                {group.items.map((item) => (
                  // Klucz z nazwy I jednostki — nazwa sama nie jest unikalna
                  // (czosnek stoi na liście w gramach i w ząbkach), a duplikat
                  // klucza zostawiał na ekranie ducha pozycji po przebudowie.
                  <ItemRow key={shoppingItemKey(item)} listId={list.id} item={item} />
                ))}
              </div>
            </Card>
          ))}
        </>
      )}

      <div className="grid gap-2 print:hidden">
        <Button variant="ghost" onClick={() => window.print()}>
          Wydrukuj lub zapisz jako PDF
        </Button>
        <BuildButton weekStart={weekStart} label="Przebuduj z jadłospisu" ghost />
        <Button variant="ghost" onClick={() => shoppingRepo.clearChecks(list.id)}>
          Odznacz wszystko
        </Button>
      </div>
    </>
  )
}

function ItemRow({ listId, item }: { listId: string; item: ShoppingItem }) {
  // Suma z całego tygodnia, w jednostce z przepisu. Pozycje bez gramatury
  // (koper, sok z cytryny) pokazują „do smaku" zamiast wymyślonej liczby;
  // chleb dodatkowo w kromkach, bo tak się go odmierza.
  return (
    <div className="border-b border-[var(--color-border)] py-0.5 last:border-b-0">
      <Checkbox
        checked={item.checked}
        onChange={(checked) => shoppingRepo.toggleItem(listId, item, checked)}
        label={
          <span className="flex items-baseline justify-between gap-3">
            <span>{item.name}</span>
            <span className="shrink-0 text-sm text-[var(--color-text-dim)]">
              {formatShoppingAmount(item)}
            </span>
          </span>
        }
      />
      <ItemSources item={item} />
    </div>
  )
}

/**
 * Skąd na liście wzięła się ta pozycja.
 *
 * Lista zakupów podaje sumę tygodnia i nic więcej — a przy zakupach ciągle
 * pada pytanie „po co mi 240 g chleba?" i „czego nie ugotuję, jak tego nie
 * kupię?". Pozycje bez zapisanego pochodzenia (listy zbudowane przed tą
 * zmianą) nie pokazują nic; wystarczy je przebudować.
 *
 * Grupujemy po przepisie, nie po dniu: ten sam obiad wchodzi dwa dni z rzędu
 * przy gotowaniu na zapas, a to jedno gotowanie i jeden przepis do przeczytania.
 */
function ItemSources({ item }: { item: ShoppingItem }) {
  const [open, setOpen] = useState(false)
  const [openRecipeId, setOpenRecipeId] = useState<string | null>(null)

  const grouped = new Map<string, { amount: number | null; dates: string[] }>()
  for (const source of item.sources ?? []) {
    const key = source.recipeId ?? ''
    const entry = grouped.get(key)
    if (!entry) {
      grouped.set(key, { amount: source.amount, dates: [source.date] })
      continue
    }
    entry.dates.push(source.date)
    if (source.amount !== null) entry.amount = (entry.amount ?? 0) + source.amount
  }

  const recipes = [...grouped.entries()]
    .map(([recipeId, entry]) => ({ recipe: RECIPES_BY_ID.get(recipeId), ...entry }))
    .filter((entry) => entry.recipe !== undefined)
    .sort((a, b) => (a.dates[0] ?? '').localeCompare(b.dates[0] ?? ''))

  if (recipes.length === 0) return null

  return (
    <div className="pb-1 pl-8 text-sm print:hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="min-h-9 text-[var(--color-text-dim)] underline decoration-dotted"
      >
        {open ? 'Ukryj przepisy' : `Z czego to jest (${recipes.length})`}
      </button>

      {open && (
        <ul className="grid gap-1 pb-1">
          {recipes.map(({ recipe, amount, dates }) => (
            <li key={recipe!.id}>
              <button
                type="button"
                onClick={() => setOpenRecipeId((id) => (id === recipe!.id ? null : recipe!.id))}
                className="w-full text-left"
              >
                <span className="text-[var(--color-accent)]">{recipe!.name}</span>
                <span className="text-[var(--color-text-dim)]">
                  {' · '}
                  {/* „razem" przy kilku dniach, bo bez tego 20 g przy czterech
                      datach czyta się jak porcja na dzień, a to suma. */}
                  {dates.length > 1 ? 'razem ' : ''}
                  {formatIngredientAmount({ amount, unit: item.unit })}
                  {' · '}
                  {dates.map((date) => formatWeekday(date)).join(', ')}
                </span>
              </button>

              {openRecipeId === recipe!.id && <RecipeDetails recipe={recipe!} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Pełny przepis z katalogu: gramatury bazowe, przyprawy i wykonanie. */
function RecipeDetails({ recipe }: { recipe: Recipe }) {
  return (
    <div className="mt-1 mb-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3">
      <p className="text-[var(--color-text-dim)]">
        {MEAL_SLOT_LABELS[recipe.slot]} · {recipe.macros.kcal} kcal · ~{recipe.prepMinutes} min
      </p>

      <ul className="mt-2 grid gap-0.5">
        {recipe.ingredients.map((ingredient) => (
          <li key={ingredient.name} className="flex justify-between gap-3">
            <span>{ingredient.name}</span>
            <span className="shrink-0 text-[var(--color-text-dim)]">
              {formatIngredientAmount(ingredient)}
            </span>
          </li>
        ))}
      </ul>

      {recipe.spices.length > 0 && (
        <p className="mt-2">
          <span className="text-[var(--color-text-dim)]">Przyprawy: </span>
          {recipe.spices.join(', ')}
        </p>
      )}

      <ol className="mt-2 grid list-decimal gap-1 pl-4">
        {recipe.steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>

      {/* Gramatury są BAZOWE, z arkusza. W jadłospisie porcja bywa
          przeskalowana (±20%), a listę sumujemy z porcji przeskalowanych —
          dlatego ilość przy nazwie przepisu wyżej może się różnić od tej tutaj. */}
      <p className="mt-2 text-xs text-[var(--color-text-dim)]">
        Gramatury jak w przepisie źródłowym; w jadłospisie porcja bywa przeskalowana.
      </p>
    </div>
  )
}

function ListProgress({ items }: { items: readonly ShoppingItem[] }) {
  const done = items.filter((i) => i.checked).length
  return (
    <div className="flex items-center justify-between">
      <p className="text-sm text-[var(--color-text-dim)]">
        {done} z {items.length} pozycji
      </p>
      {done === items.length && items.length > 0 && <Badge tone="ok">wszystko kupione</Badge>}
    </div>
  )
}

function BuildButton({
  weekStart,
  label,
  ghost = false,
}: {
  weekStart: string
  label: string
  ghost?: boolean
}) {
  const [busy, setBusy] = useState(false)
  // Nieudane budowanie listy było wcześniej niewidoczne: przycisk wracał do
  // napisu i nic się nie pojawiało. Przy pustym ekranie wyglądało to jak brak
  // jadłospisu, a nie jak błąd zapisu.
  const [error, setError] = useState<string | null>(null)

  return (
    <div className="grid gap-2">
      <Button
        variant={ghost ? 'ghost' : 'primary'}
        className="w-full"
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          setError(null)
          try {
            await shoppingRepo.build(weekStart)
          } catch (cause) {
            setError(
              cause instanceof Error
                ? `Nie udało się zbudować listy: ${cause.message}`
                : 'Nie udało się zbudować listy.',
            )
          } finally {
            setBusy(false)
          }
        }}
      >
        {busy ? 'Budowanie…' : label}
      </Button>
      {error && <Callout tone="warn">{error}</Callout>}
    </div>
  )
}
