import type { InjectFace, PropsLocale, PropsRuntime, PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { cn } from './cn'
import { EmbedReader, type SelectionHit } from './embed-reader'
import type { EditableBookmark } from './bookmark'
import { type PdfPaperTone } from './page-theme'
import { DEFAULT_HIGHLIGHT_COLOR, type HighlightColor } from './palette'
import { PDF_FLOAT_CARD } from './pdf-chrome-surface'
import { lastSegment, parsePaperAddress, resourceName, notesPaperPath } from './resource-path'
import { markAtSelection, selectionRect } from './highlight-target'
import { SelectionMenu } from './selection-menu'
import { TranslateCard } from './translate-card'

export interface PaintRect {
  x: number
  y: number
  w: number
  h: number
}

export interface PaintMark {
  id: string
  kind: string
  page: number
  rects: PaintRect[]
  space: 'norm' | 'pt'
  note: string
  /** Highlight palette key, when the store carries one. */
  color?: HighlightColor
  /** Host image URL tied to the source knowledge base. */
  asset?: string
}

/** Page rectangle in PDF points, the shape the selection plugin reports. */
export interface PdfRect {
  origin: { x: number, y: number }
  size: { width: number, height: number }
}

export interface PdfPageSize {
  width: number
  height: number
}

export interface MarkAdd {
  ref: string
  kind: 'highlight' | 'ask' | 'translate'
  quote: string
  page: number
  /** Page-point selection rectangles; lets the host write without the CLI. */
  rects?: PdfRect[]
  pageSize?: PdfPageSize
  color?: HighlightColor
  comment?: string
  question?: string
}

export interface PdfInjected {
  notesAvailable: { getSnapshot: () => boolean, subscribe: (listener: () => void) => () => void }
  loadPdf: (ref: string) => Promise<ArrayBuffer>
  loadMarks: (ref: string) => Promise<PaintMark[]>
  addMark: (body: MarkAdd) => Promise<string | undefined>
  /** Delete one stored mark. Rejects with the host's error text on failure. */
  deleteMark: (ref: string, id: string) => Promise<void>
  /** Vault-relative ref for a file-resource address, or an empty string outside the vault. */
  resolveAddress: (address: string) => string
  /** Send a question and citation as a new conversation turn. */
  ask: (text: string) => Promise<void>
  /** Write the PDF outline back to the file; resolves after the host saved it. */
  saveBookmarks: (ref: string, nodes: EditableBookmark[]) => Promise<void>
  loadLayout: (ref: string, signal?: AbortSignal) => Promise<unknown>
  /** Translate one page's text; rejects with the host error message. */
  translate: (text: string, signal?: AbortSignal) => Promise<string>
}

type PdfPanelProps =
  & PropsRuntime<'sidebar.right.pane.tab'>
  & InjectFace<PdfInjected>
  & PropsLocale<'agentero.pdf'>
  & PropsRenderSlots<'agentero.pdf.notes'>

interface MenuState {
  quote: string
  page: number
  /** Selection geometry, so the mark is written without a quote lookup. */
  rects: PdfRect[]
  pageSize: PdfPageSize
  color: HighlightColor
  screenX: number
  screenY: number
  mode: 'actions' | 'comment' | 'ask'
}

/** One selection translation, kept alive while its floating card is pinned. */
interface TranslateCardState {
  anchor: { x: number, y: number }
  page: number
  /** Selection geometry, so the pinned chip stays on the page. */
  rects: PdfRect[]
  pageSize: PdfPageSize
  pinned: boolean
  visible: boolean
  loading: boolean
  result: string
  error: string
}

export function PdfTitle({ useTabInfo, t }: PropsRuntime<'sidebar.right.pane.tab.title'> & PropsLocale<'agentero.pdf'>): ReactNode {
  const { address } = useTabInfo().tab.navigation
  const paper = parsePaperAddress(address)
  const name = paper === undefined ? resourceName(address) : lastSegment(paper)
  return <span>{name === undefined || name === '' ? t('title') : name}</span>
}

export function PdfPanel(props: PdfPanelProps): ReactNode {
  const { t, sessionId, useTabInfo, loadPdf, loadMarks, addMark, deleteMark, ask, saveBookmarks, translate, loadLayout, resolveAddress } = props
  const navigation = useTabInfo().tab.navigation
  const paperPath = parsePaperAddress(navigation.address) ?? resolveAddress(navigation.address)
  const notesPath = notesPaperPath(paperPath)
  const hasNotes = useSyncExternalStore(props.notesAvailable.subscribe, props.notesAvailable.getSnapshot)
  const [notesOpen, setNotesOpen] = useState(false)
  const [status, setStatus] = useState<'empty' | 'loading' | 'missing' | 'error' | 'ready'>('empty')
  const [message, setMessage] = useState('')
  const [bytes, setBytes] = useState<ArrayBuffer | undefined>(undefined)
  const [marks, setMarks] = useState<PaintMark[]>([])
  const [menu, setMenu] = useState<MenuState | undefined>(undefined)
  const [draft, setDraft] = useState('')
  const [banner, setBanner] = useState('')
  const [busy, setBusy] = useState(false)
  const [selectionClearVersion, setSelectionClearVersion] = useState(0)
  const [pdfTone, setPdfTone] = useState<PdfPaperTone>('white')
  const [translateCard, setTranslateCard] = useState<TranslateCardState | undefined>(undefined)
  /** Invalidates a late translation response after close / reselect. */
  const translateRun = useRef(0)

  useEffect(() => () => { translateRun.current += 1 }, [])

  const onSelect = useCallback((hit: SelectionHit) => {
    setDraft('')
    setMenu({
      quote: hit.quote,
      page: hit.page,
      rects: hit.rects,
      pageSize: { width: hit.pageWidth, height: hit.pageHeight },
      color: DEFAULT_HIGHLIGHT_COLOR,
      screenX: hit.screenX,
      screenY: hit.screenY,
      mode: 'actions',
    })
  }, [])

  const onDeselect = useCallback(() => {
    setMenu(undefined)
    setDraft('')
  }, [])

  useEffect(() => {
    let cancelled = false
    setBytes(undefined)
    setMarks([])
    setMenu(undefined)
    setBanner('')
    setTranslateCard(undefined)
    translateRun.current += 1
    if (paperPath === '') {
      setStatus('empty')
      return () => { cancelled = true }
    }
    setStatus('loading')
    void loadPdf(paperPath).then(async (next) => {
      if (cancelled) return
      setBytes(next)
      setStatus('ready')
      try {
        const painted = await loadMarks(paperPath)
        if (!cancelled) setMarks(painted)
      } catch {
        // Marks live beside papers; a PDF opened elsewhere still renders.
        if (!cancelled) setMarks([])
      }
    }).catch((error: unknown) => {
      if (cancelled) return
      const text = error instanceof Error ? error.message : ''
      if (text === 'vault is not configured') {
        setStatus('error')
        setMessage(t('vaultMissing'))
        return
      }
      if (text === 'not found') {
        setStatus('missing')
        return
      }
      setStatus('error')
      setMessage(text === '' ? t('loadFailed') : text)
    })
    return () => { cancelled = true }
  }, [paperPath, loadPdf, loadMarks, t])

  const refreshMarks = (): void => {
    if (paperPath === '') return
    void loadMarks(paperPath).then(setMarks).catch(() => { setBanner(t('markFailed')) })
  }

  const runMark = (body: MarkAdd): void => {
    setBusy(true)
    setMenu(undefined)
    void addMark(body).then((translation) => {
      if (translation !== undefined) setBanner(translation)
      setSelectionClearVersion((version) => version + 1)
      refreshMarks()
    }).catch((error: unknown) => {
      const text = error instanceof Error ? error.message : ''
      setBanner(text === '' ? t('markFailed') : text)
    }).finally(() => { setBusy(false) })
  }

  const submitDraft = (): void => {
    if (menu === undefined || busy) return
    const quote = menu.quote
    const pageNumber = menu.page
    const geometry = { rects: menu.rects, pageSize: menu.pageSize }
    if (menu.mode === 'ask') {
      const question = draft.trim()
      if (question === '') return
      if (sessionId === undefined) {
        setBanner(t('noSession'))
        return
      }
      setBusy(true)
      setBanner('')
      void ask([`${paperPath} p.${pageNumber}`, quote, question].join('\n')).then(async () => {
        setMenu(undefined)
        setDraft('')
        setBanner(t('asked'))
        // A mark failure must not block sending or make a retry send twice.
        try {
          await addMark({ ref: paperPath, kind: 'ask', quote, page: pageNumber, ...geometry, question })
          refreshMarks()
        } catch {
          setBanner(t('askedMarkFailed'))
        }
      }).catch((error: unknown) => {
        const text = error instanceof Error ? error.message : ''
        setBanner(text === '' ? t('askFailed') : text)
      }).finally(() => { setBusy(false) })
      return
    }
    runMark({
      ref: paperPath,
      kind: 'highlight',
      quote,
      page: pageNumber,
      ...geometry,
      color: menu.color,
      comment: draft,
    })
  }

  /**
   * Translate the selection into a card anchored next to it, like the motif
   * translate card. The card, not a page-top banner, owns the result.
   */
  const openTranslate = (target: MenuState): void => {
    const token = translateRun.current + 1
    translateRun.current = token
    setMenu(undefined)
    setDraft('')
    setTranslateCard({
      anchor: { x: target.screenX, y: target.screenY },
      page: target.page,
      rects: target.rects,
      pageSize: target.pageSize,
      pinned: false,
      visible: true,
      loading: true,
      result: '',
      error: '',
    })
    void translate(target.quote).then((text) => {
      if (token !== translateRun.current) return
      setTranslateCard(prev => prev === undefined ? prev : { ...prev, loading: false, result: text })
    }).catch((error: unknown) => {
      if (token !== translateRun.current) return
      const text = error instanceof Error ? error.message : ''
      setTranslateCard(prev => prev === undefined
        ? prev
        : { ...prev, loading: false, error: text === '' ? t('translateFailed') : text })
    })
  }

  const toggleTranslatePin = (): void => {
    setTranslateCard(prev => prev === undefined
      ? prev
      : { ...prev, pinned: !prev.pinned, visible: true })
  }

  const closeTranslateCard = (): void => {
    setTranslateCard((prev) => {
      if (prev === undefined) return prev
      // Pinned results stay behind as a small chip at the selection.
      return prev.pinned ? { ...prev, visible: false } : undefined
    })
  }

  // A selection that sits on an existing highlight can remove it. Computed per
  // render so it follows the current selection and the freshest marks.
  const removeTarget = menu === undefined
    ? undefined
    : (() => {
        const hit = markAtSelection(
          marks.filter(mark => mark.page === menu.page),
          // The selection reports `{origin, size}`; stored marks hold `{x, y, w, h}`.
          // `pageSize` lets a normalized (`norm`) mark convert to points.
          { page: menu.page, rects: menu.rects.map(selectionRect), pageSize: menu.pageSize },
        )
        return hit
      })()

  const selectionMenu = menu === undefined ? null : (
    <SelectionMenu
      screen={{ x: menu.screenX, y: menu.screenY }}
      mode={menu.mode}
      draft={draft}
      busy={busy}
      t={t}
      onCopy={async () => {
        try {
          await navigator.clipboard.writeText(menu.quote)
          return true
        } catch {
          return false
        }
      }}
      onHighlight={(color) => {
        setMenu({ ...menu, color })
        runMark({
          ref: paperPath,
          kind: 'highlight',
          quote: menu.quote,
          page: menu.page,
          rects: menu.rects,
          pageSize: menu.pageSize,
          color,
        })
      }}
      removeTarget={removeTarget}
      onRemoveMark={(markId) => {
        void deleteMark(paperPath, markId).then(() => { refreshMarks() }).catch(() => {
          setBanner(t('markFailed'))
        })
      }}
      onComment={() => { setMenu({ ...menu, mode: 'comment' }) }}
      onTranslate={() => { openTranslate(menu) }}
      onAsk={() => { setMenu({ ...menu, mode: 'ask' }) }}
      onDraftChange={setDraft}
      onSubmitDraft={submitDraft}
    />
  )

  let body: ReactNode
  if (status === 'empty') body = <p className="m-0 flex flex-1 items-center px-3 text-sm font-medium text-muted-foreground">{t('empty')}</p>
  else if (status === 'loading') body = <p className="m-0 flex flex-1 items-center px-3 text-sm font-medium text-muted-foreground">{t('loading')}</p>
  else if (status === 'missing') body = <p className="m-0 flex flex-1 items-center px-3 text-sm font-medium text-muted-foreground">{t('missing')}</p>
  else if (status === 'error') body = <p className="m-0 flex flex-1 items-center px-3 text-sm font-medium text-muted-foreground">{message}</p>
  else {
    body = bytes === undefined ? null : (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col @min-[700px]/pdf:flex-row">
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          {banner === '' ? null : (
            <p className={cn('m-3 whitespace-pre-wrap px-3 py-2 text-sm', PDF_FLOAT_CARD)}>{banner}</p>
          )}
          <div className="relative min-h-0 flex-1">
            <EmbedReader
              notesOpen={notesOpen}
              onToggleNotes={hasNotes && notesPath !== undefined ? () => setNotesOpen(value => !value) : undefined}
              bytes={bytes}
              docId={paperPath}
              marks={marks}
              pdfTone={pdfTone}
              onSetPdfTone={setPdfTone}
              onSelect={onSelect}
              onDeselect={onDeselect}
              selectionClearVersion={selectionClearVersion}
              saveBookmarks={(nodes) => saveBookmarks(paperPath, nodes)}
              translate={translate}
              loadLayout={loadLayout}
              translatePin={translateCard === undefined || !translateCard.pinned
                ? undefined
                : {
                    page: translateCard.page,
                    rects: translateCard.rects,
                    pageSize: translateCard.pageSize,
                    onOpen: (screen) => {
                      setTranslateCard(prev => prev === undefined ? prev : { ...prev, anchor: screen, visible: true })
                    },
                  }}
              menu={selectionMenu}
              t={t}
            />
          </div>
        </div>
        {hasNotes && notesPath !== undefined ? (
          <aside key={notesPath} hidden={!notesOpen} aria-label={t('notes')} style={notesOpen ? undefined : { display: 'none' }} className="flex h-1/2 min-h-0 min-w-0 flex-col border-t border-border @min-[700px]/pdf:h-auto @min-[700px]/pdf:w-80 @min-[700px]/pdf:border-t-0 @min-[700px]/pdf:border-l">
            {props.renderSlot('agentero.pdf.notes', { paperPath: notesPath })}
          </aside>
        ) : null}
      </div>
    )
  }

  return (
    <div className="@container/pdf agentero-pdf agentero-surface flex h-full min-h-0 flex-col">
      {body}
      {translateCard === undefined || !translateCard.visible ? null : (
        <TranslateCard
          anchor={translateCard.anchor}
          result={translateCard.result}
          error={translateCard.error}
          loading={translateCard.loading}
          pinned={translateCard.pinned}
          onTogglePin={toggleTranslatePin}
          onClose={closeTranslateCard}
          t={t}
        />
      )}
    </div>
  )
}
