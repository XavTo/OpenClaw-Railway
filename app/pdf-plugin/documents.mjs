import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { DatabaseSync } from 'node:sqlite'

const run = promisify(execFile)
export const MAX_BYTES = 12 * 1024 * 1024
const MAX_PAGES = 40
const MAX_TEXT_PER_PAGE = 32_000
let importing = false

export class DocumentError extends Error {
  constructor(message, status = 422) {
    super(message)
    this.status = status
  }
}

function openLibrary() {
  const db = new DatabaseSync(join(process.env.OPENCLAW_RAILWAY_LIBRARY || '/data/library', 'documents.sqlite'))
  db.exec(`
    PRAGMA busy_timeout = 3000;
    PRAGMA secure_delete = ON;
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, pages INTEGER NOT NULL,
      ocr_pages INTEGER NOT NULL, indexed_at TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS passages USING fts5(
      document_id UNINDEXED, page UNINDEXED, body, tokenize='unicode61 remove_diacritics 2'
    );
  `)
  return db
}

function useLibrary(operation) {
  const db = openLibrary()
  try {
    return operation(db)
  } finally {
    db.close()
  }
}

export function listDocuments() {
  return useLibrary(db => db.prepare('SELECT * FROM documents ORDER BY indexed_at DESC').all())
}

export function removeDocument(id) {
  return useLibrary(db => {
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare('DELETE FROM passages WHERE document_id = ?').run(id)
      const result = db.prepare('DELETE FROM documents WHERE id = ?').run(id)
      db.exec('COMMIT')
      return result.changes > 0
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  })
}

export function searchDocuments(query) {
  const terms = [...new Set((query.toLowerCase().match(/[\p{L}\p{N}]{2,40}/gu) ?? []).slice(0, 16))]
  if (!terms.length) return []
  return useLibrary(db => db.prepare(`
    SELECT documents.name, CAST(passages.page AS INTEGER) AS page,
      snippet(passages, 2, '', '', ' … ', 45) AS passage
    FROM passages JOIN documents ON documents.id = passages.document_id
    WHERE passages MATCH ? ORDER BY rank LIMIT 8
  `).all(terms.map(term => '"' + term + '"').join(' OR ')))
}

async function binary(file, args) {
  return (await run(file, args, {
    timeout: 17_000,
    maxBuffer: 2 * 1024 * 1024,
    killSignal: 'SIGKILL',
    env: { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', OMP_THREAD_LIMIT: '1' },
  })).stdout
}

function cleanText(value) {
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim().slice(0, MAX_TEXT_PER_PAGE)
}

async function extractPdf(bytes, signal) {
  const work = await mkdtemp(join(tmpdir(), 'openclaw-pdf-'))
  const input = join(work, 'document.pdf')
  try {
    await writeFile(input, bytes, { mode: 0o600 })
    const info = await binary('pdfinfo', [input])
    const pages = Number(info.match(/^Pages:\s+(\d+)\s*$/m)?.[1])
    if (!Number.isInteger(pages) || pages < 1 || pages > MAX_PAGES) {
      throw new DocumentError('Use a PDF with between 1 and ' + MAX_PAGES + ' pages.')
    }
    if (/^Encrypted:\s+yes\b/m.test(info)) throw new DocumentError('Remove PDF password protection before importing.')
    const deadline = Date.now() + 82_000
    const output = []
    let ocrPages = 0
    for (let page = 1; page <= pages; page++) {
      if (signal?.aborted || Date.now() > deadline) throw new DocumentError('Indexing timed out. Try importing a shorter PDF.')
      let text = cleanText(await binary('pdftotext', ['-f', String(page), '-l', String(page), '-layout', input, '-']))
      if ((text.match(/[\p{L}\p{N}]/gu)?.length ?? 0) < 24) {
        const image = join(work, 'page')
        await binary('pdftoppm', ['-f', String(page), '-l', String(page), '-scale-to', '2000', '-singlefile', '-gray', '-png', input, image])
        const recognized = cleanText(await binary('tesseract', [image + '.png', 'stdout', '-l', 'eng+fra', '--psm', '3']))
        if (recognized.length > text.length) text = recognized
        await rm(image + '.png', { force: true })
        ocrPages++
      }
      output.push(text)
    }
    if (!output.some(Boolean)) throw new DocumentError('No text was extracted. Try a clearer scan.')
    return { output, ocrPages }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

export async function importDocument(bytes, rawName, signal) {
  if (importing) throw new DocumentError('An import is already running. Try again after it finishes.', 409)
  if (bytes.length > MAX_BYTES) throw new DocumentError('PDFs must be smaller than 12 MB.', 413)
  if (bytes.subarray(0, 5).toString() !== '%PDF-') throw new DocumentError('Choose a valid PDF.')
  const name = rawName.replace(/[^\p{L}\p{N} ._()-]/gu, '_').trim().slice(0, 120) || 'Document.pdf'
  const id = createHash('sha256').update(bytes).digest('hex')
  importing = true
  try {
    const existing = useLibrary(db => db.prepare('SELECT * FROM documents WHERE id = ?').get(id))
    if (existing) return existing
    const { output, ocrPages } = await extractPdf(bytes, signal)
    return useLibrary(db => {
      db.exec('BEGIN IMMEDIATE')
      try {
        const row = { id, name, pages: output.length, ocr_pages: ocrPages, indexed_at: new Date().toISOString() }
        db.prepare('INSERT INTO documents VALUES (?, ?, ?, ?, ?)').run(id, name, row.pages, ocrPages, row.indexed_at)
        const insert = db.prepare('INSERT INTO passages VALUES (?, ?, ?)')
        for (const [index, page] of output.entries()) if (page) insert.run(id, index + 1, page)
        db.exec('COMMIT')
        return row
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    })
  } catch (error) {
    if (error instanceof DocumentError) throw error
    throw new DocumentError('Could not read this PDF. Try a shorter, unencrypted copy.')
  } finally {
    importing = false
  }
}
