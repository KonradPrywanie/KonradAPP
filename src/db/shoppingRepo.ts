import type { IsoDate, ShoppingItem, ShoppingList, Unit, Uuid } from '@/domain/types'
import {
  buildShoppingList,
  type DaySource,
  type IngredientSource,
} from '@/domain/shopping/aggregate'
import { startOfWeek } from '@/domain/dates'
import { alive, db, newId, stamp } from './db'
import { dietRepo } from './dietRepo'

/**
 * Repozytorium listy zakupów.
 *
 * Lista jest materializowana, nie liczona na żądanie: użytkownik odhacza
 * pozycje w sklepie, a te odhaczenia muszą przeżyć zamknięcie aplikacji.
 * Przebudowa listy zachowuje stan odhaczeń dla produktów, które w niej zostały.
 */
/** Tyle wystarczy, żeby wskazać pozycję listy. */
export interface ShoppingItemRef {
  name: string
  unit: Unit
}

/**
 * Tożsamość pozycji listy zakupów: nazwa I jednostka.
 *
 * Tak samo, jak grupuje agregacja (`buildShoppingList`) — dwa różne klucze
 * w dwóch miejscach oznaczałyby, że odhaczenia trafiają w inne wiersze niż
 * te, które widać.
 */
export function shoppingItemKey(item: ShoppingItemRef): string {
  return `${item.name}|${item.unit}`
}

export const shoppingRepo = {
  async forWeek(weekStart: IsoDate): Promise<ShoppingList | undefined> {
    const start = startOfWeek(weekStart)
    return alive(await db.shoppingLists.where('weekStart').equals(start).toArray())[0]
  },

  async build(weekStart: IsoDate): Promise<ShoppingList> {
    const start = startOfWeek(weekStart)
    const meals = await dietRepo.mealsForWeek(start)

    /**
     * Przypraw z przepisów TU NIE MA i to jest celowe.
     *
     * Lista zakupów bierze wyłącznie składniki z gramaturami (plus te, których
     * przepis nie zważył). Kolumna „Pasujące przyprawy i zioła" żyje w karcie
     * posiłku, obok instrukcji — tam jest potrzebna. Na liście tygodniowej
     * dawała dwadzieścia parę pozycji „do smaku" między kilogramami mięsa.
     */
    const byDate = new Map<IsoDate, IngredientSource[]>()
    for (const meal of meals) {
      // `recipeId` jedzie razem ze składnikami, żeby lista mogła pokazać,
      // z których przepisów pozycja się zsumowała.
      const source: IngredientSource = { ingredients: meal.ingredients, recipeId: meal.recipeId }
      const existing = byDate.get(meal.date)
      if (existing) existing.push(source)
      else byDate.set(meal.date, [source])
    }

    const days: DaySource[] = [...byDate.entries()]
      .map(([date, mealSources]) => ({ date, meals: mealSources }))
      .sort((a, b) => a.date.localeCompare(b.date))

    const draft = buildShoppingList({ weekStart: start, days })

    const previous = await shoppingRepo.forWeek(start)
    const checkedBefore = new Set(
      (previous?.items ?? []).filter((item) => item.checked).map(shoppingItemKey),
    )
    const restoreChecked = <T extends ShoppingItem>(item: T): T => ({
      ...item,
      checked: checkedBefore.has(shoppingItemKey(item)),
    })

    const now = stamp()
    const list: ShoppingList = {
      id: previous?.id ?? newId(),
      weekStart: start,
      items: draft.items.map(restoreChecked),
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      deletedAt: null,
    }

    await db.shoppingLists.put(list)
    return list
  },

  /**
   * Przebudowuje listę, ale TYLKO gdy już istnieje.
   *
   * Tym idą zmiany jadłospisu: usunięcie posiłku, podmiana na zamiennik,
   * wstawienie posiłku w pusty slot. Lista zakupów ma odpowiadać jadłospisowi
   * bez proszenia o to osobno — inaczej człowiek idzie do sklepu z listą, która
   * zawiera składniki dania skasowanego trzy dni wcześniej.
   *
   * „Tylko gdy istnieje" jest istotne: budowanie listy przy okazji edycji dnia
   * tworzyłoby ją komuś, kto jeszcze nigdy jej nie zbudował, i to bez pytania.
   */
  async rebuildIfExists(weekStart: IsoDate): Promise<ShoppingList | undefined> {
    const existing = await shoppingRepo.forWeek(weekStart)
    if (!existing) return undefined
    return shoppingRepo.build(weekStart)
  },

  /** Buduje listę tylko wtedy, gdy jeszcze jej nie ma. */
  async ensure(weekStart: IsoDate): Promise<ShoppingList | undefined> {
    const existing = await shoppingRepo.forWeek(weekStart)
    if (existing) return existing
    if (!(await dietRepo.hasWeek(weekStart))) return undefined
    return shoppingRepo.build(weekStart)
  },

  /**
   * Odhaczenie pozycji. Identyfikuje ją NAZWA I JEDNOSTKA, nie sama nazwa.
   *
   * Ten sam składnik potrafi stać na liście dwa razy w różnych jednostkach —
   * arkusz podaje czosnek i „do smaku", i w ząbkach, a agregacja trzyma je
   * osobno (200 g pomidorów to nie 200 ml passaty). Przy kluczu z samej nazwy
   * odhaczenie jednej pozycji odhaczało obie, a lista miała dwa wiersze
   * o tym samym `key` w Reakcie — z czego brał się duch pozycji, która została
   * na ekranie po przebudowie listy.
   */
  async toggleItem(listId: Uuid, item: ShoppingItemRef, checked: boolean): Promise<void> {
    const list = await db.shoppingLists.get(listId)
    if (!list || list.deletedAt) return

    const target = shoppingItemKey(item)
    const update = <T extends ShoppingItemRef & { checked: boolean }>(row: T): T =>
      shoppingItemKey(row) === target ? { ...row, checked } : row

    await db.shoppingLists.put({
      ...list,
      items: list.items.map(update),
      updatedAt: stamp(),
    })
  },

  async clearChecks(listId: Uuid): Promise<void> {
    const list = await db.shoppingLists.get(listId)
    if (!list || list.deletedAt) return
    const uncheck = <T extends { checked: boolean }>(item: T): T => ({ ...item, checked: false })
    await db.shoppingLists.put({
      ...list,
      items: list.items.map(uncheck),
      updatedAt: stamp(),
    })
  },
}
