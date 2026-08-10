import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import type {
  ActivityLevel,
  Allergen,
  DietStyle,
  Equipment,
  Experience,
  Goal,
  Injury,
  PrepStyle,
  Profile,
  Sex,
  SwimStroke,
  TrainingEmphasis,
  Weekday,
} from '@/domain/types'
import { nutritionTargets } from '@/domain/calc'
/**
 * Rozkład kalorii na cztery posiłki — jedno źródło, wspólne z presetem.
 *
 * Kopia tych liczb tutaj rozjechałaby się z presetem przy pierwszej korekcie,
 * a rozjazd byłby niewidoczny: jadłospis nadal by się generował, tylko profil
 * z kreatora miałby inny rozkład talerza niż profil ze startu.
 */
import { DEFAULT_MEAL_SPLIT } from '@/data/presetProfile'
import { fixedLayoutApplies, plannedWeeklySessions } from '@/domain/training/schedule'
import { BMI_CATEGORY_LABELS_PL } from '@/domain/calc/bmi'
import { todayIso } from '@/domain/dates'
import { profileRepo } from '@/db/repositories'
import {
  activityOptions,
  ALLERGEN_LABELS,
  DIET_STYLE_LABELS,
  EMPHASIS_HINTS,
  EMPHASIS_LABELS,
  EQUIPMENT_LABELS,
  EXPERIENCE_LABELS,
  GOAL_HINTS,
  GOAL_LABELS,
  INJURY_LABELS,
  PREP_STYLE_LABELS,
  SWIM_STROKE_LABELS,
  WEEKDAY_LABELS,
  entriesOf,
  optionsFrom,
} from '@/lib/labels'
import { sessionsLabel } from '@/lib/format'
import {
  Button,
  Callout,
  Card,
  ChipMulti,
  ChipRadio,
  DateInput,
  Field,
  FieldGroup,
  NumberInput,
  SectionTitle,
  Stat,
  StepDots,
  TextInput,
} from '@/components/ui'


interface Draft {
  name: string
  birthYear: number | null
  sex: Sex
  heightCm: number | null
  startWeightKg: number | null
  bodyFatPct: number | null
  goal: Goal
  eventDate: string
  activityLevel: ActivityLevel
  experience: Experience
  equipment: Equipment[]
  availableDays: Weekday[]
  emphasis: TrainingEmphasis
  sessionMinutes: number
  // Punkt wyjścia w cardio — tempo rozbite na minuty i sekundy, bo nikt
  // nie myśli o swoim tempie jako o „330 sekundach na kilometr".
  runDistanceKm: number | null
  runPaceMin: number | null
  runPaceSec: number | null
  swimLaps: number | null
  swimPoolLengthM: 25 | 50
  swimStroke: SwimStroke
  injuries: Injury[]
  dietStyle: DietStyle
  allergens: Allergen[]
  dislikedRaw: string
  cookingMinutes: number
  prepStyle: PrepStyle
  kcalOverride: number | null
}

const EMPTY_DRAFT: Draft = {
  name: '',
  birthYear: null,
  sex: 'male',
  heightCm: null,
  startWeightKg: null,
  bodyFatPct: null,
  goal: 'cut',
  eventDate: '',
  activityLevel: 'moderate',
  experience: 'beginner',
  equipment: [],
  availableDays: [],
  emphasis: 'balanced',
  sessionMinutes: 60,
  runDistanceKm: null,
  runPaceMin: null,
  runPaceSec: null,
  swimLaps: null,
  swimPoolLengthM: 25,
  swimStroke: 'any',
  injuries: [],
  dietStyle: 'omnivore',
  allergens: [],
  dislikedRaw: '',
  cookingMinutes: 30,
  prepStyle: 'daily',
  kcalOverride: null,
}

type StepId =
  | 'basics'
  | 'goal'
  | 'activity'
  | 'training'
  | 'cardio'
  | 'injuries'
  | 'diet'
  | 'summary'

/**
 * Kroki kreatora są dynamiczne.
 *
 * Krok o punkcie wyjścia w cardio pojawia się tylko wtedy, gdy wśród sprzętu
 * jest bieganie albo basen. Pytanie kogoś o tempo na kilometrze, kiedy nie
 * zaznaczyła biegania, to strata czasu i sygnał, że aplikacja jej nie słucha.
 */
function stepsFor(draft: Draft): StepId[] {
  const needsCardio = draft.equipment.includes('running') || draft.equipment.includes('pool')
  return [
    'basics',
    'goal',
    'activity',
    'training',
    ...(needsCardio ? (['cardio'] as StepId[]) : []),
    'injuries',
    'diet',
    'summary',
  ]
}

export function ProfileWizard() {
  const navigate = useNavigate()
  const [step, setStep] = useState(0)
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [saving, setSaving] = useState(false)

  function patch(update: Partial<Draft>) {
    setDraft((d) => ({ ...d, ...update }))
  }

  const steps = stepsFor(draft)
  // Odznaczenie biegania cofa krok o cardio — indeks musi zostać w zakresie.
  const current = Math.min(step, steps.length - 1)
  const stepId = steps[current] as StepId
  const stepCount = steps.length

  const errors = validateStep(stepId, draft)
  const canAdvance = errors.length === 0

  /** Podgląd kalkulacji dostępny dopiero, gdy dane podstawowe są kompletne. */
  const preview = useMemo(() => {
    const profile = draftToProfile(draft)
    if (!profile) return null
    try {
      return nutritionTargets(profile, profile.startWeightKg)
    } catch {
      return null
    }
  }, [draft])

  async function handleSave() {
    const profile = draftToProfile(draft)
    if (!profile) return
    setSaving(true)
    try {
      const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...input } = profile
      await profileRepo.save(input)
      navigate('/', { replace: true })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mx-auto flex min-h-full max-w-lg flex-col gap-4 p-4 pb-28">
      <header>
        <p className="text-sm text-[var(--color-text-dim)]">
          Krok {current + 1} z {stepCount}
        </p>
        <div className="mt-2">
          <StepDots total={stepCount} current={current} />
        </div>
      </header>

      <Card>
        {stepId === 'basics' && <StepBasics draft={draft} patch={patch} />}
        {stepId === 'goal' && <StepGoal draft={draft} patch={patch} />}
        {stepId === 'activity' && <StepActivity draft={draft} patch={patch} />}
        {stepId === 'training' && <StepTraining draft={draft} patch={patch} />}
        {stepId === 'cardio' && <StepCardio draft={draft} patch={patch} />}
        {stepId === 'injuries' && <StepInjuries draft={draft} patch={patch} />}
        {stepId === 'diet' && <StepDiet draft={draft} patch={patch} />}
        {stepId === 'summary' && <StepSummary draft={draft} patch={patch} preview={preview} />}
      </Card>

      {errors.length > 0 && (
        <Callout tone="warn" title="Uzupełnij dane">
          <ul className="list-disc pl-4">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </Callout>
      )}

      <div className="fixed inset-x-0 bottom-0 border-t border-[var(--color-border)] bg-[var(--color-bg)]/95 p-4 backdrop-blur">
        <div className="mx-auto flex max-w-lg gap-3">
          <Button
            variant="ghost"
            onClick={() => setStep(Math.max(0, current - 1))}
            disabled={current === 0}
          >
            Wstecz
          </Button>
          {current < stepCount - 1 ? (
            <Button className="flex-1" onClick={() => setStep(current + 1)} disabled={!canAdvance}>
              Dalej
            </Button>
          ) : (
            <Button className="flex-1" onClick={handleSave} disabled={!canAdvance || saving}>
              {saving ? 'Zapisywanie…' : 'Zapisz profil'}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

// ───────────────────────────────────────────────────────────── Kroki

interface StepProps {
  draft: Draft
  patch: (update: Partial<Draft>) => void
}

function StepBasics({ draft, patch }: StepProps) {
  return (
    <>
      <SectionTitle hint="Na tej podstawie policzymy BMI, BMR i zapotrzebowanie kaloryczne.">
        Dane podstawowe
      </SectionTitle>

      <div className="mb-4">
        <Callout tone="warn" title="To nie jest porada medyczna">
          FITKonrad liczy szacunki na podstawie wzorów populacyjnych. Przy chorobach
          przewlekłych, ciąży, zaburzeniach odżywiania lub przyjmowaniu leków skonsultuj
          plan z lekarzem albo dietetykiem.
        </Callout>
      </div>

      <div className="grid gap-4">
        <Field label="Imię">
          <TextInput value={draft.name} onChange={(name) => patch({ name })} placeholder="np. Konrad" />
        </Field>

        <FieldGroup label="Płeć" hint="Wpływa na wzór BMR i minimalny bezpieczny poziom kalorii.">
          <ChipRadio<Sex>
            columns={2}
            value={draft.sex}
            onChange={(sex) => patch({ sex })}
            options={[
              { value: 'male', label: 'Mężczyzna' },
              { value: 'female', label: 'Kobieta' },
            ]}
          />
        </FieldGroup>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Rok urodzenia">
            <NumberInput
              value={draft.birthYear}
              onChange={(birthYear) => patch({ birthYear })}
              min={1920}
              max={new Date().getFullYear() - 12}
              placeholder="1996"
            />
          </Field>
          <Field label="Wzrost">
            <NumberInput
              value={draft.heightCm}
              onChange={(heightCm) => patch({ heightCm })}
              min={120}
              max={230}
              suffix="cm"
            />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Waga">
            <NumberInput
              value={draft.startWeightKg}
              onChange={(startWeightKg) => patch({ startWeightKg })}
              min={35}
              max={300}
              step={0.1}
              suffix="kg"
            />
          </Field>
          <Field label="Tkanka tłuszczowa" hint="Opcjonalnie — włącza dokładniejszy wzór.">
            <NumberInput
              value={draft.bodyFatPct}
              onChange={(bodyFatPct) => patch({ bodyFatPct })}
              min={3}
              max={60}
              step={0.5}
              suffix="%"
              placeholder="—"
            />
          </Field>
        </div>
      </div>
    </>
  )
}

function StepGoal({ draft, patch }: StepProps) {
  return (
    <>
      <SectionTitle hint="Cel decyduje o kaloriach, rozkładzie makro i strukturze planu treningowego.">
        Cel
      </SectionTitle>

      <ChipRadio<Goal>
        value={draft.goal}
        onChange={(goal) => patch({ goal })}
        options={entriesOf(GOAL_LABELS).map(([value, label]) => ({
          value,
          label,
          hint: GOAL_HINTS[value],
        }))}
      />

      {draft.goal === 'event' && (
        <div className="mt-4">
          <Field
            label="Data zawodów"
            hint="Plan zostanie policzony wstecz od tej daty, z taperingiem w ostatnich tygodniach."
          >
            <DateInput
              value={draft.eventDate}
              onChange={(eventDate) => patch({ eventDate })}
              min={todayIso()}
            />
          </Field>
        </div>
      )}
    </>
  )
}

function StepActivity({ draft, patch }: StepProps) {
  return (
    <>
      <SectionTitle hint="Aktywność poza treningami. Mnożniki są niedokładne — po 14 dniach logowania aplikacja policzy Twój realny wydatek z danych.">
        Aktywność i doświadczenie
      </SectionTitle>

      <div className="grid gap-4">
        <FieldGroup label="Poziom aktywności">
          <ChipRadio<ActivityLevel>
            value={draft.activityLevel}
            onChange={(activityLevel) => patch({ activityLevel })}
            options={activityOptions()}
          />
        </FieldGroup>

        <FieldGroup label="Doświadczenie treningowe" hint="Filtruje ćwiczenia i tempo progresji.">
          <ChipRadio<Experience>
            value={draft.experience}
            onChange={(experience) => patch({ experience })}
            options={optionsFrom(EXPERIENCE_LABELS)}
          />
        </FieldGroup>
      </div>
    </>
  )
}

function StepTraining({ draft, patch }: StepProps) {
  return (
    <>
      <SectionTitle hint="Sprzęt i dostępny czas decydują o tym, jakie ćwiczenia w ogóle wejdą do planu.">
        Sprzęt i dostępność
      </SectionTitle>

      <div className="grid gap-4">
        <FieldGroup label="Dostępny sprzęt" hint="Wybierz wszystko, do czego masz dostęp.">
          <ChipMulti<Equipment>
            values={draft.equipment}
            onChange={(equipment) => patch({ equipment })}
            options={optionsFrom(EQUIPMENT_LABELS)}
          />
        </FieldGroup>

        <FieldGroup label="Dni, w które możesz trenować" hint="Zaznacz wszystkie, które wchodzą w grę.">
          <ChipMulti<string>
            values={draft.availableDays.map(String)}
            onChange={(values) =>
              patch({ availableDays: values.map(Number).sort() as Weekday[] })
            }
            options={([1, 2, 3, 4, 5, 6, 7] as Weekday[]).map((d) => ({
              value: String(d),
              label: WEEKDAY_LABELS[d],
            }))}
          />
        </FieldGroup>

        <Callout title={`Plan ułoży ${sessionsLabel(plannedWeeklySessions(draft))} w tygodniu`}>
          {fixedLayoutApplies(draft)
            ? 'Zaznaczone dni obejmują stały rozkład: poniedziałek bieganie, wtorek ' +
              'i czwartek siłownia, sobota basen. Tak wygląda tydzień, dopóki te ' +
              'cztery dni są dostępne, a sprzęt obejmuje siłownię, bieganie i basen.'
            : 'Liczba wynika z Twojego poziomu aktywności i doświadczenia — nie pytamy ' +
              'o nią osobno, żeby nie mogła rozjechać się z resztą profilu. Przy dostępie ' +
              'do biegania i basenu obie dyscypliny wchodzą w każdym tygodniu, a siłownia ' +
              'dostaje najwyżej dwie sesje.'}
        </Callout>

        <FieldGroup
          label="Na co nacisk"
          hint="Rozkład objętości między górą i dołem ciała. Ćwiczenia są te same — zmienia się, ile ich przypada na którą partię."
        >
          <ChipRadio<TrainingEmphasis>
            value={draft.emphasis}
            onChange={(emphasis) => patch({ emphasis })}
            options={entriesOf(EMPHASIS_LABELS).map(([value, label]) => ({
              value,
              label,
              hint: EMPHASIS_HINTS[value],
            }))}
          />
        </FieldGroup>

        <FieldGroup
          label="Czas jednej sesji"
          hint="45 vs 90 minut to zupełnie inny plan przy tych samych dniach."
        >
          <ChipRadio<string>
            columns={2}
            value={String(draft.sessionMinutes)}
            onChange={(v) => patch({ sessionMinutes: Number(v) })}
            options={[
              { value: '30', label: '30 min' },
              { value: '45', label: '45 min' },
              { value: '60', label: '60 min' },
              { value: '90', label: '90 min' },
            ]}
          />
        </FieldGroup>
      </div>
    </>
  )
}

function StepCardio({ draft, patch }: StepProps) {
  const hasRunning = draft.equipment.includes('running')
  const hasPool = draft.equipment.includes('pool')

  return (
    <>
      <SectionTitle hint="Od tego zależą dystanse i tempo w planie. Bez tych danych generator zgaduje z trzech sztywnych presetów — a dwie osoby o tym samym doświadczeniu mogą różnić się o dwie minuty na kilometrze.">
        Punkt wyjścia
      </SectionTitle>

      <div className="grid gap-4">
        {hasRunning && (
          <>
            <Field
              label="Ile przebiegasz bez zatrzymywania się"
              hint="Nie rekord — dystans, który dajesz spokojnie dziś."
            >
              <NumberInput
                value={draft.runDistanceKm}
                onChange={(runDistanceKm) => patch({ runDistanceKm })}
                min={0.5}
                max={60}
                step={0.5}
                suffix="km"
              />
            </Field>

            <Field
              label="W jakim tempie"
              hint="Minuty i sekundy na kilometr. Bieg spokojny w planie będzie o pół minuty wolniejszy, interwały o pół minuty szybsze."
            >
              <div className="grid grid-cols-2 gap-2">
                <NumberInput
                  value={draft.runPaceMin}
                  onChange={(runPaceMin) => patch({ runPaceMin })}
                  min={2}
                  max={15}
                  suffix="min"
                />
                <NumberInput
                  value={draft.runPaceSec}
                  onChange={(runPaceSec) => patch({ runPaceSec })}
                  min={0}
                  max={59}
                  suffix="s"
                  placeholder="0"
                />
              </div>
            </Field>
          </>
        )}

        {hasPool && (
          <>
            <FieldGroup label="Długość basenu">
              <ChipRadio<string>
                columns={2}
                value={String(draft.swimPoolLengthM)}
                onChange={(v) => patch({ swimPoolLengthM: Number(v) as 25 | 50 })}
                options={[
                  { value: '25', label: '25 m' },
                  { value: '50', label: '50 m' },
                ]}
              />
            </FieldGroup>

            <Field
              label="Ile długości przepływasz bez przerwy"
              hint={`Przy basenie ${draft.swimPoolLengthM} m to ${
                (draft.swimLaps ?? 0) * draft.swimPoolLengthM
              } m ciągiem.`}
            >
              <NumberInput
                value={draft.swimLaps}
                onChange={(swimLaps) => patch({ swimLaps })}
                min={1}
                max={200}
                suffix="dł."
              />
            </Field>

            <FieldGroup label="Jakim stylem" hint="Ten styl trafi do planu.">
              <ChipRadio<SwimStroke>
                columns={2}
                value={draft.swimStroke}
                onChange={(swimStroke) => patch({ swimStroke })}
                options={optionsFrom(SWIM_STROKE_LABELS)}
              />
            </FieldGroup>
          </>
        )}
      </div>
    </>
  )
}

function StepInjuries({ draft, patch }: StepProps) {
  return (
    <>
      <SectionTitle hint="Zaznaczone okolice wykluczą ćwiczenia obciążające dany staw. Możesz to zmienić później.">
        Kontuzje i ograniczenia
      </SectionTitle>

      <ChipMulti<Injury>
        values={draft.injuries}
        onChange={(injuries) => patch({ injuries })}
        options={optionsFrom(INJURY_LABELS)}
      />

      {draft.injuries.length === 0 && (
        <p className="mt-4 text-sm text-[var(--color-text-dim)]">
          Nic nie zaznaczone — plan nie będzie miał ograniczeń ruchowych.
        </p>
      )}
    </>
  )
}

function StepDiet({ draft, patch }: StepProps) {
  return (
    <>
      <SectionTitle hint="Alergeny i wykluczenia to twardy filtr generatora diety — bez nich jadłospis byłby nie do zjedzenia.">
        Dieta i gotowanie
      </SectionTitle>

      <div className="grid gap-4">
        <FieldGroup label="Styl diety">
          <ChipRadio<DietStyle>
            columns={2}
            value={draft.dietStyle}
            onChange={(dietStyle) => patch({ dietStyle })}
            options={optionsFrom(DIET_STYLE_LABELS)}
          />
        </FieldGroup>

        <FieldGroup
          label="Alergie i nietolerancje"
          hint="Alergeny wyliczamy z NAZW SKŁADNIKÓW przepisów — arkusz ich nie deklaruje. Traktuj to jako filtr wygody, nie gwarancję medyczną: przy poważnej alergii sprawdź skład przepisu."
        >
          <ChipMulti<Allergen>
            values={draft.allergens}
            onChange={(allergens) => patch({ allergens })}
            options={optionsFrom(ALLERGEN_LABELS)}
          />
        </FieldGroup>

        <Field
          label="Czego nie jesz"
          hint="Po przecinku, np. brokuły, wątróbka, tofu. To nie alergia — po prostu tego nie lubisz."
        >
          <TextInput
            value={draft.dislikedRaw}
            onChange={(dislikedRaw) => patch({ dislikedRaw })}
            placeholder="brokuły, wątróbka"
          />
        </Field>

        <FieldGroup label="Styl gotowania">
          <ChipRadio<PrepStyle>
            value={draft.prepStyle}
            onChange={(prepStyle) => patch({ prepStyle })}
            options={optionsFrom(PREP_STYLE_LABELS)}
          />
        </FieldGroup>

        <FieldGroup label="Czas na gotowanie w dzień powszedni">
          <ChipRadio<string>
            columns={2}
            value={String(draft.cookingMinutes)}
            onChange={(v) => patch({ cookingMinutes: Number(v) })}
            options={[
              { value: '15', label: 'do 15 min' },
              { value: '30', label: 'do 30 min' },
              { value: '45', label: 'do 45 min' },
              { value: '90', label: 'bez limitu' },
            ]}
          />
        </FieldGroup>
      </div>
    </>
  )
}

function StepSummary({
  draft,
  patch,
  preview,
}: StepProps & { preview: ReturnType<typeof nutritionTargets> | null }) {
  if (!preview) {
    return (
      <Callout tone="danger" title="Brak danych">
        Wróć do kroku 1 i uzupełnij wzrost oraz wagę.
      </Callout>
    )
  }

  const { macros } = preview
  return (
    <>
      <SectionTitle hint="Wyliczenia startowe. Po 14 dniach logowania aplikacja skoryguje je Twoim realnym wydatkiem.">
        Podsumowanie
      </SectionTitle>

      <div className="grid grid-cols-2 gap-2">
        <Stat label="BMI" value={preview.bmi} hint={BMI_CATEGORY_LABELS_PL[preview.bmiCategory]} />
        <Stat
          label="BMR"
          value={preview.bmr}
          unit="kcal"
          hint={preview.bmrFormula === 'katch' ? 'Katch-McArdle' : 'Mifflin-St Jeor'}
        />
        <Stat label="TDEE" value={preview.tdee} unit="kcal" hint="wydatek szacowany" />
        <Stat label="Cel" value={preview.kcal} unit="kcal" hint="dzienny" />
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2">
        <Stat label="Białko" value={macros.proteinG} unit="g" />
        <Stat label="Tłuszcz" value={macros.fatG} unit="g" />
        <Stat label="Węgle" value={macros.carbsG} unit="g" />
      </div>

      {preview.warnings.length > 0 && (
        <div className="mt-4 grid gap-2">
          {preview.warnings.map((w) => (
            <Callout key={w.code} tone={w.code === 'underweightNoDeficit' ? 'danger' : 'warn'}>
              {w.message}
            </Callout>
          ))}
        </div>
      )}

      <div className="mt-4">
        <Field
          label="Nadpisz cel kaloryczny"
          hint="Zostaw puste, żeby liczyć automatycznie. Minimum bezpieczeństwa obowiązuje zawsze."
        >
          <NumberInput
            value={draft.kcalOverride}
            onChange={(kcalOverride) => patch({ kcalOverride })}
            min={1000}
            max={6000}
            step={50}
            suffix="kcal"
            placeholder={String(preview.kcal)}
          />
        </Field>
      </div>
    </>
  )
}

// ────────────────────────────────────────────────────────── Pomocnicze

function validateStep(step: StepId, d: Draft): string[] {
  const errors: string[] = []
  switch (step) {
    case 'basics':
      if (!d.name.trim()) errors.push('Podaj imię.')
      if (!d.birthYear || d.birthYear < 1920 || d.birthYear > new Date().getFullYear() - 12)
        errors.push('Podaj prawidłowy rok urodzenia.')
      if (!d.heightCm || d.heightCm < 120 || d.heightCm > 230) errors.push('Podaj wzrost w cm.')
      if (!d.startWeightKg || d.startWeightKg < 35 || d.startWeightKg > 300)
        errors.push('Podaj wagę w kg.')
      if (d.bodyFatPct != null && (d.bodyFatPct < 3 || d.bodyFatPct > 60))
        errors.push('Procent tkanki tłuszczowej musi być w zakresie 3–60%.')
      break
    case 'goal':
      if (d.goal === 'event' && !d.eventDate) errors.push('Podaj datę zawodów.')
      break
    case 'cardio': {
      if (d.equipment.includes('running')) {
        if (!d.runDistanceKm || d.runDistanceKm <= 0) {
          errors.push('Podaj dystans, jaki obecnie przebiegasz.')
        }
        if (!d.runPaceMin || d.runPaceMin < 2 || d.runPaceMin > 15) {
          errors.push('Podaj tempo biegu w minutach na kilometr (2–15).')
        }
      }
      if (d.equipment.includes('pool') && (!d.swimLaps || d.swimLaps <= 0)) {
        errors.push('Podaj, ile długości basenu przepływasz bez przerwy.')
      }
      break
    }
    case 'training':
      if (d.equipment.length === 0) errors.push('Wybierz przynajmniej jeden rodzaj sprzętu.')
      if (d.availableDays.length < 2) errors.push('Wybierz co najmniej dwa dni treningowe.')
      break
    default:
      break
  }
  return errors
}

/** Buduje pełny profil z draftu. Zwraca null, gdy dane podstawowe są niekompletne. */
function draftToProfile(d: Draft): Profile | null {
  if (!d.birthYear || !d.heightCm || !d.startWeightKg) return null
  const now = new Date().toISOString()

  return {
    id: 'preview',
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    name: d.name.trim(),
    birthYear: d.birthYear,
    sex: d.sex,
    heightCm: d.heightCm,
    startWeightKg: d.startWeightKg,
    bodyFatPct: d.bodyFatPct ?? undefined,
    goal: d.goal,
    eventDate: d.goal === 'event' && d.eventDate ? d.eventDate : undefined,
    activityLevel: d.activityLevel,
    experience: d.experience,
    equipment: d.equipment,
    availableDays: d.availableDays,
    emphasis: d.emphasis,
    sessionMinutes: d.sessionMinutes,
    // Punkt wyjścia zapisujemy tylko dla dyscyplin, które użytkownik ma
    // dostępne — inaczej plan opierałby się na danych, których nie podała.
    runBaseline:
      d.equipment.includes('running') && d.runDistanceKm && d.runPaceMin
        ? {
            distanceM: Math.round(d.runDistanceKm * 1000),
            paceSecPerKm: d.runPaceMin * 60 + (d.runPaceSec ?? 0),
          }
        : undefined,
    swimBaseline:
      d.equipment.includes('pool') && d.swimLaps
        ? {
            laps: d.swimLaps,
            poolLengthM: d.swimPoolLengthM,
            stroke: d.swimStroke,
          }
        : undefined,
    diet: {
      style: d.dietStyle,
      allergens: d.allergens,
      dislikedTags: d.dislikedRaw
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
      excludedProductIds: [],
    },
    cooking: { weekdayMinutes: d.cookingMinutes, prepStyle: d.prepStyle },
    injuries: d.injuries,
    mealSplit: DEFAULT_MEAL_SPLIT,
    kcalOverride: d.kcalOverride,
  }
}
