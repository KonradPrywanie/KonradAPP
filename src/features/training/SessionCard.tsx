import { Link } from 'react-router'
import type { PlannedSession, SessionLog, SessionStatus } from '@/domain/types'
import { sessionLogRepo } from '@/db/repositories'
import { SESSION_TYPE_LABELS, WEEKDAY_LABELS } from '@/lib/labels'
import { sessionSummary, sessionTitle } from '@/lib/format'
import { Badge } from '@/components/ui'

const STATUS_TONE: Record<SessionStatus, 'ok' | 'warn' | 'danger'> = {
  done: 'ok',
  partial: 'warn',
  skipped: 'danger',
}

const STATUS_LABEL: Record<SessionStatus, string> = {
  done: 'wykonane',
  partial: 'częściowo',
  skipped: 'pominięte',
}

export function SessionCard({
  session,
  log,
  extraLogs = [],
  showWeekday = false,
  onAddExtra,
}: {
  session: PlannedSession
  log: SessionLog | undefined
  /** Treningi dopisane poza planem w tym dniu. */
  extraLogs?: readonly SessionLog[]
  showWeekday?: boolean
  /** Gdy podane, karta dostaje wiersz akcji z dopisaniem treningu. */
  onAddExtra?: () => void
}) {
  const isRest = session.type === 'rest'

  const body = (
    <div className="flex items-start justify-between gap-2">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          {showWeekday && (
            <span className="text-xs font-medium text-[var(--color-text-dim)]">
              {WEEKDAY_LABELS[session.dayOfWeek]}
            </span>
          )}
          {session.phase === 'deload' && <Badge tone="accent">deload</Badge>}
          {session.phase === 'taper' && <Badge tone="accent">tapering</Badge>}
          {log && <Badge tone={STATUS_TONE[log.status]}>{STATUS_LABEL[log.status]}</Badge>}
        </div>
        <p className={`mt-0.5 font-medium ${isRest ? 'text-[var(--color-text-dim)]' : ''}`}>
          {sessionTitle(session)}
        </p>
        <p className="mt-0.5 text-sm text-[var(--color-text-dim)]">{sessionSummary(session)}</p>
      </div>
      {!isRest && <span className="text-[var(--color-text-dim)]">›</span>}
    </div>
  )

  return (
    <div
      className={`rounded-2xl border p-3 ${
        isRest
          ? 'border-dashed border-[var(--color-border)] bg-transparent'
          : 'border-[var(--color-border)] bg-[var(--color-surface)]'
      }`}
    >
      {/* Dzień odpoczynku nie ma czego logować z planu — nie jest klikalny.
          Link obejmuje TYLKO treść sesji: przycisk dopisania musi zostać poza
          nim, bo zagnieżdżony w linku nie dałby się kliknąć osobno. */}
      {isRest ? body : <Link to={`/trening/${session.id}`} className="block">{body}</Link>}

      {extraLogs.length > 0 && (
        <ul className="mt-2 grid gap-1 border-t border-[var(--color-border)] pt-2">
          {extraLogs.map((extra) => (
            <ExtraLogRow key={extra.id} log={extra} />
          ))}
        </ul>
      )}

      {onAddExtra && (
        <div className="mt-2 border-t border-[var(--color-border)] pt-2">
          <button
            type="button"
            onClick={onAddExtra}
            className="min-h-11 text-sm text-[var(--color-accent)]"
          >
            + Dopisz trening poza planem
          </button>
        </div>
      )}
    </div>
  )
}

/** Wiersz treningu dopisanego poza planem. */
function ExtraLogRow({ log }: { log: SessionLog }) {
  const details = [
    log.durationMin ? `${log.durationMin} min` : null,
    log.sessionRpe ? `RPE ${log.sessionRpe}` : null,
  ].filter(Boolean)

  return (
    <li className="flex items-center justify-between gap-2 text-sm">
      <span className="min-w-0">
        <Badge tone="accent">poza planem</Badge>{' '}
        <span>{SESSION_TYPE_LABELS[log.type]}</span>
        {details.length > 0 && (
          <span className="text-[var(--color-text-dim)]"> · {details.join(' · ')}</span>
        )}
      </span>
      <button
        type="button"
        onClick={() => sessionLogRepo.undoLog(log.id)}
        className="shrink-0 text-xs text-[var(--color-danger)]"
      >
        usuń
      </button>
    </li>
  )
}
