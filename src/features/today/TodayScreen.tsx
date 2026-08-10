import { Link } from 'react-router'
import { useLiveQuery } from 'dexie-react-hooks'
import type { Profile } from '@/domain/types'
import { todayIso } from '@/domain/dates'
import { planRepo } from '@/db/planRepo'
import { sessionLogRepo } from '@/db/repositories'
import { formatDateLong } from '@/lib/format'
import { Callout, Spinner } from '@/components/ui'
import { Screen, ScreenHeader } from '@/app/AppShell'
import { useTargets } from '../shared/useTargets'
import { PlanRenewalCard, PlanSetupCard } from '../shared/GenerateCards'
import { SessionCard } from '../training/SessionCard'
import { DietDayPanel } from '../diet/DietDayPanel'
import { isMeasurementDay, WeeklyCheckInCard } from './WeeklyCheckInCard'

export function TodayScreen({ profile }: { profile: Profile }) {
  const today = todayIso()
  const state = useTargets(profile)

  const training = useLiveQuery(async () => {
    const [plan, sessions, logs, next, timeline] = await Promise.all([
      planRepo.active(),
      planRepo.sessionsOnDate(today),
      sessionLogRepo.byDate(today),
      planRepo.nextSession(today),
      planRepo.timeline(today),
    ])
    return { plan, sessions, logs, next, timeline }
  }, [today])

  if (!state || !training) return <Spinner />

  const logByPlanned = new Map(
    training.logs.filter((l) => l.plannedSessionId).map((l) => [l.plannedSessionId as string, l]),
  )
  const todaySessions = training.sessions
  const hasTrainingToday = todaySessions.some((s) => s.type !== 'rest')

  return (
    <Screen>
      <ScreenHeader title={`Cześć, ${profile.name}`} subtitle={formatDateLong(today)} />

      {!training.plan ? (
        <PlanSetupCard profile={profile} />
      ) : training.timeline?.isFinished ? (
        // Plan wyczerpany — bez tego ekran pokazywałby puste miejsce.
        <PlanRenewalCard profile={profile} timeline={training.timeline} />
      ) : (
        <div className="grid gap-2">
          {todaySessions.map((session) => (
            <SessionCard
              key={session.id}
              session={session}
              log={logByPlanned.get(session.id)}
            />
          ))}

          {!hasTrainingToday && training.next && (
            <Callout title="Najbliższy trening">
              <Link to={`/trening/${training.next.id}`} className="text-[var(--color-accent)]">
                {formatDateLong(training.next.date)} →
              </Link>
            </Callout>
          )}

          {/* Dopisywanie treningu poza planem żyje w zakładce Plan, pod
              konkretnym dniem — tam da się też uzupełnić wczorajszy trening,
              czego ekran „Dziś" z natury nie potrafi. */}

          {training.timeline?.isFinalWeek && (
            <PlanRenewalCard profile={profile} timeline={training.timeline} />
          )}
        </div>
      )}

      <DietDayPanel profile={profile} date={today} targets={state.targets} />

      {/* Waga i obwody: RAZ W TYGODNIU, w sobotę — jedna karta, bo to jedna
          czynność. W pozostałe dni ekran o nie nie pyta; wpis z opóźnieniem
          zrobisz z ekranu Profil. Karty „Zapotrzebowanie" tu nie ma: te liczby
          nie zmieniają się z dnia na dzień, więc ich miejsce jest w Profilu. */}
      {isMeasurementDay(today) && <WeeklyCheckInCard today={today} />}

    </Screen>
  )
}
