import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	coveredShare,
	markAtSelection,
	selectionRect,
} from '../src/client/highlight-target.ts'

/** A stored-mark rectangle (`PaintRect` shape). */
const rect = (x, y, w, h) => ({ x, y, w, h })

/** A selection rectangle, as the selection plugin reports it (`PdfRect`). */
const pdfRect = (x, y, w, h) => ({ origin: { x, y }, size: { width: w, height: h } })

const highlight = (id, page, rects) => ({ id, kind: 'highlight', page, rects })

test('selectionRect normalizes the selection plugin shape', () => {
	assert.deepEqual(selectionRect(pdfRect(10, 20, 30, 40)), rect(10, 20, 30, 40))
})

test('coveredShare is 1 for an identical rectangle', () => {
	assert.equal(coveredShare([rect(0, 0, 10, 10)], [rect(0, 0, 10, 10)]), 1)
})

test('coveredShare is 0 when the rectangles miss each other', () => {
	assert.equal(coveredShare([rect(0, 0, 10, 10)], [rect(20, 20, 10, 10)]), 0)
})

test('coveredShare counts partial coverage by area', () => {
	// Half of the selection sits inside the highlight.
	const selection = [rect(0, 0, 10, 10)]
	const target = [rect(0, 0, 5, 10)]
	assert.equal(coveredShare(selection, target), 0.5)
})

test('coveredShare sums across several selection rectangles', () => {
	const selection = [rect(0, 0, 10, 10), rect(0, 10, 10, 10)]
	const target = [rect(0, 0, 10, 10)]
	// The first rect is fully covered, the second not at all.
	assert.equal(coveredShare(selection, target), 0.5)
})

test('coveredShare is 0 for empty input and degenerate rectangles', () => {
	assert.equal(coveredShare([], [rect(0, 0, 10, 10)]), 0)
	assert.equal(coveredShare([rect(0, 0, 10, 10)], []), 0)
	assert.equal(coveredShare([rect(0, 0, 0, 10)], [rect(0, 0, 10, 10)]), 0)
})

test('coveredShare never exceeds 1 when a selection repeats a highlight', () => {
	// Two identical selection rects over one highlight: covered area is double
	// the selection, so the ratio must clamp instead of reporting 2.
	assert.equal(coveredShare([rect(0, 0, 10, 10), rect(0, 0, 10, 10)], [rect(0, 0, 10, 10)]), 1)
})

test('highlightAtSelection finds the highlight the selection sits on', () => {
	const marks = [highlight('h1', 1, [rect(0, 0, 100, 10)])]
	assert.equal(markAtSelection(marks, { page: 1, rects: [rect(10, 0, 50, 10)] })?.id, 'h1')
})

test('highlightAtSelection ignores marks on other pages', () => {
	const marks = [highlight('h1', 2, [rect(0, 0, 100, 10)])]
	assert.equal(markAtSelection(marks, { page: 1, rects: [rect(0, 0, 100, 10)] }), undefined)
})

test('markAtSelection matches an ask mark but reports its kind', () => {
	// An ask mark paints a green overlay over the same words. Selecting it must
	// offer removal (it is a visible mark the user wants gone), and the kind
	// travels with the id so the button names what it removes.
	const marks = [{ id: 'a1', kind: 'ask', page: 1, rects: [rect(0, 0, 100, 10)] }]
	assert.deepEqual(markAtSelection(marks, { page: 1, rects: [rect(0, 0, 100, 10)] }), { id: 'a1', kind: 'ask' })
})

test('highlightAtSelection declines a mostly-uncovered selection', () => {
	// Only 20% of the selection overlaps: selecting past the end of a highlight
	// must not offer to delete it.
	const marks = [highlight('h1', 1, [rect(0, 0, 10, 10)])]
	assert.equal(markAtSelection(marks, { page: 1, rects: [rect(0, 0, 50, 10)] }), undefined)
})

test('highlightAtSelection picks the best-covered highlight', () => {
	const marks = [
		highlight('low', 1, [rect(0, 0, 10, 10)]),
		highlight('high', 1, [rect(0, 0, 50, 10)]),
	]
	assert.equal(markAtSelection(marks, { page: 1, rects: [rect(0, 0, 50, 10)] })?.id, 'high')
})

test('highlightAtSelection returns undefined for no marks', () => {
	assert.equal(markAtSelection([], { page: 1, rects: [rect(0, 0, 10, 10)] }), undefined)
})

test('highlightAtSelection converts a normalized mark to points', () => {
	// A `norm` highlight covering the top-left quarter of the page must still
	// match a selection drawn in points over that same area.
	const norm = {
		id: 'norm-1',
		kind: 'highlight',
		page: 1,
		space: 'norm',
		rects: [rect(0, 0, 0.5, 0.5)],
	}
	const pageSize = { width: 600, height: 800 }
	// Selection in points: the same top-left quarter.
	const selection = [rect(0, 0, 300, 400)]
	assert.equal(markAtSelection([norm], { page: 1, rects: selection, pageSize })?.id, 'norm-1')
})

test('highlightAtSelection leaves pt marks untouched by pageSize', () => {
	const pt = { id: 'pt-1', kind: 'highlight', page: 1, space: 'pt', rects: [rect(10, 20, 100, 12)] }
	const selection = [rect(10, 20, 100, 12)]
	assert.equal(markAtSelection([pt], { page: 1, rects: selection, pageSize: { width: 600, height: 800 } })?.id, 'pt-1')
})

test('markAtSelection matches an ask mark painted over the same words', () => {
	// An ask mark paints a green overlay; a user selecting it must be able to
	// remove it, so it is a match too — with its own kind for the label.
	const ask = { id: 'ask-1', kind: 'ask', page: 1, space: 'norm', rects: [rect(0, 0, 0.5, 0.5)] }
	const pageSize = { width: 600, height: 800 }
	const hit = markAtSelection([ask], { page: 1, rects: [rect(0, 0, 300, 400)], pageSize })
	assert.deepEqual(hit, { id: 'ask-1', kind: 'ask' })
})

test('markAtSelection matches a translate mark the same way', () => {
	const translate = { id: 'tr-1', kind: 'translate', page: 1, space: 'pt', rects: [rect(0, 0, 100, 20)] }
	assert.deepEqual(
		markAtSelection([translate], { page: 1, rects: [rect(0, 0, 100, 20)] }),
		{ id: 'tr-1', kind: 'translate' },
	)
})

test('markAtSelection ignores marks it cannot remove (visual)', () => {
	// A visual crop is an image region, not text a selection covers.
	const visual = { id: 'v-1', kind: 'visual', page: 1, space: 'pt', rects: [rect(0, 0, 100, 20)] }
	assert.equal(markAtSelection([visual], { page: 1, rects: [rect(0, 0, 100, 20)] }), undefined)
})

test('markAtSelection prefers the mark covering most of the selection', () => {
	const ask = { id: 'ask-1', kind: 'ask', page: 1, space: 'pt', rects: [rect(0, 0, 50, 10)] }
	const hl = { id: 'hl-1', kind: 'highlight', page: 1, space: 'pt', rects: [rect(0, 0, 100, 10)] }
	assert.equal(markAtSelection([ask, hl], { page: 1, rects: [rect(0, 0, 100, 10)] })?.id, 'hl-1')
})
