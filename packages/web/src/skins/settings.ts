/**
 * Skin settings shared by the page (skins/index.ts) and the build (vite-skins.ts, which writes the
 * skins into index.html). No imports, so the Vite config can load this file as it is.
 */

/** The skin shown when none is chosen (or the chosen one no longer exists). */
export const DEFAULT_SKIN = "vaporwave";

/** localStorage key of the chosen skin. */
export const SKIN_KEY = "vcm-skin";

/** What a skin's `skin.json` holds (its id is the folder's name). */
export interface SkinMeta {
	/** Name on the skin switch. */
	label: string;
	/** Place in the list, lowest first (then by label). */
	order?: number;
	/** Stylesheet URL of the skin's web fonts (e.g. Google Fonts), if it uses any. */
	fonts?: string;
}

/** A skin id is its folder's name: lowercase letters, digits and dashes. */
export const SKIN_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
