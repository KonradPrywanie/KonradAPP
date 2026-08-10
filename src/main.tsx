import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import { App } from './app/App'
import { ErrorBoundary } from './app/ErrorBoundary'
import { requestPersistentStorage } from './db/persist'
import './styles.css'

// Prosimy o trwały magazyn od razu — im wcześniej, tym większa szansa,
// że przeglądarka zgodzi się bez pytania użytkownika.
void requestPersistentStorage().catch(() => undefined)

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Brak elementu #root')

createRoot(rootEl).render(
  <StrictMode>
    {/* Granica NA ZEWNĄTRZ routera: błąd w renderowaniu ekranu nie może
        zostawić białej strony bez wyjścia — patrz `ErrorBoundary`. */}
    <ErrorBoundary>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>,
)
