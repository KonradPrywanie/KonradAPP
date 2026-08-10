import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import type { Profile } from '@/domain/types'
import {
  addDays,
  isoWeekday,
  startOfWeek,
  todayIso,
  weekOrderIndex,
} from '@/domain/dates'
import { dietRepo } from '@/db/dietRepo'
import { WEEKDAY_LABELS } from '@/lib/labels'
import { formatDateLong, formatWeekRange } from '@/lib/format'
import { Badge, Button, Spinner } from '@/components/ui'
import { Screen, ScreenHeader } from '@/app/AppShell'
import { useTargets } from '../shared/useTargets'
import { DietDayPanel } from './DietDayPanel'

export function DietScreen({ profile }: { profile: Profile }) {
  const today = todayIso()
  const thisWeekStart = startOfWeek(today)

  /**
   * Nawigacja po tygodniach.
   *
   * Wcześniej ekran pokazywał wyłącznie tydzień, w którym wypada dzisiaj —
   * nie było jak zajrzeć do następnego ani wygenerować go z wyprzedzeniem,
   * a przy gotowaniu na zapas i zakupach na przyszły tydzień to podstawowa
   * potrzeba. Trzymamy przesunięcie tygodni, nie samą datę, żeby przeskok
   * między tygodniami zachowywał wybrany dzień.
   */
  const [weekOffset, setWeekOffset] = useState(0)
  // Pozycja dnia w tygodniu aplikacji (sobota = 0), nie numer dnia ISO.
  const [dayIndex, setDayIndex] = useState(() => weekOrderIndex(isoWeekday(today)))

  const weekStart = addDays(thisWeekStart, weekOffset * 7)
  const date = addDays(weekStart, dayIndex)
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i))

  const state = useTargets(profile)
  const weeks = useLiveQuery(async () => {
    // Sprawdzamy sąsiednie tygodnie, żeby na przełącznikach dało się pokazać,
    // gdzie jadłospis już jest, a gdzie trzeba go wygenerować.
    const [current, next, previous] = await Promise.all([
      dietRepo.hasWeek(weekStart),
      dietRepo.hasWeek(addDays(weekStart, 7)),
      dietRepo.hasWeek(addDays(weekStart, -7)),
    ])
    return { current, next, previous }
  }, [weekStart])

  if (!state) return <Spinner />

  return (
    <Screen>
      <ScreenHeader
        title="Jadłospis"
        subtitle={formatDateLong(date)}
        action={weekOffset !== 0 ? <Badge tone="accent">{weekLabel(weekOffset)}</Badge> : undefined}
      />

      <div className="flex items-center gap-2 print:hidden">
        <Button variant="ghost" onClick={() => setWeekOffset((v) => v - 1)}>
          ‹
        </Button>
        <div className="flex-1 text-center">
          {/* Tydzień od soboty do piątku — ten sam podział, co plan i zakupy. */}
          <p className="text-sm">{formatWeekRange(weekStart, addDays(weekStart, 6))}</p>
          <p className="text-xs text-[var(--color-text-dim)]">
            {weeks?.current ? 'jadłospis gotowy' : 'brak jadłospisu'}
          </p>
        </div>
        <Button variant="ghost" onClick={() => setWeekOffset((v) => v + 1)}>
          ›
        </Button>
      </div>

      {weekOffset !== 0 && (
        <Button variant="ghost" onClick={() => setWeekOffset(0)} className="w-full">
          Wróć do bieżącego tygodnia
        </Button>
      )}

      <div className="flex gap-1.5">
        {days.map((day, index) => {
          const active = index === dayIndex
          return (
            <button
              key={day}
              type="button"
              onClick={() => setDayIndex(index)}
              className={`min-h-14 flex-1 rounded-xl border text-sm transition-colors ${
                active
                  ? 'border-[var(--color-accent)] bg-[var(--color-accent-strong)]/15 font-semibold'
                  : 'border-[var(--color-border)] bg-[var(--color-surface-2)]'
              } ${day === today ? 'ring-1 ring-[var(--color-accent)]/40' : ''}`}
            >
              <span className="block text-xs text-[var(--color-text-dim)]">
                {WEEKDAY_LABELS[isoWeekday(day)]}
              </span>
              {Number(day.slice(-2))}
            </button>
          )
        })}
      </div>

      <DietDayPanel profile={profile} date={date} targets={state.targets} />
    </Screen>
  )
}

function weekLabel(offset: number): string {
  if (offset === 1) return 'następny tydzień'
  if (offset === -1) return 'poprzedni tydzień'
  const weeks = Math.abs(offset)
  return offset > 0 ? `za ${weeks} tyg.` : `${weeks} tyg. temu`
}
