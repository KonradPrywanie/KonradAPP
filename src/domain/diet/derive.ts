import type { Allergen, DietStyle, Recipe } from '../types'
import { normalize } from '../text'

/**
 * Alergeny i styl diety WYLICZANE z nazw składników.
 *
 * Arkusz przepisów tego nie podaje — ma nazwy, gramatury i makro. Wcześniej te
 * informacje brały się z ręcznie kuratorowanej bazy produktów, której już nie
 * ma (patrz `RecipeIngredient`). Zostaje wyliczanie ze słów kluczowych i trzeba
 * o nim wiedzieć dwie rzeczy:
 *
 *  1. **To filtr wygody, nie gwarancja medyczna.** Lista słów nigdy nie będzie
 *     pełna, a przepis może zawierać alergen w składniku, którego nazwa go nie
 *     ujawnia („pesto" zawiera nabiał i orzechy). Interfejs mówi to wprost przy
 *     polu alergenów, żeby nikt nie oparł na tym decyzji zdrowotnej.
 *  2. **Kierunek błędu jest wybrany świadomie.** Przy stylu diety wymagamy
 *     dowodu roślinności: przepis jest wegański tylko wtedy, gdy ŻADEN składnik
 *     nie wygląda na zwierzęcy. Wątpliwy przepis zostaje więc „wszystkożerny" —
 *     wegetarianka zobaczy mniej opcji, ale nie zobaczy szynki w sałatce.
 */

interface Rule {
  /** Fragmenty nazw składników — już znormalizowane (bez polskich znaków). */
  terms: readonly string[]
}

const ALLERGEN_RULES: Record<Allergen, Rule> = {
  gluten: {
    terms: [
      'chleb', 'bulka', 'bulki', 'grahamka', 'tortilla', 'makaron', 'penne', 'spaghetti',
      'tagliatelle', 'swiderki', 'udon', 'kasza peczak', 'maka orkiszowa', 'maka owsiana',
      'maka', 'platki owsiane', 'bulka tarta', 'biszkopty', 'pieczywo', 'chrupki',
      'platki kukurydziane', 'seitan', 'kuskus',
    ],
  },
  lactose: {
    terms: [
      'mleko', 'mleczko', 'jogurt', 'kefir', 'maslanka', 'twarog', 'serek', 'ser ', 'sera',
      'ser zolty', 'feta', 'mozzarella', 'parmezan', 'mascarpone', 'skyr', 'smietanka',
      'smietana', 'maslo', 'pesto', 'sos czosnkowy', 'majonez',
    ],
  },
  nuts: { terms: ['orzech', 'orzeszki', 'migdal', 'nerkowc', 'pistacj'] },
  peanuts: { terms: ['maslo orzechowe', 'orzeszki ziemne', 'fistaszk'] },
  eggs: { terms: ['jajk', 'jaja', 'jajo', 'bialko jaja', 'majonez'] },
  fish: {
    terms: [
      'dorsz', 'losos', 'pstrag', 'sandacz', 'makrela', 'tunczyk', 'ryba', 'filet z ryby',
      'sardynk', 'surimi', 'paluszki krabowe', 'sos rybny',
    ],
  },
  shellfish: { terms: ['krewetk', 'malze', 'kalmar', 'krab'] },
  soy: { terms: ['tofu', 'soja', 'sos sojowy', 'edamame', 'teriyaki', 'mleko sojowe'] },
  sesame: { terms: ['sezam', 'tahini', 'hummus', 'olej sezamowy'] },
}

/** Składniki zwierzęce po grupach — do wyliczenia stylu diety. */
const MEAT_TERMS: readonly string[] = [
  'kurczak', 'kurczaka', 'indyk', 'indyka', 'wolowin', 'wolowa', 'schab', 'poledwic',
  'cielec', 'krolik', 'kacz', 'szynka', 'mieso', 'boczek', 'kielbas', 'zurawina do mies',
]
const FISH_TERMS = ALLERGEN_RULES.fish.terms
const SHELLFISH_TERMS = ALLERGEN_RULES.shellfish.terms
const DAIRY_EGG_TERMS: readonly string[] = [
  ...ALLERGEN_RULES.lactose.terms,
  ...ALLERGEN_RULES.eggs.terms,
  'miod',
]

function haystack(recipe: Recipe): string[] {
  return [normalize(recipe.name), ...recipe.ingredients.map((ing) => normalize(ing.name))]
}

function hits(texts: readonly string[], terms: readonly string[]): boolean {
  return terms.some((term) => texts.some((text) => text.includes(term)))
}

/** Alergeny wyliczone z nazw składników. Patrz zastrzeżenia w opisie modułu. */
export function recipeAllergens(recipe: Recipe): Allergen[] {
  const texts = haystack(recipe)
  const out: Allergen[] = []
  for (const [allergen, rule] of Object.entries(ALLERGEN_RULES) as [Allergen, Rule][]) {
    if (hits(texts, rule.terms)) out.push(allergen)
  }
  return out
}

/**
 * Style diety, w których przepis jest dopuszczalny.
 *
 * Zawsze zawiera `omnivore` — wszystkożerca je wszystko. Pozostałe dokładamy
 * tylko wtedy, gdy nic w składnikach im nie przeczy.
 */
export function recipeDietStyles(recipe: Recipe): DietStyle[] {
  const texts = haystack(recipe)
  const meat = hits(texts, MEAT_TERMS)
  const fish = hits(texts, FISH_TERMS) || hits(texts, SHELLFISH_TERMS)
  const dairyOrEggs = hits(texts, DAIRY_EGG_TERMS)

  const styles: DietStyle[] = ['omnivore']
  if (!meat) {
    // Pescatarianizm dopuszcza ryby, ale nie mięso.
    styles.push('pescatarian')
    if (!fish) {
      styles.push('vegetarian')
      if (!dairyOrEggs) styles.push('vegan')
    }
  }
  return styles
}
