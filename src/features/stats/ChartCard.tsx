import { useState, type ReactNode } from 'react'
import { Card, SectionTitle } from '@/components/ui'
import { CHART } from './chartTheme'

export interface LegendItem {
  label: string
  color: string
  /** Kreska zamiast kwadratu — dla serii liniowych. */
  shape?: 'square' | 'line'
}

export interface TableView {
  headers: readonly string[]
  rows: readonly (readonly (string | number)[])[]
}

/**
 * Karta wykresu.
 *
 * Każdy wykres ma bliźniaczy widok tabelaryczny — wartość nigdy nie jest
 * dostępna wyłącznie przez kolor albo najechanie kursorem. To wymóg
 * dostępności, ale też praktyczna wygoda: z tabeli da się odczytać dokładną
 * liczbę, której z wykresu się nie odczyta.
 *
 * Wysokość kontenera obejmuje pasmo osi X — inaczej karta dostaje własny
 * mały pasek przewijania, a etykiety osi się nie mieszczą.
 */
export function ChartCard({
  title,
  hint,
  legend,
  table,
  isEmpty,
  emptyMessage,
  children,
}: {
  title: string
  hint?: string
  legend?: readonly LegendItem[]
  table: TableView
  isEmpty: boolean
  emptyMessage: string
  children: ReactNode
}) {
  const [showTable, setShowTable] = useState(false)

  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <SectionTitle hint={hint}>{title}</SectionTitle>
        </div>
        {!isEmpty && (
          <button
            type="button"
            onClick={() => setShowTable((v) => !v)}
            className="min-h-11 shrink-0 px-2 text-sm text-[var(--color-accent)] print:hidden"
          >
            {showTable ? 'Wykres' : 'Tabela'}
          </button>
        )}
      </div>

      {isEmpty ? (
        <p className="text-sm text-[var(--color-text-dim)]">{emptyMessage}</p>
      ) : (
        <>
          {/* Legenda przy dwóch lub więcej seriach — tożsamość nigdy nie
              opiera się wyłącznie na kolorze. */}
          {legend && legend.length >= 2 && (
            <ul className="mb-3 flex flex-wrap gap-x-4 gap-y-1">
              {legend.map((item) => (
                <li
                  key={item.label}
                  className="flex items-center gap-1.5 text-xs text-[var(--color-text-dim)]"
                >
                  <span
                    aria-hidden
                    className="inline-block shrink-0"
                    style={
                      item.shape === 'line'
                        ? { width: 12, height: 2, background: item.color, borderRadius: 1 }
                        : { width: 10, height: 10, background: item.color, borderRadius: 2 }
                    }
                  />
                  {item.label}
                </li>
              ))}
            </ul>
          )}

          {showTable ? <DataTable table={table} /> : children}
        </>
      )}
    </Card>
  )
}

function DataTable({ table }: { table: TableView }) {
  return (
    <div className="-mx-1 overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-[var(--color-border)]">
            {table.headers.map((header, index) => (
              <th
                key={header}
                className={`px-1 py-1.5 font-medium text-[var(--color-text-dim)] ${
                  index === 0 ? 'text-left' : 'text-right'
                }`}
              >
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row) => (
            <tr key={String(row[0])} className="border-b border-[var(--color-border)]/50">
              {row.map((cell, index) => (
                <td
                  key={index}
                  className={`px-1 py-1.5 ${
                    index === 0
                      ? 'text-left'
                      : // Kolumny liczbowe wyrównane pionowo — tu tabular-nums
                        // ma sens, w przeciwieństwie do dużych liczb w kaflach.
                        'text-right [font-variant-numeric:tabular-nums]'
                  }`}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export interface TooltipRow {
  label: string
  value: string
  color?: string
}

/**
 * Podpowiedź pod kursorem.
 *
 * Tekst nosi tokeny tekstu, nigdy koloru danych — jasny odcień serii jest
 * nieczytelny jako tekst. Tożsamość niesie kolorowy znacznik OBOK etykiety.
 */
export function ChartTooltip({ title, rows }: { title: string; rows: readonly TooltipRow[] }) {
  return (
    <div
      className="rounded-lg border border-[var(--color-border)] px-2.5 py-2 text-xs shadow-lg"
      style={{ background: CHART.surface }}
    >
      <p className="mb-1 font-medium text-[var(--color-text)]">{title}</p>
      <ul className="grid gap-0.5">
        {rows.map((row) => (
          <li key={row.label} className="flex items-center gap-2">
            {row.color && (
              <span
                aria-hidden
                className="inline-block h-2 w-2 shrink-0 rounded-sm"
                style={{ background: row.color }}
              />
            )}
            <span className="text-[var(--color-text-dim)]">{row.label}</span>
            <span className="ml-auto text-[var(--color-text)] [font-variant-numeric:tabular-nums]">
              {row.value}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
