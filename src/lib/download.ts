/**
 * Pobieranie plików w przeglądarce.
 *
 * Wydzielone z logiki eksportu, bo dotyka DOM — dzięki temu `backup.ts`
 * i `csvExport.ts` da się testować w Node bez atrapy przeglądarki.
 */

/** BOM UTF-8 — bez niego Excel czyta polskie znaki jako krzaki. */
const UTF8_BOM = '﻿'

export function downloadText(fileName: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: `${mimeType};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  try {
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = fileName
    anchor.rel = 'noopener'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
  } finally {
    // Zwolnienie od razu jest bezpieczne — kliknięcie już przechwyciło URL.
    URL.revokeObjectURL(url)
  }
}

export function downloadJson(fileName: string, data: unknown): void {
  downloadText(fileName, JSON.stringify(data, null, 2), 'application/json')
}

export function downloadCsv(fileName: string, content: string): void {
  downloadText(fileName, UTF8_BOM + content, 'text/csv')
}

/** Wczytuje plik wskazany przez użytkownika jako tekst. */
export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('Nie udało się odczytać pliku.'))
    reader.readAsText(file)
  })
}
