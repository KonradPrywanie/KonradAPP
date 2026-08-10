/**
 * Instruktaże wideo do ćwiczeń — plik KURATOROWANY RĘCZNIE.
 *
 * Nie jest generowany z arkusza, mimo że ćwiczenia są (`workouts.ts`). Arkusz ma
 * kolumnę „Wideo Instruktażowe (YouTube)", ale jest pusta — żadnego hiperlinku
 * w pliku. Linki poniżej zostały wyszukane i dobrane po tytule: polskie,
 * techniczne, dopasowane do wariantu z arkusza (np. ławka skośna dokładnie 30°,
 * side plank Z UNOSZENIEM bioder, a nie zwykła deska bokiem).
 *
 * Czego ten plik NIE gwarantuje: nikt tych materiałów nie ocenił merytorycznie
 * klatka po klatce, a filmy na YouTube można usunąć albo zmienić. Dlatego
 * `exerciseVideo` w `lib/catalog.ts` ma zawsze wyjście awaryjne — wyszukiwanie
 * po nazwie ćwiczenia. Przycisk nigdy nie prowadzi w pustkę, także wtedy, gdy
 * konkretny film zniknie.
 *
 * Gdy trener uzupełni kolumnę w arkuszu, importer przeniesie jego linki i one
 * mają pierwszeństwo — to jego plan, więc i jego materiały.
 *
 * Obrazków ani wideo NIE generujemy sami. Błędna technika w materiale
 * instruktażowym to realne ryzyko kontuzji.
 */
export const EXERCISE_VIDEOS: Readonly<Record<string, string>> = {
  // ── Trening A ────────────────────────────────────────────────────────
  'a1-hip-thrust-ze-sztanga': 'https://www.youtube.com/shorts/O5VbakL1hXw',
  'a1-alt1-glute-bridge-z-hantlem-na-zi': 'https://www.youtube.com/watch?v=adJwkQz9dj0',
  'a1-alt2-cable-pull-through-przyciaga': 'https://www.youtube.com/watch?v=6tSTDrcfBU4',
  'a2-goblet-squat-przysiad-z-hant': 'https://www.youtube.com/shorts/ESeQVOgVORc',
  'a2-alt1-przysiad-na-suwnicy-smitha': 'https://www.youtube.com/watch?v=0N62juykh1s',
  'a2-alt2-leg-press-wypychanie-ciezaru': 'https://www.youtube.com/watch?v=2ahOlxdNozQ',
  'a3-sciaganie-drazka-wyciagu-do': 'https://www.youtube.com/watch?v=9RRxXGegIzk',
  'a3-alt1-podciaganie-na-maszynie-z-as': 'https://www.youtube.com/watch?v=kGgXCg5ffP8',
  'a3-alt2-sciaganie-uchwytu-neutralneg': 'https://www.youtube.com/watch?v=urbHobVf5Ok',
  // Arkusz podaje ławkę pod 30° — ten materiał mówi o dokładnie tym kącie.
  'a4-wyciskanie-hantli-na-lawce-s': 'https://www.youtube.com/watch?v=mlgzo_tiHPc',
  'a4-alt1-pompki-klasyczne-z-dlonmi-na': 'https://www.youtube.com/watch?v=E4ZfN9N8dKM',
  'a4-alt2-wyciskanie-na-maszynie-siedz': 'https://www.youtube.com/watch?v=9ZE-Y9NSScQ',
  'a5-pallof-press-z-guma-lub-wyci': 'https://www.youtube.com/watch?v=Ef7NSilW7kA',
  // Wariant z arkusza to deska bokiem Z UNOSZENIEM bioder, nie sama deska.
  'a5-alt1-side-plank-deska-bokiem-z-un': 'https://www.youtube.com/watch?v=x_dXEEk3Lcs',
  'a5-alt2-deadbug-martwy-robak-z-pauza': 'https://www.youtube.com/watch?v=TzpwuC73gJs',

  // ── Trening B ────────────────────────────────────────────────────────
  'b1-rdl-rumunski-martwy-ciag-ze': 'https://www.youtube.com/watch?v=rVB33zXJ8Ys',
  'b1-alt1-martwy-ciag-sumo-z-kettlebel': 'https://www.youtube.com/watch?v=aLxS5iugcqk',
  'b1-alt2-uginanie-nog-lezac-na-maszyn': 'https://www.youtube.com/watch?v=q4jACUe9UEM',
  'b2-zakroki-z-hantlami-w-miejscu': 'https://www.youtube.com/watch?v=EC_MSM1THek',
  'b2-alt1-przysiad-bulgarski-bulgarian': 'https://www.youtube.com/watch?v=a8W5GnRKiQM',
  'b2-alt2-wejscia-na-skrzynie-step-z-h': 'https://www.youtube.com/watch?v=KuJYX3ZGGtc',
  'b3-wioslowanie-hantlem-jednorac': 'https://www.youtube.com/watch?v=8hClc1TBMak',
  'b3-alt1-wioslowanie-na-wyciagu-dolny': 'https://www.youtube.com/watch?v=zIJ-vzxHhck',
  'b3-alt2-wioslowanie-na-maszynie-z-op': 'https://www.youtube.com/watch?v=26u4xjbDdJo',
  'b4-wyciskanie-hantli-nad-glowe': 'https://www.youtube.com/watch?v=45exvmFOMw8',
  'b4-alt1-landmine-press-jednoracz-w-k': 'https://www.youtube.com/watch?v=61h9g7B1O3c',
  'b4-alt2-unoszenie-hantli-bokiem-late': 'https://www.youtube.com/watch?v=0v353ajJkKE',
  'b5-face-pull-z-lina-wyciagu-gor': 'https://www.youtube.com/watch?v=0FfUD5nlCtE',
  'b5-alt1-reverse-flyes-unoszenie-hant': 'https://www.youtube.com/watch?v=u_xrwgI8b0o',

  /**
   * Y-Raise NIE MA tu wpisu świadomie.
   *
   * Nie znalazłem materiału o tym konkretnym ruchu (unoszenie ramion w literę „Y"
   * leżąc przodem na ławce skośnej). Najbliższe wyniki to wznosy bokiem albo
   * wiosłowanie w tej samej pozycji — inne ćwiczenie. Podłożenie ich pod przycisk
   * „Wideo" byłoby wprowadzaniem w błąd przy ćwiczeniu, którego cały sens polega
   * na kącie ramion. Przycisk otwiera więc wyszukiwanie po nazwie z arkusza.
   */
}
