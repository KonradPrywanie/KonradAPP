import type {
  ActivityLevel,
  Allergen,
  BodyMetric,
  DietStyle,
  Equipment,
  Experience,
  Goal,
  Injury,
  MealSlot,
  PrepStyle,
  SessionStatus,
  SessionType,
  SwimStroke,
  TrainingEmphasis,
  Weekday,
} from '@/domain/types'
import { ACTIVITY_LABELS_PL } from '@/domain/calc/tdee'

export const GOAL_LABELS: Record<Goal, string> = {
  cut: 'Redukcja',
  maintain: 'Utrzymanie',
  bulk: 'Masa',
  conditioning: 'Poprawa kondycji',
  event: 'Przygotowanie do zawodów',
}

export const GOAL_HINTS: Record<Goal, string> = {
  cut: 'Deficyt kaloryczny, wyższe białko',
  maintain: 'Kalorie na poziomie wydatku',
  bulk: 'Umiarkowana nadwyżka',
  conditioning: 'Kalorie utrzymaniowe, nacisk na wytrzymałość',
  event: 'Plan liczony wstecz od daty startu, z taperingiem',
}

export const EXPERIENCE_LABELS: Record<Experience, string> = {
  beginner: 'Początkujący',
  intermediate: 'Średniozaawansowany',
  advanced: 'Zaawansowany',
}

export const EQUIPMENT_LABELS: Record<Equipment, string> = {
  gym: 'Siłownia',
  dumbbells: 'Hantle',
  running: 'Bieganie',
  home: 'Dom / masa własna',
  pool: 'Basen',
}

export const WEEKDAY_LABELS: Record<Weekday, string> = {
  1: 'Pon',
  2: 'Wt',
  3: 'Śr',
  4: 'Czw',
  5: 'Pt',
  6: 'Sob',
  7: 'Nd',
}

export const DIET_STYLE_LABELS: Record<DietStyle, string> = {
  omnivore: 'Bez ograniczeń',
  vegetarian: 'Wegetariańska',
  vegan: 'Wegańska',
  pescatarian: 'Pescatariańska',
}

export const ALLERGEN_LABELS: Record<Allergen, string> = {
  gluten: 'Gluten',
  lactose: 'Laktoza',
  nuts: 'Orzechy',
  peanuts: 'Orzeszki ziemne',
  eggs: 'Jaja',
  fish: 'Ryby',
  shellfish: 'Skorupiaki',
  soy: 'Soja',
  sesame: 'Sezam',
}

export const INJURY_LABELS: Record<Injury, string> = {
  knee: 'Kolano',
  shoulder: 'Bark',
  lowerBack: 'Odcinek lędźwiowy',
  wrist: 'Nadgarstek',
  ankle: 'Staw skokowy',
  hip: 'Biodro',
  neck: 'Szyja',
  pelvicFloor: 'Dno miednicy',
}

export const EMPHASIS_LABELS: Record<TrainingEmphasis, string> = {
  balanced: 'Równomiernie',
  lowerBody: 'Dolna część i pośladki',
  upperBody: 'Górna część ciała',
}

export const EMPHASIS_HINTS: Record<TrainingEmphasis, string> = {
  balanced: 'Tyle samo objętości na górę i dół',
  lowerBody: 'Dwie sesje dolne na jedną górną, w tym sesja biodrowo-pośladkowa',
  upperBody: 'Nacisk na pchanie i ciągnięcie, jedna sesja dolna',
}

export const PREP_STYLE_LABELS: Record<PrepStyle, string> = {
  daily: 'Gotuję codziennie',
  batch: 'Gotuję na zapas (meal prep)',
}

export const SWIM_STROKE_LABELS: Record<SwimStroke, string> = {
  freestyle: 'Kraul',
  breaststroke: 'Klasyczny',
  backstroke: 'Grzbietowy',
  butterfly: 'Delfin',
  any: 'Dowolny / mieszany',
}

export const BODY_METRIC_LABELS: Record<BodyMetric, string> = {
  waistCm: 'Talia',
  hipsCm: 'Biodra',
  chestCm: 'Klatka',
  thighCm: 'Udo',
  armCm: 'Ramię',
}

/** Gdzie dokładnie mierzyć — bez tego dwa pomiary tego samego obwodu nie są porównywalne. */
export const BODY_METRIC_HINTS: Record<BodyMetric, string> = {
  waistCm: 'W najwęższym miejscu, na wydechu, bez wciągania brzucha',
  hipsCm: 'W najszerszym miejscu pośladków',
  chestCm: 'Pod pachami, na wysokości brodawek',
  thighCm: 'Najgrubsze miejsce, zawsze ta sama noga',
  armCm: 'Środek bicepsa przy opuszczonej, rozluźnionej ręce',
}

export const MEAL_SLOT_LABELS: Record<MealSlot, string> = {
  breakfast: 'Śniadanie',
  lunch: 'Obiad',
  afternoon: 'Posiłek po pracy',
  snack: 'Słodka przekąska',
  dinner: 'Kolacja',
  // Wpis poza porządkiem dnia — patrz `MealSlot` w `domain/types.ts`.
  other: 'Poza planem',
}

export const SESSION_TYPE_LABELS: Record<SessionType, string> = {
  strength: 'Trening siłowy',
  run: 'Bieganie',
  swim: 'Pływanie',
  walk: 'Spacer',
  rest: 'Odpoczynek',
}

/**
 * Status sesji po polsku. Jedno miejsce, bo używa go i ekran sesji, i eksport
 * CSV — a dwie kopie rozjechałyby się przy pierwszej zmianie słownictwa.
 */
export const SESSION_STATUS_LABELS: Record<SessionStatus, string> = {
  done: 'Wykonane',
  partial: 'Częściowo wykonane',
  skipped: 'Pominięte',
}

export function entriesOf<K extends string, V>(record: Record<K, V>): [K, V][] {
  return Object.entries(record) as [K, V][]
}

/**
 * Etykieta poziomu aktywności rozbita na nazwę i wyjaśnienie.
 * Źródłowy słownik trzyma je w jednym ciągu po myślniku.
 */
export function activityLabelParts(level: ActivityLevel): { short: string; hint: string } {
  const full = ACTIVITY_LABELS_PL[level]
  const [short, ...rest] = full.split(' — ')
  return { short: short ?? full, hint: rest.join(' — ') }
}

export function activityOptions(): { value: ActivityLevel; label: string; hint: string }[] {
  return entriesOf(ACTIVITY_LABELS_PL).map(([value]) => {
    const parts = activityLabelParts(value)
    return { value, label: parts.short, hint: parts.hint }
  })
}

/** Słownik etykiet → opcje dla `ChipRadio` / `ChipMulti`. */
export function optionsFrom<T extends string>(
  labels: Record<T, string>,
): { value: T; label: string }[] {
  return entriesOf(labels).map(([value, label]) => ({ value, label }))
}
