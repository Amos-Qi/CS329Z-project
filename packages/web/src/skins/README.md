# Skins

A skin is one look for the panel: its colours, type, surfaces, decoration and its own motion. The
layout and behaviour stay shared, so every skin shows the same Now bar, metro line, plan overview,
module card, evidence, Log and Raw views, and keeps the same keyboard and screen-reader behaviour.

```
src/styles/base.css     structure: layout, sizes, component states (in tokens)    shared
src/skins/<id>/skin.css tokens + decoration + the skin's own motion                one per skin
src/styles/motion.css   module-change motion (ring, segment fill, card sweep, …)  shared
src/styles/final.css    reduced motion + narrow screens                           shared
```

They load in that order, as four `<style>` elements (`skins/index.ts`). So:

- a skin rule beats a base rule of the same specificity;
- `motion.css` comes after the skin, so its hooks win (a ghost copy never floats in with the skin's
  entrances). A skin colours them through the motion tokens below, or uses a more specific
  selector;
- `final.css` comes last. Under `prefers-reduced-motion` or with the harness's Motion switch off, it
  stops every animation, transition, translate and rotate. It also holds the narrow-screen layout,
  which wins a tie with a skin's own `@media` rule.

Only the chosen skin's CSS is fetched. The skin is chosen by `?skin=<id>` (which is also
remembered), then the remembered choice (`localStorage` `vcm-skin`), then `DEFAULT_SKIN`
(`vaporwave`). The id is shown as `data-skin` on `<html>`. When there is more than one skin, the
harness bar shows a skin switch.

## Adding a skin

Each design gets its own branch off `feat/vaporwave-theme`, named `feat/<id>-theme`, and adds **only**
a folder here. Skins are found by folder, so no shared file changes and the branches merge without
conflicts.

1. `src/skins/<id>/index.ts`:

   ```ts
   import type { SkinDef } from "../index.ts";

   export default {
   	label: "Paper", // name on the skin switch
   	order: 1, // place in the list (vaporwave is 0)
   	fonts: "https://fonts.googleapis.com/css2?family=…&display=swap", // optional
   	css: () => import("./skin.css?inline").then((m) => m.default),
   } satisfies SkinDef;
   ```

2. `src/skins/<id>/skin.css` starts with the tokens: every one below on `:root` (the dark theme,
   with `color-scheme: dark`), and the ones that change on `[data-theme="light"]` (with
   `color-scheme: light`). Then add the skin's decoration. `skins/vaporwave/skin.css` is a full
   example. For a plain start, the calm pre-vaporwave palette is in git:
   `git show 8812b01:packages/web/src/styles.css | sed -n 8,112p`. It then needs only the six
   tokens added since: `--ease`, `--line-done` and the four motion tokens.
3. Try it with `?skin=<id>` in both themes, with Motion on and off, at full width and at phone
   width (768 px and below).
4. `npm test` checks that the skin defines every token the shared CSS reads, and that its keyframe
   names do not clash with the shared ones.

### Rules that keep the panel working

- **Never move or resize a metro station's box** (`.st`, `.st-dot`): `drawMetro()` measures them to
  draw the line. Decorate with `::after`, `box-shadow`, `filter` or an outline instead. (`.st-dot::before`
  is taken: it is the status ring in `motion.css`.)
- **Ghost copies never animate in.** These are `.card-ghost` (the card being replaced),
  `.stations .mk.ghost` (a marker leaving) and `.ov-ghost` (the plan overview folding away). `motion.css`
  handles the first two. If the skin gives `.ov-l > li` an entrance, switch it off for
  `.ov-ghost` and its children, as vaporwave does.
- **Reduced motion.** `final.css` already stops animation. Decoration with no still form (a moving
  light, a halo) should be hidden under both `@media (prefers-reduced-motion: reduce)` and
  `:root[data-motion="off"]`; see the end of `vaporwave/skin.css`.
- **Prefix the skin's own keyframes** (for example `paper-fade`). Never reuse a shared name: the base
  uses `train` and `spin`, and `motion.css` uses `st-in`, `glyph-in`, `seg-fill`, `seg-dot`,
  `seg-flash`, `mk-in`, `cut-in` and `pip-in`.
- **Colour is never alone.** State shapes (glyphs, dashes, patterns) are in the base, so keep each
  state's colour distinct, and keep text at WCAG AA contrast on `--card` and `--bg`.
- **Layout changes** are fine in CSS. A change that needs different markup touches shared
  components, so agree on it first.

## Tokens

- **Ground, text**: `--bg` page, `--card` surfaces, `--fg` text, `--fg-2` secondary text, `--muted` chip and hover fill, `--muted-fg` quiet text, `--hair` / `--hair-2` hairlines, `--shadow` floating surfaces (popovers, tooltip, toast, harness), `--tip-bg` tooltip
- **Controls**: `--primary` ordinary button fill, `--btn-bg` / `--btn-bg-h` / `--btn-fg` primary button (fill, hover, text), `--control-border` button and field edges, `--focus` focus ring
- **Working**: `--act`, `--act-fg` (text), `--act-soft` (fill)
- **Verified**: `--ok`, `--ok-fg`, `--ok-soft`
- **Held, needs you**: `--warn`, `--warn-fg`, `--warn-soft`, `--warn-solid` / `--warn-solid-h` (button), `--on-warn` (text on it), `--warn-surface` (held Now bar), `--ctl-on-warn` (controls on the held bar)
- **Failed, stopped**: `--bad`, `--bad-fg`, `--bad-soft`, `--bad-solid`, `--on-bad`
- **Other states**: `--run` (shell-command badge), `--pend` (not started, read-action badge), `--pend-line` (the dotted future)
- **Diffs**: `--add-bg`, `--add-fg`, `--del-bg`, `--del-fg`
- **Metro**: `--line-done` (travelled line)
- **Harness bar**: `--harness-bg`, `--harness-fg`, `--harness-sub`
- **Type, easing**: `--font-ui`, `--font-mono`, `--ease`
- **Motion (`motion.css`)**: `--ring` (a station's status ring when the status has no colour), `--ring-glow` (its outer glow), `--flash-glow` (a failed segment's flash), `--sweep` (the light across an arriving card: a gradient)

A skin may define more tokens for its own rules (vaporwave adds `--pink`, `--grad`, `--glow-*` and
others). The shared CSS never reads those.
