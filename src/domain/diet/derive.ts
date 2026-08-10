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
  'kurczak', 'kurczaka', 'indyk', 'indyka', 'wolow', 'schab', 'poledwic',
  'cielec', 'krolik', 'kacz', 'szynka', 'mieso', 'boczek', 'kielbas', 'zurawina do mies',
  /**
   * `wolow` zamiast `wolowin` i `wolowa`: w tabeli produktów stoi „Rostbef
   * wołowy", którego ŻADEN z tych dwóch nie łapał — a wynikiem było wołowe
   * danie uznawane za WEGAŃSKIE. Wieprzowina doszła z bazą azjatycką („Chude
   * mielone wieprzowe") i miała ten sam skutek.
   *
   * Świadomie NIE dopisujemy `mielone`: „Siemię lniane mielone" jest mielone
   * i roślinne. Rozstrzyga zwierzę w nazwie, nie postać, w jakiej je zmielono.
   */
  'wieprz', 'rostbef',
]
const FISH_TERMS = ALLERGEN_RULES.fish.terms
const SHELLFISH_TERMS = ALLERGEN_RULES.shellfish.terms
const DAIRY_EGG_TERMS: readonly string[] = [
  ...ALLERGEN_RULES.lactose.terms,
  ...ALLERGEN_RULES.eggs.terms,
  'miod',
]

/**
 * Napoje roślinne — mają „mleko" albo „mleczko" w nazwie i zero laktozy.
 *
 * Bez tej listy „Mleko migdałowe bez cukru" i „Mleczko kokosowe lekkie"
 * dostawały alergen `lactose`, bo `mleko` i `mleczko` są wśród jego terminów.
 * Skutek był odwrotny do zamierzonego: napoje roślinne stoją w bazie właśnie
 * po to, żeby ścieżka bez laktozy miała z czego wybierać, a zamiast tego same
 * z niej wypadały. Migdałowe leżało tu od początku, kokosowe doszło z bazą
 * obiadów azjatyckich (4 przepisy).
 *
 * `hits` nie rozstrzyga po najdłuższym trafieniu — jak `aisleFor` — więc
 * dłuższy termin niczego by nie naprawił. Trzeba wykluczyć wprost.
 *
 * Wykluczamy TYLKO ten jeden napis, nie cały przepis: owsianka na mleku
 * migdałowym Z JOGURTEM nadal ma laktozę, bo jogurt jest osobnym składnikiem
 * i osobnym napisem w `haystack`.
 */
const PLANT_MILK_TERMS: readonly string[] = [
  'mleczko kokosowe', 'mleko kokosowe', 'mleko migdalowe', 'mleko sojowe',
  'mleko owsiane', 'mleko ryzowe', 'mleko orzechowe',
]

function isPlantMilk(text: string): boolean {
  return PLANT_MILK_TERMS.some((term) => text.includes(term))
}

/** Napisy, na których wolno szukać nabiału — bez napojów roślinnych. */
function withoutPlantMilk(texts: readonly string[]): string[] {
  return texts.filter((text) => !isPlantMilk(text))
}

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
    // Laktoza to jedyny alergen, którego terminy łapią też napoje roślinne.
    const searched = allergen === 'lactose' ? withoutPlantMilk(texts) : texts
    if (hits(searched, rule.terms)) out.push(allergen)
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
  // Ta sama poprawka co w alergenach: mleczko kokosowe nie jest nabiałem,
  // więc danie na nim może być wegańskie, jeśli nic innego mu nie przeczy.
  const dairyOrEggs = hits(withoutPlantMilk(texts), DAIRY_EGG_TERMS)

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
