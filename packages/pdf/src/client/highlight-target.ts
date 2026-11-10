/**
 * Decide which stored highlight, if any, a new selection overlaps.
 *
 * The reader has no annotation editing surface: a highlight is painted as a
 * non-interactive div, so clicking it selects the text underneath instead. That
 * makes the selection toolbar the only place a user can act on an existing
 * highlight — "取消高亮" belongs there, next to the swatches that create one.
 *
 * To offer it we need to know what the selection covers. Comparing quotes would
 * be fragile (the same words appear many times on a page); comparing pages and
 * rectangles is exact, because both the stored highlight and the fresh
 * selection are page-point rectangles from the same PDFium layout.
 */

/**
 * Axis-aligned page rectangle in PDF points.
 *
 * Both rectangle shapes in the reader normalize to this: a fresh selection
 * arrives as `{origin, size}` (`PdfRect`, what the selection plugin reports)
 * and a stored mark as `{x, y, w, h}` (`PaintRect`, what the host wrote).
 */
export interface RectsOverlapRect {
	x: number
	y: number
	w: number
	h: number
}

/** Normalize a selection rectangle (`{origin, size}`) to the comparison shape. */
export function selectionRect(rect: { origin: { x: number, y: number }, size: { width: number, height: number } }): RectsOverlapRect {
	return { x: rect.origin.x, y: rect.origin.y, w: rect.size.width, h: rect.size.height }
}

/** The subset of a stored mark this decision reads. */
export interface RectsOverlapMark {
	id: string
	kind: string
	/** 1-based page number. */
	page: number
	rects: readonly RectsOverlapRect[]
	/**
	 * Coordinate space of `rects`: `pt` is page points (highlights, the same
	 * space a fresh selection uses), `norm` is 0–1 of the page (per-id marks).
	 */
	space?: 'pt' | 'norm'
}

/** Minimum share of the selection that has to sit inside the highlight. */
const OVERLAP_THRESHOLD = 0.5

/** Area of one rectangle; zero for degenerate input. */
function area(rect: RectsOverlapRect): number {
	return rect.w > 0 && rect.h > 0 ? rect.w * rect.h : 0
}

/** Intersection area of two rectangles, zero when they do not overlap. */
function intersectionArea(a: RectsOverlapRect, b: RectsOverlapRect): number {
	const left = Math.max(a.x, b.x)
	const right = Math.min(a.x + a.w, b.x + b.w)
	const top = Math.max(a.y, b.y)
	const bottom = Math.min(a.y + a.h, b.y + b.h)
	if (right <= left || bottom <= top) return 0
	return (right - left) * (bottom - top)
}

/**
 * Share of `selection` covered by `highlight`, in 0–1.
 *
 * Union-based would be more precise for multi-rect selections, but selections
 * from one drag rarely self-overlap and the same rectangles are what a user
 * sees painted; summing keeps this readable and is close enough for a yes/no
 * decision with a 50% threshold.
 *
 * @param selection - rectangles of the fresh selection (page points)
 * @param highlight - rectangles of the stored highlight (page points)
 * @returns covered share, 0 when either side is empty
 */
export function coveredShare(
	selection: readonly RectsOverlapRect[],
	highlight: readonly RectsOverlapRect[],
): number {
	const total = selection.reduce((sum, rect) => sum + area(rect), 0)
	if (total <= 0 || highlight.length === 0) return 0
	let covered = 0
	for (const rect of selection) {
		for (const target of highlight) covered += intersectionArea(rect, target)
	}
	return Math.min(1, covered / total)
}

/**
 * Bring a mark's rectangles into page points.
 *
 * Highlights are stored in points (the same space as a selection), while
 * per-id marks are normalized to 0–1. Only the `highlight` kind reaches here,
 * but converting defensively keeps the ratio meaningful if that ever changes —
 * comparing 0–1 numbers against 595×842 points would report "no overlap" for a
 * selection that fully covers the mark.
 *
 * @param mark - the stored mark
 * @param pageSize - page dimensions in points, needed only for `norm` marks
 * @returns rectangles in page points
 */
function toPoints(
	mark: RectsOverlapMark,
	pageSize: { width: number, height: number } | undefined,
): readonly RectsOverlapRect[] {
	if (mark.space !== 'norm' || pageSize === undefined) return mark.rects
	return mark.rects.map(rect => ({
		x: rect.x * pageSize.width,
		y: rect.y * pageSize.height,
		w: rect.w * pageSize.width,
		h: rect.h * pageSize.height,
	}))
}

/**
 * Find the highlight a selection sits on, so the toolbar can offer to remove it.
 *
 * Only `highlight` marks on the same page are considered: an ask or translate
 * mark covering the same words is a different record and must not be deleted by
 * a button promising to remove a highlight.
 *
 * @param marks - marks currently loaded for the paper
 * @param options - page number and the selection rectangles
 * @returns the best-matching highlight id, or undefined when the selection is not (mostly) highlighted
 */
export function markAtSelection(
	marks: readonly RectsOverlapMark[],
	options: { page: number, rects: readonly RectsOverlapRect[], pageSize?: { width: number, height: number } },
): { id: string, kind: string } | undefined {
	let best: { id: string, kind: string, share: number } | undefined
	for (const mark of marks) {
		if (mark.page !== options.page) continue
		// A highlight is painted only while its annotation entry exists; an ask or
		// translate mark paints the same area with its own colour (green / blue).
		// All of them are visible overlays a user can select over, so all of them
		// are removable from here — the button's label names which one it is.
		if (mark.kind !== 'highlight' && mark.kind !== 'ask' && mark.kind !== 'translate') continue
		const share = coveredShare(options.rects, toPoints(mark, options.pageSize))
		if (share < OVERLAP_THRESHOLD) continue
		if (best === undefined || share > best.share) best = { id: mark.id, kind: mark.kind, share }
	}
	return best === undefined ? undefined : { id: best.id, kind: best.kind }
}
