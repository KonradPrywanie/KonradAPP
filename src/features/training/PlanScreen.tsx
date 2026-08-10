import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import type { Profile, SessionLog } from '@/domain/types'
import { planRepo, refreshWeekFromHistory, type WeekRefreshSummary } from '@/db/planRepo'
import { sessionLogRepo } from '@/db/repositories'
import { planWeekRanges } from '@/domain/training/planGenerator'
import { todayIso } from '@/domain/dates'
import {
  countLabel,
  formatDateLong,
  formatDayMonth,
  formatDistance,
  formatPace,
  formatWeekRange,
  sessionsLabel,
  weeksLabel,
} from '@/lib/format'
import { Badge, Button, Callout, Card, SectionTitle, Spinner } from '@/components/ui'
import { Screen, ScreenHeader } from '@/app/AppShell'
import { PlanRenewalCard, PlanSetupCard } from '../shared/GenerateCards'
import { SessionCard } from './SessionCard'
import { ExtraSessionSheet } from './ExtraSessionSheet'

const PHASE_LABELS = {
  accumulation: 'akumulacja',
  deload: 'deload',
  taper: 'tapering',
} as const

export function PlanScreen({ profile }: { profile: Profile }) {
  const [weekIndex, setWeekIndex] = useState<number | null>(null)
  const [extraDate, setExtraDate] = useState<string | null>(null)

  const data = useLiveQuery(async () => {
    const plan = await planRepo.active()
    if (!plan) {
      return { plan: undefined, sessions: [], logs: [], currentWeek: 0, timeline: null }
    }

    const timeline = await planRepo.timeline(todayIso())
    const currentWeek = timeline?.currentWeekIndex ?? plan.weeks - 1
    const week = weekIndex ?? currentWeek
    const [sessions, logs] = await Promise.all([
      planRepo.sessionsForWeek(plan.id, week),
      sessionLogRepo.all(),
    ])
    return { plan, sessions, logs, currentWeek, timeline }
  }, [weekIndex])

  if (!data) return <Spinner />
  if (!data.plan) {
    return (
      <Screen>
        <ScreenHeader title="Plan treningowy" />
        <PlanSetupCard profile={profile} />
      </Screen>
    )
  }

  const plan = data.plan
  const activeWeek = weekIndex ?? data.currentWeek
  const phase = data.sessions[0]?.phase
  const logByPlanned = new Map(
    data.logs.filter((l) => l.plannedSessionId).map((l) => [l.plannedSessionId as string, l]),
  )

  /**
   * Treningi dopisane poza planem, pogrupowane po dniu.
   *
   * Bez pokazania ich na ekranie dopisanie treningu wyglądałoby jak awaria:
   * użytkownik zapisuje sesję i nic się nie pojawia, bo karty pokazują
   * wyłącznie logi powiązane z sesją zaplanowaną (`plannedSessionId`).
   */
  const extraByDate = new Map<string, SessionLog[]>()
  for (const log of data.logs) {
    if (log.plannedSessionId !== null) continue
    const bucket = extraByDate.get(log.date)
    if (bucket) bucket.push(log)
    else extraByDate.set(log.date, [log])
  }

  /**
   * Zakresy dat tygodni planu.
   *
   * Sam numer nie mówi, o który odcinek kalendarza chodzi — a przy tygodniu
   * zaczynającym się w SOBOTĘ tym bardziej, bo to nie jest granica, której
   * ktokolwiek się domyśli. Dlatego data jest na przycisku, nie w podpowiedzi.
   */
  const weekRanges = planWeekRanges(plan.startDate, plan.weeks)
  const activeRange = weekRanges[activeWeek]

  return (
    <Screen>
      <ScreenHeader
        title="Plan treningowy"
        subtitle={`Wersja ${plan.version} · ${weeksLabel(plan.weeks)} · od ${formatDayMonth(plan.startDate)}`}
        action={phase ? <Badge tone="accent">{PHASE_LABELS[phase]}</Badge> : undefined}
      />

      <div className="flex gap-1.5 overflow-x-auto pb-1">
        {weekRanges.map((range) => (
          <button
            key={range.weekIndex}
            type="button"
            onClick={() => setWeekIndex(range.weekIndex)}
            aria-label={`Tydzień ${range.weekIndex + 1}: ${formatWeekRange(range.start, range.end)}`}
            className={`min-h-11 shrink-0 rounded-xl border px-3 py-1.5 text-sm leading-tight transition-colors ${
              range.weekIndex === activeWeek
                ? 'border-[var(--color-accent)] bg-[var(--color-accent-strong)]/15 font-semibold'
                : 'border-[var(--color-border)] bg-[var(--color-surface-2)]'
            } ${range.weekIndex === data.currentWeek ? 'ring-1 ring-[var(--color-accent)]/40' : ''}`}
          >
            <span className="block">Tydz. {range.weekIndex + 1}</span>
            <span className="block text-xs font-normal whitespace-nowrap text-[var(--color-text-dim)]">
              {formatWeekRange(range.start, range.end)}
            </span>
          </button>
        ))}
      </div>

      {activeRange && (
        <p className="-mt-1 text-sm text-[var(--color-text-dim)]">
          Tydzień {activeWeek + 1} z {plan.weeks}: {formatDateLong(activeRange.start)} –{' '}
          {formatDateLong(activeRange.end)}
          {activeWeek === data.currentWeek && ' · trwa teraz'}
        </p>
      )}

      {phase === 'deload' && (
        <Callout title="Tydzień deloadu">
          Obniżona objętość jest częścią planu, nie przerwą. Trzy tygodnie narastającego
          obciążenia bez rozładowania kończą się zastojem albo kontuzją.
        </Callout>
      )}
      {phase === 'taper' && (
        <Callout title="Tapering">
          Objętość w dół, intensywność utrzymana — organizm ma się zregenerować bez
          utraty formy.
        </Callout>
      )}

      <div className="grid gap-2">
        {data.sessions.map((session) => (
          <SessionCard
            key={session.id}
            session={session}
            log={logByPlanned.get(session.id)}
            extraLogs={extraByDate.get(session.date) ?? []}
            showWeekday
            onAddExtra={() => setExtraDate(session.date)}
          />
        ))}
      </div>

      {activeRange && (
        <RefreshWeekCard
          profile={profile}
          weekIndex={activeWeek}
          label={formatWeekRange(activeRange.start, activeRange.end)}
          trainingCount={data.sessions.filter((s) => s.type !== 'rest').length}
        />
      )}

      <ExtraSessionSheet
        date={extraDate}
        plannedSession={data.sessions.find((s) => s.date === extraDate && s.type !== 'rest')}
        onClose={() => setExtraDate(null)}
      />

      {/* Ta sama karta obsługuje odnowienie po zakończeniu i regenerację
          w trakcie — oba przypadki przenoszą ciężary i pozycję w cyklu. */}
      {data.timeline && <PlanRenewalCard profile={profile} timeline={data.timeline} />}
    </Screen>
  )
}

/**
 * Aktualizacja planu na wybrany tydzień z danych z tygodni poprzednich.
 *
 * Zastąpiła przycisk „usuń plan na tydzień". Powód zamiany jest w tym, jak
 * z aplikacji się korzysta: usuwanie dotyczyło tygodnia, którego nie będzie —
 * sytuacji rzadkiej. Codzienna sytuacja jest odwrotna: tydzień jest w planie,
 * ale jego liczby pochodzą z momentu generowania i nie wiedzą o treningach
 * zapisanych od tamtej pory. Ten przycisk przelicza je z logu.
 *
 * Bez potwierdzenia w dwóch krokach: aktualizacja nic nie usuwa, a sesje już
 * zalogowane pomija. Najgorsze, co może się stać, to brak zmian — i wtedy karta
 * to mówi wprost, zamiast milczeć.
 */
function RefreshWeekCard({
  profile,
  weekIndex,
  label,
  trainingCount,
}: {
  profile: Profile
  weekIndex: number
  label: string
  trainingCount: number
}) {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<WeekRefreshSummary | null>(null)

  async function refresh() {
    setBusy(true)
    try {
      setResult(await refreshWeekFromHistory(profile, weekIndex))
    } finally {
      setBusy(false)
    }
  }

  const verdictTone = { advance: 'ok', hold: 'neutral', regress: 'warn' } as const
  const verdictLabel = { advance: 'dokładamy', hold: 'powtarzamy', regress: 'cofamy' } as const

  return (
    <Card>
      <SectionTitle
        hint={
          `Przeliczy ${countLabel(trainingCount, ['trening', 'treningi', 'treningów'])} ` +
          `z ${label} na podstawie tego, co już zrobiłeś: ciężary z ostatnich sesji ` +
          'i progresji z poprzedniego tygodnia, dystanse i tempo z odbytego cardio. ' +
          'Sesje z zapisanym treningiem zostają nietknięte.'
        }
      >
        Aktualizuj plan na ten tydzień
      </SectionTitle>

      <Button variant="ghost" onClick={refresh} disabled={busy} className="w-full">
        {busy ? 'Przeliczanie…' : `Aktualizuj tydzień ${weekIndex + 1} z historii`}
      </Button>

      {result && (
        <div className="mt-3 grid gap-2">
          {result.updatedSessions === 0 ? (
            <Callout title="Bez zmian">
              {result.keptLogged > 0
                ? `Wszystkie dane są już aktualne (${sessionsLabel(result.keptLogged)} pominięto, bo są zalogowane).`
                : 'Plan na ten tydzień jest już zgodny z historią — nie ma czego przeliczać. ' +
                  'Zaloguj treningi, żeby kolejne tygodnie miały z czego wynikać.'}
            </Callout>
          ) : (
            <Callout tone="info" title={`Zaktualizowano ${sessionsLabel(result.updatedSessions)}`}>
              {result.sourceWeekIndex !== null
                ? `Progresja z tygodnia ${result.sourceWeekIndex + 1}, ciężary z historii, cardio z odbytych sesji.`
                : 'Pierwszy tydzień planu nie ma poprzednika — ciężary i cardio wzięliśmy z całej historii.'}
              {result.keptLogged > 0 && ` ${sessionsLabel(result.keptLogged)} pominięto (zalogowane).`}
            </Callout>
          )}

          {result.progression.length > 0 && (
            <ul className="grid gap-2 text-sm">
              {result.progression.map((entry) => (
                <li key={entry.exerciseId}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{entry.exerciseName}</span>
                    <span className="flex shrink-0 items-center gap-2">
                      <Badge tone={verdictTone[entry.verdict]}>{verdictLabel[entry.verdict]}</Badge>
                      {entry.suggestedWeightKg !== null && <span>{entry.suggestedWeightKg} kg</span>}
                    </span>
                  </div>
                  <p className="text-xs text-[var(--color-text-dim)]">{entry.reason}</p>
                </li>
              ))}
            </ul>
          )}

          {result.carried.length > 0 && (
            <div>
              <p className="text-xs tracking-wide text-[var(--color-text-dim)] uppercase">
                Ciężary z historii
              </p>
              <ul className="mt-1 grid gap-1 text-sm">
                {result.carried.map((entry) => (
                  <li key={entry.exerciseId} className="flex justify-between gap-2">
                    <span>{entry.exerciseName}</span>
                    <span className="shrink-0">{entry.weightKg} kg</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {result.cardioSessions > 0 && (
            <Callout tone="info" title="Cardio przeliczone">
              {result.cardioFromLogs.run && (
                <span className="block">
                  Bieganie: {formatDistance(result.cardioFromLogs.run.distanceM)} w tempie{' '}
                  {formatPace(result.cardioFromLogs.run.paceSecPerKm)}/km jako punkt wyjścia.
                </span>
              )}
              {result.cardioFromLogs.swim && (
                <span className="block">
                  Pływanie: {result.cardioFromLogs.swim.laps} długości jako punkt wyjścia.
                </span>
              )}
            </Callout>
          )}
        </div>
      )}
    </Card>
  )
}
