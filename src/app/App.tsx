import { Suspense, lazy } from 'react'
import { Navigate, Route, Routes } from 'react-router'
import { useLiveQuery } from 'dexie-react-hooks'
import { profileRepo } from '@/db/repositories'
import { Spinner } from '@/components/ui'
import { AppShell } from './AppShell'
import { TodayScreen } from '@/features/today/TodayScreen'
import { PlanScreen } from '@/features/training/PlanScreen'
import { SessionScreen } from '@/features/training/SessionScreen'
import { DietScreen } from '@/features/diet/DietScreen'
import { ShoppingScreen } from '@/features/shopping/ShoppingScreen'
import { ProfileScreen } from '@/features/profile/ProfileScreen'
import { ProfileWizard } from '@/features/profile/ProfileWizard'
import { QuickStartScreen } from '@/features/profile/QuickStartScreen'

/**
 * Ekran postępów ładowany leniwie.
 *
 * Recharts waży ~400 kB nieskompresowanego kodu — tyle, co cała reszta
 * aplikacji. Jest potrzebny na jednym ekranie z sześciu, więc trzymanie go
 * w głównym pakiecie opóźniałoby pierwsze uruchomienie na telefonie za każdym
 * razem. Service worker i tak precache'uje ten fragment, więc tryb offline
 * pozostaje nietknięty — zmienia się tylko to, kiedy przeglądarka go parsuje.
 */
const StatsScreen = lazy(() =>
  import('@/features/stats/StatsScreen').then((module) => ({ default: module.StatsScreen })),
)

export function App() {
  // Zawijamy w obiekt, żeby odróżnić „jeszcze się wczytuje" (undefined)
  // od „wczytane, ale profilu nie ma" ({ profile: undefined }).
  const state = useLiveQuery(async () => ({ profile: await profileRepo.get() }), [])

  if (!state) return <Spinner />

  /**
   * Bez profilu nie da się policzyć niczego.
   *
   * Domyślną drogą jest ekran szybkiego startu: profil jest w tej wersji znany
   * z góry (`PRESET_PROFILE`), więc pytamy tylko o wagę. Pełny kreator zostaje
   * dostępny pod `/profil/kreator` dla innego profilu.
   */
  if (!state.profile) {
    return (
      <Routes>
        <Route path="/profil/kreator" element={<ProfileWizard />} />
        <Route path="/start" element={<QuickStartScreen />} />
        <Route path="*" element={<Navigate to="/start" replace />} />
      </Routes>
    )
  }

  const profile = state.profile

  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<TodayScreen profile={profile} />} />
        <Route path="/plan" element={<PlanScreen profile={profile} />} />
        <Route path="/trening/:sessionId" element={<SessionScreen />} />
        <Route path="/dieta" element={<DietScreen profile={profile} />} />
        <Route path="/zakupy" element={<ShoppingScreen />} />
        <Route
          path="/postepy"
          element={
            <Suspense fallback={<Spinner />}>
              <StatsScreen />
            </Suspense>
          }
        />
        <Route path="/profil" element={<ProfileScreen profile={profile} />} />
        <Route path="/profil/kreator" element={<Navigate to="/profil" replace />} />
        <Route path="/start" element={<Navigate to="/" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  )
}
