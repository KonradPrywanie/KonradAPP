// @vitest-environment jsdom
/**
 * Testy renderowania — jedyna weryfikacja UI, jaka jest tu możliwa.
 *
 * Środowisko blokuje panel przeglądarki dla localhost, więc ekranów nikt nie
 * kliknął. Poprawny typecheck nie wystarcza: nie wyłapie ani złego wywołania
 * hooka, ani brakującego propa przekazywanego w dół, ani wyjątku w renderze.
 * Te testy montują prawdziwy `App` na prawdziwym (podstawionym) IndexedDB
 * i sprawdzają, że każdy ekran się składa i pokazuje właściwe dane.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { configure } from '@testing-library/dom'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import type { Profile, StrengthPayload } from '@/domain/types'
import { macros } from '@/domain/calc/macros'
import { dishCategory, DISH_CATEGORY_LABELS } from '@/domain/diet/category'
import { SWEET_SNACK } from '@/domain/diet/sweetSnack'
import { withoutEatenMeals } from '@/domain/shopping/aggregate'
import { DIET_CATALOG, workoutById } from '@/lib/catalog'
import { addDays, isoWeekday, startOfWeek, todayIso } from '@/domain/dates'
import { isMeasurementDay } from '@/features/today/WeeklyCheckInCard'
import { sessionTitle } from '@/lib/format'
import { db } from '@/db/db'
import {
  bodyMeasurementRepo,
  mealLogRepo,
  profileRepo,
  sessionLogRepo,
  weightRepo,
} from '@/db/repositories'
import { planRepo } from '@/db/planRepo'
import { dietRepo } from '@/db/dietRepo'
import { shoppingRepo } from '@/db/shoppingRepo'
import { App } from './App'

const TARGETS = macros({ kcal: 2207, goal: 'cut', weightKg: 80, heightCm: 180 }).macros

/**
 * Pełny zestaw uruchamia 11 plików równolegle, a te testy montują prawdziwy
 * `App` na prawdziwym IndexedDB — z generowaniem 12-tygodniowych planów
 * i rozwiązywaniem tygodnia jadłospisu. Pod obciążeniem ten plik zwalnia
 * dwukrotnie i domyślny limit 1000 ms na `findBy*` przestaje wystarczać,
 * co dawało przerywane porażki. Asercje są poprawne — za ciasny był limit.
 */
configure({ asyncUtilTimeout: 5000 })

async function seedProfile(): Promise<Profile> {
  return profileRepo.save({
    name: 'Konrad',
    birthYear: 1996,
    sex: 'male',
    heightCm: 180,
    startWeightKg: 80,
    goal: 'cut',
    activityLevel: 'moderate',
    experience: 'intermediate',
    equipment: ['gym', 'dumbbells', 'home', 'running'],
    availableDays: [1, 2, 3, 4, 5, 6, 7],
    emphasis: 'balanced',
    sessionMinutes: 60,
    // Bieganie jest w sprzęcie, więc punkt wyjścia jest WYMAGANY — bez niego
    // plan się nie generuje (patrz `missingPlanInputs`). Basenu tu nie ma,
    // więc `swimBaseline` zostaje pusty i to jest poprawny stan.
    runBaseline: { distanceM: 6000, paceSecPerKm: 330 },
    diet: { style: 'omnivore', allergens: [], dislikedTags: [], excludedProductIds: [] },
    cooking: { weekdayMinutes: 45, prepStyle: 'daily' },
    injuries: [],
    mealSplit: { breakfast: 0.24, lunch: 0.3, afternoon: 0.22, dinner: 0.24 },
    kcalOverride: null,
  })
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  )
}

beforeEach(async () => {
  await db.transaction('rw', db.tables, async () => {
    for (const table of db.tables) await table.clear()
  })
})

/**
 * Uwaga na kształt asercji w tych testach.
 *
 * `App` renderuje ekran wczytywania, dopóki zapytanie o profil się nie
 * rozwiąże. Asercja o BRAKU jakiegoś tekstu spełnia się wtedy natychmiast,
 * bo na ekranie wczytywania nie ma nic — test przechodzi, nie sprawdzając
 * niczego. Dlatego każdy test najpierw czeka (`findBy*`) na pozytywny sygnał,
 * że właściwy ekran się złożył, i tylko potem weryfikuje nieobecność.
 */

describe('bez profilu', () => {
  it('każda ścieżka prowadzi do ekranu startowego, nie do pełnego kreatora', async () => {
    renderAt('/zakupy')
    expect(await screen.findByText('Cześć, Konrad')).toBeDefined()
    expect(screen.getByText('Podstawowe dane')).toBeDefined()
  })

  it('pyta o ciało, cel kaloryczny i punkt wyjścia w cardio — reszta jest z presetu', async () => {
    renderAt('/')
    await screen.findByText('Podstawowe dane')

    expect(screen.getByText('Reszta jest już ustawiona')).toBeDefined()
    expect(screen.getByText('Cel kaloryczny')).toBeDefined()
    expect(screen.getByText('Ile maksymalnie biegasz?')).toBeDefined()
    expect(screen.getByText('Ile maksymalnie przepływasz?')).toBeDefined()
    // Siedem pól: waga, wzrost, rocznik, dystans, minuty i sekundy tempa, długości basenu.
    expect(screen.getAllByRole('spinbutton')).toHaveLength(7)
  })

  it('KRYTYCZNE: cel kaloryczny startuje na presecie, pod ktory jest baza', async () => {
    /**
     * Domyślne 2500 kcal nie jest kosmetyką: przepisy są napisane pod 2500
     * i 3000 kcal, a wyliczenie automatyczne potrafi wypaść poza ten zakres —
     * i wtedy jadłospis nie trafia w cel. Preset ma być stanem wyjściowym,
     * a nie czymś, co trzeba znaleźć w Profilu.
     */
    renderAt('/')
    await screen.findByText('Cel kaloryczny')

    expect(screen.getByRole('button', { name: '2500 kcal' })).toBeDefined()
    expect(screen.getByRole('button', { name: '3000 kcal' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'automatycznie' })).toBeDefined()
  })

  it('KRYTYCZNE: bez danych cardio nie da się zacząć', async () => {
    // Preset nie zawiera punktu wyjścia w bieganiu ani pływaniu, a plan bez
    // nich się nie utworzy — więc nie wolno pozwolić wystartować z pustymi.
    renderAt('/')
    await screen.findByText('Podstawowe dane')

    expect(screen.getByRole('button', { name: 'Zaczynamy' })).toHaveProperty('disabled', true)

    // Same dane ciała to za mało.
    const [weight, height, birthYear] = screen.getAllByRole('spinbutton')
    fireEvent.change(weight as HTMLElement, { target: { value: '86' } })
    fireEvent.change(height as HTMLElement, { target: { value: '182' } })
    fireEvent.change(birthYear as HTMLElement, { target: { value: '1990' } })
    expect(screen.getByRole('button', { name: 'Zaczynamy' })).toHaveProperty('disabled', true)
    expect(screen.getByText(/Brakuje: dystans biegu i tempo/)).toBeDefined()
  })

  it('KRYTYCZNE: waga trafia do profilu I do pomiarów, cardio do profilu', async () => {
    renderAt('/')
    await screen.findByText('Podstawowe dane')

    const [weight, height, birthYear, runKm, paceMin, paceSec, laps] =
      screen.getAllByRole('spinbutton')
    fireEvent.change(weight as HTMLElement, { target: { value: '86' } })
    fireEvent.change(height as HTMLElement, { target: { value: '182' } })
    fireEvent.change(birthYear as HTMLElement, { target: { value: '1990' } })
    fireEvent.change(runKm as HTMLElement, { target: { value: '4' } })
    fireEvent.change(paceMin as HTMLElement, { target: { value: '6' } })
    fireEvent.change(paceSec as HTMLElement, { target: { value: '30' } })
    fireEvent.change(laps as HTMLElement, { target: { value: '16' } })

    fireEvent.click(screen.getByRole('button', { name: 'Zaczynamy' }))

    await waitFor(async () => {
      const profile = await profileRepo.get()
      expect(profile?.name).toBe('Konrad')
      expect(profile?.startWeightKg).toBe(86)
      // Wzrost i rocznik są PYTANE, nie presetowane: z nich liczy się masa
      // odniesienia, a z niej białko i podłoga tłuszczu.
      expect(profile?.heightCm).toBe(182)
      expect(profile?.birthYear).toBe(1990)
      expect(profile?.goal).toBe('bulk')
      expect(profile?.emphasis).toBe('balanced')
      // Cel kaloryczny startuje na presecie, pod który napisana jest baza.
      expect(profile?.kcalOverride).toBe(2500)
      // Punkt wyjścia w formie, jakiej oczekuje generator: metry i sekundy.
      expect(profile?.runBaseline).toEqual({ distanceM: 4000, paceSecPerKm: 390 })
      expect(profile?.swimBaseline).toEqual({ laps: 16, poolLengthM: 25, stroke: 'any' })
    })

    // Bez wpisu w pomiarach wykres masy startowałby pusty.
    const entries = await weightRepo.all()
    expect(entries).toHaveLength(1)
    expect(entries[0]?.weightKg).toBe(86)
    expect(entries[0]?.date).toBe(todayIso())
  })

  it('pełny kreator pozostaje dostępny pod własnym adresem', async () => {
    renderAt('/profil/kreator')
    expect(await screen.findByText('Dane podstawowe')).toBeDefined()
    // Disclaimer medyczny musi być widoczny w pierwszym kroku.
    expect(screen.getByText('To nie jest porada medyczna')).toBeDefined()
    expect(screen.getByText('Krok 1 z 7')).toBeDefined()
  })
})

describe('ekran Dziś', () => {
  it('wita użytkownika i proponuje wygenerowanie planu', async () => {
    await seedProfile()
    renderAt('/')

    expect(await screen.findByText('Cześć, Konrad')).toBeDefined()
    expect(screen.getByText('Brak planu treningowego')).toBeDefined()
    // Panel diety ma własne zapytanie do bazy — trzeba poczekać osobno.
    expect(await screen.findByText('Brak jadłospisu na ten tydzień')).toBeDefined()
  })

  it('pokazuje sesję z planu, gdy plan istnieje', async () => {
    const profile = await seedProfile()
    await planRepo.generateAndSave(profile, todayIso(), { weeks: 4 })
    const sessions = await planRepo.sessionsOnDate(todayIso())
    expect(sessions.length).toBeGreaterThan(0)

    renderAt('/')

    // Asercja o BRAKU tekstu spełniłaby się natychmiast — jeszcze na ekranie
    // wczytywania, gdzie nie ma żadnego z obu napisów. Dlatego czekamy
    // na tytuł konkretnej dzisiejszej sesji, a dopiero potem sprawdzamy,
    // że karta „brak planu" zniknęła.
    expect(await screen.findByText(sessionTitle(sessions[0]!))).toBeDefined()
    expect(screen.queryByText('Brak planu treningowego')).toBeNull()
  })

  /**
   * Daty liczymy od poniedziałku BIEŻĄCEGO tygodnia, nie od „dziś minus N dni".
   * Plan jest wyrównany do tygodni ISO, więc odliczanie od dzisiaj dawałoby
   * inny tydzień planu w zależności od dnia tygodnia, w którym testy biegną —
   * i test raz przechodziłby, raz nie.
   */
  const isoWeeksAgo = (weeks: number) => addDays(startOfWeek(todayIso()), -7 * weeks)

  it('KRYTYCZNE: gdy plan się wyczerpał, proponuje odnowienie', async () => {
    // Regresja: plan po ostatnim tygodniu kończył się w ciszy — sekcja
    // treningu była pusta, bez wyjaśnienia i bez drogi dalej.
    const profile = await seedProfile()
    await planRepo.generateAndSave(profile, isoWeeksAgo(4), { weeks: 4 })

    renderAt('/')

    expect(await screen.findByText('Plan się zakończył')).toBeDefined()
    expect(screen.getByText('Dopisz kolejne 2 tygodnie')).toBeDefined()
  })

  it('w ostatnim tygodniu planu proponuje odnowienie zawczasu', async () => {
    const profile = await seedProfile()
    // Plan czterotygodniowy zaczęty trzy tygodnie temu — trwa ostatni tydzień.
    await planRepo.generateAndSave(profile, isoWeeksAgo(3), { weeks: 4 })

    renderAt('/')

    expect(await screen.findByText('Plan kończy się w tym tygodniu')).toBeDefined()
  })

  it('nie ma tu dopisywania treningu — to żyje w zakładce Plan', async () => {
    const profile = await seedProfile()
    await planRepo.generateAndSave(profile, todayIso(), { weeks: 4 })

    renderAt('/')
    await screen.findByText('Cześć, Konrad')
    expect(screen.queryByText('+ Dopisz trening poza planem')).toBeNull()
  })

  it('pokazuje posiłki i pozostałe kalorie, gdy jadłospis istnieje', async () => {
    const profile = await seedProfile()
    await dietRepo.generateWeek(profile, startOfWeek(todayIso()), TARGETS)
    renderAt('/')

    expect(await screen.findByText('Pozostało dziś')).toBeDefined()
    // Cztery posiłki z solvera, w kolejności dnia, plus stała pozycja przekąski.
    expect(screen.getByText('Śniadanie')).toBeDefined()
    expect(screen.getByText('Obiad')).toBeDefined()
    expect(screen.getByText('Posiłek po pracy')).toBeDefined()
    expect(screen.getByText('Kolacja')).toBeDefined()
    // Przycisk „Zjadłem" tylko przy posiłkach z planu — przekąska ma „Wpisz".
    expect(screen.getAllByText('Zjadłem')).toHaveLength(4)
  })

  it('KRYTYCZNE: słodka przekąska jest stałą pozycją do wpisania ręcznie', async () => {
    const profile = await seedProfile()
    await dietRepo.generateWeek(profile, startOfWeek(todayIso()), TARGETS)
    renderAt('/')

    await screen.findByText('Pozostało dziś')
    expect(screen.getByText('Słodka przekąska')).toBeDefined()
    expect(screen.getByText(new RegExp(`budżet ${SWEET_SNACK.kcal} kcal`))).toBeDefined()

    // Posiłki z planu mają o rezerwę MNIEJ niż cel dzienny — inaczej przekąska
    // zawsze łamałaby bilans dnia.
    const meals = await dietRepo.mealsOnDate(todayIso())
    const planned = meals.reduce((sum, meal) => sum + meal.computed.kcal, 0)
    expect(planned).toBeLessThanOrEqual(TARGETS.kcal - 50)

    fireEvent.click(screen.getByRole('button', { name: 'Wpisz' }))
    fireEvent.change(await screen.findByLabelText('Co to było'), {
      target: { value: 'dwie kostki czekolady' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Zapisz' }))

    await waitFor(async () => {
      const logs = await mealLogRepo.byDate(todayIso())
      const snack = logs.find((log) => log.slot === 'snack')
      expect(snack?.label).toBe('dwie kostki czekolady')
      // Formularz startuje z odłożonym budżetem, więc kalorii nie trzeba wpisywać.
      expect(snack?.macros).toEqual(SWEET_SNACK)
    })
  })

  it('KRYTYCZNE: nie ma karty zapotrzebowania — te liczby żyją w Profilu', async () => {
    // BMI, BMR i TDEE nie zmieniają się z dnia na dzień, więc codzienne
    // pokazywanie ich na ekranie „Dziś" tylko zabierało miejsce.
    await seedProfile()
    renderAt('/')

    await screen.findByText('Cześć, Konrad')
    expect(screen.queryByText('Zapotrzebowanie')).toBeNull()
    expect(screen.queryByText('TDEE szacowany')).toBeNull()
  })

  it('wyliczenia i trend masy są na ekranie Profil', async () => {
    await seedProfile()
    await weightRepo.upsert(todayIso(), 79.4)
    renderAt('/profil')

    expect(await screen.findByText('Wyliczenia')).toBeDefined()
    expect(screen.getByText('TDEE szacowany')).toBeDefined()
    expect(screen.getByText('79.4')).toBeDefined()
    expect(screen.getByText('1 pomiar')).toBeDefined()
  })

  it('KRYTYCZNE: kolejne ważenia nie zmieniają celu kalorycznego', async () => {
    // Cel liczy się z masy odniesienia z profilu. Gdyby szedł za trendem,
    // jadłospis i lista zakupów zmieniałyby się po każdym wejściu na wagę.
    const profile = await seedProfile()
    await weightRepo.upsert(addDays(todayIso(), -1), profile.startWeightKg)

    const { unmount } = renderAt('/profil')
    const before = (await screen.findByText('Cel')).closest('div')?.textContent
    expect(before).toMatch(/kcal/)
    unmount()

    // Trzy kilogramy w dół w kolejnym ważeniu.
    await weightRepo.upsert(todayIso(), profile.startWeightKg - 3)

    renderAt('/profil')
    const after = (await screen.findByText('Cel')).closest('div')?.textContent
    expect(after).toBe(before)
  })

  it('KRYTYCZNE: o wagę i pomiary pyta tylko w sobotę', async () => {
    // Codzienne pytanie o wagę to zaproszenie do mierzenia szumu — dobowe
    // wahania nawodnienia to ±1,5 kg. Dane zbieramy raz w tygodniu.
    await seedProfile()
    renderAt('/')
    await screen.findByText('Cześć, Konrad')

    if (isMeasurementDay(todayIso())) {
      expect(screen.getByText('Waga i pomiary')).toBeDefined()
      // Sobota bez wpisu: formularz otwarty od razu, bez klikania.
      expect(screen.getByText('Dzisiaj sobota — czas na pomiar tygodnia')).toBeDefined()
      expect(screen.getByText('Zapisz pomiar')).toBeDefined()
    } else {
      expect(screen.queryByText('Waga i pomiary')).toBeNull()
    }
  })

  it('poza sobotą pomiar da się wpisać z ekranu Profil', async () => {
    // Droga awaryjna: bez niej jedno przeoczenie kosztowałoby tygodniową dziurę
    // w historii, której nie da się odtworzyć.
    await seedProfile()
    renderAt('/profil')

    expect(await screen.findByText('Waga i pomiary')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Wpisz wagę i pomiary' }))
    expect(await screen.findByText('Zapisz pomiar')).toBeDefined()
  })

  it('KRYTYCZNE: zapisany obwód trafia do bazy z dzisiejszą datą', async () => {
    await seedProfile()
    renderAt('/profil')
    await screen.findByText('Waga i pomiary')

    fireEvent.click(screen.getByRole('button', { name: 'Wpisz wagę i pomiary' }))
    await screen.findByText('Zapisz pomiar')

    // Pierwsze pole obwodów to talia; pola wagi są w karcie powyżej.
    const waist = screen.getByLabelText(/Talia/)
    fireEvent.change(waist, { target: { value: '78.5' } })
    fireEvent.click(screen.getByText('Zapisz pomiar'))

    await waitFor(async () => {
      const entry = await bodyMeasurementRepo.onDate(todayIso())
      expect(entry?.waistCm).toBe(78.5)
      // Puste pola są pomijane, nie zapisywane jako zero.
      expect(entry?.hipsCm).toBeUndefined()
    })
  })
})

describe('ekran Plan', () => {
  it('bez planu proponuje jego wygenerowanie', async () => {
    await seedProfile()
    renderAt('/plan')
    expect(await screen.findByText('Plan treningowy')).toBeDefined()
    expect(screen.getByText('Brak planu treningowego')).toBeDefined()
  })

  it('pokazuje wybór tygodni i wersję planu', async () => {
    const profile = await seedProfile()
    await planRepo.generateAndSave(profile, todayIso(), { weeks: 12 })
    renderAt('/plan')

    expect(await screen.findByText(/Wersja 1 · 12 tygodni/)).toBeDefined()
    // Przyciski tygodni 1–12.
    expect(screen.getByRole('button', { name: /Tydzień 12/ })).toBeDefined()
  })

  it('KRYTYCZNE: przy numerze tygodnia jest jego zakres dat', async () => {
    // Sam numer nie mówi, o który odcinek kalendarza chodzi — a tydzień
    // zaczyna się w sobotę, czyli nie tam, gdzie odruchowo zakłada kalendarz.
    const profile = await seedProfile()
    // Start od początku tygodnia, żeby pierwszy tydzień nie był częściowy —
    // plan zaczęty w środku tygodnia świadomie pomija dni sprzed startu.
    const weekStart = startOfWeek(todayIso())
    const { plan } = await planRepo.generateAndSave(profile, weekStart, { weeks: 2 })
    const week0 = await planRepo.sessionsForWeek(plan.id, 0)

    renderAt('/plan')
    await screen.findByText(/Wersja 1 · 2 tygodni/)

    // Zakres jest w nazwie dostępnej przycisku i w podpisie pod przełącznikiem.
    const button = screen.getByRole('button', { name: /Tydzień 1:/ })
    expect(button.textContent).toMatch(/–/)
    expect(screen.getByText(/Tydzień 1 z 2:/)).toBeDefined()

    // Pierwszy dzień tygodnia planu to sobota, także w kolejności sesji.
    expect(isoWeekday(weekStart)).toBe(6)
    expect(week0[0]?.date).toBe(weekStart)
  })

  it('KRYTYCZNE: tydzień AKTUALIZUJE się z historii — nie ma już usuwania tygodnia', async () => {
    const profile = await seedProfile()
    const weekStart = startOfWeek(todayIso())
    await planRepo.generateAndSave(profile, weekStart, { weeks: 2 })

    renderAt('/plan')
    await screen.findByText(/Wersja 1 · 2 tygodni/)

    expect(screen.getByText('Aktualizuj plan na ten tydzień')).toBeDefined()
    expect(screen.queryByText(/Usuń plan na tydzień/)).toBeNull()
    expect(screen.queryByText('Nie trenuję w tym tygodniu')).toBeNull()

    // Bez zalogowanych treningów aktualizacja mówi to wprost, zamiast milczeć.
    fireEvent.click(screen.getByRole('button', { name: /Aktualizuj tydzień 1 z historii/ }))
    expect(await screen.findByText('Bez zmian')).toBeDefined()
  })

  it('każdy dzień ma przycisk dopisania treningu poza planem', async () => {
    const profile = await seedProfile()
    const { plan } = await planRepo.generateAndSave(profile, todayIso(), { weeks: 4 })
    // Pierwszy tygodień planu jest częściowy, gdy start wypada w środku
    // tygodnia — liczbę dni bierzemy z danych, nie zakładamy siedmiu.
    const week0 = await planRepo.sessionsForWeek(plan.id, 0)

    renderAt('/plan')
    await screen.findByText(/Wersja 1 · 4 tygodni/)

    // Każdy dzień własny przycisk, także dni odpoczynku.
    expect(screen.getAllByText('+ Dopisz trening poza planem')).toHaveLength(week0.length)
    expect(week0.length).toBeGreaterThan(0)
  })

  it('KRYTYCZNE: spacer z metrami trafia do logu z datą wskazanego dnia', async () => {
    const profile = await seedProfile()
    const { plan } = await planRepo.generateAndSave(profile, todayIso(), { weeks: 4 })
    const week0 = await planRepo.sessionsForWeek(plan.id, 0)
    /**
     * OSTATNI dzień pokazanego tygodnia, nie trzeci z listy.
     *
     * Pierwszy tydzień planu jest częściowy (plan startuje dziś, a tydzień
     * w sobotę), więc liczba kart zależy od dnia, w którym testy biegną —
     * sztywny indeks przestawał istnieć raz w tygodniu. Bierzemy dzień z DANYCH
     * i kartę o tym samym numerze.
     */
    const targetDay = week0[week0.length - 1]

    renderAt('/plan')
    await screen.findByText(/Wersja 1 · 4 tygodni/)

    // Inny dzień niż „dziś", jeśli tydzień ma więcej niż jedną kartę —
    // o to chodzi w przeniesieniu dopisywania treningu do zakładki Plan.
    const buttons = screen.getAllByText('+ Dopisz trening poza planem')
    expect(buttons).toHaveLength(week0.length)
    fireEvent.click(buttons[week0.length - 1] as HTMLElement)
    expect(await screen.findByText(/Trening poza planem —/)).toBeDefined()

    // Domyślnie spacer: pierwsze pole to dystans w metrach.
    expect(screen.getByText(/Ile metrów przeszedłeś/)).toBeDefined()
    fireEvent.change(screen.getAllByRole('spinbutton')[0] as HTMLElement, {
      target: { value: '4500' },
    })
    fireEvent.click(screen.getByText('Zapisz trening'))

    await waitFor(async () => {
      const logs = await sessionLogRepo.byDate(targetDay!.date)
      const extra = logs.filter((log) => log.plannedSessionId === null)
      expect(extra).toHaveLength(1)
      expect(extra[0]?.type).toBe('walk')
      const cardio = await sessionLogRepo.cardioForSession(extra[0]!.id)
      expect(cardio?.distanceM).toBe(4500)
    })
  })

  it('trening siłowy poza planem zapisuje się z czasem, bez dystansu', async () => {
    const profile = await seedProfile()
    const { plan } = await planRepo.generateAndSave(profile, todayIso(), { weeks: 4 })
    const week0 = await planRepo.sessionsForWeek(plan.id, 0)

    renderAt('/plan')
    await screen.findByText(/Wersja 1 · 4 tygodni/)
    fireEvent.click(screen.getAllByText('+ Dopisz trening poza planem')[0] as HTMLElement)
    await screen.findByText(/Trening poza planem —/)

    fireEvent.click(screen.getByRole('button', { name: 'Siłowy' }))
    fireEvent.change(screen.getAllByRole('spinbutton')[0] as HTMLElement, {
      target: { value: '50' },
    })
    fireEvent.click(screen.getByText('Zapisz trening'))

    await waitFor(async () => {
      const logs = await sessionLogRepo.byDate(week0[0]!.date)
      const extra = logs.filter((log) => log.plannedSessionId === null)
      expect(extra).toHaveLength(1)
      expect(extra[0]?.type).toBe('strength')
      expect(extra[0]?.durationMin).toBe(50)
    })
  })

  it('KRYTYCZNE: spacer może zastąpić zaplanowany trening', async () => {
    const profile = await seedProfile()
    const { plan } = await planRepo.generateAndSave(profile, todayIso(), { weeks: 4 })
    const week0 = await planRepo.sessionsForWeek(plan.id, 0)
    const trainingIndex = week0.findIndex((s) => s.type !== 'rest')
    expect(trainingIndex).toBeGreaterThanOrEqual(0)
    const planned = week0[trainingIndex]!

    renderAt('/plan')
    await screen.findByText(/Wersja 1 · 4 tygodni/)
    fireEvent.click(
      screen.getAllByText('+ Dopisz trening poza planem')[trainingIndex] as HTMLElement,
    )
    await screen.findByText(/Trening poza planem —/)

    // Opcja zamiany pojawia się tylko na dniu z zaplanowaną sesją.
    fireEvent.click(screen.getByText(/Zamiast zaplanowanego:/))
    fireEvent.change(screen.getAllByRole('spinbutton')[0] as HTMLElement, {
      target: { value: '3000' },
    })
    fireEvent.click(screen.getByText('Zapisz trening'))

    await waitFor(async () => {
      const logs = await sessionLogRepo.byDate(planned.date)
      // Plan zostaje w historii oznaczony jako pominięty…
      const fromPlan = logs.find((log) => log.plannedSessionId === planned.id)
      expect(fromPlan?.status).toBe('skipped')
      // …a obok jest zapis tego, co faktycznie się stało.
      expect(logs.filter((log) => log.plannedSessionId === null)).toHaveLength(1)
    })
  })

  it('na dniu odpoczynku nie ma opcji zamiany zaplanowanego treningu', async () => {
    const profile = await seedProfile()
    const { plan } = await planRepo.generateAndSave(profile, todayIso(), { weeks: 4 })
    const week0 = await planRepo.sessionsForWeek(plan.id, 0)
    const restIndex = week0.findIndex((s) => s.type === 'rest')

    renderAt('/plan')
    await screen.findByText(/Wersja 1 · 4 tygodni/)

    if (restIndex >= 0) {
      fireEvent.click(screen.getAllByText('+ Dopisz trening poza planem')[restIndex] as HTMLElement)
      await screen.findByText(/Trening poza planem —/)
      expect(screen.queryByText(/Zamiast zaplanowanego:/)).toBeNull()
    }
  })

  it('dopisany trening pokazuje się pod swoim dniem', async () => {
    const profile = await seedProfile()
    const { plan } = await planRepo.generateAndSave(profile, todayIso(), { weeks: 4 })
    const week0 = await planRepo.sessionsForWeek(plan.id, 0)

    await sessionLogRepo.record({
      plannedSessionId: null,
      date: week0[0]!.date,
      type: 'swim',
      status: 'done',
      durationMin: 30,
    })

    renderAt('/plan')
    await screen.findByText(/Wersja 1 · 4 tygodni/)

    // Bez tego dopisanie treningu wyglądałoby jak awaria — zapisujesz i nic.
    expect(screen.getByText('poza planem')).toBeDefined()
    expect(screen.getByText('Pływanie')).toBeDefined()
  })
})

describe('ekran Dieta', () => {
  it('pokazuje przełącznik dni tygodnia', async () => {
    await seedProfile()
    renderAt('/dieta')
    expect(await screen.findByText('Jadłospis')).toBeDefined()
    expect(screen.getByText('Pon')).toBeDefined()
    expect(screen.getByText('Nd')).toBeDefined()
  })

  it('pokazuje wygenerowane posiłki z gramaturami po rozwinięciu', async () => {
    const profile = await seedProfile()
    await dietRepo.generateWeek(profile, startOfWeek(todayIso()), TARGETS)
    renderAt('/dieta')

    expect(await screen.findByText('Pozostało dziś')).toBeDefined()
    // Trzy posiłki z solvera; słodka przekąska nie ma składników ani zamienników.
    expect(screen.getAllByText('Składniki i przygotowanie')).toHaveLength(4)
    expect(screen.getAllByText('Zamień')).toHaveLength(4)
  })

  it('KRYTYCZNE: zamiana posiłku to pełna lista z kategorią i kaloriami', async () => {
    const profile = await seedProfile()
    const weekStart = startOfWeek(todayIso())
    await dietRepo.generateWeek(profile, weekStart, TARGETS)
    renderAt('/dieta')

    await screen.findByText('Pozostało dziś')
    // DRUGI przycisk „Zamień" to obiad: pierwszy należy do śniadania
    // (kolejność kart to `MEAL_SLOT_ORDER`).
    fireEvent.click(screen.getAllByText('Zamień')[1] as HTMLElement)

    // Nagłówek mówi, ile pozycji jest w liście — dawniej było ich zawsze pięć.
    const intro = await screen.findByText(/Wszystkie przepisy na ten posiłek/)
    const count = Number(/\((\d+)\)/.exec(intro.textContent ?? '')?.[1])
    expect(count).toBeGreaterThan(5)

    // Kategorie dania jako nagłówki grup i kalorie przy każdej pozycji.
    const options = await dietRepo.substitutesFor(profile, todayIso(), 'lunch', TARGETS)
    const categories = new Set(
      options.map((option) => {
        const recipe = DIET_CATALOG.recipes.find((r) => r.id === option.recipeId)
        return DISH_CATEGORY_LABELS[dishCategory(recipe!)]
      }),
    )
    expect(categories.size).toBeGreaterThan(1)
    for (const label of categories) {
      expect(screen.getByText(new RegExp(`^${label} · \\d+$`)), label).toBeDefined()
    }
    expect(screen.getAllByText(/^\d+ kcal$/).length).toBeGreaterThan(5)
  })

  it('KRYTYCZNE: zamienniki da się przeszukać wpisanym tekstem', async () => {
    /**
     * Lista zamienników pokazuje CAŁY katalog na dany slot — czterdzieści parę
     * pozycji w pięciu grupach. Bez wyszukiwania jedyną drogą do konkretnego
     * dania było przewinięcie ich wszystkich.
     */
    const profile = await seedProfile()
    await dietRepo.generateWeek(profile, startOfWeek(todayIso()), TARGETS)
    renderAt('/dieta')

    await screen.findByText('Pozostało dziś')
    // DRUGI „Zamień" to obiad — kolejność kart to `MEAL_SLOT_ORDER`.
    fireEvent.click(screen.getAllByText('Zamień')[1] as HTMLElement)

    const intro = await screen.findByText(/Wszystkie przepisy na ten posiłek/)
    const total = Number(/\((\d+)\)/.exec(intro.textContent ?? '')?.[1])
    expect(total).toBeGreaterThan(5)

    const box = screen.getByPlaceholderText('Szukaj: nazwa dania albo składnik')
    fireEvent.change(box, { target: { value: 'kurczak' } })

    // Nagłówek mówi, ile z ilu pasuje — filtr ma być widoczny, a nie tylko
    // odczuwalny jako „lista nagle krótsza".
    const filtered = await screen.findByText(/Pasuje \d+ z \d+ przepisów/)
    const shown = Number(/Pasuje (\d+)/.exec(filtered.textContent ?? '')?.[1])
    expect(shown).toBeGreaterThan(0)
    expect(shown).toBeLessThan(total)
    // Tyle kart, ile zapowiada nagłówek — każda z ceną kaloryczną.
    expect(screen.getAllByText(/^\d+ kcal$/)).toHaveLength(shown)

    // Tekst spoza bazy: wprost o tym mówimy, zamiast pokazywać pustkę.
    fireEvent.change(box, { target: { value: 'wegorz' } })
    expect(await screen.findByText(/^Nic nie pasuje do/)).toBeDefined()

    /**
     * Zamknięcie CZYŚCI wyszukiwanie. Komponent zostaje zamontowany, więc bez
     * tego następne otwarcie — także dla innego posiłku — pokazywałoby listę
     * przefiltrowaną poprzednim wpisem, co wygląda jak pusty katalog.
     */
    fireEvent.click(screen.getByLabelText('Zamknij'))
    fireEvent.click(screen.getAllByText('Zamień')[1] as HTMLElement)
    expect(await screen.findByText(/Wszystkie przepisy na ten posiłek/)).toBeDefined()
  })

  it('KRYTYCZNE: usunięcie posiłku zostawia slot z wpisem ręcznym i zdejmuje składniki z zakupów', async () => {
    const profile = await seedProfile()
    const weekStart = startOfWeek(todayIso())
    await dietRepo.generateWeek(profile, weekStart, TARGETS)
    const before = await shoppingRepo.build(weekStart)

    renderAt('/dieta')
    await screen.findByText('Pozostało dziś')
    expect(screen.getAllByText('Usuń')).toHaveLength(4)

    fireEvent.click(screen.getAllByText('Usuń')[0] as HTMLElement)

    // Slot nie znika z ekranu — zostaje z dwiema drogami powrotu.
    expect(await screen.findByText('Brak posiłku w planie')).toBeDefined()
    expect(screen.getAllByText('Zamień')).toHaveLength(3)
    expect(screen.getByText('Wstaw z bazy przepisów')).toBeDefined()

    // Posiłek zniknął z planu, a lista zakupów zmalała BEZ osobnego kliknięcia.
    await waitFor(async () => {
      expect(await dietRepo.mealsOnDate(todayIso())).toHaveLength(3)
      const after = await shoppingRepo.forWeek(weekStart)
      expect(after?.id).toBe(before.id)
      const grams = (list: typeof before | undefined) =>
        (list?.items ?? [])
          .filter((i) => i.unit === 'g')
          .reduce((sum, i) => sum + (i.amount ?? 0), 0)
      expect(grams(after)).toBeLessThan(grams(before))
    })
  })

  it('KRYTYCZNE: wpis „zjadłem coś innego" nie udaje słodkiej przekąski', async () => {
    /**
     * Formularz nie miał innego slotu niż `snack`, więc pizza pokazywała się
     * w karcie „Słodka przekąska", a DRUGI wpis tego dnia był niewidoczny —
     * choć liczył się do bilansu. Teraz takie wpisy mają slot `other`
     * i sekcję „Poza planem".
     */
    const profile = await seedProfile()
    await dietRepo.generateWeek(profile, startOfWeek(todayIso()), TARGETS)
    await mealLogRepo.logManual(todayIso(), 'other', 'Pizza u siostry', {
      kcal: 900,
      proteinG: 30,
      fatG: 40,
      carbsG: 90,
    })

    renderAt('/dieta')
    await screen.findByText('Pozostało dziś')

    // Wpis jest w „Poza planem", a karta przekąski nadal czeka na wpisanie.
    expect(screen.getByText('Poza planem')).toBeDefined()
    expect(screen.getByText('Pizza u siostry')).toBeDefined()
    expect(screen.getByText('Do wpisania')).toBeDefined()
    // I liczy się do dnia — inaczej bilans by kłamał.
    expect(screen.getByText(/^900 \/ /)).toBeDefined()
  })

  it('KRYTYCZNE: każdy wpis przekąski jest widoczny, nie tylko pierwszy', async () => {
    const profile = await seedProfile()
    await dietRepo.generateWeek(profile, startOfWeek(todayIso()), TARGETS)
    const macros = { proteinG: 0, fatG: 0, carbsG: 0 }
    await mealLogRepo.logManual(todayIso(), 'snack', 'Batonik', { kcal: 150, ...macros })
    await mealLogRepo.logManual(todayIso(), 'snack', 'Lody', { kcal: 220, ...macros })

    renderAt('/dieta')
    await screen.findByText('Pozostało dziś')

    // Oba wpisy na ekranie i suma w nagłówku karty — wcześniej `find` pokazywał
    // pierwszy, a drugi znikał, mimo że odejmował kalorie od dnia.
    expect(screen.getByText('Batonik')).toBeDefined()
    expect(screen.getByText('Lody')).toBeDefined()
    expect(screen.getByText('370 kcal')).toBeDefined()
  })

  it('zjedzony posiłek nie ma przycisku usuwania', async () => {
    // Log jest nienaruszalny i wlicza się do bilansu — najpierw „Cofnij".
    const profile = await seedProfile()
    const weekStart = startOfWeek(todayIso())
    await dietRepo.generateWeek(profile, weekStart, TARGETS)
    const meal = (await dietRepo.mealsOnDate(todayIso()))[0]!
    await mealLogRepo.logFromPlan(todayIso(), meal.slot, meal.id, meal.computed)

    renderAt('/dieta')
    await screen.findByText('Pozostało dziś')
    expect(screen.getByText('Cofnij')).toBeDefined()
    expect(screen.getAllByText('Usuń')).toHaveLength(3)
  })
})

describe('ekran Zakupy', () => {
  it('bez jadłospisu wyjaśnia, czego brakuje', async () => {
    await seedProfile()
    renderAt('/zakupy')
    expect(await screen.findByText('Brak jadłospisu na ten tydzień')).toBeDefined()
  })

  it('pozycje listy są checkboxami, nie samymi przyciskami', async () => {
    /**
     * Bez `role="checkbox"` i `aria-checked` czytnik ekranu ogłasza „przycisk,
     * Marchew 480 g" i nie mówi, czy pozycja jest już kupiona — a to jedyna
     * informacja, po którą sięga się na tej liście.
     */
    const profile = await seedProfile()
    const weekStart = startOfWeek(todayIso())
    await dietRepo.generateWeek(profile, weekStart, TARGETS)
    const list = await shoppingRepo.build(weekStart)

    renderAt('/zakupy')
    await screen.findByText('Lista zakupów')

    const boxes = screen.getAllByRole('checkbox')
    expect(boxes).toHaveLength(list.items.length)
    expect(boxes.every((box) => box.getAttribute('aria-checked') === 'false')).toBe(true)

    fireEvent.click(boxes[0] as HTMLElement)
    await waitFor(() => {
      expect(screen.getAllByRole('checkbox')[0]?.getAttribute('aria-checked')).toBe('true')
    })
  })

  it('KRYTYCZNE: zjedzony posiłek schodzi z listy zakupów, a „Cofnij" go przywraca', async () => {
    /**
     * Lista odpowiada na pytanie „co jeszcze muszę kupić", a składniki obiadu
     * zjedzonego w poniedziałek nie są już odpowiedzią. Filtr działa przy
     * WYŚWIETLANIU: zapisana lista zostaje nietknięta, więc odhaczenia
     * przeżywają, a cofnięcie wpisu przywraca pozycje same z siebie.
     */
    const profile = await seedProfile()
    const weekStart = startOfWeek(todayIso())
    await dietRepo.generateWeek(profile, weekStart, TARGETS)
    const list = await shoppingRepo.build(weekStart)

    const meal = (await dietRepo.mealsOnDate(todayIso()))[0]!
    const log = await mealLogRepo.logFromPlan(todayIso(), meal.slot, meal.id, meal.computed)

    const visible = withoutEatenMeals(list.items, new Set([`${meal.date}|${meal.recipeId}`]))
    const grams = (items: typeof list.items) =>
      items.filter((i) => i.unit === 'g').reduce((sum, i) => sum + (i.amount ?? 0), 0)
    // Ilości spadają na pewno; ile POZYCJI zniknie, zależy od tego, czy dany
    // składnik wraca w innych dniach — dlatego liczby pozycji nie zgadujemy.
    //
    // Stało tu jeszcze `visible.length < list.items.length` i to było zgadywanie
    // wbrew powyższemu zdaniu: jeśli KAŻDY składnik zjedzonego posiłku wraca
    // w innym dniu tygodnia, to żadna pozycja nie znika — spadają tylko ilości.
    // Który posiłek wypada na dzisiaj, zależy od `todayIso()`, więc asercja
    // przechodziła albo nie w zależności od dnia uruchomienia testu.
    expect(grams(visible)).toBeLessThan(grams(list.items))

    renderAt('/zakupy')
    await screen.findByText('Lista zakupów')

    expect(screen.getByText('Zjedzone w tym tygodniu: 1 posiłek')).toBeDefined()
    expect(screen.getByText(`0 z ${visible.length} pozycji`)).toBeDefined()
    // Zapisana lista bez zmian — filtr niczego nie skasował.
    expect((await shoppingRepo.forWeek(weekStart))?.items).toHaveLength(list.items.length)

    // Przełącznik pokazuje całość tygodnia, gdy trzeba kupić z wyprzedzeniem.
    fireEvent.click(screen.getByText('Pokaż całą listę'))
    expect(await screen.findByText(`0 z ${list.items.length} pozycji`)).toBeDefined()
    fireEvent.click(screen.getByText('Pokaż tylko do kupienia'))
    await screen.findByText(`0 z ${visible.length} pozycji`)

    // „Cofnij" w jadłospisie kasuje log miękko — pozycje wracają bez klikania
    // czegokolwiek na tym ekranie.
    await mealLogRepo.softDelete(log.id)
    await waitFor(() => {
      expect(screen.getByText(`0 z ${list.items.length} pozycji`)).toBeDefined()
    })
    expect(screen.queryByText(/^Zjedzone w tym tygodniu/)).toBeNull()
  })

  it('pokazuje pozycje pogrupowane po działach', async () => {
    const profile = await seedProfile()
    const weekStart = startOfWeek(todayIso())
    await dietRepo.generateWeek(profile, weekStart, TARGETS)
    const list = await shoppingRepo.build(weekStart)

    renderAt('/zakupy')
    expect(await screen.findByText('Lista zakupów')).toBeDefined()
    expect(screen.getByText(`0 z ${list.items.length} pozycji`)).toBeDefined()

    // KRYTYCZNE: sekcji z przyprawami nie ma, a czosnek stoi w warzywach.
    expect(screen.queryByText('Zapas i przyprawy')).toBeNull()
    expect(screen.queryByText('Przyprawy i zioła')).toBeNull()
    expect(screen.getByText('Owoce i warzywa')).toBeDefined()
    for (const item of list.items) {
      expect(item.category, item.name).not.toBe('Przyprawy i zioła')
    }
  })
})

describe('ekran Postępy', () => {
  it('bez danych wyjaśnia, czego brakuje w każdej sekcji', async () => {
    await seedProfile()
    renderAt('/postepy')

    // NIE „Postępy" — to także etykieta w pasku nawigacji, więc pasowałaby
    // już na ekranie wczytywania. Czekamy na tytuł sekcji z treści ekranu.
    expect(await screen.findByText('Realizacja planu')).toBeDefined()
    expect(screen.getByText('Brak zalogowanych treningów w tym zakresie.')).toBeDefined()
    // Masa i obwody to dwie osobne sekcje z osobnymi komunikatami — każdy
    // odsyła tam, gdzie te dane się wpisuje.
    expect(screen.getByText(/Brak pomiarów w tym zakresie\. Wagę/)).toBeDefined()
    expect(screen.getByText(/Brak pomiarów w tym zakresie\. Obwody/)).toBeDefined()
  })

  it('KRYTYCZNE: ekran ma trzy sekcje — bez wykresów kalorii, dystansów i objętości', async () => {
    // Usunięte na życzenie: przy jednym użytkowniku i dwutygodniowym planie
    // mówiły mniej, niż zajmowały miejsca. Dane zostają w bazie i w CSV.
    await seedProfile()
    renderAt('/postepy')

    await screen.findByText('Realizacja planu')
    expect(screen.getByText('Masa ciała')).toBeDefined()
    expect(screen.getByText('Pomiary ciała')).toBeDefined()

    expect(screen.queryByText('Kalorie')).toBeNull()
    expect(screen.queryByText('Dystanse')).toBeNull()
    expect(screen.queryByText('Objętość treningowa')).toBeNull()
  })

  it('KRYTYCZNE: obwody ciała są widoczne w historii statystyk', async () => {
    await seedProfile()
    await bodyMeasurementRepo.upsert(addDays(todayIso(), -7), { waistCm: 80, hipsCm: 102 })
    await bodyMeasurementRepo.upsert(todayIso(), { waistCm: 78.5, hipsCm: 101 })

    renderAt('/postepy')
    await screen.findByText('Realizacja planu')

    expect(screen.getByText('Pomiary ciała')).toBeDefined()
    // Zmiana liczona od pierwszego do ostatniego pomiaru w zakresie.
    expect(screen.getByText('-1,5')).toBeDefined()
    expect(screen.getByText('2 pomiary')).toBeDefined()

    // Wszystkie miary są w widoku tabelarycznym, nie tylko ta na wykresie.
    // Przełącznik „Tabela" mają wyłącznie wykresy z danymi, a tu jedyne dane
    // to obwody — więc pierwszy przełącznik należy do tej karty.
    const tables = screen.getAllByRole('button', { name: 'Tabela' })
    fireEvent.click(tables[0] as HTMLElement)
    expect(await screen.findByText('Talia [cm]')).toBeDefined()
    expect(screen.getByText('Biodra [cm]')).toBeDefined()

    // Przełącznik miar pozwala wejść na drugą serię.
    fireEvent.click(screen.getByRole('button', { name: 'Wykres' }))
    fireEvent.click(screen.getByRole('button', { name: 'Biodra' }))
    expect(await screen.findByText('101')).toBeDefined()
  })

  it('pokazuje realizację planu ze statusami opisanymi słownie', async () => {
    const profile = await seedProfile()
    const { plan } = await planRepo.generateAndSave(profile, todayIso(), { weeks: 4 })
    const week0 = await planRepo.sessionsForWeek(plan.id, 0)

    await sessionLogRepo.record({
      plannedSessionId: week0[0]!.id,
      date: week0[0]!.date,
      type: 'strength',
      status: 'done',
    })
    await sessionLogRepo.record({
      plannedSessionId: week0[1]!.id,
      date: week0[1]!.date,
      type: 'run',
      status: 'skipped',
    })

    renderAt('/postepy')
    await screen.findByText('Realizacja planu')
    // Plan startuje dziś, więc część jego dni wypada w przyszłość i domyślny
    // zakres 30 dni wstecz by je odfiltrował.
    fireEvent.click(screen.getByRole('button', { name: 'wszystko' }))

    // Kolor statusu nigdy nie występuje sam — zawsze z etykietą.
    expect(screen.getByText('Wykonane')).toBeDefined()
    expect(screen.getByText('Częściowo')).toBeDefined()
    expect(screen.getByText('Pominięte')).toBeDefined()
    expect(await screen.findByText(/50% sesji z planu wykonanych w pełni/)).toBeDefined()
  })

  it('KRYTYCZNE: treningi poza planem raportowane osobno, nie jako realizacja', async () => {
    const profile = await seedProfile()
    const { plan } = await planRepo.generateAndSave(profile, todayIso(), { weeks: 4 })
    const week0 = await planRepo.sessionsForWeek(plan.id, 0)

    await sessionLogRepo.record({
      plannedSessionId: week0[0]!.id,
      date: week0[0]!.date,
      type: 'strength',
      status: 'done',
    })
    await sessionLogRepo.recordCardio(
      { plannedSessionId: null, date: week0[1]!.date, type: 'walk', status: 'done' },
      { distanceM: 4500, durationSec: 2700 },
    )

    renderAt('/postepy')
    await screen.findByText('Realizacja planu')
    fireEvent.click(screen.getByRole('button', { name: 'wszystko' }))

    // Realizacja z planu to 100% (jedna sesja, wykonana), a spacer obok.
    expect(await screen.findByText(/100% sesji z planu wykonanych w pełni/)).toBeDefined()
    expect(screen.getByText(/Poza planem: 1 trening/)).toBeDefined()
  })

  it('pokazuje trend masy i pozwala przełączyć na tabelę', async () => {
    await seedProfile()
    await weightRepo.upsert(addDays(todayIso(), -7), 80)
    await weightRepo.upsert(todayIso(), 79)

    renderAt('/postepy')
    await screen.findByText('Realizacja planu')

    expect(screen.getByText('Masa ciała')).toBeDefined()
    expect(screen.getByText('Trend teraz')).toBeDefined()

    // Widok tabelaryczny jest wymogiem dostępności — wartość nigdy nie może
    // być dostępna wyłącznie przez kolor albo najechanie kursorem.
    const toggles = screen.getAllByRole('button', { name: 'Tabela' })
    expect(toggles.length).toBeGreaterThan(0)
    fireEvent.click(toggles[0] as HTMLElement)

    expect(await screen.findByText('Masa [kg]')).toBeDefined()
    expect(screen.getByText('Trend [kg]')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Wykres' })).toBeDefined()
  })

  it('oferuje zakresy 7 dni, 30 dni i wszystko', async () => {
    await seedProfile()
    renderAt('/postepy')
    await screen.findByText('Realizacja planu')

    for (const label of ['7 dni', '30 dni', 'wszystko']) {
      expect(screen.getByRole('button', { name: label }), label).toBeDefined()
    }
  })

  it('filtr zakresu obejmuje wszystkie wykresy naraz', async () => {
    await seedProfile()
    // Pomiar sprzed 20 dni: w domyślnym zakresie 30 dni jest widoczny,
    // po zawężeniu do 7 dni musi zniknąć.
    await weightRepo.upsert(addDays(todayIso(), -20), 82)

    renderAt('/postepy')
    await screen.findByText('Realizacja planu')
    expect(screen.getByText('Trend teraz')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: '7 dni' }))
    expect(await screen.findByText(/Brak pomiarów w tym zakresie\. Wagę/)).toBeDefined()

    // I wraca po rozszerzeniu zakresu.
    fireEvent.click(screen.getByRole('button', { name: 'wszystko' }))
    expect(await screen.findByText('Trend teraz')).toBeDefined()
  })
})

describe('ekran Profil', () => {
  it('pokazuje dane, wyliczenia i możliwość zaczęcia od nowa', async () => {
    await seedProfile()
    renderAt('/profil')

    expect(await screen.findByText('Konrad')).toBeDefined()
    expect(screen.getByText('Wyliczenia')).toBeDefined()
    expect(screen.getByText('Zacznij od nowa')).toBeDefined()
    expect(screen.getByText('Wyczyść wszystkie dane')).toBeDefined()
  })

  it('kopia zapasowa jest ukryta', async () => {
    await seedProfile()
    renderAt('/profil')
    await screen.findByText('Konrad')
    expect(screen.queryByText('Kopia zapasowa')).toBeNull()
  })

  it('KRYTYCZNE: reset wymaga potwierdzenia i mówi, ile rekordów zniknie', async () => {
    const profile = await seedProfile()
    await planRepo.generateAndSave(profile, todayIso(), { weeks: 4 })

    renderAt('/profil')
    await screen.findByText('Konrad')

    // Pierwsze kliknięcie tylko otwiera potwierdzenie — nic nie usuwa.
    fireEvent.click(screen.getByText('Wyczyść wszystkie dane'))
    expect(await screen.findByText('Tego nie da się cofnąć')).toBeDefined()
    expect(screen.getByText(/Usuniesz \d+ rekordów/)).toBeDefined()
    expect(await profileRepo.get()).toBeDefined()

    // Dopiero potwierdzenie czyści bazę.
    fireEvent.click(screen.getByText('Tak, usuń wszystko i zacznij od nowa'))
    await waitFor(async () => {
      expect(await profileRepo.get()).toBeUndefined()
    })
    expect(await db.plannedSessions.count()).toBe(0)
  })

  it('po resecie aplikacja wraca do ekranu startowego bez przeładowania', async () => {
    await seedProfile()
    renderAt('/profil')
    await screen.findByText('Konrad')

    fireEvent.click(screen.getByText('Wyczyść wszystkie dane'))
    fireEvent.click(await screen.findByText('Tak, usuń wszystko i zacznij od nowa'))

    // `App` obserwuje profil na żywo — ekran startowy pojawia się sam.
    expect(await screen.findByText('Podstawowe dane')).toBeDefined()
  })

  it('pokazuje kontuzje i alergie jako twarde wykluczenia', async () => {
    await profileRepo.save({
      ...(await seedProfile()),
      injuries: ['knee'],
      diet: {
        style: 'omnivore',
        allergens: ['lactose'],
        dislikedTags: ['brokuły'],
        excludedProductIds: [],
      },
    })
    renderAt('/profil')

    expect(await screen.findByText('Kolano')).toBeDefined()
    expect(screen.getByText('Laktoza')).toBeDefined()
    expect(screen.getByText('brokuły')).toBeDefined()
  })
})

describe('nawigacja', () => {
  it('pasek dolny prowadzi do wszystkich pięciu zakładek', async () => {
    await seedProfile()
    renderAt('/')

    await screen.findByText('Cześć, Konrad')
    for (const label of ['Dziś', 'Plan', 'Dieta', 'Zakupy', 'Profil']) {
      expect(screen.getByRole('link', { name: new RegExp(label) }), label).toBeDefined()
    }
  })

  it('Postępy NIE są zakładką w pasku — sześć zakładek ściskało etykiety', async () => {
    await seedProfile()
    renderAt('/')
    await screen.findByText('Cześć, Konrad')

    expect(screen.queryByRole('link', { name: /Postępy/ })).toBeNull()
    // Pasek ma dokładnie pięć zakładek.
    const tabs = ['Dziś', 'Plan', 'Dieta', 'Zakupy', 'Profil']
    expect(screen.getAllByRole('link').filter((link) =>
      tabs.some((tab) => link.textContent?.includes(tab)),
    )).toHaveLength(5)
  })

  it('Postępy są dostępne przyciskiem z ekranu Profil', async () => {
    await seedProfile()
    renderAt('/profil')
    await screen.findByText('Konrad')

    expect(screen.getByText('Zobacz wykresy i statystyki')).toBeDefined()
    fireEvent.click(screen.getByText('Zobacz wykresy i statystyki'))

    expect(await screen.findByText('Realizacja planu')).toBeDefined()
  })

  it('z ekranu Postępy da się wrócić do Profilu', async () => {
    await seedProfile()
    renderAt('/postepy')
    await screen.findByText('Realizacja planu')

    fireEvent.click(screen.getByRole('link', { name: 'Wróć do profilu' }))
    expect(await screen.findByText('Wyliczenia')).toBeDefined()
  })

  it('nieznana ścieżka wraca na ekran Dziś', async () => {
    await seedProfile()
    renderAt('/cokolwiek')
    expect(await screen.findByText('Cześć, Konrad')).toBeDefined()
  })

  it('sesja o nieistniejącym identyfikatorze pokazuje komunikat, nie wysypuje się', async () => {
    await seedProfile()
    renderAt('/trening/brak-takiej-sesji')
    expect(await screen.findByText('Nie znaleziono sesji')).toBeDefined()
  })
})

describe('ekran sesji treningowej', () => {
  it('pokazuje ćwiczenia z planu i pola do wpisania wykonania', async () => {
    const profile = await seedProfile()
    // Start od początku tygodnia: plan zaczęty w środku tygodnia świadomie
    // pomija dni sprzed startu, więc pierwszy tydzień mógłby nie mieć sesji
    // siłowej i test przechodziłby zależnie od dnia uruchomienia.
    const { plan } = await planRepo.generateAndSave(profile, startOfWeek(todayIso()), { weeks: 4 })
    const strength = (await planRepo.sessionsForWeek(plan.id, 0)).find(
      (s) => s.payload.kind === 'strength',
    )
    expect(strength).toBeDefined()

    renderAt(`/trening/${strength!.id}`)

    expect(await screen.findByText('Zapisz jako wykonane')).toBeDefined()
    expect(screen.getByText('Częściowo')).toBeDefined()
    expect(screen.getByText('Pominięte')).toBeDefined()
    // Nagłówki kolumn tabeli serii.
    expect(screen.getAllByText('Powt.').length).toBeGreaterThan(0)
    expect(screen.getAllByText('RPE').length).toBeGreaterThan(0)
  })

  it('KRYTYCZNE: sesja siłowa to trening z arkusza — z rozgrzewką i techniką', async () => {
    const profile = await seedProfile()
    const { plan } = await planRepo.generateAndSave(profile, startOfWeek(todayIso()), { weeks: 4 })
    const strength = (await planRepo.sessionsForWeek(plan.id, 0)).find(
      (s) => s.payload.kind === 'strength',
    )
    const payload = strength!.payload as StrengthPayload
    const workout = workoutById(payload.workoutId)!

    renderAt(`/trening/${strength!.id}`)
    await screen.findByText('Zapisz jako wykonane')

    // Nazwa treningu z arkusza. Nawiasy w „Trening A (FBW A)" trzeba uciec —
    // w regexie byłyby grupą i wzorzec przestałby pasować.
    const escaped = workout.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    expect(screen.getByText(new RegExp(escaped))).toBeDefined()
    // Pięć ćwiczeń, każde pod swoją nazwą z arkusza.
    for (const slot of workout.slots) {
      expect(screen.getByText(slot.main.name), slot.main.id).toBeDefined()
    }
    // Rozgrzewka jest pod ręką w sesji, nie w osobnej zakładce.
    expect(screen.getByText('Rozgrzewka — 5–7 minut')).toBeDefined()
    // Tempo i przerwa z arkusza w podpowiedzi ćwiczenia.
    expect(screen.getAllByText(new RegExp(`tempo ${workout.slots[0]!.main.tempo}`)).length)
      .toBeGreaterThan(0)
  })

  it('KRYTYCZNE: alternatywa z arkusza podmienia ćwiczenie w planie', async () => {
    const profile = await seedProfile()
    const { plan } = await planRepo.generateAndSave(profile, startOfWeek(todayIso()), { weeks: 4 })
    const strength = (await planRepo.sessionsForWeek(plan.id, 0)).find(
      (s) => s.payload.kind === 'strength',
    )
    const payload = strength!.payload as StrengthPayload
    const slot = workoutById(payload.workoutId)!.slots[0]!

    renderAt(`/trening/${strength!.id}`)
    await screen.findByText('Zapisz jako wykonane')

    fireEvent.click(screen.getAllByText(/Inne warianty \(2\)/)[0] as HTMLElement)
    const alternative = slot.alternatives[0]!
    fireEvent.click(await screen.findByText(alternative.name))

    // Podmiana idzie do PLANU, nie tylko do ekranu.
    await waitFor(async () => {
      const reloaded = await planRepo.byId(strength!.id)
      const after = reloaded?.payload as StrengthPayload
      expect(after.exercises[0]?.exerciseId).toBe(alternative.id)
      expect(after.exercises[0]?.sets).toHaveLength(alternative.sets)
    })

    /**
     * REGRESJA: po podmianie brakowało wierszy serii.
     *
     * Prefill szkicu wisiał na `session.id`, a podmiana zmienia PLAN tej samej
     * sesji — efekt się nie uruchamiał. Nowe ćwiczenie dostawało nagłówek
     * tabeli i zero wierszy, więc nie było gdzie wpisać wykonania, a szkic
     * nadal trzymał serie ćwiczenia ZASTĄPIONEGO i to one poszłyby do logu.
     */
    const title = await waitFor(() => {
      const heading = screen.getByRole('heading', { name: alternative.name })
      const card = heading.closest('.rounded-2xl')
      if (!card) throw new Error('nie znaleziono karty ćwiczenia')
      return card as HTMLElement
    })

    const inputs = within(title).getAllByRole('spinbutton') as HTMLInputElement[]
    // Trzy pola na serię: powtórzenia, ciężar, RPE.
    expect(inputs).toHaveLength(alternative.sets * 3)
    // Powtórzenia i ciężar z ARKUSZA, dla tego wariantu — nie po ćwiczeniu,
    // które zastąpił, i nie puste.
    expect(inputs[0]?.value).toBe(String(alternative.reps))
    if (alternative.startWeightKg !== null) {
      expect(inputs[1]?.value).toBe(String(alternative.startWeightKg))
    }
    expect(inputs[2]?.value).toBe('')
  })

  it('pokazuje plan biegu i pola wykonania dla sesji cardio', async () => {
    const profile = await seedProfile()
    const { plan } = await planRepo.generateAndSave(profile, todayIso(), { weeks: 4 })
    const run = (await planRepo.sessionsForWeek(plan.id, 0)).find((s) => s.type === 'run')
    expect(run, 'plan nie zawiera sesji biegowej').toBeDefined()

    renderAt(`/trening/${run!.id}`)

    expect(await screen.findByText('Wykonanie')).toBeDefined()
    expect(screen.getByText('Średnie tętno')).toBeDefined()
    expect(screen.getByText(/Strefa tętna/)).toBeDefined()
  })
})
