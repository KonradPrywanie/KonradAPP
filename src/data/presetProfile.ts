import type { MealSplit, Profile } from '@/domain/types'

/**
 * Gotowy profil dla tej wersji aplikacji.
 *
 * Kreator pyta o siedem ekranów danych, które w tej wersji są znane z góry.
 * Zamiast przechodzić go za każdym razem, startujemy z presetu i pytamy tylko
 * o to, czego nie da się ustalić bez człowieka.
 *
 * Poza presetem są ŚWIADOMIE: waga, wzrost, rocznik oraz punkt wyjścia
 * w bieganiu i w pływaniu. Wszystkie sterują liczbami, które użytkownik ma
 * potem wykonać — waga i wzrost makrami (`referenceWeightKg` liczy się z obu),
 * tempo i dystanse treningiem. Wartość domyślna dałaby plan policzony dla
 * nieistniejącej osoby, a wygląda tak samo wiarygodnie jak prawdziwy —
 * dlatego pyta o nie ekran startowy, a plan bez nich nie powstaje
 * (patrz `missingPlanInputs`).
 *
 * Pełny kreator pozostaje dostępny — patrz link na ekranie startowym.
 */
export type PresetProfileInput = Omit<
  Profile,
  | 'id'
  | 'createdAt'
  | 'updatedAt'
  | 'deletedAt'
  | 'startWeightKg'
  | 'heightCm'
  | 'birthYear'
  | 'runBaseline'
  | 'swimBaseline'
>

/**
 * Rozkład kalorii na cztery posiłki układane przez solver.
 *
 * Udziały dotyczą celu POMNIEJSZONEGO o rezerwę na słodką przekąskę
 * (`SWEET_SNACK`), dlatego sumują się do 1,0 — przekąska jest poza tym podziałem.
 *
 * Obiad dostaje najwięcej, bo to jedyny posiłek dnia, przy którym realnie stoi
 * się przy garnkach. Śniadanie i kolacja są równe, a posiłek po pracy najlżejszy
 * — wypada między treningiem a kolacją i ma być czymś, co da się zjeść bez
 * gotowania.
 *
 * Jedno miejsce dla presetu i dla kreatora: dwie kopie tych czterech liczb
 * rozjechałyby się przy pierwszej korekcie, a rozjazd byłby niewidoczny —
 * jadłospis nadal by się generował, tylko z innym rozkładem talerza.
 */
export const DEFAULT_MEAL_SPLIT: MealSplit = {
  breakfast: 0.24,
  lunch: 0.3,
  afternoon: 0.22,
  dinner: 0.24,
}

/**
 * Kaloryczności, pod które napisana jest baza przepisów.
 *
 * Baza jest JEDNA, pisana na środek zakresu (~2750 kcal), a solver dochodzi
 * do obu celów skalowaniem porcji (`minScale`/`maxScale` = 0,75–1,25).
 * Przy 2500 kcal wychodzi mnożnik ~0,90, przy 3000 kcal ~1,10 — oba w środku
 * dozwolonego zakresu, więc żaden cel nie stoi na jego granicy, gdzie solver
 * traci swobodę i zaczyna powtarzać najcięższe dania.
 *
 * Dwie osobne bazy dałyby dokładniejsze gramatury i dwa razy więcej danych do
 * utrzymania — przy różnicy 20% między celami to nie jest wymiana, która się
 * opłaca.
 */
export const KCAL_PRESETS = [2500, 3000] as const
export type KcalPreset = (typeof KCAL_PRESETS)[number]

/** Cel startowy. Zmiana na 3000 (albo na wyliczanie automatyczne) jest w Profilu. */
export const DEFAULT_KCAL_PRESET: KcalPreset = 2500

export const PRESET_PROFILE: PresetProfileInput = {
  name: 'Konrad',
  sex: 'male',

  /**
   * Cel: masa.
   *
   * Przy 2500–3000 kcal i czterech jednostkach treningowych w tygodniu to
   * jedyny cel, który nie kłóci się z liczbami. Steruje dwiema rzeczami:
   * nadwyżką kaloryczną w automatycznym wyliczeniu i podażą białka
   * (1,8 g/kg masy odniesienia, patrz `PROTEIN_G_PER_KG`).
   *
   * Gdy cel kaloryczny jest ustawiony presetem (2500 albo 3000), pole `goal`
   * przestaje decydować o kaloriach — zostaje mu białko. To jest celowe:
   * preset istnieje po to, żeby liczba była WYBRANA, a nie wyliczona.
   */
  goal: 'bulk',

  activityLevel: 'moderate',
  experience: 'intermediate',

  equipment: ['gym', 'pool', 'running'],

  /**
   * Dni treningowe: poniedziałek, wtorek, czwartek, sobota.
   *
   * To dokładnie dni ze stałego rozkładu (`FIXED_WEEK_LAYOUT`): poniedziałek
   * bieg, wtorek i czwartek siłownia, sobota basen. Stały układ obowiązuje,
   * dopóki jego dni są wśród dostępnych.
   */
  availableDays: [1, 2, 4, 6],
  emphasis: 'balanced',
  sessionMinutes: 60,
  injuries: [],

  diet: {
    style: 'omnivore',
    allergens: [],
    dislikedTags: [],
    excludedProductIds: [],
  },
  // Gotowanie na zapas, bez limitu czasu — obiady na dwa dni.
  cooking: { prepStyle: 'batch', weekdayMinutes: 90 },

  mealSplit: DEFAULT_MEAL_SPLIT,
  kcalOverride: DEFAULT_KCAL_PRESET,
}
