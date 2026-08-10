import { useState } from 'react'
import type { PlannedSession, SessionType } from '@/domain/types'
import { sessionLogRepo } from '@/db/repositories'
import { formatDateLong, sessionTitle } from '@/lib/format'
import {
  Button,
  Callout,
  Checkbox,
  Field,
  FieldGroup,
  NumberInput,
  Sheet,
} from '@/components/ui'

/**
 * Trening poza planem.
 *
 * Plan mówi, co miało być — log mówi, co było. Bez tej ścieżki trening zrobiony
 * w dniu odpoczynku (albo drugi w ciągu dnia) nie miał gdzie się zapisać, więc
 * nie liczył się do objętości, dystansów ani realizacji planu. Model to
 * przewidywał od początku: `sessionLogs.plannedSessionId` może być `null`.
 *
 * Panel jest wołany z konkretnego DNIA w zakładce Plan, nie tylko z „Dziś" —
 * dzięki temu da się dopisać wczorajszy trening, o którym się zapomniało.
 */
type ExtraType = Exclude<SessionType, 'rest'>

const TYPE_OPTIONS: { value: ExtraType; label: string }[] = [
  { value: 'strength', label: 'Siłowy' },
  { value: 'run', label: 'Bieganie' },
  { value: 'swim', label: 'Pływanie' },
  { value: 'walk', label: 'Spacer' },
]

/** Dyscypliny, w których liczy się dystans. */
const DISTANCE_TYPES: readonly ExtraType[] = ['run', 'swim', 'walk']

export function ExtraSessionSheet({
  date,
  plannedSession,
  onClose,
}: {
  /** Null zamyka panel. */
  date: string | null
  /**
   * Sesja zaplanowana na ten dzień, jeśli jakaś jest i nie jest odpoczynkiem.
   * Pozwala oznaczyć ją jako pominiętą — „zamiast tego poszedłem na spacer".
   */
  plannedSession?: PlannedSession | undefined
  onClose: () => void
}) {
  const [type, setType] = useState<ExtraType>('walk')
  const [durationMin, setDurationMin] = useState<number | null>(null)
  const [distanceM, setDistanceM] = useState<number | null>(null)
  const [avgHr, setAvgHr] = useState<number | null>(null)
  const [rpe, setRpe] = useState<number | null>(null)
  const [replacePlanned, setReplacePlanned] = useState(false)
  const [busy, setBusy] = useState(false)

  const hasDistance = DISTANCE_TYPES.includes(type)
  const canReplace = plannedSession !== undefined && plannedSession.type !== 'rest'
  const valid = hasDistance ? distanceM !== null && distanceM > 0 : durationMin !== null

  function reset() {
    setType('walk')
    setDurationMin(null)
    setDistanceM(null)
    setAvgHr(null)
    setRpe(null)
    setReplacePlanned(false)
  }

  async function save() {
    if (!valid || !date) return
    setBusy(true)
    try {
      const base = {
        plannedSessionId: null,
        date,
        type,
        status: 'done' as const,
        ...(durationMin === null ? {} : { durationMin }),
        ...(rpe === null ? {} : { sessionRpe: rpe }),
        notes: 'Trening poza planem',
      }

      if (hasDistance && distanceM !== null) {
        await sessionLogRepo.recordCardio(base, {
          distanceM,
          durationSec: (durationMin ?? 0) * 60,
          ...(avgHr === null ? {} : { avgHr }),
        })
      } else {
        // Bez serii: to log faktu, nie sesji do progresji. Progresja liczy się
        // z zaplanowanych sesji, żeby dodatkowy trening jej nie zaburzał.
        await sessionLogRepo.record(base)
      }

      /**
       * Zastąpienie zaplanowanego treningu.
       *
       * Plan zostaje nietknięty — oznaczamy go jako POMINIĘTY i obok zapisujemy,
       * co faktycznie się stało. To jedyna uczciwa wersja: plan mówi, co miało
       * być, log mówi, co było. Nadpisanie planu skasowałoby informację
       * o tym, że zamiana w ogóle nastąpiła.
       */
      if (replacePlanned && canReplace && plannedSession) {
        await sessionLogRepo.markStatus(
          plannedSession.id,
          plannedSession.date,
          plannedSession.type,
          'skipped',
        )
      }

      reset()
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet
      open={date !== null}
      title={date ? `Trening poza planem — ${formatDateLong(date)}` : ''}
      onClose={onClose}
    >
      <div className="grid gap-3">
        <FieldGroup label="Co to było">
          <div className="grid grid-cols-2 gap-2">
            {TYPE_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setType(option.value)}
                className={`min-h-11 rounded-xl border px-2 text-sm transition-colors ${
                  type === option.value
                    ? 'border-[var(--color-accent)] bg-[var(--color-accent-strong)]/15 font-semibold'
                    : 'border-[var(--color-border)] bg-[var(--color-surface-2)]'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </FieldGroup>

        {hasDistance && (
          <Field
            label="Dystans"
            hint={
              type === 'walk' ? 'Ile metrów przeszedłeś — spacer z psem też się liczy.' : undefined
            }
          >
            <NumberInput
              value={distanceM}
              onChange={setDistanceM}
              min={0}
              max={100000}
              step={type === 'walk' ? 500 : 100}
              suffix="m"
            />
          </Field>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Czas">
            <NumberInput
              value={durationMin}
              onChange={setDurationMin}
              min={0}
              max={600}
              suffix="min"
            />
          </Field>
          {hasDistance ? (
            <Field label="Tętno śr." hint="Opcjonalnie">
              <NumberInput value={avgHr} onChange={setAvgHr} min={40} max={230} placeholder="—" />
            </Field>
          ) : (
            <Field label="RPE" hint="Opcjonalnie">
              <NumberInput value={rpe} onChange={setRpe} min={1} max={10} step={0.5} placeholder="—" />
            </Field>
          )}
        </div>

        {canReplace && plannedSession && (
          <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-1">
            <Checkbox
              checked={replacePlanned}
              onChange={setReplacePlanned}
              label={`Zamiast zaplanowanego: ${sessionTitle(plannedSession)}`}
              hint="Zaplanowana sesja zostanie oznaczona jako pominięta. Plan zostaje w historii — widać, że była zamiana."
            />
          </div>
        )}

        <Callout>
          Ten wpis nie wpływa na obciążenia w kolejnym tygodniu — progresję liczymy
          tylko z sesji zaplanowanych, żeby dodatkowy trening jej nie zaburzał.
        </Callout>

        <Button onClick={save} disabled={!valid || busy} className="w-full">
          {busy ? 'Zapisywanie…' : 'Zapisz trening'}
        </Button>
      </div>
    </Sheet>
  )
}
