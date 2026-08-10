import type { IsoDate, MealIngredient, ShoppingItem, ShoppingItemSource } from '../types'
import { normalize } from '../text'
import { aisleFor, aisleRank } from './aisles'
import { canonicalIngredientName, dropFromShoppingList } from './canonical'

/**
 * Minimalny kształt wejścia — sama lista składników.
 *
 * Celowo NIE przyjmujemy `DietDay`: agregacja nie potrzebuje wiedzieć nic
 * o makro, przepisach ani odchyleniach. Dzięki temu ta sama funkcja obsługuje
 * i świeżo wygenerowany tydzień, i posiłki odczytane z bazy (`PlannedMeal`),
 * bez podrabiania struktur.
 */
export interface IngredientSource {
  ingredients: readonly MealIngredient[]
  /**
   * Przepis, z którego pochodzą składniki — do pokazania „skąd to jest"
   * przy pozycji listy. Opcjonalny, bo agregacja działa też bez niego.
   */
  recipeId?: string
}

export interface DaySource {
  date: IsoDate
  meals: readonly IngredientSource[]
}

export interface ShoppingListDraft {
  weekStart: IsoDate
  /** Wszystko do kupienia, pogrupowane po działach sklepu. */
  items: ShoppingItem[]
}

/** Adapter: wynik `solveWeek()` → wejście agregacji. */
export function dietWeekToDays(
  week: readonly { date: IsoDate; day: { meals: readonly IngredientSource[] } | null }[],
): (DaySource | null)[] {
  return week.map(({ date, day }) => (day ? { date, meals: day.meals } : null))
}

export interface BuildShoppingListInput {
  weekStart: IsoDate
  days: readonly (DaySource | null | undefined)[]
}

interface Bucket {
  name: string
  unit: ShoppingItem['unit']
  amount: number | null
  sources: ShoppingItemSource[]
}

/**
 * PRZYPRAWY NIE WCHODZĄ NA LISTĘ ZAKUPÓW.
 *
 * Decyzja użytkownika i widać, skąd się wzięła: kolumna „Pasujące przyprawy
 * i zioła" z arkusza dawała ponad dwadzieścia pozycji w stylu „sól", „pieprz",
 * „oregano", „bazylia świeża" — rzeczy, które albo są w domu, albo kupuje się
 * raz na kwartał. Na liście tygodniowej były wyłącznie szumem między
 * kilogramami mięsa i warzyw.
 *
 * Przyprawy nie znikają z aplikacji: zostają w karcie posiłku obok instrukcji,
 * czyli tam, gdzie są potrzebne — przy garnku, nie w sklepie.
 *
 * WYJĄTEK: czosnek. Jest w przepisach składnikiem, nie doprawieniem, kupuje się
 * go świeżego co tydzień i trafia do warzyw (`aisleFor` odsyła go do „Owoce
 * i warzywa"). Dlatego lista terminów zawiera „czosnek granulowany", ale nie
 * sam „czosnek".
 */
/**
 * Dopasowanie po CAŁYM SŁOWIE, nie po fragmencie.
 *
 * Wyszło z podglądu listy zakupów: fragment „bazyli" wyrzucał „Pesto zielone
 * bazyliowe" — słoik pesto, który trzeba kupić. Przy dopasowaniu po słowie
 * „bazylia" zostaje przyprawą, a „bazyliowe" przymiotnikiem w nazwie produktu.
 */
const SEASONING_WORDS: readonly string[] = [
  'sol',
  'soli',
  'pieprz',
  'pieprzu',
  'oregano',
  'bazylia',
  'bazylii',
  'majeranek',
  'majeranku',
  'tymianek',
  'tymianku',
  'rozmaryn',
  'rozmarynu',
  'kminek',
  'kminku',
  'kmin',
  'kolendra',
  'kolendry',
  'kurkuma',
  'kurkumy',
  'cynamon',
  'cynamonu',
  'wanilia',
  'wanilii',
  'chili',
  'curry',
  'papryczka',
  'goździki',
  'gozdziki',
  'estragon',
  'lubczyk',
  'szafran',
]

/** Zwroty wielowyrazowe — tu fragment jest w porządku, bo jest długi i konkretny. */
const SEASONING_PHRASES: readonly string[] = [
  'ziele angielskie',
  'lisc laurowy',
  'liscie laurowe',
  'ziola prowansalskie',
  'ziola wloskie',
  'zioła',
  'przyprawa',
  'przyprawy',
  'papryka slodka',
  'papryka wedzona',
  'papryka ostra',
  'papryka w proszku',
  'galka muszkatolowa',
  'czosnek granulowany',
  'czosnek w proszku',
  'cebula granulowana',
  'slodzik',
  'ksylitol',
  'ekstrakt',
  'sol morska',
  'sol himalajska',
  'sol czosnkowa',
]

/**
 * Czy nazwa to przyprawa, której nie kupujemy tygodniowo.
 *
 * Czosnek jest wyjątkiem, o który poprosił użytkownik: w przepisach jest
 * składnikiem, kupuje się go świeżego i trafia do warzyw. Granulowany
 * i w proszku to już doprawienie — te wypadają.
 */
export function isSeasoning(name: string): boolean {
  const text = normalize(name)
  if (SEASONING_PHRASES.some((phrase) => text.includes(phrase))) return true
  const words = text.split(/[\s,()/]+/).filter(Boolean)
  return words.some((word) => SEASONING_WORDS.includes(word))
}

/**
 * Buduje listę zakupów z tygodnia jadłospisu.
 *
 * Sumujemy po nazwie KANONICZNEJ i jednostce (`canonicalIngredientName`).
 * Wcześniej kluczem była sama nazwa znormalizowana, więc „Oliwa" i „Oliwa
 * z oliwek", „Ziemniak" i „Ziemniaki", „Jajko" i „Jajko ugotowane" stawały na
 * liście jako osobne pozycje, każda z częścią tygodniowej ilości. Które nazwy
 * znaczą to samo, a które tylko podobnie, rozstrzyga tabela w `canonical.ts` —
 * z wypisanymi wyjątkami (ryż suchy a ugotowany, łosoś świeży a wędzony).
 * Jednostka zostaje w kluczu, bo 200 g pomidorów i 200 ml passaty to nie ta
 * sama pozycja.
 *
 * Składniki bez podanej ilości (sok z cytryny, koper, erytrytol) ZOSTAJĄ
 * na liście — to nadal rzeczy do kupienia, tylko bez gramatury. Pokazujemy je
 * w swoim dziale z adnotacją „do smaku", zamiast odsyłać do osobnej sekcji
 * „zapas": przy zakupach liczy się półka w sklepie, nie to, czy przepis podał
 * gramaturę. Wyjątkiem jest czosnek — patrz `dropFromShoppingList`.
 */
export function buildShoppingList(input: BuildShoppingListInput): ShoppingListDraft {
  const buckets = new Map<string, Bucket>()

  for (const day of input.days) {
    if (!day) continue
    for (const meal of day.meals) {
      for (const ingredient of meal.ingredients) {
        if (isSeasoning(ingredient.name)) continue
        if (dropFromShoppingList(ingredient)) continue

        const name = canonicalIngredientName(ingredient.name)
        const key = `${normalize(name)}|${ingredient.unit}`
        const source: ShoppingItemSource = {
          date: day.date,
          amount: ingredient.amount,
          ...(meal.recipeId ? { recipeId: meal.recipeId } : {}),
        }
        const bucket = buckets.get(key)

        if (!bucket) {
          buckets.set(key, {
            name,
            unit: ingredient.unit,
            amount: ingredient.amount,
            sources: [source],
          })
          continue
        }

        bucket.sources.push(source)
        /**
         * Sumujemy ilości ZNANE, a pozycje „do smaku" po prostu pomijamy
         * w sumie.
         *
         * Poprzednia reguła zerowała całą pozycję: jeden przepis bez gramatury
         * kasował gramaturę pozostałych. Po scaleniu nazw robiło to szkodę —
         * „Ogórek świeży 180 g" plus „Ogórek do smaku" pokazywało „do smaku",
         * czyli mniej, niż wiemy. 180 g jest dolną granicą i to jest
         * użyteczniejsze niż brak liczby; z których przepisów pochodzi, widać
         * w `sources`.
         */
        if (ingredient.amount !== null) {
          bucket.amount = (bucket.amount ?? 0) + ingredient.amount
        }
      }
    }
  }

  const items: ShoppingItem[] = [...buckets.values()].map((bucket) => ({
    name: bucket.name,
    amount: bucket.amount === null ? null : round1(bucket.amount),
    unit: bucket.unit,
    category: aisleFor(bucket.name),
    checked: false,
    sources: bucket.sources,
  }))

  items.sort(byNameInAisle)
  return { weekStart: input.weekStart, items }
}

/**
 * Tożsamość posiłku w pochodzeniu pozycji: DATA i PRZEPIS.
 *
 * Tyle wystarczy, bo przepis należy do jednego slotu (`Recipe.slot`), a slot
 * w dniu jest zajęty najwyżej raz (`dietRepo.addMeal` odmawia drugiego) —
 * więc para „data + przepis" wskazuje dokładnie jeden zaplanowany posiłek.
 * Identyfikatora posiłku w źródłach nie ma i celowo nie dokładamy go teraz:
 * listy zbudowane wcześniej i tak by go nie miały, więc droga po dacie
 * i przepisie musiałaby istnieć obok niego.
 */
export function sourceMealKey(source: { date: IsoDate; recipeId?: string }): string {
  return `${source.date}|${source.recipeId ?? ''}`
}

/**
 * Lista bez tego, co już zjedzone.
 *
 * Lista zakupów odpowiada na pytanie „co jeszcze muszę kupić", a składniki
 * obiadu zjedzonego w poniedziałek nie są już odpowiedzią — leżą w lodówce
 * albo na talerzu. Odejmujemy je z pozycji, a pozycję, z której nie zostało
 * nic, zdejmujemy w całości.
 *
 * Ilość liczy się tą samą regułą, co przy budowaniu listy: suma ilości ZNANYCH,
 * a `null` („do smaku") dopiero wtedy, gdy żadne z pozostałych wystąpień
 * gramatury nie podaje. Inaczej zjedzenie jednego z dwóch dań zamieniałoby
 * „400 g ryżu" w „do smaku", czyli w mniej, niż wiemy.
 *
 * Filtrowanie jest ODWRACALNE i dlatego dzieje się przy wyświetlaniu, a nie
 * przez przebudowę zapisanej listy: „Cofnij" przy posiłku ma przywrócić
 * składniki na listę, a przebudowa gubiłaby przy okazji odhaczenia pozycji,
 * które w tym tygodniu już zniknęły.
 *
 * Pozycje BEZ pochodzenia (listy zbudowane przed dopisaniem `sources`)
 * przechodzą nietknięte — nie wiadomo, z czego się wzięły, więc ukrycie ich
 * byłoby zgadywaniem. Wystarczy przebudować listę.
 */
export function withoutEatenMeals(
  items: readonly ShoppingItem[],
  eatenMeals: ReadonlySet<string>,
): ShoppingItem[] {
  if (eatenMeals.size === 0) return [...items]

  const remaining: ShoppingItem[] = []
  for (const item of items) {
    const sources = item.sources ?? []
    if (sources.length === 0) {
      remaining.push(item)
      continue
    }

    const left = sources.filter((source) => !eatenMeals.has(sourceMealKey(source)))
    if (left.length === 0) continue
    if (left.length === sources.length) {
      remaining.push(item)
      continue
    }

    const known = left.filter((source) => source.amount !== null)
    remaining.push({
      ...item,
      amount:
        known.length === 0
          ? null
          : round1(known.reduce((sum, source) => sum + (source.amount as number), 0)),
      sources: left,
    })
  }
  return remaining
}

export interface ShoppingCategoryGroup {
  category: string
  items: ShoppingItem[]
}

/** Grupowanie po dziale — kolejność jak w sklepie, nie alfabetyczna. */
export function groupByCategory(items: readonly ShoppingItem[]): ShoppingCategoryGroup[] {
  const groups = new Map<string, ShoppingItem[]>()
  for (const item of items) {
    const bucket = groups.get(item.category)
    if (bucket) bucket.push(item)
    else groups.set(item.category, [item])
  }

  return [...groups.entries()]
    .map(([category, groupItems]) => ({ category, items: groupItems }))
    .sort((a, b) => aisleRank(a.category) - aisleRank(b.category))
}

function byNameInAisle(a: ShoppingItem, b: ShoppingItem): number {
  const rank = aisleRank(a.category) - aisleRank(b.category)
  return rank !== 0 ? rank : a.name.localeCompare(b.name, 'pl')
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}
