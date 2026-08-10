import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import type { Macros, MealSlot, NutritionTargets, PlannedMeal, Profile } from '@/domain/types'
import type { ScaledMeal } from '@/domain/diet/scaling'
import { SWEET_SNACK, SWEET_SNACK_LABEL } from '@/domain/diet/sweetSnack'
import {
  dishCategory,
  DISH_CATEGORY_LABELS,
  type DishCategory,
} from '@/domain/diet/category'
import { recipeMatches, searchTerms } from '@/domain/diet/search'
import { dietRepo, MEAL_SLOT_ORDER } from '@/db/dietRepo'
import { mealLogRepo } from '@/db/repositories'
import { shoppingRepo } from '@/db/shoppingRepo'
import { RECIPES_BY_ID } from '@/lib/catalog'
import { MEAL_SLOT_LABELS } from '@/lib/labels'
import { addDays, isoWeekday, startOfWeek, weekOrderIndex } from '@/domain/dates'
import { pl } from '@/lib/format'
import {
  Button,
  Callout,
  Card,
  Field,
  NumberInput,
  ProgressBar,
  SectionTitle,
  Sheet,
  Spinner,
  TextInput,
} from '@/components/ui'
import { MealCard } from './MealCard'
import { DietSetupCard } from '../shared/GenerateCards'

export function DietDayPanel({
  profile,
  date,
  targets,
}: {
  profile: Profile
  date: string
  targets: NutritionTargets
}) {
  const [substituteSlot, setSubstituteSlot] = useState<MealSlot | null>(null)
  const [manualOpen, setManualOpen] = useState(false)
  const [snackOpen, setSnackOpen] = useState(false)
  /** Slot, do którego wpisujemy posiłek ręcznie (po usunięciu z planu). */
  const [manualSlot, setManualSlot] = useState<MealSlot | null>(null)

  const data = useLiveQuery(async () => {
    /**
     * Sąsiednie dni czytamy po to, żeby powiedzieć, KIEDY się gotuje.
     *
     * Obiad powtarza się przez dwa dni (gotowanie na zapas), a bez tej adnotacji
     * powtórka wygląda jak pomyłka generatora — zamiast jak plan: dziś ugotuj
     * podwójną porcję, jutro odgrzej.
     */
    const [meals, logs, yesterday, tomorrow, weekMeals] = await Promise.all([
      dietRepo.mealsOnDate(date),
      mealLogRepo.byDate(date),
      dietRepo.mealsOnDate(addDays(date, -1)),
      dietRepo.mealsOnDate(addDays(date, 1)),
      dietRepo.mealsForWeek(date),
    ])
    return { meals, logs, yesterday, tomorrow, weekHasMeals: weekMeals.length > 0 }
  }, [date])

  if (!data) return <Spinner />

  /**
   * WSZYSTKIE wpisy przekąski, nie pierwszy z nich.
   *
   * Wcześniej karta pokazywała `find(...)` — jeden wpis. Drugi batonik tego
   * samego dnia był niewidoczny, choć wchodził do bilansu: „pozostało dziś"
   * spadało, a na ekranie nie było czego z tym powiązać.
   */
  const snackLogs = data.logs.filter((log) => log.slot === 'snack' && log.source === 'manual')

  /**
   * Karta „ułóż jadłospis" tylko wtedy, gdy tygodnia NIE MA.
   *
   * Dzień może być pusty także dlatego, że wszystkie posiłki zostały z niego
   * usunięte ręcznie — wtedy propozycja wygenerowania tygodnia jest odpowiedzią
   * na pytanie, którego nikt nie zadał. Zamiast niej pokazujemy puste slots
   * z wpisem ręcznym i wyborem z bazy.
   */
  if (data.meals.length === 0 && !data.weekHasMeals) {
    /**
     * Także tutaj musi być LISTA wpisów, nie tylko ich suma.
     *
     * Bez niej dzień bez jadłospisu pokazywał „zjedzone 900 z 1742 kcal"
     * i nic więcej: ani co to było, ani skąd to usunąć. Ten sam błąd, który
     * naprawiliśmy w dniu Z jadłospisem — kalorie bez pozycji do wytłumaczenia.
     */
    const logged = data.logs.filter((log) => log.source === 'manual')
    return (
      <div className="grid gap-4">
        <DietSetupCard profile={profile} targets={targets.macros} weekStart={date} />
        <ManualLogButton onOpen={() => setManualOpen(true)} />
        {logged.length > 0 && <ManualLogList logs={logged} />}
        <ConsumedCard logs={data.logs} targets={targets} />
        <ManualLogSheet
          open={manualOpen}
          date={date}
          onClose={() => setManualOpen(false)}
        />
      </div>
    )
  }

  const bySlot = new Map(data.meals.map((m) => [m.slot, m]))
  const logByPlannedId = new Map(
    data.logs.filter((l) => l.plannedMealId).map((l) => [l.plannedMealId as string, l]),
  )

  /**
   * Ręczne wpisy przypisane do slotu pokazujemy W TYM slocie, nie w „Poza planem".
   *
   * Wpis po usunięciu obiadu jest obiadem — jego miejsce jest tam, gdzie stał
   * usunięty posiłek. W „Poza planem" zostaje to, co jest naprawdę poza planem:
   * wpisy do slotu, który mimo wszystko ma zaplanowany posiłek.
   */
  const manualBySlot = new Map<MealSlot, typeof data.logs>()
  for (const log of data.logs) {
    if (log.source !== 'manual') continue
    if (log.slot === 'snack' || log.slot === 'other') continue
    if (bySlot.has(log.slot)) continue
    const bucket = manualBySlot.get(log.slot)
    if (bucket) bucket.push(log)
    else manualBySlot.set(log.slot, [log])
  }
  /**
   * „Poza planem": wpisy bez przypisanej pory dnia (`other`) i te, które trafiły
   * do slotu mającego zaplanowany posiłek — bo wtedy naprawdę są obok planu.
   *
   * Żaden wpis nie może wypaść ze WSZYSTKICH miejsc: każdy liczy się do
   * dziennego bilansu, więc musi być gdzie go zobaczyć i skąd go usunąć.
   */
  const offPlanLogs = data.logs.filter(
    (log) =>
      log.source === 'manual' &&
      log.slot !== 'snack' &&
      (log.slot === 'other' || bySlot.has(log.slot)),
  )

  /**
   * Suma zaplanowanych posiłków plus rezerwa na przekąskę.
   *
   * Gdy wychodzi wyraźnie pod celem, widać to TU, przy jadłospisie, a nie
   * tylko w momencie generowania tygodnia. Komunikat podaje same liczby:
   * przyczyna jest zawsze ta sama (sufit bazy przepisów), a rada „zmień
   * preset" była nieprawdziwa dokładnie wtedy, gdy ostrzeżenie się pokazuje —
   * przy 3000 kcal odsyłała do presetu 3000, który jest już włączony.
   */
  const plannedKcal =
    data.meals.reduce((sum, meal) => sum + meal.computed.kcal, 0) + SWEET_SNACK.kcal
  const shortfall = targets.kcal - plannedKcal

  /**
   * Który dzień pary gotowania to dzisiaj.
   *
   * Decyduje POZYCJA W TYGODNIU, nie samo porównanie przepisów. Pary liczą się
   * od początku tygodnia aplikacji (soboty): 0–1, 2–3, 4–5, a siódmy dzień
   * zostaje sam. Sama zgodność przepisu z wczorajszym nie wystarcza, bo przy
   * ciasnym celu solver potrafi wybrać to samo danie w DWÓCH kolejnych parach —
   * i środa mówiła wtedy „odgrzej", choć jest dniem gotowania.
   *
   * Porównanie przepisu zostaje jako drugi warunek: adnotacja pojawia się tylko
   * wtedy, gdy dania faktycznie są te same (jadłospis mógł zostać ręcznie
   * podmieniony na jednym dniu z pary).
   */
  const lunchId = bySlot.get('lunch')?.recipeId
  const sameLunch = (meals: readonly PlannedMeal[]) =>
    lunchId !== undefined && meals.some((m) => m.slot === 'lunch' && m.recipeId === lunchId)

  const secondDayOfPair = weekOrderIndex(isoWeekday(date)) % 2 === 1
  const batchNote =
    secondDayOfPair && sameLunch(data.yesterday)
      ? 'Z wczorajszego gotowania — odgrzej porcję.'
      : !secondDayOfPair && sameLunch(data.tomorrow)
        ? 'Ugotuj podwójną porcję: ten obiad jest też na jutro.'
        : undefined

  return (
    <div className="grid gap-4">
      <ConsumedCard logs={data.logs} targets={targets} />

      {shortfall > targets.kcal * 0.05 && (
        <Callout tone="warn" title={`Jadłospis daje ${plannedKcal} z ${targets.kcal} kcal`} />
      )}

      <div className="grid gap-2">
        {MEAL_SLOT_ORDER.map((slot) => {
          /**
           * Słodka przekąska stoi w kolejności dnia jak każdy inny posiłek,
           * ale nie pochodzi z solvera — ma odłożony budżet i pustą treść.
           * Bez tej pozycji rezerwa 200 kcal byłaby niewidoczna i wyglądałaby
           * jak błąd w wyliczeniach („dlaczego posiłki nie sumują się do celu?").
           */
          if (slot === 'snack') {
            return (
              <SweetSnackCard key="snack" logs={snackLogs} onOpen={() => setSnackOpen(true)} />
            )
          }

          const meal = bySlot.get(slot)
          if (!meal) {
            /**
             * Slot bez posiłku — po usunięciu z planu albo w dniu, który nigdy
             * go nie dostał. Zamiast pustego miejsca dajemy dwie drogi: wpisać
             * własny posiłek albo wstawić danie z bazy.
             */
            return (
              <EmptySlotCard
                key={slot}
                slot={slot}
                logs={manualBySlot.get(slot) ?? []}
                onManual={() => setManualSlot(slot)}
                onPick={() => setSubstituteSlot(slot)}
              />
            )
          }
          return (
            <MealCard
              key={meal.id}
              meal={meal}
              note={slot === 'lunch' ? batchNote : undefined}
              log={logByPlannedId.get(meal.id)}
              onLog={() => mealLogRepo.logFromPlan(date, slot, meal.id, meal.computed)}
              onUnlog={async () => {
                const log = logByPlannedId.get(meal.id)
                if (log) await mealLogRepo.softDelete(log.id)
              }}
              onSubstitute={() => setSubstituteSlot(slot)}
              onRemove={async () => {
                await dietRepo.removeMeal(meal.id)
                // Lista zakupów ma odpowiadać jadłospisowi bez proszenia o to
                // osobno — inaczej idziesz do sklepu po składniki dania, którego
                // już nie ma w planie. Przebudowa zachowuje odhaczenia.
                await shoppingRepo.rebuildIfExists(startOfWeek(date))
              }}
            />
          )
        })}
      </div>

      <ManualLogButton onOpen={() => setManualOpen(true)} />

      {offPlanLogs.length > 0 && <ManualLogList logs={offPlanLogs} />}

      <SubstituteSheet
        profile={profile}
        date={date}
        slot={substituteSlot}
        targets={targets.macros}
        currentMeal={substituteSlot ? bySlot.get(substituteSlot) : undefined}
        onClose={() => setSubstituteSlot(null)}
      />
      <ManualLogSheet open={manualOpen} date={date} onClose={() => setManualOpen(false)} />
      {manualSlot && (
        <ManualLogSheet
          open
          date={date}
          slot={manualSlot}
          title={`${MEAL_SLOT_LABELS[manualSlot]} — wpis własny`}
          intro="Ten posiłek nie pochodzi z bazy przepisów, więc nie wejdzie na listę zakupów. Kalorie są obowiązkowe, makra opcjonalne — bez nich dzienny bilans i wyliczenie realnego wydatku byłyby nieprawdziwe."
          onClose={() => setManualSlot(null)}
        />
      )}
      <ManualLogSheet
        open={snackOpen}
        date={date}
        slot="snack"
        title={SWEET_SNACK_LABEL}
        intro={`Budżet ${SWEET_SNACK.kcal} kcal jest już odłożony z celu dziennego — wpisz, co to było. Jeśli wyszło więcej, dzień nadal się policzy, tylko bilans będzie wyższy.`}
        preset={SWEET_SNACK}
        onClose={() => setSnackOpen(false)}
      />
    </div>
  )
}

/**
 * Stała pozycja: słodka przekąska.
 *
 * Nie jest propozycją z katalogu, bo solver nie ma jak zaproponować „czegoś
 * słodkiego" z bazy obiadowej — wyszedłby jogurt w miejscu batonika. Zamiast
 * tego pokazujemy odłożony budżet i pole do wpisania, co faktycznie zostało
 * zjedzone.
 */
function SweetSnackCard({
  logs,
  onOpen,
}: {
  /** WSZYSTKIE wpisy przekąski z tego dnia, nie pierwszy z nich. */
  logs: readonly { id: string; label?: string; macros: Macros }[]
  onOpen: () => void
}) {
  const kcal = logs.reduce((sum, log) => sum + log.macros.kcal, 0)

  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs tracking-wide text-[var(--color-text-dim)] uppercase">
            {MEAL_SLOT_LABELS.snack}
          </p>
          <p className="mt-0.5 font-medium">{logs.length > 0 ? `${kcal} kcal` : 'Do wpisania'}</p>
          {logs.length === 0 && (
            <p className="mt-0.5 text-sm text-[var(--color-text-dim)]">
              budżet {SWEET_SNACK.kcal} kcal — odłożony z celu dziennego
            </p>
          )}
        </div>
        <Button variant={logs.length > 0 ? 'ghost' : 'primary'} onClick={onOpen}>
          {logs.length > 0 ? 'Dopisz' : 'Wpisz'}
        </Button>
      </div>

      {logs.length > 0 && (
        <ul className="mt-2 grid gap-1 text-sm">
          {logs.map((log) => (
            <li key={log.id} className="flex items-center justify-between gap-3">
              <span>{log.label ?? 'Bez nazwy'}</span>
              <span className="flex shrink-0 items-center gap-3 text-[var(--color-text-dim)]">
                {log.macros.kcal} kcal
                <button
                  type="button"
                  onClick={() => mealLogRepo.softDelete(log.id)}
                  className="text-[var(--color-danger)]"
                >
                  usuń
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

/**
 * Slot bez zaplanowanego posiłku.
 *
 * Powstaje po usunięciu posiłku z planu („Usuń" w karcie) i to jest jego główny
 * powód istnienia: bez tej karty slot znikał z ekranu, a razem z nim droga
 * powrotna. Są tu dwie — wpisać własny posiłek albo wziąć danie z bazy.
 *
 * Wpisy własne pokazujemy TUTAJ, a nie w „Poza planem": wpis po usunięciu obiadu
 * jest obiadem i jego miejsce jest w miejscu obiadu. Nie wchodzą na listę
 * zakupów, bo aplikacja nie zna ich składników — mówimy to wprost w karcie.
 */
function EmptySlotCard({
  slot,
  logs,
  onManual,
  onPick,
}: {
  slot: MealSlot
  logs: readonly { id: string; label?: string; macros: Macros }[]
  onManual: () => void
  onPick: () => void
}) {
  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs tracking-wide text-[var(--color-text-dim)] uppercase">
            {MEAL_SLOT_LABELS[slot]}
          </p>
          <p className="mt-0.5 font-medium">
            {logs.length > 0 ? 'Wpisane ręcznie' : 'Brak posiłku w planie'}
          </p>
          {logs.length === 0 && (
            <p className="mt-0.5 text-sm text-[var(--color-text-dim)]">
              Wpisz, co jesz, albo wstaw danie z bazy przepisów.
            </p>
          )}
        </div>
        {logs.length === 0 && <Button onClick={onManual}>Wpisz</Button>}
      </div>

      {logs.length > 0 && (
        <ul className="mt-2 grid gap-1 text-sm">
          {logs.map((log) => (
            <li key={log.id} className="flex items-center justify-between gap-3">
              <span>{log.label ?? 'Bez nazwy'}</span>
              <span className="flex shrink-0 items-center gap-3 text-[var(--color-text-dim)]">
                {log.macros.kcal} kcal
                <button
                  type="button"
                  onClick={() => mealLogRepo.softDelete(log.id)}
                  className="text-[var(--color-danger)]"
                >
                  usuń
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-2 flex gap-3 text-sm">
        {logs.length > 0 && (
          <button type="button" onClick={onManual} className="min-h-11 text-[var(--color-accent)]">
            Dopisz kolejny
          </button>
        )}
        <button type="button" onClick={onPick} className="min-h-11 text-[var(--color-text-dim)]">
          Wstaw z bazy przepisów
        </button>
      </div>
    </Card>
  )
}

// ────────────────────────────────────────────────────── Podsumowanie

function ConsumedCard({
  logs,
  targets,
}: {
  logs: readonly { macros: Macros }[]
  targets: NutritionTargets
}) {
  const consumed = logs.reduce<Macros>(
    (sum, log) => ({
      kcal: sum.kcal + log.macros.kcal,
      proteinG: sum.proteinG + log.macros.proteinG,
      fatG: sum.fatG + log.macros.fatG,
      carbsG: sum.carbsG + log.macros.carbsG,
    }),
    { kcal: 0, proteinG: 0, fatG: 0, carbsG: 0 },
  )

  const remaining = targets.kcal - Math.round(consumed.kcal)

  return (
    <Card>
      <div className="flex items-end justify-between">
        <div>
          <p className="text-xs tracking-wide text-[var(--color-text-dim)] uppercase">
            Pozostało dziś
          </p>
          <p className="text-3xl font-semibold">
            {remaining}
            <span className="ml-1 text-sm font-normal text-[var(--color-text-dim)]">kcal</span>
          </p>
        </div>
        <p className="text-sm text-[var(--color-text-dim)]">
          {Math.round(consumed.kcal)} / {targets.kcal} kcal
        </p>
      </div>
      <div className="mt-2">
        <ProgressBar
          value={consumed.kcal}
          max={targets.kcal}
          tone={consumed.kcal > targets.kcal * 1.05 ? 'warn' : 'accent'}
        />
      </div>

      <div className="mt-4 grid grid-cols-3 gap-3">
        {(
          [
            ['Białko', consumed.proteinG, targets.macros.proteinG],
            ['Tłuszcz', consumed.fatG, targets.macros.fatG],
            ['Węgle', consumed.carbsG, targets.macros.carbsG],
          ] as const
        ).map(([label, value, max]) => (
          <div key={label}>
            <div className="flex justify-between text-xs">
              <span className="text-[var(--color-text-dim)]">{label}</span>
              <span>
                {Math.round(value)}/{max}
              </span>
            </div>
            <div className="mt-1">
              <ProgressBar value={value} max={max} tone={value > max * 1.1 ? 'warn' : 'ok'} />
            </div>
          </div>
        ))}
      </div>
    </Card>
  )
}

function ManualLogButton({ onOpen }: { onOpen: () => void }) {
  return (
    <Button variant="ghost" onClick={onOpen} className="w-full">
      + Zjadłem coś innego
    </Button>
  )
}

function ManualLogList({ logs }: { logs: readonly { id: string; label?: string; macros: Macros }[] }) {
  return (
    <Card>
      <SectionTitle hint="Wpisy poza planem. Wliczają się do dziennego bilansu i do wyliczenia realnego wydatku.">
        Poza planem
      </SectionTitle>
      <ul className="grid gap-2 text-sm">
        {logs.map((log) => (
          <li key={log.id} className="flex items-center justify-between gap-3">
            <span>{log.label ?? 'Bez nazwy'}</span>
            <span className="flex shrink-0 items-center gap-3 text-[var(--color-text-dim)]">
              {log.macros.kcal} kcal
              <button
                type="button"
                onClick={() => mealLogRepo.softDelete(log.id)}
                className="text-[var(--color-danger)]"
              >
                usuń
              </button>
            </span>
          </li>
        ))}
      </ul>
    </Card>
  )
}

// ─────────────────────────────────────────────────────── Zamienniki

function SubstituteSheet({
  profile,
  date,
  slot,
  targets,
  currentMeal,
  onClose,
}: {
  profile: Profile
  date: string
  slot: MealSlot | null
  targets: Macros
  currentMeal: PlannedMeal | undefined
  onClose: () => void
}) {
  const [busy, setBusy] = useState(false)
  /** Wpisany tekst — patrz `domain/diet/search.ts`. */
  const [query, setQuery] = useState('')

  const options = useLiveQuery(
    async () => (slot ? dietRepo.substitutesFor(profile, date, slot, targets) : []),
    [slot, date, profile.id],
  )

  /**
   * Zamknięcie arkusza czyści wyszukiwanie.
   *
   * Komponent zostaje ZAMONTOWANY po zamknięciu (`Sheet` zwraca null, ale stan
   * przeżywa), więc bez tego następne otwarcie — także dla innego posiłku —
   * pokazywałoby listę przefiltrowaną poprzednim wpisem. Wygląda to jak pusty
   * katalog, nie jak filtr, bo pole wyszukiwania jest wtedy poza ekranem.
   */
  function close() {
    setQuery('')
    onClose()
  }

  /**
   * Podmiana albo WSTAWIENIE, zależnie od tego, czy slot jest zajęty.
   *
   * Ten sam arkusz obsługuje oba przypadki, bo pytanie jest to samo: „które
   * danie z bazy ma tu stanąć". Po usunięciu posiłku slot jest pusty i wtedy
   * `addMeal` jest jedyną drogą powrotną.
   */
  async function replace(replacement: ScaledMeal) {
    if (!slot) return
    setBusy(true)
    try {
      if (currentMeal) await dietRepo.replaceMeal(currentMeal.id, replacement)
      else await dietRepo.addMeal(date, slot, replacement)
      // Lista zakupów przestała odpowiadać jadłospisowi — przebudowa
      // zachowuje odhaczone pozycje. Tylko gdy lista istnieje: budowanie jej
      // przy okazji edycji dnia byłoby zrobieniem czegoś, o co nikt nie prosił.
      await shoppingRepo.rebuildIfExists(startOfWeek(date))
      close()
    } finally {
      setBusy(false)
    }
  }

  /**
   * Filtr po wpisanym tekście stoi PRZED grupowaniem.
   *
   * Dzięki temu znikają też całe grupy, w których nic nie zostało — inaczej
   * ekran pokazywałby nagłówki kategorii z pustą listą pod spodem.
   *
   * Przepis nieznany katalogowi (pozycja z bazy, której już nie ma) przechodzi
   * tylko przy pustym wyszukiwaniu: nie znamy jego nazwy ani składników, więc
   * nie ma czego dopasować, a pokazanie go przy wpisanym tekście byłoby
   * wynikiem, który nie pasuje do zapytania.
   */
  const terms = searchTerms(query)
  const matching = (options ?? []).filter((option) => {
    const recipe = RECIPES_BY_ID.get(option.recipeId)
    return recipe ? recipeMatches(recipe, terms) : terms.length === 0
  })

  /**
   * PEŁNA lista, pogrupowana po kategorii dania.
   *
   * Wcześniej było pięć pierwszych pozycji rankingu i nic więcej — a ranking
   * odpowiada tylko na pytanie „co najlepiej trafia w makra". Wybór posiłku
   * bywa podejmowany z innego powodu: co jest w domu, na co jest ochota, czy
   * dziś ma być mięso. Dlatego pokazujemy wszystko, co pasuje do slotu,
   * z kategorią i kaloriami przy każdej pozycji.
   *
   * Grupy ustawiamy w kolejności RANKINGU — kategoria z najlepszą pozycją jest
   * pierwsza. Kolejność alfabetyczna zepchnęłaby najlepszy zamiennik na koniec
   * listy, a to on jest domyślną odpowiedzią.
   */
  const groups = groupByCategory(matching)

  return (
    <Sheet
      open={slot !== null}
      title={slot ? `Zamienniki: ${MEAL_SLOT_LABELS[slot]}` : ''}
      onClose={close}
    >
      {options && options.length > 0 && (
        <div className="mb-3 flex items-center gap-2">
          <div className="flex-1">
            <TextInput
              value={query}
              onChange={setQuery}
              placeholder="Szukaj: nazwa dania albo składnik"
            />
          </div>
          {query.length > 0 && (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="min-h-11 shrink-0 px-2 text-sm text-[var(--color-text-dim)]"
            >
              Wyczyść
            </button>
          )}
        </div>
      )}

      <p className="mb-3 text-sm text-[var(--color-text-dim)]">
        {options && options.length > 0
          ? terms.length > 0
            ? `Pasuje ${matching.length} z ${options.length} przepisów na ten posiłek. ` +
              'Szukamy w nazwie dania i w jego składnikach.'
            : `Wszystkie przepisy na ten posiłek (${options.length}), pogrupowane po kategorii. ` +
              'W obrębie grupy pierwszy jest ten, po którym cały dzień najlepiej trafia w makra.'
          : 'Uszeregowane tak, żeby cały dzień nadal trafiał w makra — nie po podobieństwie samego posiłku.'}
      </p>

      {!options ? (
        <Spinner />
      ) : options.length === 0 ? (
        <Callout tone="warn">
          Brak alternatyw dla tego posiłku przy obecnych wykluczeniach.
        </Callout>
      ) : matching.length === 0 ? (
        <Callout tone="warn" title={`Nic nie pasuje do „${query.trim()}”`}>
          Szukamy w nazwach dań i w składnikach, bez polskich znaków i odmiany —
          spróbuj krótszego fragmentu, np. „twaroz” zamiast „twarożkiem”.
        </Callout>
      ) : (
        <div className="grid gap-4">
          {groups.map(({ category, items }) => (
            <div key={category}>
              <p className="mb-1.5 text-xs tracking-wide text-[var(--color-text-dim)] uppercase">
                {DISH_CATEGORY_LABELS[category]} · {items.length}
              </p>
              <ul className="grid gap-2">
                {items.map(({ option, rank }) => (
                  <li key={`${option.recipeId}-${option.scale}`}>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => replace(option)}
                      className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3 text-left disabled:opacity-50"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p className="font-medium">
                          {RECIPES_BY_ID.get(option.recipeId)?.name ?? option.recipeId}
                        </p>
                        <span className="shrink-0 font-medium">{option.macros.kcal} kcal</span>
                      </div>
                      <p className="mt-0.5 text-sm text-[var(--color-text-dim)]">
                        {option.macros.proteinG} B · {option.macros.fatG} T ·{' '}
                        {option.macros.carbsG} W · porcja ×{pl(option.scale, 2)}
                        {rank === 0 && ' · najlepiej trafia w dzienne makro'}
                      </p>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </Sheet>
  )
}

interface CategoryGroup {
  category: DishCategory
  /** `rank` to pozycja w rankingu całej listy — zero znaczy „najlepszy zamiennik". */
  items: { option: ScaledMeal; rank: number }[]
}

/** Grupuje zamienniki po kategorii, zachowując kolejność rankingową. */
function groupByCategory(options: readonly ScaledMeal[]): CategoryGroup[] {
  const groups = new Map<DishCategory, CategoryGroup['items']>()

  options.forEach((option, rank) => {
    const recipe = RECIPES_BY_ID.get(option.recipeId)
    const category = recipe ? dishCategory(recipe) : 'grain'
    const bucket = groups.get(category)
    if (bucket) bucket.push({ option, rank })
    else groups.set(category, [{ option, rank }])
  })

  // Map zachowuje kolejność wstawiania, a wstawiamy w kolejności rankingu —
  // więc grupa z najlepszym zamiennikiem wychodzi pierwsza bez sortowania.
  return [...groups.entries()].map(([category, items]) => ({ category, items }))
}

// ───────────────────────────────────────── Logowanie odstępstwa

const EMPTY_MANUAL = { label: '', kcal: null, proteinG: null, fatG: null, carbsG: null }

/**
 * Ręczny wpis — i dla odstępstwa od planu, i dla słodkiej przekąski.
 *
 * Jeden komponent na oba przypadki, bo różnią się wyłącznie slotem, tytułem
 * i wartościami startowymi. Dwie kopie tego formularza rozjechałyby się przy
 * pierwszej zmianie walidacji.
 */
function ManualLogSheet({
  open,
  date,
  // Domyślnie POZA planem, nie w przekąsce: „zjadłem coś innego" nie jest
  // słodką przekąską. Patrz `MealSlot` w `domain/types.ts`.
  slot = 'other',
  title = 'Zjadłem coś innego',
  intro = 'Makra są opcjonalne, kalorie nie. Bez zalogowanych odstępstw dzienny bilans kłamie, a realnego wydatku nie da się policzyć.',
  preset,
  onClose,
}: {
  open: boolean
  date: string
  slot?: MealSlot
  title?: string
  intro?: string
  /** Wartości startowe — dla przekąski wypełniamy odłożonym budżetem. */
  preset?: Macros
  onClose: () => void
}) {
  const [form, setForm] = useState<{
    label: string
    kcal: number | null
    proteinG: number | null
    fatG: number | null
    carbsG: number | null
  }>(() =>
    preset
      ? {
          label: '',
          kcal: preset.kcal,
          proteinG: preset.proteinG,
          fatG: preset.fatG,
          carbsG: preset.carbsG,
        }
      : EMPTY_MANUAL,
  )
  const [busy, setBusy] = useState(false)

  const valid = form.label.trim().length > 0 && form.kcal !== null && form.kcal > 0

  async function save() {
    if (!valid) return
    setBusy(true)
    try {
      await mealLogRepo.logManual(date, slot, form.label.trim(), {
        kcal: Math.round(form.kcal as number),
        proteinG: form.proteinG ?? 0,
        fatG: form.fatG ?? 0,
        carbsG: form.carbsG ?? 0,
      })
      setForm(preset ? { ...EMPTY_MANUAL, ...preset, label: '' } : EMPTY_MANUAL)
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet open={open} title={title} onClose={onClose}>
      <p className="mb-3 text-sm text-[var(--color-text-dim)]">{intro}</p>

      <div className="grid gap-3">
        <Field label="Co to było">
          <TextInput
            value={form.label}
            onChange={(label) => setForm((f) => ({ ...f, label }))}
            placeholder="np. pizza, obiad na mieście"
          />
        </Field>

        <Field label="Kalorie">
          <NumberInput
            value={form.kcal}
            onChange={(kcal) => setForm((f) => ({ ...f, kcal }))}
            min={1}
            max={5000}
            step={10}
            suffix="kcal"
          />
        </Field>

        <div className="grid grid-cols-3 gap-2">
          <Field label="Białko">
            <NumberInput
              value={form.proteinG}
              onChange={(proteinG) => setForm((f) => ({ ...f, proteinG }))}
              min={0}
              suffix="g"
            />
          </Field>
          <Field label="Tłuszcz">
            <NumberInput
              value={form.fatG}
              onChange={(fatG) => setForm((f) => ({ ...f, fatG }))}
              min={0}
              suffix="g"
            />
          </Field>
          <Field label="Węgle">
            <NumberInput
              value={form.carbsG}
              onChange={(carbsG) => setForm((f) => ({ ...f, carbsG }))}
              min={0}
              suffix="g"
            />
          </Field>
        </div>

        <Button onClick={save} disabled={!valid || busy} className="w-full">
          {busy ? 'Zapisywanie…' : 'Zapisz'}
        </Button>
      </div>
    </Sheet>
  )
}
