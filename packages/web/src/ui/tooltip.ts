/**
 * The mockup's global tooltip manager and the small DOM helpers that go with it (bar sizes,
 * ensureVisible). It is imperative on purpose: one `#tip` element for the whole page, driven by
 * document listeners, so any element with `data-tip` gets a tooltip on hover AND keyboard focus.
 * Focus from a mouse click shows no tip (see focusVisible), and a focus tip goes when its trigger
 * loses focus.
 *
 * Rules kept from the mockup (WCAG 1.4.13): a hover tip survives the trip from its trigger onto the
 * tip itself; a focus tip never takes the pointer; an open popover's trigger (`aria-expanded="true"`)
 * shows no tip; evidence tabs (`role="tab"`) show their tip above; `data-tip="legend"` shows the
 * activity-tick legend.
 */

const NOW = "#now";
const HARNESS = "#harness";

let tip: HTMLElement | null = null;
let tipEl: Element | null = null;
let tipSrc: "hover" | "focus" | null = null;
/** The `data-tip` the shown tooltip was made from (syncTip compares it after a render). */
let tipText: string | null = null;
let hideTimer = 0;

function esc(text: string): string {
	return text.replace(
		/[&<>"']/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
	);
}

function legendHTML(): string {
	return '<div>Activity ticks</div><div class="lg"><i class="t t-read"></i><span>read</span><i class="t t-edit"></i><span>edit or write</span><i class="t t-bash"></i><span>command</span><i class="t t-test"></i><span>tests passed</span><i class="t t-test fail"></i><span>a test failed</span><i class="t t-test live"></i><span>tests running</span></div>';
}

function tipNode(): HTMLElement {
	if (tip?.isConnected) return tip;
	let el = document.getElementById("tip");
	if (!el) {
		el = document.createElement("div");
		el.id = "tip";
		el.setAttribute("role", "tooltip");
		el.hidden = true;
		document.body.appendChild(el);
	}
	tip = el;
	return el;
}

/** Shows the tooltip of `el` (its `data-tip`), positioned below it (above for tabs), clamped to the viewport. */
export function showTip(el: Element, src: "hover" | "focus"): void {
	const text = el.getAttribute("data-tip");
	if (!text || el.getAttribute("aria-expanded") === "true") {
		hideTip();
		return;
	}
	const node = tipNode();
	tipEl = el;
	tipSrc = src;
	tipText = text;
	node.style.pointerEvents = src === "hover" ? "auto" : "none";
	node.innerHTML = text === "legend" ? legendHTML() : esc(text);
	node.hidden = false;
	const r = el.getBoundingClientRect();
	const tw = node.offsetWidth;
	const th = node.offsetHeight;
	const above = el.getAttribute("role") === "tab";
	let top = above ? r.top - th - 8 : r.bottom + 8;
	if (above && top < 8) top = r.bottom + 8;
	if (!above && top + th > innerHeight - 8) top = r.top - th - 8;
	const left = Math.max(8, Math.min(r.left + r.width / 2 - tw / 2, innerWidth - tw - 8));
	node.style.top = `${Math.max(8, top)}px`;
	node.style.left = `${left}px`;
}

/** Hides the tooltip (the mockup calls this on every render; call it when UI state changes). */
export function hideTip(): void {
	if (tip) tip.hidden = true;
	tipEl = null;
	tipSrc = null;
	tipText = null;
}

/**
 * Whether `el` has keyboard focus (`:focus-visible`): Tab, or a script moving focus after keyboard
 * use. A mouse click also focuses a button, but the pointer already shows its hover tip, and a focus
 * tip would stay after the pointer leaves.
 */
export function focusVisible(el: Element): boolean {
	try {
		return el.matches(":focus-visible");
	} catch {
		return true; // an engine without :focus-visible: keep the tip for keyboard users
	}
}

/** Whether a tooltip is showing for the keyboard focus. */
export function focusTipShown(): boolean {
	return !!tipEl && tipSrc === "focus" && !!tip && !tip.hidden;
}

/**
 * Keeps the shown tooltip true to its trigger after a render: hidden if the trigger left the DOM, lost
 * its `data-tip` or opened its popover; re-shown (text and position) if its `data-tip` changed in place.
 */
export function syncTip(): void {
	if (!tipEl) return;
	const text = tipEl.getAttribute("data-tip");
	if (!tipEl.isConnected || !text || tipEl.getAttribute("aria-expanded") === "true") {
		hideTip();
		return;
	}
	if (tip && text !== tipText && tipSrc) showTip(tipEl, tipSrc);
}

let barObserver: ResizeObserver | undefined;
let observed = new WeakSet<Element>();

/**
 * Sets `--now-h` and `--harness-h` from the bars' sizes, so scroll-padding keeps focus clear of both
 * bars. Call it after renders that can change the bars (the app root's layout effect); once
 * installTooltips() ran, size changes of either bar also update it.
 */
export function setBarVars(): void {
	const root = document.documentElement.style;
	const now = document.querySelector<HTMLElement>(NOW);
	const harness = document.querySelector<HTMLElement>(HARNESS);
	for (const el of [now, harness]) {
		if (el && barObserver && !observed.has(el)) {
			observed.add(el);
			barObserver.observe(el);
		}
	}
	root.setProperty("--now-h", `${now?.offsetHeight ?? 0}px`);
	root.setProperty(
		"--harness-h",
		`${harness ? Math.max(0, Math.round(innerHeight - harness.getBoundingClientRect().top)) : 0}px`,
	);
}

/** Scrolls `el` into view if the sticky Now bar or the floating harness bar covers it (the mockup's ensureVisible). */
export function ensureVisible(el: Element | null | undefined): void {
	if (!el?.isConnected || el.closest(`${NOW}, ${HARNESS}`)) return;
	const r = el.getBoundingClientRect();
	const top = (document.querySelector<HTMLElement>(NOW)?.offsetHeight ?? 0) + 8;
	const harness = document.querySelector<HTMLElement>(HARNESS);
	const bottom = (harness ? harness.getBoundingClientRect().top : innerHeight) - 8;
	if (r.height > bottom - top) return;
	if (r.top < top || r.bottom > bottom) el.scrollIntoView({ block: "nearest" });
}

/**
 * Installs the document listeners (hover, focus, scroll, resize → bar sizes). Returns a cleanup
 * function; call it once from the app root's effect.
 */
export function installTooltips(): () => void {
	const onMove = (e: MouseEvent) => {
		const target = e.target as Element | null;
		if (tip && target && tip.contains(target)) {
			clearTimeout(hideTimer);
			return;
		}
		const el = target?.closest ? target.closest("[data-tip]") : null;
		if (el) {
			clearTimeout(hideTimer);
			if (el !== tipEl) showTip(el, "hover");
		} else if (tipEl && tipSrc === "hover") {
			clearTimeout(hideTimer);
			hideTimer = window.setTimeout(() => {
				if (tipSrc === "hover") hideTip();
			}, 250);
		}
	};
	const onFocus = (e: FocusEvent) => {
		const target = e.target as Element | null;
		const el = target?.closest ? target.closest("[data-tip]") : null;
		if (el && target && focusVisible(target)) showTip(el, "focus");
		else if (tipSrc !== "hover") hideTip();
		requestAnimationFrame(() => {
			if (document.activeElement === target) ensureVisible(target);
		});
	};
	const onBlur = (e: FocusEvent) => {
		const target = e.target as Node | null;
		if (tipSrc === "focus" && tipEl && target && tipEl.contains(target)) hideTip();
	};
	const onLeave = () => {
		if (tipSrc === "hover") hideTip();
	};
	const onScroll = () => {
		if (tipEl && tipSrc === "focus" && tipEl === document.activeElement && tipEl.isConnected) showTip(tipEl, "focus");
		else hideTip();
	};
	let frame = 0;
	const onResize = () => {
		cancelAnimationFrame(frame);
		frame = requestAnimationFrame(setBarVars);
	};
	document.addEventListener("mousemove", onMove, { passive: true });
	document.addEventListener("focusin", onFocus);
	document.addEventListener("focusout", onBlur);
	document.documentElement.addEventListener("mouseleave", onLeave);
	window.addEventListener("scroll", onScroll, true);
	window.addEventListener("resize", onResize);
	observed = new WeakSet<Element>();
	barObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => setBarVars()) : undefined;
	setBarVars();
	return () => {
		document.removeEventListener("mousemove", onMove);
		document.removeEventListener("focusin", onFocus);
		document.removeEventListener("focusout", onBlur);
		document.documentElement.removeEventListener("mouseleave", onLeave);
		window.removeEventListener("scroll", onScroll, true);
		window.removeEventListener("resize", onResize);
		barObserver?.disconnect();
		barObserver = undefined;
		clearTimeout(hideTimer);
		hideTip();
	};
}
