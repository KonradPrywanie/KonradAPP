import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { countAllRecords, wipeAllData } from '@/db/reset'
import { Button, Callout, Card, SectionTitle, Sheet } from '@/components/ui'

/**
 * Wyczyszczenie danych i start od zera.
 *
 * Dwa kroki potwierdzenia, bo operacja jest nieodwracalna i nie ma po niej
 * żadnej ścieżki odzysku. Liczba rekordów w potwierdzeniu jest istotna —
 * „usuniesz 1 247 rekordów" mówi więcej niż „czy jesteś pewna?".
 */
export function ResetCard() {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const recordCount = useLiveQuery(() => countAllRecords(), [], 0)

  async function reset() {
    setBusy(true)
    try {
      await wipeAllData()
      // Bez nawigacji: `App` obserwuje profil na żywo, więc zniknięcie
      // profilu samo przerzuca aplikację na kreator.
      setOpen(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <SectionTitle hint="Usuwa profil, plany, jadłospisy, listy zakupów i całą historię. Po tym aplikacja zacznie od kreatora, jak przy pierwszym uruchomieniu.">
        Zacznij od nowa
      </SectionTitle>

      <Button variant="ghost" onClick={() => setOpen(true)} className="w-full">
        Wyczyść wszystkie dane
      </Button>

      <Sheet open={open} title="Wyczyścić wszystkie dane?" onClose={() => setOpen(false)}>
        <div className="grid gap-3">
          <Callout tone="danger" title="Tego nie da się cofnąć">
            Usuniesz {recordCount} rekordów: profil, wszystkie wersje planu, jadłospisy,
            listy zakupów, pomiary masy, zalogowane treningi i posiłki. Nie ma kosza
            ani kopii, z której dałoby się to przywrócić.
          </Callout>

          <Button variant="danger" onClick={reset} disabled={busy} className="w-full">
            {busy ? 'Czyszczenie…' : 'Tak, usuń wszystko i zacznij od nowa'}
          </Button>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy} className="w-full">
            Anuluj
          </Button>
        </div>
      </Sheet>
    </Card>
  )
}
