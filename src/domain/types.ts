/**
 * Model danych FITKonrada.
 *
 * Zasada nadrzędna: PLAN jest mutowalny, LOG jest append-only.
 * Historia, statystyki, progresja i adaptacja czytają wyłącznie z logu.
 * Regeneracja planu nigdy nie rusza logu.
 *
 * Każdy rekord ma UUID + updatedAt + opcjonalny deletedAt — pod przyszłą
 * synchronizację z Postgresem. Nie używamy autoincrement i nie usuwamy
 * twardo danych użytkownika.
 */

export type Uuid = string
/** Data kalendarzowa bez strefy, format `YYYY-MM-DD`. */
export type IsoDate = string
/** Znacznik czasu ISO 8601 z UTC. */
export type IsoTimestamp = string

export interface Syncable {
  id: Uuid
  updatedAt: IsoTimestamp
  deletedAt?: IsoTimestamp | null
}

// ─────────────────────────────────────────────────────────── Profil

export type Sex = 'male' | 'female'

export type Goal =
  | 'cut' // redukcja
  | 'maintain' // utrzymanie
  | 'bulk' // masa
  | 'conditioning' // poprawa kondycji
  | 'event' // przygotowanie do zawodów — wymaga eventDate

export type ActivityLevel = 'sedentary' | 'light' | 'moderate' | 'high' | 'veryHigh'

export type Experience = 'beginner' | 'intermediate' | 'advanced'

export type Equipment = 'gym' | 'dumbbells' | 'running' | 'home' | 'pool'

/** ISO-8601: 1 = poniedziałek … 7 = niedziela. */
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7

export type DietStyle = 'omnivore' | 'vegetarian' | 'vegan' | 'pescatarian'

/**
 * Alergeny jako zamknięta lista — są twardym filtrem w solverze diety,
 * nie tagiem opisowym. Dopisanie wartości wymaga uzupełnienia danych produktów.
 */
export type Allergen =
  | 'gluten'
  | 'lactose'
  | 'nuts'
  | 'peanuts'
  | 'eggs'
  | 'fish'
  | 'shellfish'
  | 'soy'
  | 'sesame'

/**
 * Ograniczenia ruchowe — twardy filtr katalogu ćwiczeń.
 * Musiały istnieć od v1: dopisanie później oznaczałoby przepisanie generatora.
 *
 * `pelvicFloor` nie jest kontuzją stawu, ale działa tak samo — wyklucza
 * ćwiczenia z mocnym parciem tłoczni brzusznej i sesje o wysokim wpływie
 * (interwały biegowe). To najczęstsze realne ograniczenie w tej grupie
 * użytkowników i pomijanie go dawałoby plany, których nie da się wykonać.
 */
export type Injury =
  | 'knee'
  | 'shoulder'
  | 'lowerBack'
  | 'wrist'
  | 'ankle'
  | 'hip'
  | 'neck'
  | 'pelvicFloor'

/**
 * Ukierunkowanie objętości treningowej.
 *
 * To PREFERENCJA, nie reguła biologiczna. Fizjologia nie zna „ćwiczeń dla
 * kobiet" — mięsień odpowiada na bodziec tak samo niezależnie od płci.
 * Różni się natomiast to, czego ludzie chcą od treningu i od czego startują:
 * nacisk na dolną część ciała i pośladki jest bardzo częstym celem, a górna
 * część zwykle wymaga więcej stopni pośrednich w progresji (podciąganie
 * z gumą, pompka na podwyższeniu). Tym sterujemy tutaj — doborem objętości
 * i głębokością katalogu, nie osobnymi „damskimi" ćwiczeniami.
 */
export type TrainingEmphasis = 'balanced' | 'lowerBody' | 'upperBody'

/**
 * Punkt wyjścia w bieganiu.
 *
 * Bez tego generator dobierał dystans i tempo wyłącznie z pola „doświadczenie",
 * czyli z trzech sztywnych presetów. Dwie osoby oznaczone jako
 * „średniozaawansowane" mogą różnić się o 2 minuty na kilometrze — plan liczony
 * z presetu będzie dla jednej za łatwy, dla drugiej niewykonalny.
 */
export interface RunBaseline {
  /** Dystans, jaki obecnie przebiega bez zatrzymywania się. */
  distanceM: number
  /** Tempo tego dystansu, w sekundach na kilometr. */
  paceSecPerKm: number
}

/** Punkt wyjścia w pływaniu. Analogicznie do `RunBaseline`. */
export interface SwimBaseline {
  /** Ile długości basenu przepływa bez przerwy. */
  laps: number
  /** Długość basenu — od niej zależy, ile metrów to jedna długość. */
  poolLengthM: 25 | 50
  stroke: SwimStroke
}

export type PrepStyle = 'daily' | 'batch'

/**
 * Rozkład kalorii na posiłki UKŁADANE PRZEZ SOLVER — cztery, nie pięć.
 *
 * Słodkiej przekąski tu nie ma i to jest celowe: ona nie jest planowana,
 * tylko wpisywana ręcznie, a jej budżet jest odłożony z góry
 * (patrz `SWEET_SNACK` w `domain/diet/sweetSnack.ts`).
 *
 * Udziały sumują się do 1,0 i dotyczą celu POMNIEJSZONEGO o rezerwę
 * na przekąskę.
 */
export interface MealSplit {
  /** Śniadanie. */
  breakfast: number
  /** Obiad. */
  lunch: number
  /** Posiłek po pracy. */
  afternoon: number
  /** Kolacja. */
  dinner: number
}

export interface DietRestrictions
  extends Readonly<{
    style: DietStyle
    allergens: Allergen[]
    /** Tagi produktów/przepisów, których użytkownik nie chce jeść. */
    dislikedTags: string[]
    excludedProductIds: string[]
  }> {}

export interface Profile extends Syncable {
  name: string
  birthYear: number
  sex: Sex
  heightCm: number
  /** Waga startowa. Bieżąca waga zawsze pochodzi z `weightEntries`. */
  startWeightKg: number
  /** Znany % tkanki tłuszczowej → przełącza BMR na Katch-McArdle. */
  bodyFatPct?: number

  goal: Goal
  /** Wymagane dla goal === 'event'; plan liczony wstecz od tej daty. */
  eventDate?: IsoDate
  activityLevel: ActivityLevel
  experience: Experience
  equipment: Equipment[]
  /**
   * Dni, w które użytkownik MOŻE trenować.
   *
   * Ile z nich faktycznie wykorzystamy, wylicza `derivedWeeklySessions()`
   * z poziomu aktywności i doświadczenia — profil nie przechowuje osobnej
   * liczby treningów, żeby nie mogła rozjechać się z resztą danych.
   */
  availableDays: Weekday[]
  /** Budżet czasowy jednej sesji — 45 vs 90 min to inny plan przy tych samych dniach. */
  sessionMinutes: number
  emphasis: TrainingEmphasis
  /** Pytane tylko wtedy, gdy wśród sprzętu jest bieganie. */
  runBaseline?: RunBaseline
  /** Pytane tylko wtedy, gdy wśród sprzętu jest basen. */
  swimBaseline?: SwimBaseline

  diet: DietRestrictions
  cooking: { weekdayMinutes: number; prepStyle: PrepStyle }
  injuries: Injury[]

  mealSplit: MealSplit
  /** Ręczne nadpisanie celu kalorycznego. Null = licz automatycznie. */
  kcalOverride?: number | null

  createdAt: IsoTimestamp
}

// ────────────────────────────────────────────────── Pomiary (log)

export interface WeightEntry extends Syncable {
  date: IsoDate
  weightKg: number
  createdAt: IsoTimestamp
}

/** Wynik wygładzania EWMA — surowa waga plus trend. */
export interface WeightTrendPoint {
  date: IsoDate
  weightKg: number
  trendKg: number
}

/**
 * Obwody ciała w centymetrach.
 *
 * Osobny rekord, nie pola w `WeightEntry`: wagę wpisuje się codziennie, obwody
 * raz w tygodniu (w sobotę — patrz `WEEK_START_DAY`). Wspólna tabela zmusiłaby
 * do trzymania pustych kolumn w większości dni i psułaby wykres masy.
 *
 * Wszystkie miary są opcjonalne, bo nikt nie mierzy wszystkiego za każdym
 * razem. Zapis wymaga przynajmniej jednej — pusty rekord nie jest pomiarem.
 * Obwody są tu WYŁĄCZNIE historią: nie wchodzą do żadnego wyliczenia
 * kalorycznego ani do planu treningowego.
 */
export interface BodyMeasurement extends Syncable {
  date: IsoDate
  waistCm?: number
  hipsCm?: number
  chestCm?: number
  thighCm?: number
  armCm?: number
  notes?: string
  createdAt: IsoTimestamp
}

/** Klucze obwodów — jedno źródło prawdy dla formularza, wykresu i eksportu. */
export type BodyMetric = 'waistCm' | 'hipsCm' | 'chestCm' | 'thighCm' | 'armCm'

// ─────────────────────────────────────────── Trening — katalog

export type MovementPattern =
  | 'squat'
  | 'hinge'
  | 'horizontalPush'
  | 'verticalPush'
  | 'horizontalPull'
  | 'verticalPull'
  | 'core'
  | 'carry'
  | 'isolation'

export type MuscleGroup =
  | 'quads'
  | 'hamstrings'
  | 'glutes'
  | 'chest'
  | 'back'
  | 'shoulders'
  | 'biceps'
  | 'triceps'
  | 'calves'
  | 'abs'

/**
 * Katalog ćwiczeń to DWA GOTOWE TRENINGI (FBW A i FBW B) z arkusza trenera,
 * nie zbiór, z którego aplikacja komponuje sesje.
 *
 * Poprzednia wersja miała 34 ćwiczenia i generator dobierający je pod wzorce
 * ruchowe. Zostało to usunięte świadomie: plan pisany przez trenera pod
 * konkretną osobę zawiera dobór, kolejność, tempo i przerwy, których żaden
 * generator nie odgadnie — a dwa źródła prawdy o „dzisiejszym treningu" to
 * jedno źródło za dużo. Aplikacja odpowiada teraz za kalendarz, progresję
 * obciążeń z logu i podmianę na alternatywę, nie za wymyślanie ćwiczeń.
 *
 * Wzorzec ruchowy (`pattern`) jest jedynym polem, którego arkusz nie zawiera:
 * potrzebują go reguły progresji (`evaluateProgression`), bo dokładka na
 * przysiadzie i na izolacji nie może być taka sama. Uzupełniany jawną tabelą
 * w importerze, nigdy domyślną wartością.
 */
export type WorkoutVariant = 'main' | 'alt1' | 'alt2'

export interface WorkoutExercise {
  id: string
  name: string
  pattern: MovementPattern
  variant: WorkoutVariant
  /** Główne partie mięśniowe — opis z arkusza, nie zbiór enumów. */
  muscles: string
  description: string
  /** Uwagi techniczne i fizjoterapeutyczne, punkt po punkcie. */
  cues: string[]
  /** Zapis tempa ruchu, np. „3010". Znaczenie cyfr: `TEMPO_LEGEND`. */
  tempo: string
  tempoNote?: string
  /** Dolna granica przerwy z arkusza — do szacowania czasu sesji. */
  restSec: number
  /** Zapis przerwy ze źródła, np. „90 - 120 sek.". */
  restLabel: string
  sets: number
  setsMax: number
  reps: number
  repsMax: number
  /** Powtórzenia liczone na stronę/nogę, nie łącznie. */
  perSide: boolean
  /**
   * Ciężar startowy w kg albo null, gdy arkusz nie podaje liczby, którą można
   * podnosić: masa własnego ciała, „Gryf + …" (masa gryfu zależy od suwnicy)
   * oraz asysta maszyny, gdzie WIĘKSZA liczba znaczy łatwiej.
   */
  startWeightKg: number | null
  /** Zapis ciężaru ze źródła — pokazujemy go zawsze, także gdy `startWeightKg` jest null. */
  startWeightLabel: string
  /**
   * Instruktaż z kolumny „Wideo Instruktażowe" w arkuszu.
   *
   * Dziś kolumna jest pusta, więc pole jest puste — linki żyją w kuratorowanym
   * `data/exerciseVideos.ts`. Gdy trener ją uzupełni, importer przeniesie jego
   * materiały i to ONE mają pierwszeństwo (patrz `exerciseVideo`).
   */
  videoUrl?: string
}

/** Ćwiczenie główne i jego dwie alternatywy — jedna pozycja planu treningu. */
export interface WorkoutSlot {
  index: number
  main: WorkoutExercise
  alternatives: WorkoutExercise[]
}

export interface Workout {
  id: 'A' | 'B'
  name: string
  /** Podtytuł z arkusza — po co jest ten trening. */
  focus: string
  slots: WorkoutSlot[]
}

export interface WarmupStep {
  step: number
  element: string
  name: string
  description: string
  duration: string
  purpose: string
}

export interface TempoDigit {
  digit: number
  meaning: string
}

// ─────────────────────────────────────────── Trening — plan

/**
 * `walk` (spacer) występuje WYŁĄCZNIE w logu, nigdy w planie — dlatego nie ma
 * odpowiadającego mu wariantu w `SessionPayload`. Generator nie planuje spacerów,
 * ale spacer z psem to realna aktywność, która powinna liczyć się do dystansów.
 * Wrzucenie go do biegania fałszowałoby statystyki biegowe.
 */
export type SessionType = 'strength' | 'run' | 'swim' | 'walk' | 'rest'

/** 3 tygodnie akumulacji + 1 deload. Progresja liniowa przez 12 tyg. nie działa. */
export type MesocyclePhase = 'accumulation' | 'deload' | 'taper'

export interface PlannedSet {
  reps: number
  /** Null dla ćwiczeń z masą własną lub gdy ciężar jeszcze nieznany. */
  weightKg: number | null
  /** Docelowe RPE — wejście do reguły progresji. */
  targetRpe: number
}

export interface PlannedExercise {
  exerciseId: string
  sets: PlannedSet[]
  restSec: number
  note?: string
}

/**
 * Ukierunkowanie sesji siłowej. Wpływa na dobór wzorców ruchowych i — co
 * ważniejsze — na reguły kolizji: po dniu nóg nie stawiamy mocnego biegu.
 */
export type SessionFocus = 'full' | 'upper' | 'lower' | 'push' | 'pull' | 'legs' | 'glutes'

export interface StrengthPayload {
  kind: 'strength'
  focus: SessionFocus
  /** Z którego treningu z arkusza pochodzi sesja: „A" albo „B". */
  workoutId: Workout['id']
  exercises: PlannedExercise[]
  estimatedMinutes: number
}

export type HeartRateZone = 1 | 2 | 3 | 4 | 5

export interface RunPayload {
  kind: 'run'
  distanceM: number
  targetPaceSecPerKm: number
  durationSec: number
  zone: HeartRateZone
  /** np. „6×400 m / 90 s przerwy" — null dla biegu ciągłego. */
  intervals?: string | null
}

export type SwimStroke = 'freestyle' | 'breaststroke' | 'backstroke' | 'butterfly' | 'any'

export interface SwimPayload {
  kind: 'swim'
  distanceM: number
  stroke: SwimStroke
  sets: number
  restSec: number
}

export interface RestPayload {
  kind: 'rest'
  note?: string
}

export type SessionPayload = StrengthPayload | RunPayload | SwimPayload | RestPayload

export interface TrainingPlan extends Syncable {
  startDate: IsoDate
  weeks: number
  /** Kopia profilu z momentu generowania — plan musi być odtwarzalny. */
  profileSnapshot: Profile
  /** Rośnie przy każdej regeneracji; poprzednie wersje zostają (soft delete). */
  version: number
  status: 'active' | 'archived'
  /**
   * Przesunięcie rytmu bloków użyte przy generowaniu.
   *
   * Musi być zapisane, żeby ponowne dopasowanie planu po zmianie profilu
   * odtworzyło te same fazy. Bez tego korekta ustawień przestawiałaby deload
   * na inny tydzień. Brak pola w starszych rekordach znaczy zero.
   */
  blockOffsetWeeks?: number
  createdAt: IsoTimestamp
}

export interface PlannedSession extends Syncable {
  planId: Uuid
  /** 0-indeksowany. */
  weekIndex: number
  dayOfWeek: Weekday
  date: IsoDate
  type: SessionType
  phase: MesocyclePhase
  payload: SessionPayload
}

// ─────────────────────────────────────── Trening — log (append-only)

export type SessionStatus = 'done' | 'partial' | 'skipped'

export interface SessionLog extends Syncable {
  /** Null dla treningu poza planem. */
  plannedSessionId: Uuid | null
  date: IsoDate
  type: SessionType
  status: SessionStatus
  sessionRpe?: number
  durationMin?: number
  notes?: string
  createdAt: IsoTimestamp
}

/**
 * Log PER SERIA, nie per ćwiczenie.
 * Bez tej granularności nie ma progresji ani objętości treningowej.
 */
export interface SetLog extends Syncable {
  sessionLogId: Uuid
  exerciseId: string
  setIndex: number
  reps: number
  weightKg: number | null
  rpe?: number
  createdAt: IsoTimestamp
}

export interface CardioLog extends Syncable {
  sessionLogId: Uuid
  distanceM: number
  durationSec: number
  avgHr?: number
  createdAt: IsoTimestamp
}

// ─────────────────────────────────────────────── Dieta — katalog

/**
 * Jednostki ilości składnika.
 *
 * Trzy, bo tyle występuje w arkuszu przepisów: gramy, mililitry i sztuki
 * (jajko, ząbek czosnku — także połówki). Bazy produktów z wartościami
 * na 100 g już nie ma: makro pochodzi z przepisu, więc gęstości i mas sztuki
 * nie ma po co przeliczać.
 */
export type Unit = 'g' | 'ml' | 'piece'

/**
 * Pory posiłków w kolejności dnia.
 *
 * Rytm to CZTERY posiłki plus przekąska: śniadanie, obiad, posiłek po pracy,
 * słodka przekąska i kolacja. Śniadanie jest tu różnicą względem FitPlannera,
 * z którego ta aplikacja wyrosła, i nie jest kosmetyką: przy celu 2500–3000
 * kcal trzy posiłki oznaczałyby 800–1000 kcal na talerzu, czyli porcje, których
 * nikt nie zjada w tygodniu pracy. Cztery posiłki schodzą do 550–800 kcal —
 * i dopiero wtedy gramatury z przepisu wyglądają jak jedzenie, a nie jak wyzwanie.
 *
 * `snack` (słodka przekąska) jest slotem SZCZEGÓLNYM: solver go nie układa,
 * bo nie da się z góry powiedzieć, co konkretnie wpadnie. Zamiast udawać, że
 * wiemy, odkładamy na niego stały budżet kaloryczny (`SWEET_SNACK`), a treść
 * wpisuje użytkownik. To ta sama zasada, co przy logowaniu odstępstw:
 * lepiej zaplanować miejsce na coś, co i tak się zdarzy, niż potem tłumaczyć
 * przekroczony bilans.
 *
 * `other` to wpis POZA porządkiem dnia — „zjadłem coś innego". Bez niego takie
 * wpisy szłyby do slotu `snack` i skutki byłyby dwa, oba mylące: pizza
 * pokazywałaby się w karcie „słodka przekąska", a drugi i każdy kolejny wpis
 * z tego dnia byłby NIEWIDOCZNY, choć liczy się do bilansu — „pozostało dziś"
 * spadałoby bez pozycji, przy której to widać.
 *
 * `other` nie występuje w przepisach ani w planie: tylko w logu.
 */
export type MealSlot = 'breakfast' | 'lunch' | 'afternoon' | 'snack' | 'dinner' | 'other'

/**
 * Składnik przepisu — nazwą i ilością, tak jak zapisał go autor przepisu.
 *
 * Nie ma tu `productId`, bo nie ma już bazy produktów. Powód jest w danych:
 * arkusz podaje 267 różnych składników i gotowe makro całego posiłku, ale nie
 * podaje wartości na 100 g. Zbudowanie z tego katalogu produktów wymagałoby
 * wpisania ~267 zestawów wartości odżywczych z zewnętrznego źródła i przyjęcia,
 * że zgadzają się z makrem z arkusza. Nie zgadzałyby się — i wtedy jadłospis
 * miałby dwie różne prawdy o tym samym obiedzie.
 */
export interface RecipeIngredient {
  /** Nazwa jak w przepisie, np. „Pierś z kurczaka". */
  name: string
  /** Ilość w jednostce `unit`; null, gdy przepis jej nie podaje („Czosnek"). */
  amount: number | null
  unit: Unit
  /** Zapis ilości ze źródła, np. „2 duże szt 150g" — do wyświetlenia bez zgadywania. */
  label?: string
}

export interface Recipe {
  id: string
  name: string
  /** Jeden slot — arkusz przypisuje przepis do konkretnej pory dnia. */
  slot: MealSlot
  ingredients: RecipeIngredient[]
  /** Przyprawy i zioła bez gramatur — tak, jak podaje je przepis. */
  spices: string[]
  steps: string[]
  prepMinutes: number
  /** np. „+chłodzenie", „+noc" — czas, którego nie da się skrócić. */
  prepNote?: string
  /**
   * Makro PORCJI BAZOWEJ, wartość autorytatywna z arkusza.
   *
   * Skalowanie porcji mnoży je przez ten sam współczynnik co gramatury —
   * kalorie są liniowe w porcji, więc to jest poprawne przeliczenie.
   */
  macros: Macros
  /** Dopuszczalny zakres mnożnika porcji przy skalowaniu przez solver. */
  minScale: number
  maxScale: number
}

// ───────────────────────────────────────────────── Dieta — plan

export interface MealIngredient {
  name: string
  /** Ilość po przeskalowaniu porcji; null, gdy przepis jej nie podaje. */
  amount: number | null
  unit: Unit
  /** Zapis ilości ze źródła — pokazywany, gdy `amount` jest null. */
  label?: string
}

export interface PlannedMeal extends Syncable {
  date: IsoDate
  slot: MealSlot
  recipeId: string
  /** Mnożnik porcji wyliczony przez solver. */
  scale: number
  /**
   * Gramatury zamrożone w momencie generowania — plan jest migawką, tak samo
   * jak `profileSnapshot` w planie treningowym. Odtwarzanie ich z `recipeId`
   * i `scale` rozjechałoby się z listą zakupów po każdej korekcie w katalogu
   * produktów, a użytkownik kupił już to, co plan pokazał.
   */
  ingredients: MealIngredient[]
  /** Zamrożone makro po zaokrągleniu gramatur — nie przeliczamy w UI. */
  computed: Macros
}

// ────────────────────────────────────── Dieta — log (append-only)

export interface Macros {
  kcal: number
  proteinG: number
  fatG: number
  carbsG: number
}

/**
 * `source: 'manual'` to obywatel pierwszej kategorii, nie wyjątek.
 * Bez logowania odstępstw kalorie na dashboardzie kłamią,
 * a adaptacyjny TDEE nie ma na czym się oprzeć.
 */
export interface MealLog extends Syncable {
  date: IsoDate
  slot: MealSlot
  plannedMealId: Uuid | null
  source: 'plan' | 'manual'
  /** Wymagane dla source === 'manual'. */
  label?: string
  macros: Macros
  createdAt: IsoTimestamp
}

// ──────────────────────────────────────────────── Lista zakupów

/**
 * Pozycja listy zakupów.
 *
 * Pokazujemy ilość FAKTYCZNIE POTRZEBNĄ, nie zaokrągloną do opakowań
 * handlowych. Zaokrąglanie w górę („1,8 kg ryżu → 2 × 1 kg") brzmiało wygodnie,
 * a w praktyce mieszało dwie różne informacje: ile potrzeba do jadłospisu i ile
 * trzeba kupić przy danej gramaturze opakowania. Druga zależy od sklepu, półki
 * i promocji — tego aplikacja nie wie, a przy zapasach w domu podpowiadała
 * kupowanie rzeczy, których kupować nie trzeba.
 */
/**
 * Skąd na liście wzięła się pozycja — jedno wystąpienie składnika w jadłospisie.
 *
 * Bez tego lista zakupów jest zbiorem liczb bez pochodzenia: „Chleb razowy
 * 240 g" nie mówi, czy to jedna zapiekanka, czy siedem kanapek, ani czego nie
 * ugotujesz, gdy chleba zabraknie. `recipeId` jest opcjonalny, bo listy
 * zbudowane przed tą zmianą go nie mają.
 */
export interface ShoppingItemSource {
  date: IsoDate
  recipeId?: string
  /** Ilość z tego jednego przepisu; null dla „do smaku". */
  amount: number | null
}

export interface ShoppingItem {
  /** Nazwa składnika z przepisów — ona jest identyfikatorem pozycji. */
  name: string
  /** Suma ilości z całego tygodnia; null dla pozycji bez gramatury. */
  amount: number | null
  unit: Unit
  category: string
  checked: boolean
  /** Przepisy, z których pozycja się zsumowała. Puste dla starych list. */
  sources?: ShoppingItemSource[]
}

/**
 * Lista zakupów na tydzień.
 *
 * Jedna sekcja pozycji, pogrupowana po działach sklepu. Osobnej sekcji
 * „zapas i przyprawy" NIE MA: przyprawy nie wchodzą już na listę (zostają
 * w karcie posiłku, przy instrukcji), a składniki bez gramatury stoją w swoim
 * dziale z adnotacją „do smaku". Przy zakupach liczy się półka w sklepie,
 * nie to, czy przepis podał gramaturę.
 */
export interface ShoppingList extends Syncable {
  weekStart: IsoDate
  items: ShoppingItem[]
  createdAt: IsoTimestamp
}

// ────────────────────────────────────────── Wyniki kalkulatorów

export interface CalcWarning {
  code:
    | 'kcalFloorApplied'
    | 'belowBmr'
    | 'underweightNoDeficit'
    | 'deficitCapped'
    | 'lowCarbs'
    | 'insufficientData'
  message: string
}

export interface NutritionTargets {
  bmi: number
  bmiCategory: 'underweight' | 'normal' | 'overweight' | 'obese'
  bmr: number
  bmrFormula: 'mifflin' | 'katch'
  tdee: number
  kcal: number
  macros: Macros
  warnings: CalcWarning[]
}
