import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { useLiveQuery } from 'dexie-react-hooks'
import type { PlannedSession, SessionStatus, SetLog } from '@/domain/types'
import { applyWeekProgression, planRepo, type ProgressionSummary } from '@/db/planRepo'
import { sessionLogRepo } from '@/db/repositories'
import {
  exerciseName,
  exercisePlacement,
  exerciseVideo,
  WARMUP,
  WORKOUT_EXERCISES_BY_ID,
  workoutById,
} from '@/lib/catalog'
import { SESSION_STATUS_LABELS } from '@/lib/labels'
import {
  formatDateLong,
  formatDistance,
  formatDuration,
  formatPace,
  sessionTitle,
} from '@/lib/format'
import {
  Badge,
  Button,
  Callout,
  Card,
  Field,
  NumberInput,
  SectionTitle,
  Spinner,
} from '@/components/ui'
import { Screen, ScreenHeader } from '@/app/AppShell'

interface SetDraft {
  reps: number | null
  weightKg: number | null
  rpe: number | null
}

type StrengthDraft = Record<string, SetDraft[]>

export function SessionScreen() {
  const { sessionId } = useParams<{ sessionId: string }>()
  const navigate = useNavigate()

  const data = useLiveQuery(async () => {
    if (!sessionId) return { session: undefined, log: undefined, sets: [] as SetLog[] }
    const session = await planRepo.byId(sessionId)
    const log = session ? await sessionLogRepo.forPlannedSession(session.id) : undefined
    const sets = log ? await sessionLogRepo.setsForSession(log.id) : []
    return { session, log, sets }
  }, [sessionId])

  if (!data) return <Spinner />
  if (!data.session) {
    return (
      <Screen>
        <Callout tone="danger" title="Nie znaleziono sesji">
          Ta sesja nie istnieje albo plan został zregenerowany.
        </Callout>
        <Button variant="ghost" onClick={() => navigate('/plan')}>
          Wróć do planu
        </Button>
      </Screen>
    )
  }

  const session = data.session

  return (
    <Screen>
      <ScreenHeader
        title={sessionTitle(session)}
        subtitle={formatDateLong(session.date)}
        action={
          session.phase !== 'accumulation' ? (
            <Badge tone="accent">{session.phase === 'deload' ? 'deload' : 'tapering'}</Badge>
          ) : undefined
        }
      />

      {data.log ? (
        <LoggedView session={session} log={data.log} sets={data.sets} />
      ) : session.payload.kind === 'strength' ? (
        <StrengthForm session={session} />
      ) : session.payload.kind === 'run' || session.payload.kind === 'swim' ? (
        <CardioForm session={session} />
      ) : (
        <Callout>Dzień odpoczynku — nie ma czego logować.</Callout>
      )}
    </Screen>
  )
}

// ─────────────────────────────────────────── Widok zalogowanej sesji

function LoggedView({
  session,
  log,
  sets,
}: {
  session: PlannedSession
  log: NonNullable<Awaited<ReturnType<typeof sessionLogRepo.forPlannedSession>>>
  sets: readonly SetLog[]
}) {
  const byExercise = new Map<string, SetLog[]>()
  for (const set of sets) {
    const bucket = byExercise.get(set.exerciseId)
    if (bucket) bucket.push(set)
    else byExercise.set(set.exerciseId, [set])
  }

  return (
    <>
      <Card>
        <SectionTitle hint={log.notes}>{SESSION_STATUS_LABELS[log.status]}</SectionTitle>
        {[...byExercise.entries()].map(([exerciseId, exerciseSets]) => (
          <div key={exerciseId} className="mb-3 last:mb-0">
            <p className="font-medium">{exerciseName(exerciseId)}</p>
            <p className="text-sm text-[var(--color-text-dim)]">
              {exerciseSets
                .sort((a, b) => a.setIndex - b.setIndex)
                .map((s) => `${s.reps}${s.weightKg ? `×${s.weightKg} kg` : ''}`)
                .join('  ·  ')}
            </p>
          </div>
        ))}
        {sets.length === 0 && (
          <p className="text-sm text-[var(--color-text-dim)]">Bez zapisanych serii.</p>
        )}
      </Card>

      <Callout title="Wpis jest zapisany">
        Historia jest nienaruszalna — poprawka wycofuje ten wpis (zostaje w bazie ze
        znacznikiem usunięcia) i pozwala wprowadzić go ponownie.
      </Callout>

      <Button variant="ghost" onClick={() => sessionLogRepo.undoLog(log.id)}>
        Popraw wpis
      </Button>

      <ProgressionPanel planId={session.planId} targetWeekIndex={session.weekIndex + 1} />
    </>
  )
}

// ──────────────────────────────────────────────────── Rozgrzewka

/**
 * Rozgrzewka z arkusza, zwinięta domyślnie.
 *
 * Jest w planie trenera i ma być pod ręką w sesji, a nie w osobnej zakładce,
 * do której nikt nie zajrzy przed treningiem. Zwinięta, bo po trzecim razie
 * pamięta się ją z nazw kroków — a wtedy rozłożona zajmowałaby pół ekranu
 * nad tym, co się faktycznie wpisuje.
 */
function WarmupCard() {
  const [open, setOpen] = useState(false)

  return (
    <Card>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-11 w-full items-center justify-between gap-3 text-left"
      >
        <span>
          <span className="block font-medium">Rozgrzewka — 5–7 minut</span>
          <span className="block text-sm text-[var(--color-text-dim)]">
            {WARMUP.map((step) => step.element).join(' · ')}
          </span>
        </span>
        <span className="shrink-0 text-[var(--color-accent)]">{open ? 'Ukryj' : 'Pokaż'}</span>
      </button>

      {open && (
        <ol className="mt-3 grid gap-3 border-t border-[var(--color-border)] pt-3">
          {WARMUP.map((step) => (
            <li key={step.step}>
              <p className="font-medium">
                {step.step}. {step.name}
              </p>
              <p className="text-sm text-[var(--color-text-dim)]">{step.description}</p>
              <p className="mt-0.5 text-sm">
                {step.duration}
                <span className="text-[var(--color-text-dim)]"> · {step.purpose}</span>
              </p>
            </li>
          ))}
        </ol>
      )}
    </Card>
  )
}

// ──────────────────────────────────────────── Instruktaż wideo

/**
 * Mały link do instruktażu — otwiera YouTube w nowej karcie.
 *
 * Podpis zależy od tego, co się otworzy: „Wideo" przy konkretnym materiale,
 * „Szukaj wideo" przy wyszukiwaniu. Obiecywanie filmu tam, gdzie pojawi się
 * lista wyników, byłoby drobnym kłamstwem interfejsu — a to jedno ćwiczenie
 * (Y-Raise), dla którego nie znalazłem wiarygodnego materiału.
 */
function VideoLink({ exerciseId }: { exerciseId: string }) {
  const video = exerciseVideo(exerciseId)

  return (
    <a
      href={video.href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex min-h-11 items-center text-sm text-[var(--color-accent)]"
    >
      ▶ {video.kind === 'video' ? 'Wideo' : 'Szukaj wideo'}
    </a>
  )
}

// ────────────────────────────────────────── Alternatywy ćwiczenia

/**
 * Podmiana ćwiczenia na wariant z arkusza.
 *
 * Arkusz podaje dwie alternatywy przy każdym ćwiczeniu i mówi wprost, po co:
 * „gdy ławka i sztanga są zajęte". Podmiana idzie do PLANU, nie tylko do
 * ekranu — inaczej trening zrobiony na wariancie zapisałby się jako ćwiczenie,
 * którego nie było, a progresja policzyłaby ciężar dla niewłaściwego ruchu.
 */
function AlternativesPanel({
  sessionId,
  exerciseId,
}: {
  sessionId: string
  exerciseId: string
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const placement = exercisePlacement(exerciseId)
  if (!placement) return null

  const variants = [placement.slot.main, ...placement.slot.alternatives]
  const others = variants.filter((v) => v.id !== exerciseId)
  if (others.length === 0) return null

  async function swap(nextId: string) {
    setBusy(true)
    try {
      await planRepo.swapExercise(sessionId, nextId)
      setOpen(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mb-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="min-h-11 text-sm text-[var(--color-accent)]"
      >
        {open ? 'Ukryj warianty' : `Inne warianty (${others.length})`}
      </button>

      {open && (
        <ul className="mt-1 grid gap-2">
          {others.map((variant) => (
            <li key={variant.id}>
              <button
                type="button"
                disabled={busy}
                onClick={() => swap(variant.id)}
                className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3 text-left text-sm disabled:opacity-50"
              >
                <span className="block font-medium">
                  {variant.name}
                  {variant.variant === 'main' && ' (główne)'}
                </span>
                <span className="block text-[var(--color-text-dim)]">
                  {variant.sets}×{variant.reps}
                  {variant.perSide ? ' na stronę' : ''} · {variant.startWeightLabel} · przerwa{' '}
                  {variant.restLabel}
                </span>
                <span className="mt-0.5 block text-[var(--color-text-dim)]">{variant.muscles}</span>
              </button>
              <div className="mt-0.5 pl-3">
                <VideoLink exerciseId={variant.id} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ────────────────────────────────────────────── Formularz siłowy

function StrengthForm({ session }: { session: PlannedSession }) {
  const payload = session.payload.kind === 'strength' ? session.payload : null
  const navigate = useNavigate()
  const [draft, setDraft] = useState<StrengthDraft>({})
  const [busy, setBusy] = useState(false)
  /**
   * Błąd zapisu MUSI być widoczny.
   *
   * Wcześniej `try/finally` bez `catch` zjadał wyjątek: przy nieudanym zapisie
   * (pełny magazyn, zablokowana baza) przycisk przestawał się kręcić, ekran
   * zostawał ten sam i nic nie mówiło, że trening się nie zapisał. Człowiek
   * wychodzi z siłowni przekonany, że ma go w historii.
   */
  const [error, setError] = useState<string | null>(null)

  /**
   * Prefill z planu: powtórzenia i ciężar takie, jak zaplanowane.
   *
   * Zależność od LISTY ĆWICZEŃ, nie tylko od `session.id`, jest tu istotna.
   * Podmiana ćwiczenia na wariant zmienia plan tej samej sesji, więc przy
   * zależności od samego `id` efekt się nie uruchamiał: nowe ćwiczenie nie
   * dostawało wierszy serii (tabela zostawała pusta), a wpisy zapisane
   * w szkicu dla ćwiczenia ZASTĄPIONEGO nadal poszłyby do logu — czyli
   * progresja policzyłaby ciężar dla ruchu, którego nie było.
   *
   * Wpisane wartości dla ćwiczeń, które w sesji zostały, przenosimy: podmiana
   * jednej pozycji nie ma prawa wyczyścić trzech zapisanych serii obok.
   */
  const exerciseKey = payload?.exercises.map((e) => e.exerciseId).join('|') ?? ''
  const seededSessionId = useRef<string | null>(null)

  useEffect(() => {
    if (!payload) return
    // Inna sesja = czysty szkic. Trening A wraca co tydzień z tymi samymi
    // identyfikatorami ćwiczeń, więc bez tego wpisy przeciekłyby między sesjami.
    const freshSession = seededSessionId.current !== session.id
    seededSessionId.current = session.id

    setDraft((current) => {
      const next: StrengthDraft = {}
      for (const exercise of payload.exercises) {
        const kept = freshSession ? undefined : current[exercise.exerciseId]
        next[exercise.exerciseId] =
          kept ??
          exercise.sets.map((set) => ({
            reps: set.reps,
            weightKg: set.weightKg,
            rpe: null,
          }))
      }
      // Ćwiczenia wyjętego z planu w szkicu nie zostawiamy — patrz wyżej.
      return next
    })
  }, [session.id, exerciseKey])

  if (!payload) return null

  function updateSet(exerciseId: string, index: number, patch: Partial<SetDraft>) {
    setDraft((current) => {
      const sets = current[exerciseId]
      if (!sets) return current
      const next = sets.map((set, i) => (i === index ? { ...set, ...patch } : set))
      return { ...current, [exerciseId]: next }
    })
  }

  async function save(status: SessionStatus) {
    setBusy(true)
    setError(null)
    try {
      const setLogs: Omit<SetLog, 'id' | 'sessionLogId' | 'createdAt' | 'updatedAt' | 'deletedAt'>[] =
        []

      if (status !== 'skipped') {
        for (const [exerciseId, sets] of Object.entries(draft)) {
          sets.forEach((set, index) => {
            // Seria bez powtórzeń nie została wykonana — nie zapisujemy jej.
            if (set.reps === null || set.reps <= 0) return
            setLogs.push({
              exerciseId,
              setIndex: index,
              reps: set.reps,
              weightKg: set.weightKg,
              ...(set.rpe === null ? {} : { rpe: set.rpe }),
            })
          })
        }
      }

      await sessionLogRepo.record(
        {
          plannedSessionId: session.id,
          date: session.date,
          type: session.type,
          status,
        },
        setLogs,
      )

      // Domknięcie pętli: obciążenia kolejnego tygodnia liczymy z tego,
      // co właśnie zostało zapisane.
      await applyWeekProgression(session.planId, session.weekIndex + 1)
      navigate('/')
    } catch (cause) {
      setError(
        cause instanceof Error
          ? `Nie udało się zapisać treningu: ${cause.message}`
          : 'Nie udało się zapisać treningu.',
      )
    } finally {
      setBusy(false)
    }
  }

  const workout = workoutById(payload.workoutId)

  return (
    <>
      <Callout title={workout ? `${workout.name} — ${payload.exercises.length} ćwiczeń` : undefined}>
        {workout ? `${workout.focus}. ` : ''}
        Wpisz, co faktycznie zrobiłeś. RPE (odczuwany wysiłek 1–10) jest opcjonalne, ale
        właśnie z niego wynika, czy w kolejnym tygodniu dokładamy obciążenie.
      </Callout>

      <WarmupCard />

      {payload.exercises.map((exercise) => {
        const meta = WORKOUT_EXERCISES_BY_ID.get(exercise.exerciseId)
        const sets = draft[exercise.exerciseId] ?? []
        return (
          <Card key={exercise.exerciseId}>
            <SectionTitle
              hint={
                `Plan: ${exercise.sets.length}×${exercise.sets[0]?.reps}` +
                `${meta?.perSide ? ' na stronę' : ''} @ RPE ${exercise.sets[0]?.targetRpe}` +
                `${meta ? ` · tempo ${meta.tempo}` : ''} · przerwa ${meta?.restLabel ?? `${exercise.restSec} s`}` +
                `${meta ? ` · ciężar z arkusza: ${meta.startWeightLabel}` : ''}`
              }
            >
              {meta?.name ?? exercise.exerciseId}
            </SectionTitle>

            {meta && (
              <>
                <p className="mb-2 text-sm text-[var(--color-text-dim)]">{meta.description}</p>
                {meta.tempoNote && (
                  <p className="mb-2 text-xs text-[var(--color-text-dim)]">
                    Tempo {meta.tempo}: {meta.tempoNote}.
                  </p>
                )}
              </>
            )}

            {meta && meta.cues.length > 0 && (
              <ul className="mb-3 grid gap-0.5 text-xs text-[var(--color-text-dim)]">
                {meta.cues.map((cue) => (
                  <li key={cue}>• {cue}</li>
                ))}
              </ul>
            )}

            <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1">
              <VideoLink exerciseId={exercise.exerciseId} />
              <AlternativesPanel sessionId={session.id} exerciseId={exercise.exerciseId} />
            </div>

            <div className="grid gap-2">
              <div className="grid grid-cols-[2rem_1fr_1fr_1fr] items-center gap-2 text-xs text-[var(--color-text-dim)]">
                <span>#</span>
                <span>Powt.</span>
                <span>Ciężar</span>
                <span>RPE</span>
              </div>
              {sets.map((set, index) => (
                <div
                  key={index}
                  className="grid grid-cols-[2rem_1fr_1fr_1fr] items-center gap-2"
                >
                  <span className="text-sm text-[var(--color-text-dim)]">{index + 1}</span>
                  <NumberInput
                    value={set.reps}
                    onChange={(reps) => updateSet(exercise.exerciseId, index, { reps })}
                    min={0}
                    max={100}
                  />
                  <NumberInput
                    value={set.weightKg}
                    onChange={(weightKg) => updateSet(exercise.exerciseId, index, { weightKg })}
                    min={0}
                    max={400}
                    step={2.5}
                    placeholder="—"
                  />
                  <NumberInput
                    value={set.rpe}
                    onChange={(rpe) => updateSet(exercise.exerciseId, index, { rpe })}
                    min={1}
                    max={10}
                    step={0.5}
                    placeholder="—"
                  />
                </div>
              ))}
            </div>
          </Card>
        )
      })}

      {error && <Callout tone="warn">{error}</Callout>}

      <SaveButtons busy={busy} onSave={save} />
    </>
  )
}

// ────────────────────────────────────────────── Formularz cardio

function CardioForm({ session }: { session: PlannedSession }) {
  const navigate = useNavigate()
  const payload = session.payload
  const planned =
    payload.kind === 'run'
      ? { distanceM: payload.distanceM, durationSec: payload.durationSec }
      : payload.kind === 'swim'
        ? { distanceM: payload.distanceM, durationSec: 0 }
        : { distanceM: 0, durationSec: 0 }

  const [distanceM, setDistanceM] = useState<number | null>(planned.distanceM)
  const [durationMin, setDurationMin] = useState<number | null>(
    planned.durationSec > 0 ? Math.round(planned.durationSec / 60) : null,
  )
  const [avgHr, setAvgHr] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save(status: SessionStatus) {
    setBusy(true)
    setError(null)
    try {
      const durationSec = (durationMin ?? 0) * 60
      if (status === 'skipped' || !distanceM) {
        await sessionLogRepo.record({
          plannedSessionId: session.id,
          date: session.date,
          type: session.type,
          status,
        })
      } else {
        await sessionLogRepo.recordCardio(
          {
            plannedSessionId: session.id,
            date: session.date,
            type: session.type,
            status,
            ...(durationMin === null ? {} : { durationMin }),
          },
          {
            distanceM,
            durationSec,
            ...(avgHr === null ? {} : { avgHr }),
          },
        )
      }
      navigate('/')
    } catch (cause) {
      // Tak samo jak w formularzu siłowym: cichy wyjątek wygląda jak zapis.
      setError(
        cause instanceof Error
          ? `Nie udało się zapisać sesji: ${cause.message}`
          : 'Nie udało się zapisać sesji.',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Card>
        <SectionTitle>Plan</SectionTitle>
        {payload.kind === 'run' && (
          <ul className="grid gap-1 text-sm">
            <li>Dystans: {formatDistance(payload.distanceM)}</li>
            <li>Tempo: {formatPace(payload.targetPaceSecPerKm)} /km</li>
            <li>Czas: {formatDuration(payload.durationSec)}</li>
            <li>Strefa tętna: {payload.zone}</li>
            {payload.intervals && <li>Odcinki: {payload.intervals}</li>}
          </ul>
        )}
        {payload.kind === 'swim' && (
          <ul className="grid gap-1 text-sm">
            <li>Dystans: {payload.distanceM} m</li>
            <li>Serie: {payload.sets}</li>
            <li>Przerwa: {payload.restSec} s</li>
          </ul>
        )}
      </Card>

      <Card>
        <SectionTitle hint="Wpisz, co faktycznie wyszło.">Wykonanie</SectionTitle>
        <div className="grid gap-3">
          <Field label="Dystans">
            <NumberInput
              value={distanceM}
              onChange={setDistanceM}
              min={0}
              max={100000}
              step={100}
              suffix="m"
            />
          </Field>
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
            <Field label="Średnie tętno" hint="Opcjonalnie">
              <NumberInput value={avgHr} onChange={setAvgHr} min={40} max={230} placeholder="—" />
            </Field>
          </div>
        </div>
      </Card>

      {error && <Callout tone="warn">{error}</Callout>}

      <SaveButtons busy={busy} onSave={save} />
    </>
  )
}

function SaveButtons({
  busy,
  onSave,
}: {
  busy: boolean
  onSave: (status: SessionStatus) => void | Promise<void>
}) {
  return (
    <div className="grid gap-2">
      <Button onClick={() => onSave('done')} disabled={busy} className="w-full">
        {busy ? 'Zapisywanie…' : 'Zapisz jako wykonane'}
      </Button>
      <div className="grid grid-cols-2 gap-2">
        <Button variant="ghost" onClick={() => onSave('partial')} disabled={busy}>
          Częściowo
        </Button>
        <Button variant="ghost" onClick={() => onSave('skipped')} disabled={busy}>
          Pominięte
        </Button>
      </div>
    </div>
  )
}

// ──────────────────────────────────────────── Podsumowanie progresji

function ProgressionPanel({
  planId,
  targetWeekIndex,
}: {
  planId: string
  targetWeekIndex: number
}) {
  const [summary, setSummary] = useState<ProgressionSummary | null>(null)

  useEffect(() => {
    let cancelled = false
    void applyWeekProgression(planId, targetWeekIndex).then((result) => {
      if (!cancelled) setSummary(result)
    })
    return () => {
      cancelled = true
    }
  }, [planId, targetWeekIndex])

  if (!summary || summary.entries.length === 0) return null

  const tone = { advance: 'ok', hold: 'neutral', regress: 'warn' } as const
  const label = { advance: 'dokładamy', hold: 'powtarzamy', regress: 'cofamy' } as const

  return (
    <Card>
      <SectionTitle hint={`Zastosowano do tygodnia ${summary.targetWeekIndex + 1}.`}>
        Obciążenia na kolejny tydzień
      </SectionTitle>
      <ul className="grid gap-2 text-sm">
        {summary.entries.map((entry) => (
          <li key={entry.exerciseId}>
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">{entry.exerciseName}</span>
              <span className="flex shrink-0 items-center gap-2">
                <Badge tone={tone[entry.verdict]}>{label[entry.verdict]}</Badge>
                {entry.suggestedWeightKg !== null && <span>{entry.suggestedWeightKg} kg</span>}
              </span>
            </div>
            <p className="text-xs text-[var(--color-text-dim)]">{entry.reason}</p>
          </li>
        ))}
      </ul>
    </Card>
  )
}
