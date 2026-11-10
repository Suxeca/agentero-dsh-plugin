import { Check, Copy, Eraser, Languages, MessageSquare } from "lucide-react";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	type KeyboardEvent,
} from "react";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import { Button } from "./button";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "./tooltip";
import {
	HIGHLIGHT_COLOR_STACK_EXPANDED_W,
	HighlightColorStack,
} from "./highlight-color-stack";
import { cn } from "./cn";
import type { HighlightColor } from "./palette";

type PdfT = PropsLocale<"agentero.pdf">["t"];

type SelectionMenuProps = {
	/** Screen point near the top-center of the selection (toolbar anchor). */
	screen: { x: number; y: number };
	mode: "actions" | "comment" | "ask";
	draft: string;
	busy: boolean;
	t: PdfT;
	onCopy: () => Promise<boolean>;
	/** Every swatch calls this with the chosen palette key. */
	onHighlight: (color: HighlightColor) => void;
	/**
	 * The stored mark this selection sits on. Absent when the selection covers
	 * no marked area, in which case the toolbar offers no erase affordance.
	 *
	 * `kind` picks the label: a highlight reads "取消高亮", while an ask or
	 * translate mark paints the same words in its own colour and reads
	 * "取消标记" — the button must say what it is about to remove.
	 */
	removeTarget?: { id: string, kind: string } | undefined;
	onRemoveMark: (id: string) => void;
	onComment: () => void;
	onTranslate: () => void;
	onAsk: () => void;
	onDraftChange: (value: string) => void;
	onSubmitDraft: () => void;
};

const EDGE = 12;
const COPIED_FLASH_MS = 1500;

const TEXT_ACTION =
	"inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-caption font-medium text-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring/50 active:scale-[0.97] motion-reduce:active:scale-100 disabled:pointer-events-none disabled:opacity-50";

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

function SelectionCopyButton({
	onCopy,
	label,
	copiedLabel,
}: {
	onCopy: () => Promise<boolean>;
	label: string;
	copiedLabel: string;
}) {
	const [copied, setCopied] = useState(false);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const mountedRef = useRef(true);

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			if (timerRef.current) clearTimeout(timerRef.current);
		};
	}, []);

	const handleClick = useCallback(() => {
		void (async () => {
			const ok = await onCopy();
			if (!mountedRef.current || ok === false) return;
			setCopied(true);
			if (timerRef.current) clearTimeout(timerRef.current);
			timerRef.current = setTimeout(() => {
				timerRef.current = null;
				if (mountedRef.current) setCopied(false);
			}, COPIED_FLASH_MS);
		})();
	}, [onCopy]);

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					className="size-7"
					aria-label={copied ? copiedLabel : label}
					onPointerDown={(event) => event.preventDefault()}
					onClick={handleClick}
				>
					{copied ? (
						<Check className="size-3.5" />
					) : (
						<Copy className="size-3.5" />
					)}
				</Button>
			</TooltipTrigger>
			<TooltipContent side="top">{label}</TooltipContent>
		</Tooltip>
	);
}

/**
 * Floating action bar shown next to a text selection: overlapping highlight
 * color dots (fan left on hover), then Translate / Comment / Copy / Quick chat / Add to chat.
 * Copy keeps the bar open and swaps the icon for a check.
 * The bar is pinned by its right edge so expanding colors only grow left.
 */
export function SelectionMenu({
	screen,
	mode,
	draft,
	busy,
	t,
	onCopy,
	onHighlight,
	removeTarget,
	onRemoveMark,
	onComment,
	onTranslate,
	onAsk,
	onDraftChange,
	onSubmitDraft,
}: SelectionMenuProps) {
	// What the erase button calls the thing it would remove: a highlight has its
	// own name, while an ask/translate mark paints the same words in another
	// colour and should not be called a highlight.
	const removeLabel = removeTarget === undefined
		? ""
		: removeTarget.kind === "highlight"
			? t("removeHighlight")
			: t("removeMark")
	const showHighlight = mode === "actions";
	const menuRef = useRef<HTMLDivElement>(null);
	const dividerRef = useRef<HTMLDivElement>(null);
	const colorsRef = useRef<HTMLFieldSetElement>(null);
	const [position, setPosition] = useState<{
		right: number;
		top: number;
		dimmed: boolean;
	} | null>(null);

	useLayoutEffect(() => {
		const menu = menuRef.current;
		if (!menu) return;
		const place = () => {
			const rect = menu.getBoundingClientRect();
			const divider = showHighlight
				? dividerRef.current?.getBoundingClientRect()
				: undefined;
			const anchor = divider
				? divider.left + divider.width / 2
				: rect.left + rect.width / 2;
			// Measure the action side, so labels need no estimates.
			// Keep `right` fixed while the color stack expands to the left.
			const expandedWidth =
				rect.width +
				(colorsRef.current
					? HIGHLIGHT_COLOR_STACK_EXPANDED_W -
						colorsRef.current.getBoundingClientRect().width
					: 0);
			const right = clamp(
				window.innerWidth - screen.x - (rect.right - anchor),
				EDGE,
				Math.max(EDGE, window.innerWidth - expandedWidth - EDGE),
			);
			// Prefer above the selection, flipping below near the top edge.
			const above = screen.y - rect.height - 10;
			const overContent = above < EDGE;
			const top = clamp(
				overContent ? screen.y + 18 : above,
				EDGE,
				Math.max(EDGE, window.innerHeight - rect.height - EDGE),
			);
			const dimmed = overContent || top !== above;
			setPosition((prev) =>
				prev?.right === right && prev.top === top && prev.dimmed === dimmed
					? prev
					: { right, top, dimmed },
			);
		};
		place();
		const observer = new ResizeObserver(place);
		observer.observe(menu);
		window.addEventListener("resize", place);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", place);
		};
	}, [screen.x, screen.y, showHighlight]);

	return (
		<div
			ref={menuRef}
			data-pdf-chrome
			className={cn(
				"fixed z-50 flex h-8 items-center gap-0.5 rounded-md border border-border/80 bg-background px-1 shadow-2xl ring-1 ring-black/5 transition-[background-color,opacity] duration-150 dark:ring-white/10",
				position?.dimmed &&
					"bg-background/80 opacity-70 backdrop-blur-sm hover:bg-background hover:opacity-100",
			)}
			style={{
				top: position?.top ?? 0,
				right: position?.right ?? 0,
				visibility: position ? undefined : "hidden",
			}}
			role="toolbar"
			aria-label={t("menu")}
			onMouseDown={(event) => {
				event.stopPropagation();
				const target = event.target;
				if (
					target instanceof HTMLInputElement ||
					target instanceof HTMLTextAreaElement
				) {
					return;
				}
				event.preventDefault();
			}}
			onPointerUp={(event) => event.stopPropagation()}
		>
			{mode === "actions" ? (
				<TooltipProvider delayDuration={200}>
					<HighlightColorStack
						ref={colorsRef}
						t={t}
						onSelect={(color) => {
							if (!busy) onHighlight(color);
						}}
					/>
					{removeTarget === undefined ? null : (
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									type="button"
									variant="ghost"
									size="icon-sm"
									className="size-7"
									aria-label={removeLabel}
									disabled={busy}
									onPointerDown={(event) => event.preventDefault()}
									onClick={() => onRemoveMark(removeTarget.id)}
								>
									<Eraser className="size-3.5" />
								</Button>
							</TooltipTrigger>
							<TooltipContent side="top">{removeLabel}</TooltipContent>
						</Tooltip>
					)}
					<div ref={dividerRef} className="mx-0.5 h-4 w-px shrink-0 bg-border" />
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="icon-sm"
								className="size-7"
								aria-label={t("translate")}
								disabled={busy}
								onClick={onTranslate}
							>
								<Languages className="size-3.5" />
							</Button>
						</TooltipTrigger>
						<TooltipContent side="top">{t("translate")}</TooltipContent>
					</Tooltip>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="icon-sm"
								className="size-7"
								aria-label={t("comment")}
								onPointerDown={(event) => event.preventDefault()}
								onClick={onComment}
							>
								<MessageSquare className="size-3.5" />
							</Button>
						</TooltipTrigger>
						<TooltipContent side="top">{t("comment")}</TooltipContent>
					</Tooltip>
					<SelectionCopyButton
						onCopy={onCopy}
						label={t("copy")}
						copiedLabel={t("copied")}
					/>
					<button
						type="button"
						className={TEXT_ACTION}
						aria-label={t("ask")}
						disabled={busy}
						onPointerDown={(event) => event.preventDefault()}
						onClick={onAsk}
					>
						<span>{t("ask")}</span>
					</button>
				</TooltipProvider>
			) : (
				<>
					<input
						className="h-7 w-52 bg-transparent px-1.5 text-sm text-foreground outline-none placeholder:text-muted-foreground"
						value={draft}
						disabled={busy}
						placeholder={mode === "ask" ? t("askHint") : t("commentHint")}
						autoFocus
						onChange={(event) => {
							onDraftChange(event.target.value);
						}}
						onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
							if (event.key !== "Enter" || event.nativeEvent.isComposing || busy) return;
							event.preventDefault();
							onSubmitDraft();
						}}
					/>
					<button
						type="button"
						className={TEXT_ACTION}
						disabled={busy || (mode === "ask" && draft.trim() === "")}
						onClick={onSubmitDraft}
					>
						{mode === "ask" ? t("send") : t("save")}
					</button>
				</>
			)}
		</div>
	);
}
