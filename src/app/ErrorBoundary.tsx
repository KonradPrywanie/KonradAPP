import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * Ostatnia linia obrony przed białym ekranem.
 *
 * Aplikacja jest local-first: dane są w przeglądarce, nie na serwerze, więc
 * „odśwież i spróbuj jeszcze raz" to nie tylko niedogodność — bez tego ekranu
 * błąd w renderowaniu JEDNEGO ekranu wygląda jak utrata wszystkiego. Biała
 * strona nie mówi też, że dane są całe, ani gdzie po nie sięgnąć.
 *
 * Dlatego pokazujemy trzy rzeczy: że dane są nietknięte, treść błędu (do
 * przekazania dalej) i drogę wyjścia — powrót na ekran główny albo restart.
 * Kopia zapasowa jest wprost w podpowiedzi, bo to jedyna realna ochrona przy
 * lokalnym magazynie.
 *
 * Klasa, nie hook: React nie ma hookowego odpowiednika
 * `componentDidCatch`/`getDerivedStateFromError`.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  override state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Konsola to jedyne miejsce, w którym ten ślad da się jeszcze zobaczyć —
    // zdalnego logowania w tej aplikacji nie ma i mieć nie musi.
    console.error('Błąd renderowania:', error, info.componentStack)
  }

  override render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="mx-auto grid min-h-dvh max-w-md content-center gap-4 p-6 text-[var(--color-text)]">
        <div>
          <h1 className="text-xl font-semibold">Coś się zacięło</h1>
          <p className="mt-2 text-sm text-[var(--color-text-dim)]">
            Ten ekran się nie wyświetlił, ale <strong>Twoje dane są całe</strong> — waga, treningi
            i jadłospis siedzą w pamięci przeglądarki i nic ich nie ruszyło.
          </p>
        </div>

        <pre className="overflow-x-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-xs whitespace-pre-wrap">
          {error.message || String(error)}
        </pre>

        <div className="grid gap-2">
          <button
            type="button"
            onClick={() => {
              this.setState({ error: null })
              window.location.assign('/')
            }}
            className="min-h-11 rounded-xl bg-[var(--color-accent-strong)] px-4 font-medium text-[#04141f]"
          >
            Wróć na ekran główny
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="min-h-11 rounded-xl border border-[var(--color-border)] px-4"
          >
            Odśwież aplikację
          </button>
        </div>

        {/**
         * Bez odsyłania do kopii zapasowej: karta „Kopia zapasowa" jest w tej
         * wersji UKRYTA (patrz `ProfileScreen`), więc instrukcja „zrób kopię
         * w Profilu" prowadziłaby w miejsce, którego nie ma. Ekran awaryjny to
         * ostatnie miejsce, w którym wolno wysłać człowieka po nic.
         */}
        <p className="text-xs text-[var(--color-text-dim)]">
          Jeśli to się powtarza, przepisz treść błędu powyżej — po niej da się znaleźć przyczynę.
          Odświeżenie i ponowna instalacja aplikacji nie usuwają danych z tej przeglądarki.
        </p>
      </div>
    )
  }
}
