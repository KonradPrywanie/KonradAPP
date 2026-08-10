import type { ReactNode } from 'react'
import { NavLink } from 'react-router'

/**
 * Zakładki dolnego paska.
 *
 * Postępy tu NIE MA — są pod przyciskiem na ekranie Profil. Sześć zakładek
 * na szerokości 375 px dawało po 62 px na etykietę, co ściskało napisy.
 * Postępy są ekranem, do którego zagląda się raz na jakiś czas, a nie
 * codziennie jak „Dziś" czy „Dieta" — więc to one ustępują miejsca.
 */
const TABS: { to: string; label: string; icon: string }[] = [
  { to: '/', label: 'Dziś', icon: '◉' },
  { to: '/plan', label: 'Plan', icon: '▤' },
  { to: '/dieta', label: 'Dieta', icon: '◍' },
  { to: '/zakupy', label: 'Zakupy', icon: '☰' },
  { to: '/profil', label: 'Profil', icon: '☺' },
]

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-full">
      {/* Dolny margines na wysokość paska nawigacji plus obszar bezpieczny iOS. */}
      <main className="pb-24">{children}</main>

      <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-[var(--color-border)] bg-[var(--color-bg)]/95 backdrop-blur print:hidden">
        <div className="mx-auto flex max-w-lg">
          {TABS.map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              end={tab.to === '/'}
              className={({ isActive }) =>
                `flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-xs transition-colors ${
                  isActive ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-dim)]'
                }`
              }
            >
              <span className="text-lg leading-none">{tab.icon}</span>
              {tab.label}
            </NavLink>
          ))}
        </div>
      </nav>
    </div>
  )
}

export function ScreenHeader({
  title,
  subtitle,
  action,
}: {
  title: string
  subtitle?: string
  action?: ReactNode
}) {
  return (
    <header className="mb-4 flex items-start justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-[var(--color-text-dim)]">{subtitle}</p>}
      </div>
      {action}
    </header>
  )
}

export function Screen({ children }: { children: ReactNode }) {
  return <div className="mx-auto flex max-w-lg flex-col gap-4 p-4">{children}</div>
}
