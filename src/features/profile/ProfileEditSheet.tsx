import { useState } from 'react'
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
  SwimStroke,
  TrainingEmphasis,
  Weekday,
} from '@/domain/types'
import { todayIso } from '@/domain/dates'
import { nutritionTargets } from '@/domain/calc'
import { KCAL_PRESETS } from '@/data/presetProfile'
import { fixedLayoutApplies, plannedWeeklySessions } from '@/domain/training/schedule'
import { sessionsLabel } from '@/lib/format'
import { profileRepo } from '@/db/repositories'
import { resyncPlan, type ResyncSummary } from '@/db/planRepo'
import { dietRepo } from '@/db/dietRepo'
import { shoppingRepo } from '@/db/shoppingRepo'
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
import {
  Button,
  Callout,
  ChipMulti,
  ChipRadio,
  DateInput,
  Field,
  FieldGroup,
  NumberInput,
  Sheet,
} from '@/components/ui'

/**
 * Edycja profilu po jego utworzeniu.
 *
 * Nie edytujemy tu imienia, rocznika i płci — te się nie zmieniają, a ich
 * obecność w formularzu tylko rozprasza.
 *
 * Masa odniesienia JEST tu edytowalna i to jest zmiana względem pierwotnego
 * założenia. Skoro codzienne ważenie nie rusza wyliczeń (patrz `useTargets`),
 * to musi istnieć miejsce, w którym podnosi się je świadomie — inaczej po
 * pięciu kilogramach w dół cel kaloryczny dotyczyłby osoby, której już nie ma.
 * Jedna zmiana w kontrolowanym momencie zamiast dryfu przy każdym wejściu
 * na wagę.
 */
export interface ResyncResult {
  plan?: ResyncSummary | undefined
  diet?: { updatedDays: string[]; keptLoggedDays: string[]; affectedWeeks: string[] } | undefined
}

export function ProfileEditSheet({
  profile,
  open,
  onClose,
  onSaved,
}: {
  profile: Profile
  open: boolean
  onClose: () => void
  onSaved: (result: ResyncResult) => void
}) {
  const [draft, setDraft] = useState(() => toDraft(profile))
  const [busy, setBusy] = useState(false)
  /**
   * Błąd zapisu, w odróżnieniu od błędów walidacji.
   *
   * `resyncPlan` potrafi rzucić `MissingPlanInputsError`, a zapis do IndexedDB
   * może się nie udać. Wcześniej `try/finally` bez `catch` zjadał to po cichu:
   * arkusz zostawał otwarty, nic się nie działo i nie było jak zgadnąć dlaczego.
   */
  const [saveError, setSaveError] = useState<string | null>(null)

  function patch(update: Partial<ReturnType<typeof toDraft>>) {
    setDraft((d) => ({ ...d, ...update }))
  }

  const errors: string[] = []
  if (draft.goal === 'event' && !draft.eventDate) errors.push('Podaj datę zawodów.')
  if (draft.equipment.length === 0) errors.push('Wybierz przynajmniej jeden rodzaj sprzętu.')
  if (draft.availableDays.length < 2) errors.push('Wybierz co najmniej dwa dni treningowe.')
  if (!draft.heightCm || draft.heightCm < 120 || draft.heightCm > 230)
    errors.push('Podaj prawidłowy wzrost.')
  if (!draft.startWeightKg || draft.startWeightKg < 35 || draft.startWeightKg > 300)
    errors.push('Podaj prawidłową masę odniesienia.')
  /**
   * Punkt wyjścia w cardio jest WARUNKIEM zapisu, nie polem opcjonalnym.
   *
   * Bez tego dałoby się zaznaczyć basen, zostawić puste długości i zapisać —
   * a wtedy plan przestaje się tworzyć (patrz `missingPlanInputs`) i wygląda to
   * jak awaria aplikacji, nie jak brak danych. Blokujemy tu, u źródła.
   */
  if (draft.equipment.includes('running') && (!draft.runDistanceKm || !draft.runPaceMin))
    errors.push('Podaj maksymalny dystans biegu i tempo — bez nich plan się nie utworzy.')
  if (draft.equipment.includes('pool') && !draft.swimLaps)
    errors.push('Podaj maksymalną liczbę długości basenu — bez niej plan się nie utworzy.')

  async function save() {
    if (errors.length > 0) return
    setBusy(true)
    setSaveError(null)
    try {
      const planStale = affectsPlan(profile, draft)
      const dietStale = affectsDiet(profile, draft)

      const updated = await profileRepo.patch({
        goal: draft.goal,
        eventDate: draft.goal === 'event' ? draft.eventDate : undefined,
        activityLevel: draft.activityLevel,
        experience: draft.experience,
        equipment: draft.equipment,
        availableDays: [...draft.availableDays].sort((a, b) => a - b),
        emphasis: draft.emphasis,
        sessionMinutes: draft.sessionMinutes,
        runBaseline:
          draft.equipment.includes('running') && draft.runDistanceKm && draft.runPaceMin
            ? {
                distanceM: Math.round(draft.runDistanceKm * 1000),
                paceSecPerKm: draft.runPaceMin * 60 + (draft.runPaceSec ?? 0),
              }
            : undefined,
        swimBaseline:
          draft.equipment.includes('pool') && draft.swimLaps
            ? {
                laps: draft.swimLaps,
                poolLengthM: draft.swimPoolLengthM,
                stroke: draft.swimStroke,
              }
            : undefined,
        injuries: draft.injuries,
        heightCm: draft.heightCm as number,
        startWeightKg: draft.startWeightKg as number,
        bodyFatPct: draft.bodyFatPct ?? undefined,
        diet: {
          style: draft.dietStyle,
          allergens: draft.allergens,
          dislikedTags: draft.dislikedRaw
            .split(',')
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean),
          excludedProductIds: profile.diet.excludedProductIds,
        },
        cooking: { weekdayMinutes: draft.cookingMinutes, prepStyle: draft.prepStyle },
        kcalOverride: draft.kcalOverride,
      })

      /**
       * Dopasowanie planu jest AUTOMATYCZNE, nie proponowane przyciskiem.
       *
       * Wcześniej zapis ustawiał tylko flagę „plan nieaktualny" i czekał, aż
       * użytkownik kliknie regenerację. To zostawiało ją z planem, o którym
       * aplikacja wiedziała, że jest zły. Teraz przeliczamy od razu — nietknięte
       * zostają sesje z przeszłości i te, które już zalogowała.
       */
      const today = todayIso()
      const result: ResyncResult = {}

      if (updated && planStale) {
        result.plan = (await resyncPlan(updated, today)) ?? undefined
      }
      if (updated && dietStale) {
        const targets = nutritionTargets(updated, updated.startWeightKg).macros
        const diet = await dietRepo.resyncFromDate(updated, today, targets)
        result.diet = diet
        // Jadłospis się zmienił, więc listy zakupów przestały mu odpowiadać.
        // `rebuildIfExists`, nie `build`: zmiana profilu nie ma prawa TWORZYĆ
        // listy zakupów na tygodnie, dla których nikt jej nie zbudował.
        for (const week of diet.affectedWeeks) await shoppingRepo.rebuildIfExists(week)
      }

      onSaved(result)
      onClose()
    } catch (cause) {
      setSaveError(
        cause instanceof Error
          ? `Nie udało się zapisać profilu: ${cause.message}`
          : 'Nie udało się zapisać profilu.',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet open={open} title="Zmień profil" onClose={onClose}>
      <div className="grid gap-4">
        <FieldGroup label="Cel">
          <ChipRadio<Goal>
            value={draft.goal}
            onChange={(goal) => patch({ goal })}
            options={entriesOf(GOAL_LABELS).map(([value, label]) => ({
              value,
              label,
              hint: GOAL_HINTS[value],
            }))}
          />
        </FieldGroup>

        {draft.goal === 'event' && (
          <Field label="Data zawodów" hint="Plan zostanie policzony wstecz od tej daty.">
            <DateInput
              value={draft.eventDate}
              onChange={(eventDate) => patch({ eventDate })}
              min={todayIso()}
            />
          </Field>
        )}

        <FieldGroup label="Poziom aktywności">
          <ChipRadio<ActivityLevel>
            value={draft.activityLevel}
            onChange={(activityLevel) => patch({ activityLevel })}
            options={activityOptions()}
          />
        </FieldGroup>

        <FieldGroup label="Doświadczenie">
          <ChipRadio<Experience>
            value={draft.experience}
            onChange={(experience) => patch({ experience })}
            options={optionsFrom(EXPERIENCE_LABELS)}
          />
        </FieldGroup>

        <FieldGroup label="Dostępny sprzęt">
          <ChipMulti<Equipment>
            values={draft.equipment}
            onChange={(equipment) => patch({ equipment })}
            options={optionsFrom(EQUIPMENT_LABELS)}
          />
        </FieldGroup>

        <FieldGroup label="Dni, w które możesz trenować">
          <ChipMulti<string>
            values={draft.availableDays.map(String)}
            onChange={(values) => patch({ availableDays: values.map(Number) as Weekday[] })}
            options={([1, 2, 3, 4, 5, 6, 7] as Weekday[]).map((d) => ({
              value: String(d),
              label: WEEKDAY_LABELS[d],
            }))}
          />
        </FieldGroup>

        <Callout title={`Plan ułoży ${sessionsLabel(plannedWeeklySessions(draft))} w tygodniu`}>
          {fixedLayoutApplies(draft)
            ? 'Dni są ustalone: poniedziałek bieganie, wtorek i czwartek siłownia, ' +
              'sobota basen. Odznaczenie któregoś z nich przełącza plan na rozstawianie ' +
              'sesji z poziomu aktywności i doświadczenia.'
            : 'Liczba wynika z poziomu aktywności i doświadczenia. Siłownia dostaje ' +
              'najwyżej dwie sesje, żeby bieganie i basen weszły w każdym tygodniu.'}
        </Callout>

        <FieldGroup label="Na co nacisk" hint="Rozkład objętości między górą i dołem ciała.">
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

        <FieldGroup label="Czas jednej sesji">
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

        {draft.equipment.includes('running') && (
          <>
            <Field
              label="Maksymalny dystans biegu bez zatrzymywania się"
              hint="Wymagane. Plan startuje od tej wartości i podnosi ją z tego, co zalogujesz."
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
            <Field label="W jakim tempie" hint="Wymagane. Minuty i sekundy na kilometr.">
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

        {draft.equipment.includes('pool') && (
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
              label="Maksymalna liczba długości bez przerwy"
              hint={
                draft.swimLaps
                  ? `Wymagane. To ${draft.swimLaps * draft.swimPoolLengthM} m ciągiem.`
                  : 'Wymagane — bez tego plan się nie utworzy.'
              }
            >
              <NumberInput
                value={draft.swimLaps}
                onChange={(swimLaps) => patch({ swimLaps })}
                min={1}
                max={200}
                suffix="dł."
              />
            </Field>
            <FieldGroup label="Jakim stylem">
              <ChipRadio<SwimStroke>
                columns={2}
                value={draft.swimStroke}
                onChange={(swimStroke) => patch({ swimStroke })}
                options={optionsFrom(SWIM_STROKE_LABELS)}
              />
            </FieldGroup>
          </>
        )}

        <FieldGroup label="Kontuzje i ograniczenia">
          <ChipMulti<Injury>
            values={draft.injuries}
            onChange={(injuries) => patch({ injuries })}
            options={optionsFrom(INJURY_LABELS)}
          />
        </FieldGroup>

        <Field
          label="Masa odniesienia"
          hint="Od tej wartości liczą się kalorie i makro. Codzienne ważenie jej NIE zmienia — podnieś ją albo obniż, gdy trend przesunie się na tyle, że warto przeliczyć jadłospis."
        >
          <NumberInput
            value={draft.startWeightKg}
            onChange={(startWeightKg) => patch({ startWeightKg })}
            min={35}
            max={300}
            step={0.1}
            suffix="kg"
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Wzrost">
            <NumberInput
              value={draft.heightCm}
              onChange={(heightCm) => patch({ heightCm })}
              min={120}
              max={230}
              suffix="cm"
            />
          </Field>
          <Field label="Tkanka tłuszczowa" hint="Opcjonalnie">
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

        <Field label="Czego nie jesz" hint="Po przecinku.">
          <input
            className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2.5 outline-none focus:border-[var(--color-accent)]"
            value={draft.dislikedRaw}
            onChange={(e) => patch({ dislikedRaw: e.target.value })}
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

        <FieldGroup label="Cel kaloryczny">
          {/*
            Dwa presety plus wyliczanie automatyczne — te same trzy opcje, co na
            ekranie startowym. Chipy nie zastępują pola poniżej, tylko dają
            jedno kliknięcie na wartości, pod które NAPRAWDĘ jest napisana baza
            przepisów; wpisanie 2730 nadal jest możliwe i nadal działa, po prostu
            porcje dobiją bliżej granicy skalowania.
          */}
          <ChipRadio<string>
            columns={3}
            value={draft.kcalOverride === null ? 'auto' : String(draft.kcalOverride)}
            onChange={(value) =>
              patch({ kcalOverride: value === 'auto' ? null : Number(value) })
            }
            options={[
              ...KCAL_PRESETS.map((kcal) => ({ value: String(kcal), label: `${kcal} kcal` })),
              { value: 'auto', label: 'automatycznie' },
            ]}
          />
        </FieldGroup>

        <Field
          label="…albo wpisz własną wartość"
          hint="Zostaw puste, żeby liczyć automatycznie. Minimum bezpieczeństwa obowiązuje zawsze. Baza przepisów trafia najlepiej w 2500 i 3000 kcal."
        >
          <NumberInput
            value={draft.kcalOverride}
            onChange={(kcalOverride) => patch({ kcalOverride })}
            min={1000}
            max={6000}
            step={50}
            suffix="kcal"
            placeholder="automatycznie"
          />
        </Field>

        {saveError && <Callout tone="warn">{saveError}</Callout>}

        {errors.length > 0 && (
          <Callout tone="warn" title="Popraw dane">
            <ul className="list-disc pl-4">
              {errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </Callout>
        )}

        <Button onClick={save} disabled={errors.length > 0 || busy} className="w-full">
          {busy ? 'Zapisywanie…' : 'Zapisz zmiany'}
        </Button>
      </div>
    </Sheet>
  )
}

type Draft = ReturnType<typeof toDraft>

function toDraft(profile: Profile) {
  return {
    goal: profile.goal,
    eventDate: profile.eventDate ?? '',
    activityLevel: profile.activityLevel,
    experience: profile.experience,
    equipment: [...profile.equipment],
    availableDays: [...profile.availableDays],
    emphasis: profile.emphasis,
    sessionMinutes: profile.sessionMinutes,
    runDistanceKm: profile.runBaseline ? profile.runBaseline.distanceM / 1000 : null,
    runPaceMin: profile.runBaseline ? Math.floor(profile.runBaseline.paceSecPerKm / 60) : null,
    runPaceSec: profile.runBaseline ? profile.runBaseline.paceSecPerKm % 60 : null,
    swimLaps: profile.swimBaseline?.laps ?? null,
    swimPoolLengthM: profile.swimBaseline?.poolLengthM ?? (25 as 25 | 50),
    swimStroke: profile.swimBaseline?.stroke ?? ('any' as SwimStroke),
    injuries: [...profile.injuries],
    heightCm: profile.heightCm as number | null,
    startWeightKg: profile.startWeightKg as number | null,
    bodyFatPct: profile.bodyFatPct ?? null,
    dietStyle: profile.diet.style,
    allergens: [...profile.diet.allergens],
    dislikedRaw: profile.diet.dislikedTags.join(', '),
    prepStyle: profile.cooking.prepStyle,
    cookingMinutes: profile.cooking.weekdayMinutes,
    kcalOverride: profile.kcalOverride ?? null,
  }
}

/** Które zmiany unieważniają istniejący plan treningowy. */
function affectsPlan(profile: Profile, draft: Draft): boolean {
  return (
    profile.goal !== draft.goal ||
    profile.experience !== draft.experience ||
    profile.sessionMinutes !== draft.sessionMinutes ||
    profile.emphasis !== draft.emphasis ||
    (profile.eventDate ?? '') !== draft.eventDate ||
    !sameSet(profile.equipment, draft.equipment) ||
    !sameSet(profile.injuries, draft.injuries) ||
    !sameSet(profile.availableDays.map(String), draft.availableDays.map(String)) ||
    // Punkt wyjścia w cardio przelicza dystanse i tempo w niewykonanych sesjach.
    (profile.runBaseline?.distanceM ?? null) !==
      (draft.runDistanceKm === null ? null : Math.round(draft.runDistanceKm * 1000)) ||
    (profile.runBaseline?.paceSecPerKm ?? null) !==
      (draft.runPaceMin === null ? null : draft.runPaceMin * 60 + (draft.runPaceSec ?? 0)) ||
    (profile.swimBaseline?.laps ?? null) !== draft.swimLaps ||
    (profile.swimBaseline?.poolLengthM ?? 25) !== draft.swimPoolLengthM ||
    (profile.swimBaseline?.stroke ?? 'any') !== draft.swimStroke
  )
}

/** Które zmiany unieważniają istniejący jadłospis. */
function affectsDiet(profile: Profile, draft: Draft): boolean {
  return (
    profile.goal !== draft.goal ||
    profile.activityLevel !== draft.activityLevel ||
    profile.heightCm !== draft.heightCm ||
    // Masa odniesienia zmienia cel kaloryczny, a więc i gramatury.
    profile.startWeightKg !== draft.startWeightKg ||
    (profile.bodyFatPct ?? null) !== draft.bodyFatPct ||
    (profile.kcalOverride ?? null) !== draft.kcalOverride ||
    profile.diet.style !== draft.dietStyle ||
    profile.cooking.weekdayMinutes !== draft.cookingMinutes ||
    !sameSet(profile.diet.allergens, draft.allergens) ||
    profile.diet.dislikedTags.join(',') !==
      draft.dislikedRaw
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
        .join(',')
  )
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const setB = new Set(b)
  return a.every((item) => setB.has(item))
}
