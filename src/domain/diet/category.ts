import type { Recipe } from '../types'
import { normalize } from '../text'

/**
 * Kategoria dania — po głównym źródle białka.
 *
 * Po co: lista zamienników pokazuje cały katalog dla slotu (50 pozycji), a nie
 * pierwsze pięć z rankingu. Pięćdziesiąt nazw pod rząd czyta się źle, bo
 * o wyborze decyduje najczęściej jedna rzecz: „chcę dziś rybę", „nie chcę
 * mięsa", „coś roślinnego". Kategoria stawia tę informację obok nazwy i kalorii.
 *
 * Wyliczamy ją z NAZW SKŁADNIKÓW, bo tylko one są w danych — arkusz nie ma
 * tagów. Pomyłka kosztuje tu wyłącznie miejsce na liście: to grupowanie
 * w interfejsie, nie filtr bezpieczeństwa (tym jest `eligibility`).
 */
export type DishCategory = 'fish' | 'meat' | 'eggs' | 'plant' | 'dairy' | 'grain'

export const DISH_CATEGORY_LABELS: Record<DishCategory, string> = {
  fish: 'Ryby i owoce morza',
  meat: 'Mięso i drób',
  eggs: 'Jaja',
  plant: 'Roślinne',
  dairy: 'Nabiał',
  grain: 'Zbożowe i owocowe',
}

/**
 * Kolejność ma znaczenie — pierwsze trafienie wygrywa.
 *
 * Dania mieszają źródła białka (jajecznica z serem, kurczak z jogurtem), więc
 * potrzebna jest hierarchia, a nie zbiór. Ustawiona od składnika, który
 * najbardziej określa danie w rozmowie o jedzeniu: ryba i mięso decydują
 * o charakterze posiłku, nabiał zwykle jest dodatkiem — dlatego jest ostatni
 * wśród źródeł białka.
 */
const CATEGORY_TERMS: readonly (readonly [DishCategory, readonly string[]])[] = [
  [
    'fish',
    [
      'dorsz', 'losos', 'pstrag', 'sandacz', 'makrela', 'tunczyk', 'ryba', 'krewetk',
      'surimi', 'paluszki krabowe',
    ],
  ],
  [
    'meat',
    [
      'kurczak', 'indyk', 'wolowin', 'wolowa', 'schab', 'poledwic', 'cielec', 'krolik',
      'kacz', 'szynka', 'mieso', 'kielbas',
    ],
  ],
  ['eggs', ['jajk', 'jaja', 'bialko jaja']],
  [
    'plant',
    [
      'tofu', 'soczewica', 'ciecierzyc', 'fasola', 'edamame', 'hummus', 'falafel',
      'kiełki fasoli', 'kielki fasoli',
    ],
  ],
  [
    'dairy',
    [
      'twarog', 'jogurt', 'skyr', 'serek', 'ser ', 'feta', 'mozzarella', 'parmezan',
      'mascarpone', 'mleko', 'kefir', 'maslanka', 'smietank', 'odzywka bialkowa',
    ],
  ],
]

/** Kategoria dania. `grain` to wynik domyślny: danie bez wyraźnego źródła białka. */
export function dishCategory(recipe: Recipe): DishCategory {
  const texts = recipe.ingredients.map((ing) => normalize(ing.name))

  for (const [category, terms] of CATEGORY_TERMS) {
    if (terms.some((term) => texts.some((text) => text.includes(term)))) return category
  }
  return 'grain'
}
