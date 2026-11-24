import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { importDocument, listDocuments, removeDocument, searchDocuments } from '../app/pdf-plugin/documents.mjs'

function textPdf() {
  const content = 'BT /F1 18 Tf 70 700 Td (MANGROVE 78421 warranty is 37 months.) Tj ET'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream',
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = []
  for (const [i, o] of objects.entries()) {
    offsets.push(pdf.length)
    pdf += (i + 1) + ' 0 obj\n' + o + '\nendobj\n'
  }
  const xref = pdf.length
  pdf += 'xref\n0 6\n0000000000 65535 f \n'
  for (const offset of offsets) pdf += String(offset).padStart(10, '0') + ' 00000 n \n'
  pdf += 'trailer\n<< /Root 1 0 R /Size 6 >>\nstartxref\n' + xref + '\n%%EOF\n'
  return Buffer.from(pdf)
}

test('PDF memory stores page citations, deduplicates, and removes imports', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openclaw-library-test-'))
  const previous = process.env.OPENCLAW_RAILWAY_LIBRARY
  process.env.OPENCLAW_RAILWAY_LIBRARY = directory
  try {
    await assert.rejects(importDocument(Buffer.from('invalid'), 'bad.pdf'), /valid PDF/)
    const original = await importDocument(textPdf(), 'warranty.pdf')
    assert.equal(original.pages, 1)
    assert.equal(original.ocr_pages, 0)
    assert.equal((await importDocument(textPdf(), 'duplicate.pdf')).id, original.id)
    assert.equal(listDocuments().length, 1)
    const [result] = searchDocuments('mangrove warranty')
    assert.equal(result.page, 1)
    assert.equal(result.name, 'warranty.pdf')
    assert.match(result.passage, /37 months/)
    assert.deepEqual(searchDocuments('no-matching-result'), [])
    assert.equal(removeDocument(original.id), true)
    assert.equal(removeDocument(original.id), false)
    assert.deepEqual(searchDocuments('mangrove'), [])
  } finally {
    if (previous === undefined) delete process.env.OPENCLAW_RAILWAY_LIBRARY
    else process.env.OPENCLAW_RAILWAY_LIBRARY = previous
    await rm(directory, { recursive: true, force: true })
  }
})
