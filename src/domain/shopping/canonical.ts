import { normalize } from '../text'

/**
 * Ujednolicanie nazw składników na liście zakupów.
 *
 * **Tabela jest PUSTA i to jest wynik lepszego modelu danych, nie brak pracy.**
 *
 * FitPlanner, z którego ta aplikacja wyrosła, dostawał przepisy z arkusza
 * pisanego przez ludzi, więc ta sama rzecz nazywała się tam różnie: „Oliwa"
 * i „Oliwa z oliwek", „Ziemniak" i „Ziemniaki", „Jajko" i „Jajko ugotowane".
 * Lista zakupów robiła z tego dwie pozycje, każdą z połową tygodniowej ilości —
 * czyli dokładnie to, czego lista zakupów ma nie robić. Ratunkiem była tabela
 * ponad stu wariantów.
 *
 * FITKonrad nie ma tego problemu U ŹRÓDŁA: składnik przepisu musi być pozycją
 * z `data-source/produkty.json`, a importer przerywa pracę na nazwie spoza tej
 * listy. Nazwy są więc jednolite z konstrukcji i nie ma czego scalać —
 * pilnuje tego test „nazwy składników pochodzą z zamkniętej listy produktów".
 *
 * DLACZEGO MECHANIZM ZOSTAJE
 *
 * Bo dzień, w którym w tabeli produktów staną obok siebie „Ryż basmati"
 * i „Ryż ugotowany", jest realny — i wtedy trzeba będzie umieć powiedzieć,
 * że to NIE jest to samo. Kuszące jest wtedy obcięcie końcówek („ugotowany",
 * „pieczony", „mrożony"). Tylko że część takich określeń zmienia PRODUKT,
 * nie stan: ryż ugotowany waży prawie trzy razy tyle co suchy, łosoś wędzony
 * to inna półka niż świeży, a „Pomidory suszone" to nie „Pomidor". Dlatego
 * gdy grupy tu wrócą, mają być WYPISANE, nie wyliczone z morfologii.
 */

interface CanonicalGroup {
  /** Nazwa pokazywana na liście — jedna z wariantów, ta najbardziej konkretna. */
  canonical: string
  /** Warianty scalane do niej. Kanoniczną też można tu wpisać, nie zaszkodzi. */
  variants: readonly string[]
}

const GROUPS: readonly CanonicalGroup[] = []

/**
 * Wszystkie nazwy wymienione w tabeli — kanoniczne i warianty.
 *
 * Eksportowane dla testu, który sprawdza je o arkusz: wariant z literówką nie
 * rzuca wyjątku, tylko po cichu nic nie scala, więc jedyną obroną jest
 * porównanie z danymi.
 */
export const CANONICAL_NAMES: readonly string[] = GROUPS.flatMap((group) => [
  group.canonical,
  ...group.variants,
])

/** Wariant (znormalizowany) → nazwa kanoniczna. */
const CANONICAL_BY_VARIANT: ReadonlyMap<string, string> = new Map(
  GROUPS.flatMap((group) =>
    [group.canonical, ...group.variants].map(
      (variant) => [normalize(variant), group.canonical] as const,
    ),
  ),
)

/**
 * Nazwa pod jaką składnik trafia na listę zakupów.
 *
 * Nazwy spoza tabeli wracają bez zmian — łączenie „po podobieństwie" sumowałoby
 * rzeczy, których nikt nie kazał łączyć.
 */
export function canonicalIngredientName(name: string): string {
  return CANONICAL_BY_VARIANT.get(normalize(name)) ?? name
}

/**
 * Czy składnik ma wypaść z listy zakupów.
 *
 * Czosnek bez gramatury („do smaku", w czternastu przepisach) — prośba
 * użytkownika i widać, skąd się wzięła: pozycja „Czosnek — do smaku" nie mówi
 * nic, czego kupujący nie wie. Czosnek ZWAŻONY (arkusz podaje też „2 ząbki")
 * zostaje, bo to konkretna sztuka do kupienia.
 *
 * Reguła jest wąska świadomie: dotyczy czosnku, nie wszystkich pozycji bez
 * gramatury. Koper, szczypiorek, natka czy sałata „do smaku" to nadal pęczek,
 * którego może w domu nie być.
 */
export function dropFromShoppingList(ingredient: { name: string; amount: number | null }): boolean {
  if (ingredient.amount !== null) return false
  const text = normalize(ingredient.name)
  return text === 'czosnek' || text.startsWith('czosnek ')
}

/**
 * Średnia waga kromki chleba.
 *
 * Arkusz podaje chleb w gramach (30–80 g na porcję), a w sklepie i na desce
 * liczy się kromkami. 35 g to kromka chleba żytniego/razowego z krojonego
 * bochenka — arkuszowe porcje 30, 40 i 70 g wychodzą wtedy na jedną, jedną
 * i dwie kromki, czyli tak, jak te przepisy są napisane.
 */
export const BREAD_SLICE_G = 35

/**
 * Ile kromek to podana ilość chleba — albo `null`, gdy przeliczenie nie ma sensu.
 *
 * Pieczywo chrupkie jest wyłączone: jego „kromka" waży około dziesięciu gramów,
 * więc ta sama liczba wprowadzałaby w błąd. Bułki i tortille też nie są krojone
 * na kromki. Zaokrąglamy do połówek, bo pół kromki to realna porcja, a 1,7
 * kromki nie jest.
 */
export function breadSlices(item: { name: string; amount: number | null; unit: string }): number | null {
  if (item.amount === null || item.unit !== 'g') return null

  const words = normalize(item.name).split(/[\s,()/]+/).filter(Boolean)
  if (!words.includes('chleb')) return null
  if (words.includes('chrupki') || words.includes('chrupkie')) return null

  const slices = Math.round((item.amount / BREAD_SLICE_G) * 2) / 2
  return slices > 0 ? slices : null
}
