import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { bmi, bmiCategory, nutritionTargets } from '@/domain/calc'
import { BMI_CATEGORY_LABELS_PL } from '@/domain/calc/bmi'
import {
  FIXED_WEEK_LAYOUT,
  plannedWeeklySessions,
  type WeekLayoutDay,
} from '@/domain/training/schedule'
import { DEFAULT_PLAN_WEEKS } from '@/domain/training/planGenerator'
import { todayIso } from '@/domain/dates'
import {
  DEFAULT_KCAL_PRESET,
  KCAL_PRESETS,
  PRESET_PROFILE,
  type KcalPreset,
} from '@/data/presetProfile'
import { profileRepo, weightRepo } from '@/db/repositories'
import {
  EQUIPMENT_LABELS,
  EXPERIENCE_LABELS,
  GOAL_LABELS,
  EMPHASIS_LABELS,
  WEEKDAY_LABELS,
} from '@/lib/labels'
import { formatPace, sessionsLabel, weeksLabel } from '@/lib/format'

/**
 * Nazwy dyscyplin w wierszu „Dni" — krótsze niż `SESSION_TYPE_LABELS`.
 *
 * „pon bieganie, wt siłownia" mieści się w jednej linii na telefonie,
 * „pon Trening siłowy, wt Trening siłowy" już nie. Ta lista jest wyłącznie
 * o brzmieniu w tym jednym miejscu, dlatego żyje tutaj, a nie w `lib/labels`.
 */
const LAYOUT_TYPE_LABELS: Record<WeekLayoutDay['type'], string> = {
  strength: 'siłownia',
  run: 'bieganie',
  swim: 'basen',
}
import {
  Button,
  Callout,
  Card,
  Field,
  FieldGroup,
  ChipRadio,
  NumberInput,
  SectionTitle,
  Stat,
} from '@/components/ui'
import { Screen, ScreenHeader } from '@/app/AppShell'

/**
 * Ekran startowy dla wersji z gotowym profilem.
 *
 * Pyta o to, czego nie da się ustalić bez człowieka, i o nic więcej. Reszta
 * jest w `PRESET_PROFILE`.
 *
 *  1. **Waga, wzrost i rocznik** — od nich zależą BMI, BMR, TDEE i makra.
 *     Waga trafia w DWA miejsca: do profilu jako masa odniesienia i do pomiarów
 *     jako pierwszy wpis; bez drugiego wykres masy startowałby pusty. Wzrost
 *     nie jest kosmetyką: `referenceWeightKg` liczy z niego masę, od której
 *     idzie białko i podłoga tłuszczu.
 *  2. **Cel kaloryczny** — 2500 albo 3000, czyli kaloryczności, pod które jest
 *     napisana baza przepisów. Do wyboru jest też wyliczenie automatyczne, ale
 *     nie jest domyślne: baza trafia w te dwie liczby, a nie w dowolną.
 *  3. **Maksymalny dystans biegu i tempo.**
 *  4. **Maksymalna liczba długości basenu.**
 *
 * Punkty 3 i 4 mogłyby być opcjonalne, z presetem dla poziomu doświadczenia.
 * To najgorszy możliwy wariant: plan wygląda wiarygodnie i dotyczy kogoś innego
 * — dwie osoby „średniozaawansowane" mogą różnić się o dwie minuty na
 * kilometrze. Bez tych danych plan się nie tworzy, więc pytamy o nie od razu,
 * a nie po pierwszym nieudanym generowaniu.
 */
export function QuickStartScreen() {
  const navigate = useNavigate()
  const [weightKg, setWeightKg] = useState<number | null>(null)
  const [heightCm, setHeightCm] = useState<number | null>(null)
  const [birthYear, setBirthYear] = useState<number | null>(null)
  const [kcalPreset, setKcalPreset] = useState<KcalPreset | 'auto'>(DEFAULT_KCAL_PRESET)
  const [runKm, setRunKm] = useState<number | null>(null)
  const [paceMin, setPaceMin] = useState<number | null>(null)
  const [paceSec, setPaceSec] = useState<number | null>(null)
  const [poolLengthM, setPoolLengthM] = useState<25 | 50>(25)
  const [laps, setLaps] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)

  const thisYear = new Date().getFullYear()
  const weightOk = weightKg !== null && weightKg >= 35 && weightKg <= 300
  const heightOk = heightCm !== null && heightCm >= 120 && heightCm <= 230
  const birthYearOk = birthYear !== null && birthYear >= 1930 && birthYear <= thisYear - 12
  const bodyOk = weightOk && heightOk && birthYearOk
  const runOk = runKm !== null && runKm > 0 && paceMin !== null && paceMin >= 2
  const swimOk = laps !== null && laps > 0
  const valid = bodyOk && runOk && swimOk

  const missing = [
    weightOk ? null : 'wagę',
    heightOk ? null : 'wzrost',
    birthYearOk ? null : 'rocznik',
    runOk ? null : 'dystans biegu i tempo',
    swimOk ? null : 'liczbę długości basenu',
  ].filter((item): item is string => item !== null)

  const kcalOverride = kcalPreset === 'auto' ? null : kcalPreset

  const preview = bodyOk
    ? nutritionTargets(
        {
          ...PRESET_PROFILE,
          id: 'preview',
          createdAt: '',
          updatedAt: '',
          startWeightKg: weightKg,
          heightCm,
          birthYear,
          kcalOverride,
        },
        weightKg,
      )
    : null

  const paceSecPerKm = (paceMin ?? 0) * 60 + (paceSec ?? 0)

  async function start() {
    if (!valid || weightKg === null || heightCm === null || birthYear === null) return
    if (runKm === null || laps === null) return
    setSaving(true)
    setFailed(null)
    try {
      await profileRepo.save({
        ...PRESET_PROFILE,
        startWeightKg: weightKg,
        heightCm,
        birthYear,
        kcalOverride,
        runBaseline: { distanceM: Math.round(runKm * 1000), paceSecPerKm },
        swimBaseline: { laps, poolLengthM, stroke: 'any' },
      })
      await weightRepo.upsert(todayIso(), weightKg)
      navigate('/', { replace: true })
    } catch (cause) {
      /**
       * To najgorsze możliwe miejsce na cichy błąd: bez profilu aplikacja nie
       * wpuszcza dalej niż ten ekran. Nieudany zapis bez komunikatu zostawiał
       * człowieka przy wypełnionym formularzu i przycisku, który „nic nie robi".
       */
      setFailed(
        cause instanceof Error
          ? `Nie udało się zapisać profilu: ${cause.message}`
          : 'Nie udało się zapisać profilu.',
      )
    } finally {
      setSaving(false)
    }
  }

  /**
   * Liczbę sesji bierzemy ze STAŁEGO UKŁADU, gdy preset go unosi.
   *
   * Wyliczenie z aktywności i doświadczenia opisywałoby plan, którego nie będzie:
   * dni presetu są podane wprost (pon bieg, wt i czw siłownia, sob basen), więc
   * to one decydują, ile treningów ma tydzień.
   */
  const sessions = plannedWeeklySessions(PRESET_PROFILE)
  const trainingDays = FIXED_WEEK_LAYOUT.map(
    (day) => `${WEEKDAY_LABELS[day.dayOfWeek].toLowerCase()} ${LAYOUT_TYPE_LABELS[day.type]}`,
  ).join(', ')

  return (
    <div className="mx-auto flex min-h-full max-w-lg flex-col">
      <Screen>
        <ScreenHeader title={`Cześć, ${PRESET_PROFILE.name}`} subtitle="Zostały cztery pytania." />

        <Card>
          <SectionTitle hint="Bez tych trzech liczb nie da się policzyć zapotrzebowania ani ułożyć jadłospisu — dlatego aplikacja ich nie zgaduje.">
            Podstawowe dane
          </SectionTitle>

          <div className="grid gap-4">
            <Field
              label="Waga"
              hint="Zapisze się też jako pierwszy pomiar na dziś. Kolejne ważenia nie zmienią wyliczeń — to robi się świadomie w Profilu."
            >
              <NumberInput
                value={weightKg}
                onChange={setWeightKg}
                min={35}
                max={300}
                step={0.1}
                suffix="kg"
              />
            </Field>

            <Field
              label="Wzrost"
              hint="Wchodzi do BMI i do masy odniesienia, z której liczy się białko i minimum tłuszczu."
            >
              <NumberInput value={heightCm} onChange={setHeightCm} min={120} max={230} suffix="cm" />
            </Field>

            <Field label="Rocznik" hint="Wiek wchodzi do wzoru na przemianę spoczynkową (BMR).">
              <NumberInput
                value={birthYear}
                onChange={setBirthYear}
                min={1930}
                max={thisYear - 12}
                placeholder="np. 1990"
              />
            </Field>
          </div>
        </Card>

        <Card>
          <SectionTitle hint="Baza przepisów jest napisana pod 2500 i 3000 kcal — przy tych dwóch celach porcje wychodzą w środku dozwolonego skalowania i dzień trafia w makra.">
            Cel kaloryczny
          </SectionTitle>

          <FieldGroup label="Ile chcesz jeść dziennie">
            <ChipRadio<string>
              columns={3}
              value={String(kcalPreset)}
              onChange={(value) =>
                setKcalPreset(value === 'auto' ? 'auto' : (Number(value) as KcalPreset))
              }
              options={[
                ...KCAL_PRESETS.map((kcal) => ({ value: String(kcal), label: `${kcal} kcal` })),
                { value: 'auto', label: 'automatycznie' },
              ]}
            />
          </FieldGroup>

          {kcalPreset === 'auto' && (
            <div className="mt-3">
              <Callout>
                Cel policzy się z wagi, wzrostu, wieku i aktywności. Gdy wypadnie daleko poza
                2500–3000 kcal, jadłospis nadal powstanie, ale porcje dobiją do granicy
                skalowania i dzień może nie trafić w cel — aplikacja powie o tym wprost przy
                jadłospisie.
              </Callout>
            </div>
          )}

          {preview && (
            <div className="mt-4 grid grid-cols-2 gap-2">
              <Stat
                label="BMI"
                value={bmi(weightKg as number, heightCm as number)}
                hint={BMI_CATEGORY_LABELS_PL[bmiCategory(bmi(weightKg as number, heightCm as number))]}
              />
              <Stat label="Cel dzienny" value={preview.kcal} unit="kcal" />
              <Stat label="Białko" value={preview.macros.proteinG} unit="g" />
              <Stat label="Tłuszcz" value={preview.macros.fatG} unit="g" />
            </div>
          )}

          {preview && preview.warnings.length > 0 && (
            <div className="mt-3 grid gap-2">
              {preview.warnings.map((warning) => (
                <Callout key={warning.code} tone="warn">
                  {warning.message}
                </Callout>
              ))}
            </div>
          )}
        </Card>

        <Card>
          <SectionTitle hint="Od tego zależą dystanse i tempo w planie. Podaj to, co dajesz dziś — nie rekord życiowy i nie cel.">
            Ile maksymalnie biegasz?
          </SectionTitle>

          <div className="grid gap-4">
            <Field
              label="Najdłuższy dystans bez zatrzymywania się"
              hint="Plan zacznie od tej wartości i podniesie ją z tego, co faktycznie zalogujesz."
            >
              <NumberInput value={runKm} onChange={setRunKm} min={0.5} max={60} step={0.5} suffix="km" />
            </Field>

            <Field
              label="W jakim tempie pokonujesz ten dystans"
              hint="Minuty i sekundy na kilometr. Bieg spokojny w planie będzie o pół minuty wolniejszy, interwały o pół minuty szybsze."
            >
              <div className="grid grid-cols-2 gap-2">
                <NumberInput value={paceMin} onChange={setPaceMin} min={2} max={15} suffix="min" />
                <NumberInput
                  value={paceSec}
                  onChange={setPaceSec}
                  min={0}
                  max={59}
                  suffix="s"
                  placeholder="0"
                />
              </div>
            </Field>

            {runOk && (
              <Callout>
                {runKm} km w tempie {formatPace(paceSecPerKm)}/km. Bieg spokojny w planie:{' '}
                {formatPace(paceSecPerKm + 30)}/km.
              </Callout>
            )}
          </div>
        </Card>

        <Card>
          <SectionTitle hint="Liczba długości, nie metrów — bez długości basenu ta sama liczba znaczy dwa razy inny dystans.">
            Ile maksymalnie przepływasz?
          </SectionTitle>

          <div className="grid gap-4">
            <FieldGroup label="Długość basenu">
              <ChipRadio<string>
                columns={2}
                value={String(poolLengthM)}
                onChange={(value) => setPoolLengthM(Number(value) as 25 | 50)}
                options={[
                  { value: '25', label: '25 m' },
                  { value: '50', label: '50 m' },
                ]}
              />
            </FieldGroup>

            <Field
              label="Maksymalna liczba długości bez przerwy"
              hint={
                swimOk
                  ? `To ${(laps as number) * poolLengthM} m ciągiem.`
                  : 'Tyle, ile przepłyniesz bez zatrzymania się na ściance.'
              }
            >
              <NumberInput value={laps} onChange={setLaps} min={1} max={200} suffix="dł." />
            </Field>
          </div>
        </Card>

        <Card>
          {!valid && (
            <div className="mb-3">
              <Callout tone="warn" title="Zostało do uzupełnienia">
                Brakuje: {missing.join(', ')}. Bez punktu wyjścia w bieganiu i pływaniu plan
                się nie utworzy — liczby z presetu dotyczyłyby kogoś innego.
              </Callout>
            </div>
          )}
          <Button onClick={start} disabled={!valid || saving} className="w-full">
            {saving ? 'Zapisywanie…' : 'Zaczynamy'}
          </Button>
          {failed && (
            <div className="mt-3">
              <Callout tone="warn">{failed}</Callout>
            </div>
          )}
        </Card>

        <Card>
          <SectionTitle hint="Wszystko poniżej możesz później zmienić w zakładce Profil — zmiany od razu przeliczą niewykonane sesje i jadłospis.">
            Reszta jest już ustawiona
          </SectionTitle>
          <dl className="grid gap-2 text-sm">
            <Row label="Cel" value={GOAL_LABELS[PRESET_PROFILE.goal]} />
            <Row label="Doświadczenie" value={EXPERIENCE_LABELS[PRESET_PROFILE.experience]} />
            <Row
              label="Treningi"
              value={`${sessionsLabel(sessions)} w tygodniu, po ${PRESET_PROFILE.sessionMinutes} min`}
            />
            {/* Dni są ustalone, więc podajemy je wprost — „4 sesje w tygodniu"
                nie mówi, że basen wypada w sobotę, a to jest część planu dnia. */}
            <Row label="Dni" value={trainingDays} />
            <Row
              label="Sprzęt"
              value={PRESET_PROFILE.equipment.map((e) => EQUIPMENT_LABELS[e]).join(', ')}
            />
            <Row label="Nacisk" value={EMPHASIS_LABELS[PRESET_PROFILE.emphasis]} />
            <Row label="Dieta" value="bez ograniczeń, gotowanie na zapas" />
            <Row label="Plan" value={`${weeksLabel(DEFAULT_PLAN_WEEKS)} do przodu`} />
          </dl>
        </Card>

        <Link to="/profil/kreator" className="block">
          <Button variant="ghost" className="w-full">
            Wolę wypełnić pełny kreator
          </Button>
        </Link>
      </Screen>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-[var(--color-text-dim)]">{label}</dt>
      <dd className="text-right">{value}</dd>
    </div>
  )
}
