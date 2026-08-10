import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import type { BodyMeasurement, BodyMetric } from '@/domain/types'
import { addDays, isoWeekday, startOfWeek, WEEK_START_DAY } from '@/domain/dates'
import {
  measurementReminderIcs,
  MEASUREMENT_HOUR,
  MEASUREMENT_WEEKS,
  type MeasurementReminder,
} from '@/domain/calendar/ics'
import { downloadText } from '@/lib/download'
import { BODY_METRICS, bodyMeasurementRepo, weightRepo } from '@/db/repositories'
import { BODY_METRIC_HINTS, BODY_METRIC_LABELS } from '@/lib/labels'
import { formatDateLong, pl, signed } from '@/lib/format'
import { Button, Callout, Card, Field, NumberInput, SectionTitle } from '@/components/ui'

/**
 * Cotygodniowy pomiar: waga i obwody razem, w SOBOTĘ.
 *
 * Dane zbieramy dokładnie dwa razy: przy pierwszym uruchomieniu (ekran
 * startowy pyta o wagę) i potem raz w tygodniu, w sobotę. Codzienne pytanie
 * o wagę było zaproszeniem do mierzenia szumu — dobowe wahania nawodnienia to
 * ±1,5 kg, więc siedem wpisów w tygodniu nie mówi więcej niż jeden, a każdy
 * z nich kusi do wniosków. Sobota, bo to pierwszy dzień tygodnia w tej
 * aplikacji: pomiar wypada na tej samej granicy, co tydzień planu, jadłospisu
 * i zakupów.
 *
 * Obwody i waga stoją w jednej karcie, bo to jedna czynność: staje się na wagę
 * i bierze centymetr. Dwie osobne karty pytały o to samo dwa razy.
 *
 * Wariant `profile` jest drogą awaryjną: gdy sobota przeszła bez wpisu, dane
 * nadal da się wpisać z ekranu Profil. Bez tego jedno przeoczenie kosztowałoby
 * tygodniową dziurę w historii, której nie da się odtworzyć.
 */
export const MEASUREMENT_WEEKDAY = WEEK_START_DAY

/** Czy dziś jest dzień pomiarów. */
export function isMeasurementDay(date: string): boolean {
  return isoWeekday(date) === MEASUREMENT_WEEKDAY
}

export function WeeklyCheckInCard({
  today,
  variant = 'today',
}: {
  today: string
  /** `today` — karta sobotnia; `profile` — dostęp na żądanie w inne dni. */
  variant?: 'today' | 'profile'
}) {
  const [open, setOpen] = useState(false)

  const data = useLiveQuery(async () => {
    const weekStart = startOfWeek(today)
    const [measurements, thisWeek, entries] = await Promise.all([
      bodyMeasurementRepo.all(),
      bodyMeasurementRepo.inRange(weekStart, addDays(weekStart, 6)),
      weightRepo.all(),
    ])
    return {
      measurements,
      thisWeekMeasurement: thisWeek.at(-1),
      weightThisWeek: entries.find((e) => e.date >= weekStart && e.date <= addDays(weekStart, 6)),
      latestWeightKg: entries.at(-1)?.weightKg ?? null,
    }
  }, [today])

  if (!data) return null

  const measurementDay = isMeasurementDay(today)
  const latest = data.measurements.at(-1)
  const beforeLatest = data.measurements.at(-2)
  const done = data.thisWeekMeasurement !== undefined && data.weightThisWeek !== undefined

  // W sobotę bez wpisu formularz jest otwarty od razu — to jest ten moment.
  const formOpen = open || (variant === 'today' && measurementDay && !done)

  return (
    <Card>
      <SectionTitle
        hint={
          measurementDay
            ? 'Sobota to dzień pomiarów. Waż się rano, przed jedzeniem, i mierz zawsze w tych samych miejscach.'
            : 'Pomiary robimy raz w tygodniu, w sobotę. Wpis z innego dnia jest wart tyle samo.'
        }
      >
        Waga i pomiary
      </SectionTitle>

      {measurementDay && !done && variant === 'today' && (
        <div className="mb-3">
          <Callout title="Dzisiaj sobota — czas na pomiar tygodnia">
            Obwody pokazują to, czego waga nie pokaże: masa może stać w miejscu, a talia
            zejść o dwa centymetry.
          </Callout>
        </div>
      )}

      <div className="grid gap-1.5 text-sm">
        <div className="flex justify-between gap-3">
          <span className="text-[var(--color-text-dim)]">Ostatnia waga</span>
          <span className="text-right">
            {data.latestWeightKg !== null ? `${pl(data.latestWeightKg)} kg` : '—'}
          </span>
        </div>
        {latest ? (
          <>
            <p className="text-[var(--color-text-dim)]">
              Obwody z {formatDateLong(latest.date)}:
            </p>
            {BODY_METRICS.filter((metric) => latest[metric] !== undefined).map((metric) => (
              <MetricRow key={metric} metric={metric} latest={latest} previous={beforeLatest} />
            ))}
          </>
        ) : (
          <p className="text-[var(--color-text-dim)]">
            Brak obwodów. Wystarczy jedna miara, żeby zacząć — talia mówi najwięcej.
          </p>
        )}
      </div>

      {formOpen ? (
        <div className="mt-4">
          <CheckInForm
            date={today}
            existingMeasurement={
              data.thisWeekMeasurement?.date === today ? data.thisWeekMeasurement : undefined
            }
            reference={data.measurements.filter((m) => m.date !== today).at(-1)}
            currentWeightKg={data.weightThisWeek?.date === today ? data.weightThisWeek.weightKg : null}
            onDone={() => setOpen(false)}
          />
        </div>
      ) : (
        <div className="mt-3 grid gap-2">
          <Button variant="ghost" onClick={() => setOpen(true)} className="w-full">
            {done ? 'Popraw wpis' : 'Wpisz wagę i pomiary'}
          </Button>
          {/* Przypomnienie żyje w kalendarzu telefonu, nie w aplikacji — patrz
              `domain/calendar/ics.ts`. Na ekranie Profil, nie na „Dziś": to
              czynność jednorazowa, a nie coś do zrobienia codziennie. */}
          {variant === 'profile' && <ReminderButton today={today} />}
        </div>
      )}
    </Card>
  )
}

/**
 * Pobranie pliku `.ics` z cotygodniowym przypomnieniem o pomiarach.
 *
 * Aplikacja nie umie się sama obudzić w sobotę o dziewiątej (PWA bez serwera —
 * patrz README), ale kalendarz telefonu umie. Jedno kliknięcie zapisuje serię
 * na 12 tygodni; ponowne kliknięcie nadpisuje ją, bo `UID` zależy od daty startu.
 */
function ReminderButton({ today }: { today: string }) {
  const [saved, setSaved] = useState<MeasurementReminder | null>(null)

  function download() {
    const reminder = measurementReminderIcs({ today, now: new Date().toISOString() })
    downloadText('pomiary-fitkonrad.ics', reminder.content, 'text/calendar')
    setSaved(reminder)
  }

  return (
    <>
      <Button variant="ghost" onClick={download} className="w-full">
        Przypomnienie w kalendarzu ({MEASUREMENT_WEEKS} tygodni)
      </Button>
      {saved && (
        <Callout tone="info" title="Plik pobrany — otwórz go, żeby dodać do kalendarza">
          {saved.weeks} sobót od {formatDateLong(saved.firstDate)} do{' '}
          {formatDateLong(saved.lastDate)}, zawsze o {MEASUREMENT_HOUR}:00, z przypomnieniem.
          Wydarzenie nazywa się „Podaj miary do aplikacji". Kolejne pobranie tej samej serii
          ją nadpisze, nie zdubluje.
        </Callout>
      )}
    </>
  )
}

function MetricRow({
  metric,
  latest,
  previous,
}: {
  metric: BodyMetric
  latest: BodyMeasurement
  previous: BodyMeasurement | undefined
}) {
  const value = latest[metric]
  const before = previous?.[metric]
  const change = value !== undefined && before !== undefined ? value - before : null

  return (
    <div className="flex justify-between gap-3">
      <span className="text-[var(--color-text-dim)]">{BODY_METRIC_LABELS[metric]}</span>
      <span className="text-right">
        {pl(value as number)} cm
        {change !== null && change !== 0 && (
          <span className="ml-2 text-xs text-[var(--color-text-dim)]">{signed(change)} cm</span>
        )}
      </span>
    </div>
  )
}

function CheckInForm({
  date,
  existingMeasurement,
  reference,
  currentWeightKg,
  onDone,
}: {
  date: string
  /** Wpis z DZISIAJ — tylko taki wolno nadpisać. */
  existingMeasurement: BodyMeasurement | undefined
  /** Poprzedni pomiar jako podpowiedź, od czego startujemy. */
  reference: BodyMeasurement | undefined
  currentWeightKg: number | null
  onDone: () => void
}) {
  const [weightKg, setWeightKg] = useState<number | null>(currentWeightKg)
  const [values, setValues] = useState<Partial<Record<BodyMetric, number | null>>>(() => {
    const initial: Partial<Record<BodyMetric, number | null>> = {}
    for (const metric of BODY_METRICS) initial[metric] = existingMeasurement?.[metric] ?? null
    return initial
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const anyMetric = BODY_METRICS.some((metric) => {
    const value = values[metric]
    return value !== null && value !== undefined && value > 0
  })
  const weightOk = weightKg !== null && weightKg >= 35 && weightKg <= 300
  const canSave = weightOk || anyMetric

  async function save() {
    if (!canSave) return
    setBusy(true)
    setError(null)
    try {
      // Waga i obwody zapisują się niezależnie — wpisanie tylko jednego z nich
      // jest w porządku, wymuszanie obu skończyłoby się brakiem obu.
      if (weightOk) await weightRepo.upsert(date, weightKg as number)
      if (anyMetric) await bodyMeasurementRepo.upsert(date, values)
      onDone()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Nie udało się zapisać wpisu.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid gap-3">
      <Field
        label="Waga"
        hint="Cel kaloryczny liczy się z masy odniesienia w profilu — ten wpis zasila trend i wykresy."
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

      {BODY_METRICS.map((metric) => {
        const before = reference?.[metric]
        return (
          <Field
            key={metric}
            label={BODY_METRIC_LABELS[metric]}
            hint={
              before !== undefined
                ? `${BODY_METRIC_HINTS[metric]}. Ostatnio ${pl(before)} cm.`
                : BODY_METRIC_HINTS[metric]
            }
          >
            <NumberInput
              value={values[metric] ?? null}
              onChange={(value) => setValues((current) => ({ ...current, [metric]: value }))}
              min={20}
              max={200}
              step={0.5}
              suffix="cm"
              placeholder="—"
            />
          </Field>
        )
      })}

      <p className="text-xs text-[var(--color-text-dim)]">
        Puste pola są pomijane — nie musisz mierzyć wszystkiego. Wpisane wartości zobaczysz
        w Postępach.
      </p>

      {error && <Callout tone="warn">{error}</Callout>}

      <div className="flex gap-2">
        <Button onClick={save} disabled={!canSave || busy} className="flex-1">
          {busy ? 'Zapisywanie…' : 'Zapisz pomiar'}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Anuluj
        </Button>
      </div>
    </div>
  )
}
