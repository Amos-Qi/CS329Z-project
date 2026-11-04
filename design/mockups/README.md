# Observation panel mockups

**[panel.html](panel.html) is the chosen design** (the "Metro line" direction; see `docs/design.md` §6 and decision D7).
It is clickable, self-contained HTML. Open it directly in Chrome or Safari. It needs no server or network.

The floating **MOCKUP** pill is not part of the product. It switches:
- the state: 1 Working, 2 Waiting for you, 3 Finished, 4 Redo preview;
- the view: Modules (treatment) or Log (baseline);
- the theme.

What to look at:

- **L0 Now bar.** Shared by both views. It turns amber when the agent waits at a boundary and offers Continue, Change next, Redo and Stop.
- **L1 Metro line.** Modules are stations. Dependency arcs, the pause marker and the redo cut are drawn on the line itself.
- **L2 module card.** Done-when criteria (agent says vs. tests show), files, tests, what the agent read, and the instruction version.
- **L3 evidence.** Actions, your notes and corrections, the diff, test output.
- **Log view.** The baseline condition: the same Now bar and controls, with no module aggregates.

The scenario is the `toy-shop-discounts` task. M3 follows the planted `docs/CONTRIBUTING.md`, truncates cents, and claims done without a passing test.

Screenshots of the final design: [shots/panel-overview.png](shots/panel-overview.png) (the four states) and `shots/panel-*.png`
(Log view, light theme, phone width).

The mockup has been through a review of five lenses: keyboard and accessibility, contrast and visuals, interaction state,
study equivalence, and text budget. Each finding was checked by a skeptic before it was fixed, and regression checks ran in
headless Chrome. The default screen has about 21 words besides titles.

## Explored directions

These are kept for the record, each after one review-and-fix round. They are not maintained.

| File | Direction | Plan drawn as |
|---|---|---|
| [explored/b-metro.html](explored/b-metro.html) | Metro line, as first built (became `panel.html`) | A horizontal line of stations |
| [explored/a-instrument.html](explored/a-instrument.html) | Instrument | A vertical rail beside the card. Scales best past ~6 modules, but its glyphs are dense. |
| [explored/c-tiles.html](explored/c-tiles.html) | Tiles | A row of tiles. The selected tile opens into the card. It uses the most words. |

Side by side: [shots/compare.png](shots/compare.png).
