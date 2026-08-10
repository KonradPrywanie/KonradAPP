import { useRef, useState } from 'react'
import {
  BackupError,
  backupFileName,
  countRecords,
  exportBackup,
  importBackup,
  parseBackup,
  type BackupFile,
  type ImportMode,
  type ImportResult,
} from '@/db/backup'
import { buildCsvBundles } from '@/db/csvExport'
import { downloadCsv, downloadJson, readFileAsText } from '@/lib/download'
import { recordsLabel } from '@/lib/format'
import {
  BACKUP_REMINDER_DAYS,
  daysSinceLastBackup,
  getLastBackupAt,
  setLastBackupAt,
} from '@/lib/localSettings'
import { Badge, Button, Callout, Card, SectionTitle, Sheet } from '@/components/ui'

export function BackupCard() {
  const [lastBackup, setLastBackup] = useState(() => getLastBackupAt())
  const [busy, setBusy] = useState<'export' | 'csv' | null>(null)
  const [pending, setPending] = useState<BackupFile | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ImportResult | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const staleDays = daysSinceLastBackup()
  const overdue = staleDays === null || staleDays >= BACKUP_REMINDER_DAYS

  async function handleExport() {
    setBusy('export')
    setError(null)
    try {
      const backup = await exportBackup()
      downloadJson(backupFileName(), backup)
      const now = new Date().toISOString()
      setLastBackupAt(now)
      setLastBackup(now)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Eksport nie udał się.')
    } finally {
      setBusy(null)
    }
  }

  async function handleCsv() {
    setBusy('csv')
    setError(null)
    try {
      for (const bundle of await buildCsvBundles()) {
        // Puste zestawy pomijamy — cztery pliki z samymi nagłówkami tylko mylą.
        if (bundle.rowCount === 0) continue
        downloadCsv(bundle.name, bundle.content)
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Eksport CSV nie udał się.')
    } finally {
      setBusy(null)
    }
  }

  async function handleFile(file: File | undefined) {
    if (!file) return
    setError(null)
    setResult(null)
    try {
      setPending(parseBackup(await readFileAsText(file)))
    } catch (caught) {
      setError(
        caught instanceof BackupError
          ? caught.message
          : caught instanceof Error
            ? caught.message
            : 'Nie udało się wczytać pliku.',
      )
    } finally {
      // Bez tego wybranie tego samego pliku po raz drugi nie odpali zdarzenia.
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  return (
    <Card>
      <SectionTitle hint="Aplikacja nie ma serwera. Kopia zapasowa to jedyny sposób, żeby przetrwać wyczyszczenie danych przeglądarki albo utratę telefonu.">
        Kopia zapasowa
      </SectionTitle>

      <div className="mb-3 flex items-center gap-2">
        {lastBackup ? (
          <>
            <Badge tone={overdue ? 'warn' : 'ok'}>
              {staleDays === 0 ? 'dzisiaj' : `${staleDays} dni temu`}
            </Badge>
            <span className="text-sm text-[var(--color-text-dim)]">
              ostatnia kopia: {lastBackup.slice(0, 10)}
            </span>
          </>
        ) : (
          <Badge tone="danger">nigdy nie robiona</Badge>
        )}
      </div>

      {overdue && (
        <div className="mb-3">
          <Callout tone={lastBackup ? 'warn' : 'danger'}>
            {lastBackup
              ? `Od ostatniej kopii minęło ${staleDays} dni. Zrób nową — historii nie da się odtworzyć z niczego.`
              : 'Nie masz jeszcze żadnej kopii. Wystarczy jedno wyczyszczenie danych witryny, żeby stracić całą historię.'}
          </Callout>
        </div>
      )}

      <div className="grid gap-2">
        <Button onClick={handleExport} disabled={busy !== null} className="w-full">
          {busy === 'export' ? 'Zapisywanie…' : 'Zapisz kopię zapasową (JSON)'}
        </Button>

        <Button
          variant="ghost"
          onClick={() => fileInput.current?.click()}
          disabled={busy !== null}
          className="w-full"
        >
          Przywróć z kopii
        </Button>

        <Button variant="ghost" onClick={handleCsv} disabled={busy !== null} className="w-full">
          {busy === 'csv' ? 'Eksportowanie…' : 'Eksportuj historię do CSV'}
        </Button>
      </div>

      <input
        ref={fileInput}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={(event) => void handleFile(event.target.files?.[0])}
      />

      <p className="mt-3 text-xs text-[var(--color-text-dim)]">
        CSV służy do analizy w arkuszu — nie odtworzy bazy. Do przywrócenia potrzebny
        jest plik JSON.
      </p>

      {error && (
        <div className="mt-3">
          <Callout tone="danger" title="Nie udało się">
            {error}
          </Callout>
        </div>
      )}

      {result && <ImportSummary result={result} />}

      <RestoreSheet
        backup={pending}
        onClose={() => setPending(null)}
        onDone={(imported) => {
          setResult(imported)
          setPending(null)
        }}
      />
    </Card>
  )
}

function RestoreSheet({
  backup,
  onClose,
  onDone,
}: {
  backup: BackupFile | null
  onClose: () => void
  onDone: (result: ImportResult) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function restore(mode: ImportMode) {
    if (!backup) return
    setBusy(true)
    setError(null)
    try {
      onDone(await importBackup(backup, mode))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Przywracanie nie udało się.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet open={backup !== null} title="Przywróć z kopii" onClose={onClose}>
      {backup && (
        <>
          <dl className="mb-4 grid gap-1 text-sm">
            <Row label="Data kopii" value={backup.exportedAt.slice(0, 16).replace('T', ' ')} />
            <Row label="Wersja schematu" value={String(backup.schemaVersion)} />
            <Row label="Rekordów w pliku" value={String(countRecords(backup))} />
          </dl>

          <div className="grid gap-3">
            <div>
              <Button
                variant="danger"
                onClick={() => restore('replace')}
                disabled={busy}
                className="w-full"
              >
                {busy ? 'Przywracanie…' : 'Zastąp wszystko z kopii'}
              </Button>
              <p className="mt-1 text-xs text-[var(--color-text-dim)]">
                Czyści bazę i wczytuje zrzut. Wszystko, co jest teraz w aplikacji, zniknie.
                To zwykłe odtworzenie po awarii.
              </p>
            </div>

            <div>
              <Button
                variant="ghost"
                onClick={() => restore('merge')}
                disabled={busy}
                className="w-full"
              >
                Scal z obecnymi danymi
              </Button>
              <p className="mt-1 text-xs text-[var(--color-text-dim)]">
                Zostawia nowszą wersję każdego rekordu. Przydatne, gdy łączysz dane
                z dwóch urządzeń.
              </p>
            </div>
          </div>

          {error && (
            <div className="mt-3">
              <Callout tone="danger">{error}</Callout>
            </div>
          )}
        </>
      )}
    </Sheet>
  )
}

function ImportSummary({ result }: { result: ImportResult }) {
  const total = Object.values(result.imported).reduce((sum, n) => sum + n, 0)
  return (
    <div className="mt-3">
      <Callout
        tone={result.warnings.length > 0 ? 'warn' : 'info'}
        title={`Przywrócono ${recordsLabel(total)} w trybie ${
          result.mode === 'replace' ? 'zastąpienia' : 'scalania'
        }`}
      >
        <ul className="grid gap-0.5">
          {Object.entries(result.imported)
            .filter(([, count]) => count > 0)
            .map(([table, count]) => (
              <li key={table}>
                {table}: {count}
              </li>
            ))}
        </ul>
        {result.warnings.map((warning) => (
          <span key={warning} className="mt-1 block">
            {warning}
          </span>
        ))}
      </Callout>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-[var(--color-text-dim)]">{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}
