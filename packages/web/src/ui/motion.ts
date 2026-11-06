/**
 * Transitions the CSS motion layer cannot express (styles.css "Vaporwave motion"): an element React
 * keeps while what it shows changes (the card moving to another module, a station changing status,
 * the Now bar's title), or a new element that should continue from where an old one was (the train
 * moving station). They run through the Web Animations API, so they never touch React state or the
 * box sizes drawMetro() measures, and every call does nothing under prefers-reduced-motion or while
 * the harness's Motion switch is off (WCAG 2.2.2: the looping decoration can be stopped in the page).
 */

import { useSyncExternalStore } from "react";

/** Floating ease-out (the CSS `--ease`): quick start, long soft landing, no bounce. */
export const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
/** A train's ease: pulls away, cruises, brakes into the platform. */
export const EASE_TRAIN = "cubic-bezier(0.65, 0, 0.35, 1)";

/** Whether the viewer asked for reduced motion or switched motion off (checked per call, so a change applies at once). */
export function reducedMotion(): boolean {
	return motionOff() || (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);
}

/** localStorage key of the Motion switch. */
export const MOTION_KEY = "vcm-motion";

/** Whether motion is switched off on this page (`data-motion="off"` on <html>, which styles.css follows). */
export function motionOff(): boolean {
	return typeof document !== "undefined" && document.documentElement.dataset.motion === "off";
}

/** The remembered switch (default on; storage may be unavailable). */
export function storedMotionOff(): boolean {
	try {
		return localStorage.getItem(MOTION_KEY) === "off";
	} catch {
		return false;
	}
}

const readers = new Set<() => void>();

/** Switches the page's motion off or on and remembers it; useMotionOff() readers re-render. */
export function setMotionOff(off: boolean): void {
	document.documentElement.dataset.motion = off ? "off" : "on";
	try {
		localStorage.setItem(MOTION_KEY, off ? "off" : "on");
	} catch {
		// private mode: the switch just is not remembered
	}
	for (const read of readers) read();
}

/** The Motion switch's state, for the harness button. */
export function useMotionOff(): boolean {
	return useSyncExternalStore(
		(read) => {
			readers.add(read);
			return () => readers.delete(read);
		},
		motionOff,
		() => false,
	);
}

/**
 * `el.animate(keyframes, options)`, or nothing when there is no element, motion is reduced or the
 * engine lacks Web Animations (or the pseudo-element target). Callers never fill forwards, so once
 * an animation ends the element is back to its styles.
 */
export function play(
	el: Element | null | undefined,
	keyframes: Keyframe[],
	options: KeyframeAnimationOptions,
): Animation | undefined {
	if (!el || typeof el.animate !== "function" || reducedMotion()) return undefined;
	try {
		return el.animate(keyframes, options);
	} catch {
		return undefined;
	}
}
