import { describe, expect, it } from 'vitest'
import type { Recipe, WorkoutExercise } from '@/domain/types'
import { MEAL_SLOTS } from '@/domain/diet/solver'
import { recipeAllergens, recipeDietStyles } from '@/domain/diet/derive'
import { dishCategory, DISH_CATEGORY_LABELS } from '@/domain/diet/category'
import { aisleFor } from '@/domain/shopping/aisles'
import { SWEET_SNACK, plannedMealTargets } from '@/domain/diet/sweetSnack'
import { EXERCISE_VIDEOS } from '@/data/exerciseVideos'
import {
  BANNED_INGREDIENT_TERMS,
  DIET_CATALOG,
  RECIPES,
  WARMUP,
  WORKOUTS,
  WORKOUT_EXERCISES_BY_ID,
  exercisePlacement,
  exerciseVideo,
  passesCatalogBan,
} from './catalog'

/**
 * Katalog pochodzi z arkuszy trenera (`data-source/`), więc testy pilnują dwóch
 * różnych rzeczy: (1) reguł gospodarstwa domowego, które da się złamać przy
 * dopisywaniu przepisu, i (2) tego, że import nie zgubił ani nie przekręcił
 * danych — bo generowanego pliku nikt nie czyta linia po linii.
 */

describe('filtr katalogu', () => {
  function recipe(patch: Partial<Recipe> = {}): Recipe {
    return {
      id: 'test',
      name: 'Danie testowe',
      slot: 'lunch',
      ingredients: [{ name: 'Pierś z kurczaka', amount: 150, unit: 'g' }],
      spices: ['sól'],
      steps: ['Zrób.'],
      prepMinutes: 10,
      macros: { kcal: 500, proteinG: 40, fatG: 15, carbsG: 45 },
      minScale: 0.8,
      maxScale: 1.2,
      ...patch,
    }
  }

  it('KRYTYCZNE: domyślnie nie wyklucza NICZEGO', () => {
    /**
     * Lista jest pusta świadomie. FitPlanner miał tu wykluczenia swojej
     * użytkowniczki i przepisanie ich do FITKonrada byłoby przeniesieniem
     * cudzego gustu — a wykluczenie, o które nikt nie prosił, po cichu zwęża
     * bazę. Ten test pilnuje, żeby nie wróciły przez przypadek przy kopiowaniu
     * kodu z tamtego projektu.
     */
    expect(BANNED_INGREDIENT_TERMS).toEqual([])
    expect(passesCatalogBan(recipe({ name: 'Kalafior zapiekany' }))).toBe(true)
    expect(
      passesCatalogBan(recipe({ ingredients: [{ name: 'Kasza jaglana', amount: 60, unit: 'g' }] })),
    ).toBe(true)
  })

  it('mechanizm działa po nazwie dania I po nazwie składnika', () => {
    // Sam mechanizm zostaje sprawny, żeby dopisanie „tego nie jem" było jedną
    // linią. Testujemy go na jawnie podanej liście, nie na domyślnej.
    const banned = ['kalafior']
    expect(passesCatalogBan(recipe({ name: 'Kalafior zapiekany' }), banned)).toBe(false)
    expect(
      passesCatalogBan(
        recipe({ ingredients: [{ name: 'Kalafior', amount: 200, unit: 'g' }] }),
        banned,
      ),
    ).toBe(false)
    expect(passesCatalogBan(recipe({ name: 'Kurczak z ryżem' }), banned)).toBe(true)
  })

  it('dopasowanie ignoruje polskie znaki i wielkość liter', () => {
    expect(passesCatalogBan(recipe({ name: 'Zupa z ŁOSOSIA' }), ['lososia'])).toBe(false)
  })

  it('cały katalog przechodzi własny filtr', () => {
    for (const r of DIET_CATALOG.recipes) {
      expect(passesCatalogBan(r), r.id).toBe(true)
    }
  })

  it('przy pustej liście katalog jest całą bazą — nic nie odpada po cichu', () => {
    expect(DIET_CATALOG.recipes).toHaveLength(RECIPES.length)
  })
})

describe('baza przepisów', () => {
  /**
   * Minimum na slot, nie dokładna liczba: dopisanie przepisu ma być zmianą
   * w jednym pliku JSON, a nie zmianą w JSON-ie plus poprawką testu.
   * Dolna granica jest natomiast twarda i wynika z reguły „żaden przepis nie
   * wraca przez miesiąc": 28 dni zużywa 28 pozycji w slocie (obiad przy
   * gotowaniu na zapas: 14), a bez zapasu solver wpada w awaryjny powrót
   * do pełnej listy. Ta sama liczba stoi w `import_recipes.py`.
   */
  const MIN_PER_SLOT = 40

  it(`ma co najmniej ${MIN_PER_SLOT} przepisów w każdym z czterech slotów`, () => {
    expect(MEAL_SLOTS).toEqual(['breakfast', 'lunch', 'afternoon', 'dinner'])
    for (const slot of MEAL_SLOTS) {
      expect(
        RECIPES.filter((r) => r.slot === slot).length,
        slot,
      ).toBeGreaterThanOrEqual(MIN_PER_SLOT)
    }
    expect(RECIPES.length).toBe(MEAL_SLOTS.reduce((sum, slot) => sum + RECIPES.filter((r) => r.slot === slot).length, 0))
  })

  it('identyfikatory i nazwy są unikalne', () => {
    // Powtórzony identyfikator rozjechałby historię („żaden przepis nie wraca
    // przez miesiąc" chodzi po `recipeId`), a powtórzona nazwa dałaby dwie
    // nierozróżnialne pozycje na liście zamienników.
    expect(new Set(RECIPES.map((r) => r.id)).size).toBe(RECIPES.length)
    expect(new Set(RECIPES.map((r) => r.name)).size).toBe(RECIPES.length)
  })

  it('każdy przepis ma składniki, instrukcję i makro', () => {
    for (const r of RECIPES) {
      expect(r.ingredients.length, r.id).toBeGreaterThan(0)
      expect(r.steps.length, r.id).toBeGreaterThan(0)
      expect(r.macros.kcal, r.id).toBeGreaterThan(0)
      expect(r.prepMinutes, r.id).toBeGreaterThan(0)
    }
  })

  it('KRYTYCZNE: makro zgadza się z kaloriami', () => {
    // 4/9/4 kcal na gram. Rozjazd większy niż 5% znaczyłby, że importer pomieszał
    // kolumny w `produkty.json` albo tabela ma literówkę — jedno i drugie
    // zafałszowałoby cały dzienny bilans. Próg jest ciaśniejszy niż w
    // FitPlannerze (10%), bo tam makro pochodziło z arkusza i mogło mieć własne
    // zaokrąglenia; tutaj liczy je ten sam skrypt, więc zgodność ma być pełna.
    for (const r of RECIPES) {
      const fromMacros = r.macros.proteinG * 4 + r.macros.fatG * 9 + r.macros.carbsG * 4
      const drift = Math.abs(fromMacros - r.macros.kcal) / r.macros.kcal
      expect(drift, `${r.id}: ${r.macros.kcal} kcal vs ${Math.round(fromMacros)} z makro`).toBeLessThan(0.05)
    }
  })

  it('KRYTYCZNE: każdy przepis trafia w cel kaloryczny swojego slotu', () => {
    /**
     * Wielkość porcji dobiera importer (`fit_portion`), więc ten test sprawdza
     * jego robotę na wyniku, nie na wejściu. Cele: 24/30/22/24% z 2550 kcal
     * posiłków planowanych przy diecie projektowej 2750 kcal. Bez tego przepis
     * odstający o 20% od slotu wchodziłby do bazy niezauważony i zjadał cały
     * zapas tolerancji dnia.
     */
    const targets: Record<string, number> = {
      breakfast: 2550 * 0.24,
      lunch: 2550 * 0.3,
      afternoon: 2550 * 0.22,
      dinner: 2550 * 0.24,
    }
    for (const r of RECIPES) {
      const target = targets[r.slot] as number
      const deviation = Math.abs(r.macros.kcal - target) / target
      expect(deviation, `${r.id}: ${r.macros.kcal} kcal przy celu ${Math.round(target)}`).toBeLessThan(0.03)
    }
  })

  it('żaden przepis nie celuje w slot słodkiej przekąski', () => {
    // Ten slot wypełnia użytkownik ręcznie z odłożonego budżetu.
    for (const r of RECIPES) {
      expect(r.slot, r.id).not.toBe('snack')
    }
  })

  it('ilości składników mają jednostkę z tabeli, bez wymyślonych liczb', () => {
    for (const r of RECIPES) {
      for (const ing of r.ingredients) {
        expect(['g', 'ml', 'piece'], `${r.id}/${ing.name}`).toContain(ing.unit)
        if (ing.amount !== null) expect(ing.amount, `${r.id}/${ing.name}`).toBeGreaterThan(0)
      }
    }
  })

  it('KRYTYCZNE: żadna gramatura nie jest kuchennie bezsensowna', () => {
    /**
     * Dopasowanie porcji potrafi zejść do „oliwa z oliwek 2 g" — liczby
     * arytmetycznie poprawnej i nie do odmierzenia. Podłogi (`minGram`
     * w `produkty.json`) mają temu zapobiegać; ten test sprawdza, czy
     * faktycznie zapobiegły, bo w generowanym pliku nikt tego nie zauważy.
     */
    for (const r of RECIPES) {
      for (const ing of r.ingredients) {
        if (ing.amount === null || ing.unit === 'piece') continue
        expect(ing.amount, `${r.id}: ${ing.name} ${ing.amount} ${ing.unit}`).toBeGreaterThanOrEqual(4)
      }
    }
  })

  it('porcje skalują się o najwyżej ±25%', () => {
    /**
     * 0,75–1,25 pokrywa cały zakres 2500–3000 kcal (baza jest pisana na 2750),
     * z zapasem po obu stronach — przy 2500 solver schodzi do ~0,90, przy 3000
     * wchodzi na ~1,10. Szerszy zakres dawałby porcje, których nikt nie zje;
     * węższy postawiłby jeden z dwóch celów na granicy, gdzie solver traci
     * swobodę i zaczyna powtarzać najcięższe dania.
     */
    for (const r of RECIPES) {
      expect(r.minScale, r.id).toBe(0.75)
      expect(r.maxScale, r.id).toBe(1.25)
    }
  })
})

describe('wyliczanie alergenów i stylu diety', () => {
  function recipeWith(names: string[]): Recipe {
    return {
      id: 'x',
      name: 'Danie',
      slot: 'lunch',
      ingredients: names.map((name) => ({ name, amount: 100, unit: 'g' as const })),
      spices: [],
      steps: ['Zrób.'],
      prepMinutes: 10,
      macros: { kcal: 400, proteinG: 30, fatG: 10, carbsG: 40 },
      minScale: 0.8,
      maxScale: 1.2,
    }
  }

  it('rozpoznaje alergeny po nazwach składników', () => {
    expect(recipeAllergens(recipeWith(['Chleb razowy']))).toContain('gluten')
    expect(recipeAllergens(recipeWith(['Jogurt naturalny']))).toContain('lactose')
    expect(recipeAllergens(recipeWith(['Jajko']))).toContain('eggs')
    expect(recipeAllergens(recipeWith(['Dorsz filet']))).toContain('fish')
    expect(recipeAllergens(recipeWith(['Tofu naturalne']))).toContain('soy')
    expect(recipeAllergens(recipeWith(['Orzechy włoskie']))).toContain('nuts')
  })

  it('KRYTYCZNE: styl diety wymaga DOWODU roślinności', () => {
    // Kierunek błędu jest wybrany: danie wątpliwe zostaje wszystkożerne.
    // Wegetarianka zobaczy mniej opcji, ale nie zobaczy szynki w sałatce.
    expect(recipeDietStyles(recipeWith(['Pierś z kurczaka', 'Ryż basmati']))).toEqual(['omnivore'])
    expect(recipeDietStyles(recipeWith(['Dorsz filet', 'Ziemniaki']))).toEqual([
      'omnivore',
      'pescatarian',
    ])
    expect(recipeDietStyles(recipeWith(['Twaróg chudy', 'Chleb razowy']))).toEqual([
      'omnivore',
      'pescatarian',
      'vegetarian',
    ])
    expect(recipeDietStyles(recipeWith(['Tofu wędzone', 'Ryż brązowy']))).toContain('vegan')

    /**
     * Dwa produkty, które przez to sito przeszły — oba dawały danie MIĘSNE
     * uznane za wegańskie, czyli błąd w najgorszym możliwym kierunku.
     *
     * „Rostbef wołowy" leżał w tabeli od początku: `MEAT_TERMS` miało `wolowin`
     * i `wolowa`, a nie `wolowy`. „Chude mielone wieprzowe" przyszło z bazą
     * obiadów azjatyckich. Żadne nie zawiera słowa „mięso", więc nazwa dania
     * („…z mielonym mięsem") też nie ratowała — `mieso` nie jest fragmentem
     * `miesem`.
     */
    expect(recipeDietStyles(recipeWith(['Rostbef wołowy', 'Ryż basmati']))).toEqual(['omnivore'])
    expect(recipeDietStyles(recipeWith(['Chude mielone wieprzowe']))).toEqual(['omnivore'])
    // A mielone roślinne dalej jest roślinne — postać nie decyduje, zwierzę decyduje.
    expect(recipeDietStyles(recipeWith(['Siemię lniane mielone']))).toContain('vegan')
  })

  it('KRYTYCZNE: napój roślinny nie jest nabiałem', () => {
    /**
     * „Mleko" i „mleczko" są terminami laktozy, więc napoje roślinne dostawały
     * alergen, którego nie mają — a stoją w bazie właśnie po to, żeby ścieżka
     * bez laktozy miała z czego wybierać. Migdałowe leżało tu od początku,
     * kokosowe doszło z bazą obiadów azjatyckich.
     */
    expect(recipeAllergens(recipeWith(['Mleko migdałowe bez cukru']))).not.toContain('lactose')
    expect(recipeAllergens(recipeWith(['Mleczko kokosowe lekkie']))).not.toContain('lactose')
    expect(recipeDietStyles(recipeWith(['Mleczko kokosowe lekkie', 'Ryż basmati']))).toContain(
      'vegan',
    )

    // Nabiał dalej jest nabiałem — także obok napoju roślinnego, bo wykluczenie
    // dotyczy pojedynczej nazwy składnika, nie całego przepisu.
    expect(recipeAllergens(recipeWith(['Mleko 2%']))).toContain('lactose')
    expect(
      recipeAllergens(recipeWith(['Mleko migdałowe bez cukru', 'Jogurt naturalny'])),
    ).toContain('lactose')
  })

  it('KRYTYCZNE: nic z działu „Mięso i ryby" nie stoi w przepisie wegetariańskim', () => {
    /**
     * Krzyżowanie DWÓCH niezależnych list terminów z tego repozytorium:
     * działów listy zakupów (`aisles.ts`) i składników zwierzęcych
     * (`derive.ts`). Żadna z nich osobno nie pokazuje luki — dopiero
     * niezgodność między nimi mówi, że jedna czegoś nie widzi.
     *
     * Tak wyszły „Rostbef wołowy" i „Chude mielone wieprzowe": dział sklepowy
     * wiedział, że to mięso, a styl diety nie. Przegląd bazy tego nie łapie,
     * bo trzeba by porównać dwie listy słów kluczowych po sto pozycji każda.
     *
     * Ryb NIE sprawdzamy tą drogą: dla peskatarianina są dozwolone, a dla
     * wegetarianina odsiewa je osobna reguła `FISH_TERMS`.
     */
    const podejrzane: string[] = []
    for (const recipe of RECIPES) {
      if (!recipeDietStyles(recipe).includes('vegetarian')) continue
      for (const ingredient of recipe.ingredients) {
        if (aisleFor(ingredient.name) !== 'Mięso i ryby') continue
        podejrzane.push(`${recipe.id}: ${ingredient.name}`)
      }
    }
    expect(podejrzane, `mięso w daniu wegetariańskim:\n${podejrzane.join('\n')}`).toEqual([])
  })

  it('wszystkożerca może zjeść każdy przepis z bazy', () => {
    for (const r of RECIPES) {
      expect(recipeDietStyles(r), r.id).toContain('omnivore')
    }
  })
})

describe('kategoria dania — do listy zamienników', () => {
  function categoryOf(recipeId: string) {
    const recipe = RECIPES.find((r) => r.id === recipeId)
    if (!recipe) throw new Error(`Brak przepisu ${recipeId}`)
    return dishCategory(recipe)
  }

  it('rozpoznaje główne źródło białka', () => {
    const byName = (fragment: string) => {
      const found = RECIPES.find((r) => r.name.toLowerCase().includes(fragment.toLowerCase()))
      if (!found) throw new Error(`Brak przepisu zawierającego „${fragment}"`)
      return found
    }
    expect(categoryOf(byName('Pierś z kurczaka w sosie pomidorowym').id)).toBe('meat')
    expect(categoryOf(byName('Pieczony dorsz z ziemniakami').id)).toBe('fish')
  })

  it('każdy przepis w katalogu ma kategorię z etykietą', () => {
    for (const recipe of DIET_CATALOG.recipes) {
      expect(DISH_CATEGORY_LABELS[dishCategory(recipe)], recipe.id).toBeTruthy()
    }
  })

  it('kategorie faktycznie różnicują bazę — grupowanie ma sens', () => {
    const counts = new Set(DIET_CATALOG.recipes.map((r) => dishCategory(r)))
    expect(counts.size).toBeGreaterThanOrEqual(4)
  })
})

describe('treningi z arkusza', () => {
  it('są dwa, po pięć ćwiczeń z dwiema alternatywami', () => {
    expect(WORKOUTS.map((w) => w.id)).toEqual(['A', 'B'])
    for (const workout of WORKOUTS) {
      expect(workout.slots, workout.id).toHaveLength(5)
      for (const slot of workout.slots) {
        expect(slot.alternatives, `${workout.id}/${slot.index}`).toHaveLength(2)
        expect(slot.main.variant).toBe('main')
      }
    }
  })

  it('każde ćwiczenie ma parametry, których nie wolno zgadywać', () => {
    for (const exercise of WORKOUT_EXERCISES_BY_ID.values()) {
      expect(exercise.sets, exercise.id).toBeGreaterThan(0)
      expect(exercise.reps, exercise.id).toBeGreaterThan(0)
      expect(exercise.restSec, exercise.id).toBeGreaterThan(0)
      expect(exercise.tempo, exercise.id).toMatch(/^\d{4}$/)
      expect(exercise.cues.length, exercise.id).toBeGreaterThan(0)
      expect(exercise.startWeightLabel, exercise.id).toBeTruthy()
      expect(exercise.description, exercise.id).toBeTruthy()
    }
  })

  it('KRYTYCZNE: ciężar startowy jest null tam, gdzie liczba nie jest obciążeniem', () => {
    // Masa własnego ciała, „Gryf + …" i asysta maszyny: wpisanie ich jako
    // kilogramów odwróciłoby progresję albo kazało dokładać do gryfu,
    // którego masy nie znamy.
    const all = [...WORKOUT_EXERCISES_BY_ID.values()]
    const unliftable = all.filter((e) => {
      const label = e.startWeightLabel.toLowerCase()
      return label.startsWith('gryf') || label.includes('asysta') || /^masa /.test(label)
    })

    expect(unliftable.length).toBeGreaterThan(0)
    for (const exercise of unliftable) {
      expect(exercise.startWeightKg, `${exercise.id}: ${exercise.startWeightLabel}`).toBeNull()
    }

    // A tam, gdzie arkusz podaje kilogramy wprost, ciężar MA być liczbą —
    // także gdy w nawiasie stoi „Gryf + 2x5kg", bo suma jest podana.
    const hipThrust = WORKOUT_EXERCISES_BY_ID.get('a1-hip-thrust-ze-sztanga')
    expect(hipThrust?.startWeightLabel).toBe('30 kg (Gryf + 2x5kg)')
    expect(hipThrust?.startWeightKg).toBe(30)
  })

  it('identyfikatory ćwiczeń są unikalne i odnajdywalne', () => {
    const ids = [...WORKOUT_EXERCISES_BY_ID.keys()]
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toHaveLength(30)
    for (const id of ids) {
      const placement = exercisePlacement(id)
      expect(placement?.exercise.id, id).toBe(id)
    }
  })

  it('KRYTYCZNE: każde ćwiczenie ma link do instruktażu', () => {
    // Przycisk „Wideo" nie ma prawa prowadzić w pustkę: gdy nie ma konkretnego
    // materiału, otwiera wyszukiwanie po nazwie ćwiczenia.
    for (const exercise of WORKOUT_EXERCISES_BY_ID.values()) {
      const video = exerciseVideo(exercise.id)
      expect(video.href, exercise.id).toMatch(/^https:\/\/www\.youtube\.com\//)
      expect(['video', 'search'], exercise.id).toContain(video.kind)
    }
  })

  it('kuratorowane linki pokrywają wszystkie ćwiczenia poza jednym', () => {
    /**
     * Y-Raise nie ma wpisu świadomie — nie znalazłem materiału o tym konkretnym
     * ruchu, a podłożenie wznosów bokiem byłoby wprowadzaniem w błąd przy
     * ćwiczeniu, którego cały sens polega na kącie ramion.
     */
    const bySearch = [...WORKOUT_EXERCISES_BY_ID.values()].filter(
      (exercise) => exerciseVideo(exercise.id).kind === 'search',
    )
    expect(bySearch.map((e) => e.id)).toEqual(['b5-alt2-y-raise-na-lawce-skosnej-lez'])
  })

  it('kuratorowane identyfikatory pasują do ćwiczeń z arkusza', () => {
    // Literówka w kluczu dałaby ciche wyszukiwanie zamiast filmu — bez śladu.
    for (const id of Object.keys(EXERCISE_VIDEOS)) {
      expect(WORKOUT_EXERCISES_BY_ID.has(id), id).toBe(true)
    }
  })

  it('link z arkusza ma pierwszeństwo nad kuratorowanym', () => {
    // Gdy trener uzupełni kolumnę „Wideo Instruktażowe", jego materiał wygrywa.
    const first = [...WORKOUT_EXERCISES_BY_ID.values()][0] as WorkoutExercise
    expect(exerciseVideo(first.id).href).toBe(EXERCISE_VIDEOS[first.id])
    expect(first.videoUrl).toBeUndefined()
  })

  it('wyszukiwanie zawiera nazwę ćwiczenia, nie identyfikator', () => {
    const fallback = exerciseVideo('nie-ma-takiego-cwiczenia')
    expect(fallback.kind).toBe('search')
    expect(fallback.href).toContain('search_query=')

    const yRaise = exerciseVideo('b5-alt2-y-raise-na-lawce-skosnej-lez')
    expect(decodeURIComponent(yRaise.href)).toContain('Y-Raise na ławce skośnej')
  })

  it('rozgrzewka ma kroki z czasem i uzasadnieniem', () => {
    expect(WARMUP.length).toBeGreaterThanOrEqual(3)
    for (const step of WARMUP) {
      expect(step.name, `krok ${step.step}`).toBeTruthy()
      expect(step.duration, `krok ${step.step}`).toBeTruthy()
      expect(step.purpose, `krok ${step.step}`).toBeTruthy()
    }
  })
})

describe('rezerwa na słodką przekąskę', () => {
  const daily = { kcal: 1800, proteinG: 130, fatG: 60, carbsG: 180 }

  it('posiłki z planu dostają cel pomniejszony o rezerwę', () => {
    const planned = plannedMealTargets(daily)
    expect(planned.kcal).toBe(1800 - SWEET_SNACK.kcal)
    expect(planned.fatG).toBe(60 - SWEET_SNACK.fatG)
    expect(planned.carbsG).toBe(180 - SWEET_SNACK.carbsG)
  })

  it('rezerwa prawie nie zabiera białka', () => {
    expect(SWEET_SNACK.proteinG).toBeLessThanOrEqual(3)
    expect(plannedMealTargets(daily).proteinG).toBe(daily.proteinG - SWEET_SNACK.proteinG)
  })

  it('rezerwa to 200 kcal i zgadza się z rozkładem makro', () => {
    /**
     * 200, nie 150 jak w FitPlannerze: rezerwa ma być tym samym UŁAMKIEM dnia,
     * nie tą samą liczbą. Przy 1600 kcal 150 kcal to 9% dnia; przy 2750 te same
     * 150 kcal to 5,5%, czyli już nie „kostka czekolady, która i tak się zdarzy".
     */
    expect(SWEET_SNACK).toEqual({ kcal: 200, proteinG: 3, fatG: 11, carbsG: 22 })
    const fromMacros =
      SWEET_SNACK.proteinG * 4 + SWEET_SNACK.fatG * 9 + SWEET_SNACK.carbsG * 4
    expect(Math.abs(fromMacros - SWEET_SNACK.kcal)).toBeLessThanOrEqual(5)
  })

  it('nie schodzi poniżej zera przy skrajnie niskim celu', () => {
    const tiny = plannedMealTargets({ kcal: 50, proteinG: 1, fatG: 1, carbsG: 1 })
    expect(tiny.kcal).toBe(0)
    expect(tiny.fatG).toBe(0)
    expect(tiny.carbsG).toBe(0)
  })
})
