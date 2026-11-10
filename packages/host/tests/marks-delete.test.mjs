import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { deleteMark, writeMark } from '../lib/marks-store.js'

/** Build a minimal vault with one scaffolded paper and a marks directory. */
async function paperVault(id = '2401.00001') {
  const vault = await mkdtemp(path.join(tmpdir(), 'agentero-marks-'))
  const paper = path.join(vault, 'papers', id)
  await mkdir(path.join(paper, 'marks'), { recursive: true })
  await writeFile(path.join(paper, 'NOTES.md'), '# notes\n', 'utf8')
  return { vault, id, paper, marks: path.join(paper, 'marks') }
}

/** Write one highlight through the same path the browser uses. */
async function addHighlight(vault, ref, quote = 'a quoted passage') {
  const written = await writeMark(vault, {
    ref,
    kind: 'highlight',
    quote,
    page: 1,
    rects: [{ x: 10, y: 20, w: 100, h: 12 }],
    pageSize: { width: 595, height: 842 },
    color: 'yellow',
  })
  assert.equal(written.ok, true, 'highlight should write')
  return written.ids[0]
}

test('deleteMark removes one highlight from annotations.json', async () => {
  const { vault, id, marks } = await paperVault()
  const kept = await addHighlight(vault, `papers/${id}`, 'keep me')
  const removed = await addHighlight(vault, `papers/${id}`, 'remove me')

  const result = await deleteMark(vault, `papers/${id}`, removed)
  assert.equal(result.ok, true)
  assert.deepEqual(result.ids, [removed])

  const stored = JSON.parse(await readFile(path.join(marks, 'annotations.json'), 'utf8'))
  const ids = stored.map((entry) => entry.annotation.id)
  assert.deepEqual(ids, [kept], 'the other highlight must survive')
})

test('deleteMark accepts the bare paper id the browser sends', async () => {
  // The reader names a paper by id; resolveVault maps a bare id under the vault
  // root, which has no such directory. The delete must still reach the paper.
  const { vault, id } = await paperVault()
  const markId = await addHighlight(vault, `papers/${id}`)

  const result = await deleteMark(vault, id, markId)
  assert.equal(result.ok, true)
  assert.deepEqual(result.ids, [markId])
})

test('deleteMark removes a per-id mark file', async () => {
  const { vault, id, marks } = await paperVault()
  const markId = 'AbCdEfGhIj'
  await writeFile(
    path.join(marks, `${markId}.json`),
    `${JSON.stringify({ version: 1, kind: 'ask', id: markId }, null, 2)}\n`,
    'utf8',
  )

  const result = await deleteMark(vault, `papers/${id}`, markId)
  assert.equal(result.ok, true)
  await assert.rejects(readFile(path.join(marks, `${markId}.json`), 'utf8'), /ENOENT/)
})

test('deleteMark reports 404 for an unknown id instead of succeeding quietly', async () => {
  const { vault, id } = await paperVault()
  await addHighlight(vault, `papers/${id}`)

  const result = await deleteMark(vault, `papers/${id}`, 'not-a-real-id')
  assert.equal(result.ok, false)
  assert.equal(result.status, 404)
})

test('deleteMark rejects an empty id', async () => {
  const { vault, id } = await paperVault()
  const result = await deleteMark(vault, `papers/${id}`, '   ')
  assert.equal(result.ok, false)
  assert.equal(result.status, 400)
})

test('deleteMark refuses an id that tries to escape the marks directory', async () => {
  const { vault, id } = await paperVault()
  const result = await deleteMark(vault, `papers/${id}`, '../../NOTES')
  // A traversal id resolves outside `marks/`, so the boundary check refuses it
  // with 400 (invalid path) rather than 404 — it is not a legal id at all.
  assert.equal(result.ok, false)
  assert.equal(result.status, 400)
  // The paper's own files are untouched.
  assert.deepEqual(await readdir(path.join(vault, 'papers', id)).then((f) => f.sort()), ['NOTES.md', 'marks'])
})

test('deleteMark 404s on a paper that does not exist', async () => {
  const { vault } = await paperVault()
  const result = await deleteMark(vault, 'papers/9999.99999', 'whatever')
  assert.equal(result.ok, false)
  assert.equal(result.status, 404)
})
