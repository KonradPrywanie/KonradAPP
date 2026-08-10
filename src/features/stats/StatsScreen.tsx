import { useState } from 'react'
import { Link } from 'react-router'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { BodyMetric } from '@/domain/types'
import { weightTrend } from '@/domain/calc'
import {
  adherence,
  bodyMetricSeries,
  measuredMetrics,
  withinRange,
  type RangeDays,
} from '@/domain/stats/aggregate'
import { todayIso } from '@/domain/dates'
import {
  BODY_METRICS,
  bodyMeasurementRepo,
  sessionLogRepo,
  weightRepo,
} from '@/db/repositories'
import { BODY_METRIC_LABELS } from '@/lib/labels'
import { measurementsLabel, pl, signed } from '@/lib/format'
import { Card, SectionTitle, Spinner, Stat } from '@/components/ui'
import { Screen, ScreenHeader } from '@/app/AppShell'
import { ChartCard, ChartTooltip } from './ChartCard'
import { AXIS_PROPS, CHART, shortDate } from './chartTheme'

const RANGES: { value: RangeDays; label: string }[] = [
  { value: 7, label: '7 dni' },
  { value: 30, label: '30 dni' },
  { value: null, label: 'wszystko' },
]

/** Wysokość obejmuje pasmo osi X — inaczej karta dostaje własny scroll. */
const CHART_HEIGHT = 200

export function StatsScreen() {
  const today = todayIso()
  // Jeden filtr nad wszystkim, co obejmuje — nie po jednym na wykres.
  const [range, setRange] = useState<RangeDays>(30)
  /**
   * Obwody: JEDNA miara na wykresie, wybierana zakładką.
   *
   * Zwalidowana paleta ma trzy slot kategorialne (patrz `chartTheme.ts`),
   * a miar jest pięć — pięć serii wymusiłoby kolory, które nie przechodzą
   * separacji CVD. Poza tym talia i ramię różnią się o kilkadziesiąt
   * centymetrów, więc na jednej osi zmiana o dwa centymetry w ramieniu byłaby
   * niewidoczna. Wszystkie miary naraz są w widoku tabelarycznym.
   */
  const [metric, setMetric] = useState<BodyMetric>('waistCm')

  /**
   * Ekran pokazuje TRZY rzeczy: realizację planu, masę i obwody.
   *
   * Wykresy kalorii, dystansów i objętości treningowej zostały usunięte na
   * życzenie — przy jednym użytkowniku i dwutygodniowym planie mówiły mniej,
   * niż zajmowały miejsca. Agregacje (`weeklyVolume`, `weeklyDistance`,
   * `dailyKcal`) zostają w `domain/stats/aggregate.ts` wraz z testami: dane
   * nadal są w bazie i w eksporcie CSV, więc przywrócenie wykresu to dodanie
   * karty, nie odtwarzanie warstwy liczącej.
   */
  const data = useLiveQuery(async () => {
    const [entries, logs, measurements] = await Promise.all([
      weightRepo.all(),
      sessionLogRepo.all(),
      bodyMeasurementRepo.all(),
    ])
    return { entries, logs, measurements }
  }, [])

  if (!data) return <Spinner />

  const entries = withinRange(data.entries, today, range)
  const logs = withinRange(data.logs, today, range)
  const measurements = withinRange(data.measurements, today, range)

  const availableMetrics = measuredMetrics(measurements, BODY_METRICS)
  // Zakładka wybrana wcześniej może nie mieć pomiarów w tym zakresie.
  const activeMetric = availableMetrics.includes(metric) ? metric : availableMetrics[0]
  const bodySeries = activeMetric ? bodyMetricSeries(measurements, activeMetric) : null

  const trend = weightTrend(entries)
  const plan = adherence(logs)

  const trendKg = trend.at(-1)?.trendKg ?? null
  const firstTrendKg = trend[0]?.trendKg ?? null
  const trendChange = trendKg !== null && firstTrendKg !== null ? trendKg - firstTrendKg : null

  return (
    <Screen>
      {/* Ten ekran nie ma zakładki w dolnym pasku — bez tego linku nie byłoby
          oczywistej drogi powrotnej tam, skąd się przyszło. */}
      <Link
        to="/profil"
        // Sam znak „‹" czytnik ekranu przeczytałby jako „mniejsze niż".
        aria-label="Wróć do profilu"
        className="-mb-2 inline-block min-h-11 text-sm text-[var(--color-accent)] print:hidden"
      >
        ‹ Profil
      </Link>

      <ScreenHeader
        title="Postępy"
        subtitle="Wszystko liczone z tego, co zalogowałeś — nie z planu."
      />

      <div className="flex gap-1.5 print:hidden">
        {RANGES.map((option) => {
          const active = option.value === range
          return (
            <button
              key={option.label}
              type="button"
              onClick={() => setRange(option.value)}
              className={`min-h-11 flex-1 rounded-xl border px-2 text-sm transition-colors ${
                active
                  ? 'border-[var(--color-accent)] bg-[var(--color-accent-strong)]/15 font-semibold'
                  : 'border-[var(--color-border)] bg-[var(--color-surface-2)]'
              }`}
            >
              {option.label}
            </button>
          )
        })}
      </div>

      {/* Kilka liczb nagłówkowych to rząd kafli, nie wykres. */}
      <Card>
        <SectionTitle hint="Statusy sesji zalogowanych w wybranym zakresie.">
          Realizacja planu
        </SectionTitle>
        {plan.logged === 0 ? (
          <p className="text-sm text-[var(--color-text-dim)]">
            Brak zalogowanych treningów w tym zakresie.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2">
              <StatusTile label="Wykonane" value={plan.done} color={CHART.status.done} />
              <StatusTile label="Częściowo" value={plan.partial} color={CHART.status.partial} />
              <StatusTile label="Pominięte" value={plan.skipped} color={CHART.status.skipped} />
            </div>
            <p className="mt-3 text-sm text-[var(--color-text-dim)]">
              {plan.donePct}% sesji z planu wykonanych w pełni ({plan.logged} zalogowanych).
              {plan.extra > 0 && (
                <>
                  {' '}
                  Poza planem: {plan.extra}
                  {plan.extra === 1 ? ' trening' : ' treningi'} — nie wliczane do
                  realizacji planu.
                </>
              )}
            </p>
          </>
        )}
      </Card>

      {/* ── Masa: jedna seria jest tematem, druga kontekstem ── */}
      <ChartCard
        title="Masa ciała"
        hint="Linia to trend, punkty to pojedyncze pomiary. Decyzje opierają się na trendzie — dobowe wahania nawodnienia to ±1,5 kg."
        isEmpty={trend.length === 0}
        emptyMessage="Brak pomiarów w tym zakresie. Wagę zapiszesz na ekranie Dziś."
        legend={[
          { label: 'Trend', color: CHART.series1, shape: 'line' },
          { label: 'Pomiar', color: CHART.context },
        ]}
        table={{
          headers: ['Data', 'Masa [kg]', 'Trend [kg]'],
          rows: trend.map((point) => [point.date, pl(point.weightKg), pl(point.trendKg, 2)]),
        }}
      >
        <div className="grid grid-cols-2 gap-2">
          <Stat label="Trend teraz" value={trendKg ?? '—'} unit={trendKg ? 'kg' : undefined} />
          <Stat
            label="Zmiana w zakresie"
            value={trendChange !== null ? signed(trendChange, 2) : '—'}
            unit={trendChange !== null ? 'kg' : undefined}
          />
        </div>
        <div className="mt-3" style={{ height: CHART_HEIGHT }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={trend} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
              <CartesianGrid stroke={CHART.grid} strokeDasharray="0" vertical={false} />
              <XAxis dataKey="date" tickFormatter={shortDate} {...AXIS_PROPS} />
              {/* Masa nie zaczyna się od zera — obcięta oś jest tu poprawna. */}
              <YAxis domain={['dataMin - 1', 'dataMax + 1']} width={44} {...AXIS_PROPS} />
              <Tooltip
                cursor={{ stroke: CHART.grid }}
                content={({ active, payload, label }) =>
                  active && payload?.length ? (
                    <ChartTooltip
                      title={String(label)}
                      rows={[
                        {
                          label: 'Trend',
                          value: `${pl(Number(payload.find((p) => p.dataKey === 'trendKg')?.value ?? 0), 2)} kg`,
                          color: CHART.series1,
                        },
                        {
                          label: 'Pomiar',
                          value: `${pl(Number(payload.find((p) => p.dataKey === 'weightKg')?.value ?? 0))} kg`,
                          color: CHART.context,
                        },
                      ]}
                    />
                  ) : null
                }
              />
              <Line
                type="monotone"
                dataKey="weightKg"
                stroke="none"
                strokeWidth={0}
                dot={{ r: 4, fill: CHART.context, stroke: CHART.surface, strokeWidth: 2 }}
                activeDot={{ r: 5, fill: CHART.context, stroke: CHART.surface, strokeWidth: 2 }}
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="trendKg"
                stroke={CHART.series1}
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                dot={false}
                activeDot={{ r: 5, fill: CHART.series1, stroke: CHART.surface, strokeWidth: 2 }}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </ChartCard>

      {/* ── Obwody ciała: jedna miara na raz, wybór zakładką ── */}
      <ChartCard
        title="Pomiary ciała"
        hint="Obwody w centymetrach, wpisywane w sobotę. Pokazują to, czego waga nie pokaże: masa może stać w miejscu, gdy talia schodzi."
        isEmpty={!bodySeries || bodySeries.points.length === 0}
        emptyMessage="Brak pomiarów w tym zakresie. Obwody wpiszesz w sobotę na ekranie Dziś."
        table={{
          headers: ['Data', ...BODY_METRICS.map((m) => `${BODY_METRIC_LABELS[m]} [cm]`)],
          rows: measurements.map((row) => [
            row.date,
            ...BODY_METRICS.map((m) => (row[m] === undefined ? '—' : pl(row[m] as number))),
          ]),
        }}
      >
        {availableMetrics.length > 1 && (
          <div className="mb-3 flex flex-wrap gap-1.5 print:hidden">
            {availableMetrics.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setMetric(option)}
                className={`min-h-11 rounded-xl border px-3 text-sm transition-colors ${
                  option === activeMetric
                    ? 'border-[var(--color-accent)] bg-[var(--color-accent-strong)]/15 font-semibold'
                    : 'border-[var(--color-border)] bg-[var(--color-surface-2)]'
                }`}
              >
                {BODY_METRIC_LABELS[option]}
              </button>
            ))}
          </div>
        )}

        {bodySeries && activeMetric && (
          <>
            <div className="grid grid-cols-2 gap-2">
              <Stat
                label={BODY_METRIC_LABELS[activeMetric]}
                value={bodySeries.last ?? '—'}
                unit={bodySeries.last !== null ? 'cm' : undefined}
              />
              <Stat
                label="Zmiana w zakresie"
                value={bodySeries.changeCm !== null ? signed(bodySeries.changeCm) : '—'}
                unit={bodySeries.changeCm !== null ? 'cm' : undefined}
                hint={measurementsLabel(bodySeries.points.length)}
              />
            </div>
            <div className="mt-3" style={{ height: CHART_HEIGHT }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={bodySeries.points}
                  margin={{ top: 8, right: 8, bottom: 0, left: -12 }}
                >
                  <CartesianGrid stroke={CHART.grid} strokeDasharray="0" vertical={false} />
                  <XAxis dataKey="date" tickFormatter={shortDate} {...AXIS_PROPS} />
                  {/* Obwód nie zaczyna się od zera — obcięta oś jest tu poprawna,
                      tak samo jak przy masie ciała. */}
                  <YAxis domain={['dataMin - 2', 'dataMax + 2']} width={44} {...AXIS_PROPS} />
                  <Tooltip
                    cursor={{ stroke: CHART.grid }}
                    content={({ active, payload, label }) =>
                      active && payload?.length ? (
                        <ChartTooltip
                          title={String(label)}
                          rows={[
                            {
                              label: BODY_METRIC_LABELS[activeMetric],
                              value: `${pl(Number(payload[0]?.value ?? 0))} cm`,
                              color: CHART.series1,
                            },
                          ]}
                        />
                      ) : null
                    }
                  />
                  <Line
                    type="monotone"
                    dataKey="valueCm"
                    stroke={CHART.series1}
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    // Pomiary są tygodniowe, więc punktów jest mało i każdy
                    // z nich jest informacją — nie ukrywamy ich pod linią.
                    dot={{ r: 4, fill: CHART.series1, stroke: CHART.surface, strokeWidth: 2 }}
                    activeDot={{ r: 5, fill: CHART.series1, stroke: CHART.surface, strokeWidth: 2 }}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </>
        )}
      </ChartCard>

    </Screen>
  )
}

/**
 * Kafel statusu.
 *
 * Kolor statusu nigdy nie występuje sam — zawsze z etykietą tekstową.
 * Paleta statusów jest stała i nietematyzowana, więc nie przechodzi
 * wszystkich kontroli palet kategorialnych (patrz `chartTheme.ts`).
 */
function StatusTile({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="rounded-xl bg-[var(--color-surface-2)] p-3">
      <div className="flex items-center gap-1.5">
        <span
          aria-hidden
          className="inline-block h-2 w-2 shrink-0 rounded-full"
          style={{ background: color }}
        />
        <span className="text-xs text-[var(--color-text-dim)]">{label}</span>
      </div>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
    </div>
  )
}
