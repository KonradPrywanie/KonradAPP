import type { ReactNode } from 'react'

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 ${className}`}
    >
      {children}
    </div>
  )
}

export function SectionTitle({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <div className="mb-4">
      <h2 className="text-xl font-semibold">{children}</h2>
      {hint && <p className="mt-1 text-sm text-[var(--color-text-dim)]">{hint}</p>}
    </div>
  )
}

export function Button({
  children,
  onClick,
  variant = 'primary',
  disabled = false,
  type = 'button',
  className = '',
}: {
  children: ReactNode
  onClick?: () => void
  variant?: 'primary' | 'ghost' | 'danger'
  disabled?: boolean
  type?: 'button' | 'submit'
  className?: string
}) {
  const styles = {
    primary:
      'bg-[var(--color-accent-strong)] text-[#04141f] font-semibold hover:bg-[var(--color-accent)]',
    ghost:
      'border border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)]',
    danger: 'bg-[var(--color-danger)] text-[#2b0707] font-semibold',
  }[variant]

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`min-h-11 rounded-xl px-5 transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${styles} ${className}`}
    >
      {children}
    </button>
  )
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-[var(--color-text-dim)]">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-[var(--color-text-dim)]">{hint}</span>}
    </label>
  )
}

/**
 * Grupa wyboru — dla zestawów PRZYCISKÓW, nie pól formularza.
 *
 * `Field` renderuje `<label>`, co jest poprawne dla pojedynczego pola, ale
 * błędne dla grupy przycisków: `<label>` obejmujący przyciski sprawia, że
 * nazwa dostępna przycisku liczy się z treści całej etykiety, więc czytnik
 * ekranu odczytuje „Co to było Siłowy Bieganie Pływanie Spacer" zamiast
 * „Siłowy". Tu używamy `role="group"` z własną etykietą.
 */
export function FieldGroup({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <div role="group" aria-label={label}>
      <span className="mb-1.5 block text-sm font-medium text-[var(--color-text-dim)]">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-[var(--color-text-dim)]">{hint}</span>}
    </div>
  )
}

const inputClass =
  'w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2.5 ' +
  'text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]'

export function TextInput({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
}) {
  return (
    <input
      className={inputClass}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

export function NumberInput({
  value,
  onChange,
  min,
  max,
  step = 1,
  suffix,
  placeholder,
}: {
  value: number | null
  onChange: (value: number | null) => void
  min?: number
  max?: number
  step?: number
  suffix?: string
  placeholder?: string
}) {
  return (
    <div className="relative">
      <input
        type="number"
        inputMode="decimal"
        className={inputClass}
        value={value ?? ''}
        min={min}
        max={max}
        step={step}
        placeholder={placeholder}
        onChange={(e) => {
          const raw = e.target.value
          onChange(raw === '' ? null : Number(raw))
        }}
      />
      {suffix && (
        <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-sm text-[var(--color-text-dim)]">
          {suffix}
        </span>
      )}
    </div>
  )
}

export function DateInput({
  value,
  onChange,
  min,
}: {
  value: string
  onChange: (value: string) => void
  min?: string
}) {
  return (
    <input
      type="date"
      className={inputClass}
      value={value}
      min={min}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

export interface ChipOption<T extends string> {
  value: T
  label: string
  hint?: string
}

/** Wybór jednokrotny. Duże pola dotyku — to interfejs mobilny. */
export function ChipRadio<T extends string>({
  options,
  value,
  onChange,
  columns = 1,
}: {
  options: ChipOption<T>[]
  value: T
  onChange: (value: T) => void
  /**
   * Trzy kolumny są dla wyborów z krótkimi etykietami („2500 kcal") — przy
   * dłuższych tekst łamie się na telefonie i pola przestają być równe.
   * Klasy siatki wypisujemy jawnie, bo Tailwind skanuje kod jako TEKST
   * i `grid-cols-${n}` nie trafiłoby do arkusza.
   */
  columns?: 1 | 2 | 3
}) {
  const grid = columns === 3 ? 'grid-cols-3' : columns === 2 ? 'grid-cols-2' : 'grid-cols-1'
  return (
    <div className={`grid gap-2 ${grid}`}>
      {options.map((opt) => {
        const active = opt.value === value
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className={`min-h-11 rounded-xl border px-3 py-2.5 text-left transition-colors ${
              active
                ? 'border-[var(--color-accent)] bg-[var(--color-accent-strong)]/15'
                : 'border-[var(--color-border)] bg-[var(--color-surface-2)]'
            }`}
          >
            <span className="block text-sm font-medium">{opt.label}</span>
            {opt.hint && (
              <span className="mt-0.5 block text-xs text-[var(--color-text-dim)]">{opt.hint}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}

/** Wybór wielokrotny. */
export function ChipMulti<T extends string>({
  options,
  values,
  onChange,
}: {
  options: ChipOption<T>[]
  values: T[]
  onChange: (values: T[]) => void
}) {
  function toggle(v: T) {
    onChange(values.includes(v) ? values.filter((x) => x !== v) : [...values, v])
  }
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((opt) => {
        const active = values.includes(opt.value)
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => toggle(opt.value)}
            className={`min-h-11 rounded-xl border px-4 text-sm transition-colors ${
              active
                ? 'border-[var(--color-accent)] bg-[var(--color-accent-strong)]/15 font-medium'
                : 'border-[var(--color-border)] bg-[var(--color-surface-2)]'
            }`}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}

export function Callout({
  tone = 'info',
  title,
  children,
}: {
  tone?: 'info' | 'warn' | 'danger'
  title?: string
  children: ReactNode
}) {
  const color = {
    info: 'var(--color-accent)',
    warn: 'var(--color-warn)',
    danger: 'var(--color-danger)',
  }[tone]

  return (
    <div
      className="rounded-xl border-l-4 bg-[var(--color-surface-2)] p-3 text-sm"
      style={{ borderLeftColor: color }}
    >
      {title && (
        <p className="mb-1 font-semibold" style={{ color }}>
          {title}
        </p>
      )}
      <div className="text-[var(--color-text-dim)]">{children}</div>
    </div>
  )
}

export function Stat({
  label,
  value,
  unit,
  hint,
}: {
  label: string
  value: string | number
  unit?: string
  hint?: string
}) {
  return (
    <div className="rounded-xl bg-[var(--color-surface-2)] p-3">
      <p className="text-xs tracking-wide text-[var(--color-text-dim)] uppercase">{label}</p>
      <p className="mt-1 text-2xl font-semibold">
        {value}
        {unit && <span className="ml-1 text-sm font-normal text-[var(--color-text-dim)]">{unit}</span>}
      </p>
      {hint && <p className="mt-0.5 text-xs text-[var(--color-text-dim)]">{hint}</p>}
    </div>
  )
}

/** Panel wysuwany od dołu — zamienniki posiłków, logowanie odstępstwa. */
export function Sheet({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
}) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center">
      <button
        type="button"
        aria-label="Zamknij"
        onClick={onClose}
        className="absolute inset-0 bg-black/60"
      />
      <div className="relative max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-t-3xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 pb-8">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-lg font-semibold">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            className="min-h-11 px-3 text-2xl leading-none text-[var(--color-text-dim)]"
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

export function Checkbox({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: ReactNode
  hint?: ReactNode
}) {
  return (
    /**
     * `role="checkbox"` i `aria-checked` są tu konieczne, nie kosmetyczne.
     * Bez nich czytnik ekranu ogłasza „przycisk, Marchew 480 g" i nie mówi,
     * czy pozycja jest już kupiona — a to jedyna informacja, po którą sięga się
     * na tej liście. Nazwę bierze z treści etykiety, która jest w środku.
     */
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex min-h-11 w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-[var(--color-surface-2)]"
    >
      <span
        aria-hidden="true"
        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md border-2 text-sm ${
          checked
            ? 'border-[var(--color-accent)] bg-[var(--color-accent-strong)] text-[#04141f]'
            : 'border-[var(--color-border)]'
        }`}
      >
        {checked ? '✓' : ''}
      </span>
      <span className="flex-1">
        <span className={`block ${checked ? 'text-[var(--color-text-dim)] line-through' : ''}`}>
          {label}
        </span>
        {hint && <span className="block text-xs text-[var(--color-text-dim)]">{hint}</span>}
      </span>
    </button>
  )
}

/** Wskaźnik postępu wypełnienia celu — kalorie, makro. */
export function ProgressBar({
  value,
  max,
  tone = 'accent',
}: {
  value: number
  max: number
  tone?: 'accent' | 'warn' | 'ok'
}) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0
  const color = {
    accent: 'var(--color-accent)',
    warn: 'var(--color-warn)',
    ok: 'var(--color-ok)',
  }[tone]
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-border)]">
      <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
    </div>
  )
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode
  tone?: 'neutral' | 'ok' | 'warn' | 'danger' | 'accent'
}) {
  const styles = {
    neutral: 'bg-[var(--color-surface-2)] text-[var(--color-text-dim)]',
    ok: 'bg-[var(--color-ok)]/20 text-[var(--color-ok)]',
    warn: 'bg-[var(--color-warn)]/20 text-[var(--color-warn)]',
    danger: 'bg-[var(--color-danger)]/20 text-[var(--color-danger)]',
    accent: 'bg-[var(--color-accent-strong)]/20 text-[var(--color-accent)]',
  }[tone]
  return (
    <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${styles}`}>
      {children}
    </span>
  )
}

export function Spinner({ label = 'Wczytywanie…' }: { label?: string }) {
  return <p className="p-6 text-sm text-[var(--color-text-dim)]">{label}</p>
}

export function StepDots({ total, current }: { total: number; current: number }) {
  return (
    <div className="flex gap-1.5">
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          className={`h-1.5 flex-1 rounded-full ${
            i <= current ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-border)]'
          }`}
        />
      ))}
    </div>
  )
}
