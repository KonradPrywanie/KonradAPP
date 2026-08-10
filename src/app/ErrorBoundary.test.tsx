// @vitest-environment jsdom
/**
 * Granica błędu to jedyne miejsce, w którym aplikacja mówi cokolwiek po awarii
 * renderowania. Bez testu byłaby obietnicą bez dowodu — a sprawdzić ją da się
 * tylko przez komponent, który faktycznie rzuca.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ErrorBoundary } from './ErrorBoundary'

function Boom(): never {
  throw new Error('Coś pękło w renderze')
}

describe('ErrorBoundary', () => {
  beforeEach(() => {
    // React wypisuje przechwycony błąd na konsolę — w teście to szum.
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('przepuszcza dzieci, gdy nic nie rzuca', () => {
    render(
      <ErrorBoundary>
        <p>Ekran działa</p>
      </ErrorBoundary>,
    )
    expect(screen.getByText('Ekran działa')).toBeDefined()
  })

  it('KRYTYCZNE: zamiast białego ekranu pokazuje treść błędu i drogę wyjścia', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    )

    expect(screen.getByText('Coś się zacięło')).toBeDefined()
    // Treść błędu jest widoczna — bez niej nie ma czego zgłosić ani sprawdzić.
    expect(screen.getByText('Coś pękło w renderze')).toBeDefined()
    // Dwa wyjścia: ekran główny i restart.
    expect(screen.getByRole('button', { name: 'Wróć na ekran główny' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Odśwież aplikację' })).toBeDefined()
  })

  it('KRYTYCZNE: mówi wprost, że dane są całe', () => {
    // Przy magazynie lokalnym biały ekran wygląda jak utrata wszystkiego —
    // i to jest pierwsza rzecz, którą trzeba zdementować.
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    )
    expect(screen.getByText(/Twoje dane są całe/)).toBeDefined()
    expect(screen.getByText(/nie usuwają danych z tej przeglądarki/)).toBeDefined()
  })

  it('KRYTYCZNE: nie odsyła do ekranu, którego nie ma', () => {
    /**
     * Pierwsza wersja tego ekranu radziła „zrób kopię danych w Profilu (Kopia
     * zapasowa → Pobierz kopię)" — a ta karta jest w tej wersji UKRYTA. Ekran
     * awaryjny to ostatnie miejsce, w którym wolno wysłać człowieka po nic.
     */
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    )
    expect(screen.queryByText(/Kopia zapasowa/)).toBeNull()
    expect(screen.queryByText(/Pobierz kopię/)).toBeNull()
  })
})
