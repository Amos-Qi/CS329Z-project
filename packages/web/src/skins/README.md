# Skins

A skin is one look for the panel: its colours, type, surfaces, decoration and its own motion. The
layout and behaviour stay shared, so every skin shows the same Now bar, metro line, plan overview,
module card, evidence, Log and Raw views, and keeps the same keyboard and screen-reader behaviour.

```
src/styles/base.css      structure: layout, sizes, component states (in tokens)    shared
src/skins/<id>/skin.css  tokens + decoration + the skin's own motion                one per skin
src/styles/motion.css    module-change motion (ring, segment fill, card sweep, …)  shared
src/styles/final.css     reduced motion + narrow screens                           shared
```

The build (`vite-skins.ts`) writes them into `index.html` as `<style>` elements in that order, with
every skin in the skin slot. Only the chosen skin applies; the others carry `media="not all"`. A small
inline script picks the skin before the first paint, and a switch only moves that attribute
(`skins/index.ts`). So:

- a skin rule beats a base rule of the same specificity;
- `motion.css` comes after the skin, so its hooks win (the card or marker being replaced never floats
  in with the skin's entrances). A skin colours them through the motion tokens below, or uses a more
  specific selector;
- `final.css` comes last. Under `prefers-reduced-motion` or with the harness's Motion switch off, it
  stops every animation, transition, translate and rotate. It also holds the narrow-screen layout,
  which wins a tie with a skin's own `@media` rule.

The skin is chosen by `?skin=<id>` (remembered, then dropped from the address), then the remembered
choice (`localStorage` `vcm-skin`), then `DEFAULT_SKIN` (`vaporwave`, in `skins/settings.ts`). The id is
shown as `data-skin` on `<html>`. When there is more than one skin, the harness bar shows a skin switch.

In `npm run dev`, saving any of these CSS files swaps its `<style>` in place, without a reload. Adding
or removing a skin, or editing a `skin.json`, reloads the page.

## Adding a skin

Each design gets its own branch off `main`, named `feat/<id>-theme`, and adds **only**
a folder here, named by the skin's id (lowercase letters, digits, dashes). Skins are found by folder,
so no shared file changes and the branches merge without conflicts.

1. `src/skins/<id>/skin.json`:

   ```json
   {
   	"label": "Paper",
   	"order": 1,
   	"fonts": "https://fonts.googleapis.com/css2?family=…&display=swap"
   }
   ```

   `label` is the name on the skin switch. `order` is its place in the list (vaporwave is 0).
   `fonts` is an optional https stylesheet URL for its web fonts. Other keys are an error.

2. `src/skins/<id>/skin.css` starts with the tokens. Every token below goes in one flat `:root { … }`
   block, the dark theme, with `color-scheme: dark`. The ones that change go in a flat
   `[data-theme="light"] { … }` block, with `color-scheme: light`. Then add the skin's decoration.
   `skins/vaporwave/skin.css` is a full example. Files the skin uses (a texture, a self-hosted font)
   live in its folder and are referred to relatively, as `url(./noise.png)`; the build points them
   into the folder, since the CSS ends up inline in `index.html`.

   For a plain start, use the calm pre-vaporwave palette from git:
   `git show 8812b01:packages/web/src/styles.css | sed -n 8,112p`. Its fonts were
   `https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap`.
   It then needs only the tokens added since: `--ease`, `--line-done` and the four motion tokens.
3. Try it with `?skin=<id>` in both themes, with Motion on and off, at full width and at phone
   width (768 px and below).
4. `npm test` checks that the skin has a valid `skin.json` and defines every token the shared CSS and
   components read on `:root`, that it sets both colour schemes, and that its keyframe names do not
   clash with the shared ones.

### Rules that keep the panel working

- **Never move or resize what the metro measures.** `drawMetro()` measures the stations (`.st`,
  `.st-dot`) to draw the line, and assumes the held diamond (`.mk.held`), the pause boundary button
  (`.bnd`) and the parked train (`.train`) keep their base sizes (`HELD_HALF`, `BND_HALF`,
  `TRAIN_HALF` in `Metro.tsx`). Decorate with `box-shadow`, `filter`, an outline or a free
  pseudo-element instead.
- **Two pseudo-elements are taken.** `.st-dot::before` is the status ring. `.card::after` is the light
  that sweeps across an arriving card (coloured by `--sweep`; set it to `none` to drop it).
  `motion.css` and `ui/motion.ts` own both. `motion.css` also makes `.card` `position: relative`.
- **Copies that leave never animate in.** These are `.card-ghost` (the card being replaced),
  `.stations .mk.ghost` (a marker leaving) and `.ov-ghost` (the plan overview folding away).
  `motion.css` stops the card copy and the marker copy themselves. If the skin gives anything
  inside them an entrance (card rows, `.ov-l > li`), switch it off for those copies and their
  children, as vaporwave does for `.ov-ghost`.
- **Reduced motion.** `final.css` already stops animation. Decoration with no still form (a moving
  light, a halo) should be hidden under both `@media (prefers-reduced-motion: reduce)` and
  `:root[data-motion="off"]`; see the end of `vaporwave/skin.css`.
- **Prefix the skin's own keyframes** (for example `paper-fade`). Never reuse a shared name: the base
  uses `train` and `spin`, and `motion.css` uses `st-in`, `glyph-in`, `seg-fill`, `seg-dot`,
  `seg-flash`, `mk-in`, `cut-in` and `pip-in`.
- **Colour is never alone.** State shapes (glyphs, dashes, patterns) are in the base, so keep each
  state's colour distinct, and keep text at WCAG AA contrast on `--card` and `--bg`.
- **Layout changes** are fine in CSS, within the rules above. A change that needs different markup
  touches shared components, so agree on it first.

## Tokens

- **Ground, text**: `--bg` page, `--card` surfaces, `--fg` text, `--fg-2` secondary text (and the
  metro's travelled line), `--muted` chip and hover fill, `--muted-fg` quiet text, `--hair` /
  `--hair-2` hairlines, `--shadow` floating surfaces (popovers, tooltip, toast, harness), `--tip-bg`
  tooltip
- **Controls**: `--primary` ordinary button fill, `--btn-bg` / `--btn-bg-h` / `--btn-fg` primary
  button (fill, hover, text), `--control-border` button and field edges, `--focus` focus ring
- **Working**: `--act`, `--act-fg` (text)
- **Verified**: `--ok`, `--ok-fg`, `--ok-soft`, `--on-ok` (the tick on a verified glyph)
- **Held, needs you**: `--warn`, `--warn-fg`, `--warn-soft`, `--warn-solid` / `--warn-solid-h`
  (button), `--on-warn` (text on it), `--warn-surface` (held Now bar), `--ctl-on-warn` (controls on
  the held bar)
- **Failed, stopped**: `--bad`, `--bad-fg`, `--bad-soft`, `--bad-solid`, `--on-bad`
- **Other states**: `--run` (shell-command badge), `--pend` (not started, read-action badge),
  `--pend-line` (the dotted future)
- **Diffs**: `--add-bg`, `--add-fg`, `--del-bg`, `--del-fg`
- **Plan overview**: `--line-done` (its rail into a module that has started; vaporwave also uses it
  for the metro's travelled line)
- **Harness bar**: `--harness-bg`, `--harness-fg`, `--harness-sub`
- **Type, easing**: `--font-ui`, `--font-mono`, `--ease` (CSS transitions and the module-change
  animations in `ui/motion.ts`)
- **Motion (`motion.css`)**: `--ring` (a station's status ring when the status has no colour),
  `--ring-glow` (its outer glow), `--flash-glow` (a failed segment's flash), `--sweep` (the light
  across an arriving card: a gradient)
- **Optional**: `--focus-radius` (the focus ring's corner, 4px when left out)

A skin may define more tokens for its own rules (vaporwave adds `--pink`, `--grad`, `--glow-*`,
`--act-soft` and others). The shared CSS and components never read those.
