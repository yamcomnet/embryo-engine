# Embryo Engine

*What's the minimal set of rules that produces embryo-like behavior from physics-like constraints?*

A cellular automaton that grows an embryo-like specimen from **37 stem cells** (alike but for a random lifespan and starting activator level) and a fixed pot of energy that is never created or destroyed. One conservation law, three rules (divide, die, become what your depth demands) and four signal fields turn the founders into a layered body with seven tissue types: concentric germ layers, an anterior neural plate, and a mesoderm ring that a Turing activator–inhibitor pattern breaks into muscle blocks separated by vessel. The rules assign the layers and the head–tail axis; the muscle pattern, the body's size and its turnover work themselves out ([what is local, and what is not](#what-is-local-and-what-is-not)).

Version 1.0 "Darkfield" shows it as a living specimen under a darkfield microscope, in 3D: only light scattered by living tissue reaches you, so cells glow against black. The simulation itself is a flat sheet on a 200 × 200 grid; in 3D, deeper cells stand taller, which is an encoding, not anatomy. Every cell's colour, glow, height and width, and every label and number, is read from the running simulation; the dish, lens and dust around it are decoration.

**[Try it live](https://embryo.yamcom.net)** (also on [GitHub Pages](https://yamcomnet.github.io/embryo-engine/))

![Embryo Engine v1.0, seed 1 at T 5,261 with 4,441 cells, running in the Tissue stain: a dome of cells glowing against black, blue ectoderm around the base, green vessel and pink muscle blocks above it, amber endoderm and a pale stem core on top, with callouts for the neural plate, anterior, muscle blocks, stem core and ectoderm. The specimen log and composition legend are on the left, the stains rail on the right and the timeline along the bottom.](screenshot.png)

## The Idea

If the universe is computational, what would the "game board" look like?

Real physics has a deep connection between symmetry and conservation (Noether's theorem): time symmetry gives energy conservation, spatial symmetry gives momentum conservation. Meanwhile, biology runs on *breaking* symmetry locally — not in the laws, which stay the same everywhere (energy is still conserved inside an embryo), but in the matter they act on: an embryo starts nearly symmetric and becomes asymmetric through differentiation.

This simulation asks: **what's the minimal set of rules that produces embryo-like behavior from physics-like constraints?**

v1.0's answer, a working one rather than a proven minimum, is one law, three rules and four signals:

- **Law: energy is conserved.** 250,000 units, shared equally by the founders. Nothing creates or destroys energy: cells pass it to their neighbours, split it when they divide, and hand all of it on when they die.
- **Rule 1: divide.** A cell holding more than 30 energy (stem) or 42 (any other type), and older than 14 ticks, splits in two if a neighbouring place is empty. The daughter is always a stem cell, and each keeps half.
- **Rule 2: die.** Of old age, when a cell has no living neighbour, or (8% a tick) when it is an exposed tip with one neighbour. Its energy goes to the nearest living cells. A cell's age restarts whenever it divides, so a cell that keeps dividing never dies of old age. Over the first 20,000 ticks about 93% of deaths are from old age, 7% are tips and none are from isolation (5 seeds).
- **Rule 3: become what your depth demands.** A cell's depth is counted in steps from the embryo's outer surface. Four bands, scaled to the depth of the deepest cell, assign the fate: ectoderm outside, then mesoderm, endoderm, and a stem core. Within the bands, signals pick the specialists: neural in the outer band where the midline and A–P signals overlap, and muscle or vessel in the mesoderm, by its activator.
- **Signals.** Four fields diffuse and fade across the dish, empty places included. An activator that amplifies itself, and the inhibitor it makes, form spots and stripes on their own. A midline signal and an anterior–posterior (A–P, head–tail) signal are laid down around the embryo's centre.

### What is local, and what is not

The honest version of "one law, three rules":

- **Rules 1 and 2 are local:** a cell and its four neighbours.
- **Rule 3 is not.** Depth is measured from the outside of the whole embryo, the band edges scale with the whole embryo's depth, and the muscle/vessel choice compares a cell's activator with the mean of every live cell at the same depth.
- **Midline and A–P are positional information,** written in by the engine every tick around the embryo's centroid. The body axis always runs along the grid's columns, "anterior" is fixed to one side of the dish, and at T 0 a short A–P stripe is laid from the founders' centre toward that side. The neural plate appears where these two imposed gradients overlap, so its anterior position is expected, not discovered.
- **The order of the layers is what Rule 3 assigns,** and the rules know the tissue types: each band maps to a named germ layer, gates pick neural, muscle and vessel, and each type has its own lifespan. Cells never move, so this is layering by position, not gastrulation by cell migration.
- **Few rules, many numbers:** about 60 hand-set constants (thresholds, lifespans, band edges, gates, kinetics, deposits) sit behind the three rules, several of them chosen by measuring alternatives ([docs/engine-v1.md](docs/engine-v1.md)).
- **What does organise itself:** the activator–inhibitor labyrinth (about 11–14 cells between spots) and the muscle blocks it carves; the embryo's size, which no rule sets (it follows from the fixed pot and the division thresholds); its steady turnover of births and deaths; and how the stem core keeps going. Rule 3 decides where the core is, but after T 1,000 nearly every new core cell (97–100% in seeds 1 and 2) is born there by division rather than converted from endoderm.
- **Energy transport is local,** except for a fallback: energy from a death with no living cell within two steps is spread over every living cell. In 5 seeds neither this fallback nor the two-step route fired before T 20,000; in longer runs the fallback fires a handful of times (4–8 per seed by T 100,000).

## How It Works

### Energy

All energy lives inside cells: there is no substrate and no background field.

- **Sharing:** in every pair of neighbours, the richer cell passes 5% of the difference to the poorer each tick (one in-place sweep over the grid).
- **Division** halves the parent's energy. It is the only "cost" of growth.
- **Death** hands everything to the living: to the dead cell's live neighbours, else to live cells two steps away, else to a pool shared by every live cell at the end of the tick.
- **By construction, and measured:** no code path destroys energy. Over 5 runs of 20,000 ticks the worst relative error in the total is 2.3 × 10⁻¹⁶, one or two rounding units of a compensated sum, and to T 100,000 (checked every tick, pool fallback firings included) it stays within 3.5 × 10⁻¹⁶.

Growth slows as energy per cell approaches the division thresholds, and turnover takes over: at T 20,000 about 6,900 cells hold 250,000 / 6,895 ≈ 36.3 each, between the stem (30) and differentiated (42) thresholds. The embryo is still creeping larger then: about 7,450 cells at T 50,000 and 7,550 (≈ 33 each) at T 100,000.

### Depth and fate (Rule 3)

- **Depth** counts steps from the exterior, the empty region outside the embryo: 1 for a cell that touches it, then inward in 4-neighbour steps, with diagonal steps allowed on every other ring (an octagonal metric, which keeps the layers round rather than diamond-shaped). Holes left inside by deaths are not surfaces.
- **Bands** are fractions of the embryo's depth (the deepest cell's depth, which the bands follow only when it moves by more than 1): outer 15% ectoderm (neural where the midline and A–P signals both pass 0.18), to 30% mesoderm, to 85% endoderm, deeper stem.
- **Continuously:** every stem, ecto, meso or endo cell older than 12 ticks re-reads its band every tick and takes the band's fate. Hysteresis (a ±1 depth margin and 6 ticks of persistence) keeps cells on a boundary from flickering.
- **Terminal tissues** (neural, muscle, vessel) keep their fate in their own band, and revert after 150 ticks outside it.
- **The stem core** does not "stay" stem: all 37 founders take a fate at T 14, before the embryo is thick enough to have a core. The core first forms from buried endoderm (and early muscle) turning back into stem, then renews itself by division.

### Signals

- **Activator and inhibitor** follow Gierer–Meinhardt kinetics on live cells. The inhibitor diffuses 10.8× faster than the activator.
- **Muscle and vessel:** mesoderm that has held for 40 ticks becomes muscle where its activator is above 1.2× the mean at its depth, and vessel below 0.8×.
- **Midline:** a Gaussian (σ 14 cells) of each cell's sideways offset from the centroid. **A–P:** proportional to how far a cell lies on the anterior side of the centroid, and zero behind it.
- **Deposits by type:** ectoderm adds to the midline; neural cells add to both midline and A–P, which makes the neural plate self-reinforcing; mesoderm and muscle add to A–P.

### Growth

Cells divide into any empty neighbouring place: at the rim, or into holes left by deaths inside the tissue. Early growth is at the rim (68–71% of births at T 1,000). From about T 3,000, 79–93% of births refill interior holes, and only the rim adds net cells.

## What Grows

Measured over 5 seeds (means, % of live cells; the standard deviation is at most 0.6 points and 9 cells). The share of each layer family mostly follows from Rule 3's band edges on a round body; what the rules leave open is the split inside each family (neural, muscle, vessel), the timing and the pattern. Full tables with ± sd and method: [docs/engine-v1.md](docs/engine-v1.md).

| Tick | Cells | Stem | Ecto | Meso | Endo | Neural | Muscle | Vessel |
|---|---|---|---|---|---|---|---|---|
| T 1,000 | 1,694 | 5.4 | 25.5 | 2.9 | 33.1 | 10.8 | 9.8 | 12.6 |
| T 5,000 | 4,347 | 4.9 | 23.5 | 2.1 | 42.9 | 6.9 | 7.0 | 12.8 |
| T 20,000 | 6,895 | 5.8 | 22.4 | 2.8 | 45.3 | 4.3 | 8.0 | 11.3 |

- **Concentric order** (ecto < meso family < endo < stem, by mean depth) holds from T 1,000 on in every seed (checked at T 1,000, 2,500, 5,000, 10,000 and 20,000; at T 500 the stem core is still forming), and at T 20,000, 96% of live cells carry the fate their band assigns. Both check that Rule 3 does what it says; neither is a discovery.
- **Muscle blocks:** clustering (the share of a muscle cell's live neighbours that are muscle) reaches 0.4 at T 384–542 and about 0.76 at T 1,000, against about 0.07 for salt-and-pepper.
- **Milestones** the app detects from real state (tick: min / median / max over 5 seeds):

| Milestone | Condition | Tick |
|---|---|---|
| First fates | any non-stem cell | 14 |
| Four layers | ecto, meso family and endo each ≥ 5% and stem ≥ 1% of 200+ cells | 282 / 311 / 311 |
| Muscle | ≥ 10 muscle cells (still scattered, not yet blocks) | 335 / 356 / 364 |
| Gut core | ≥ 500 cells and endoderm outnumbers ectoderm | 363 / 363 / 398 |
| Neural plate | ≥ 10 neural cells | 648 / 656 / 663 |
| Turnover | after T 1,000, births and deaths within 15% over the last 500 ticks | 3,558 / 3,585 / 3,633 |
| Founders gone | the last original cell dies | 6,516 / 8,837 / 15,125 |

- **Known limits:** after about T 15,000 the rim becomes porous, and it keeps getting worse: about 37 interior gaps at T 20,000, about 650 at T 50,000 and about 1,300 at T 100,000 (5 seeds). Muscle blocks are crispest between T 1,000 and T 5,000.

## Stains and the 3D View

The stains rail recolours the specimen; the legend on the left explains each one.

| Key | Stain | Colour shows |
|---|---|---|
| 1 | Tissue | Cell type; glow is energy (pale tissues glow brighter at the same energy, so compare in 3); cells past 85% of their lifespan fade toward grey |
| 2 | Depth | The Rule 3 band each cell's depth falls in now |
| 3 | Energy | Energy ÷ division threshold (white = threshold); gold marks the few cells that can divide now |
| 4 | Age | Share of lifespan used; old past 85% |
| 5 | Midline | Midline signal |
| 6 | A–P | Anterior–posterior (head–tail) signal |
| 7 | Activator | Turing activator |
| 8 | Inhibitor | Turing inhibitor |

In 3D, height encodes depth below the surface (a dome, with a small step at each band edge: an encoding, not anatomy), width encodes energy toward the division threshold, and round pebbles are stem cells. Glow appears only in the Tissue stain. A brief flash marks a cell taking a new fate ([flash safety](#flash-safety-and-reduced-motion)). The **Map** camera shows the grid flat, as it is simulated: no height, lighting or glow. **Apart** lifts each germ-layer family onto its own plate.

## Controls

- **Play, step, reset, new seed, speed** (7.5 to 480 ticks per second, 60 by default, or as fast as possible). A fresh page starts running after about a second, except under reduced motion or from a share link.
- **Hover** a cell for its exact values and history; **click or tap** to pin it.
- **Isolate:** in the Tissue stain, click a tissue in the composition legend to dim all the others; click it again, or press Esc, to show all.
- **Timeline:** milestones and snapshots taken every 1,000 ticks, on a log-time axis. Milestones are always kept; the other snapshots are thinned to the latest eight and every 5,000th, then, oldest first, to fit a cap of 16 in all (6 on phones and other devices that start at Low quality). Click one to view that moment; *Back to live* returns, *Resume here* carries on from it (the same seed replays the same future).
- **Share:** the link button copies `?seed=…&t=…`; the link fast-forwards to that tick and lands paused. A long jump shows the time left and a Stop button.
- **Scene dock:** the bar floating over the view, just above the time bar (on phones, above the bottom sheet; in landscape, beside the stains) holds **Apart**, the **Specimen**, **Close** and **Map** camera presets, **Orbit** and, once you have moved the camera, **Frame**. Drag to turn the camera, right-drag or two-finger drag to pan, scroll or pinch to zoom. While the run plays, the camera follows the growing embryo and turns slowly (Orbit, or O, switches the turntable off) until you move it (Frame, or F, re-frames).
- **Guide (?)** explains every colour and rule, with Quality (auto, high, medium, low) and Reduced motion settings.

| Key | Action |
|---|---|
| Space | Run / pause (stops a fast-forward; from a snapshot, back to live and run) |
| . or → | Step one tick |
| R / N | Reset (same seed) / new seed |
| − / + | Slower / faster |
| 1–8 | Stains |
| X | Together ⇄ Apart |
| [ / ] | Previous / next milestone |
| L / Enter | Back to live / resume from the snapshot |
| C / F / O | Camera preset / frame and follow / orbit (the turntable) |
| Shift + arrows, PgUp / PgDn | Turn the camera, zoom |
| Q / M | Quality / reduced motion |
| ? or H | Guide |
| Esc | Close, unpin, back to live, stop a fast-forward, or show all tissues |

### Flash safety and reduced motion

- **Nothing strobes.** Colours ease over about a tenth of a second. Early fates arrive in synchronised waves, and at hundreds of ticks per second a whole wave lands inside one frame, so the commitment flash and the death ember share a light budget that is measured on every rendered frame from what is about to be drawn: their total stays under a ceiling and may rise only a little from one frame to the next. A lone fate change still flashes fully, and after a wave the strength recovers over about a second. A dying cell's ember never outshines the cell, the Apart streaks ease into their glow, the illuminator's ring dims toward the frame's edge and its light curtain fades out near the camera, so neither switches on across the whole frame when the camera moves. Measured with a 60 fps frame-brightness check (seed 1, two phone framings and two desktop ones, 60 ticks per second to max, the opening, the Four layers wave and Apart), single-frame pulses of more than 10% brightness went from up to 4 per run (the largest 22%) to none.
- **Reduced motion** follows your system setting, and M toggles it. It turns off glides, camera flights, the turntable and the flashes, and the run waits for Play instead of starting by itself.

## Technical Details

- **No build step.** Static files: `index.html`, `styles.css`, ES modules in `src/`. three.js r183 comes from a CDN through an import map.
- **Engine** (`src/engine.js`): a pure module, no DOM, that runs in node and in workers. 200 × 200 torus, Float64 energy with a compensated sum, typed arrays, no allocation per tick, depth by an exterior flood fill and a BFS with an octagonal metric. Every buffer is allocated once.
- **Deterministic:** seeded sfc32 random numbers and no transcendental `Math` calls in the dynamics, so a seed grows the same embryo in every browser. Golden hash for seed 1 at T 5,000: `472c912f`, identical in node and a Chrome worker. A share link replays the run from T 0 to its tick, so it lands on the same state anywhere. Snapshots restore bit-exactly, random-number state included, which is what makes the timeline and *Resume here* work.
- **Worker** (`src/sim-worker.js`): runs the engine in a module worker, paces ticks, packs each frame into a pool of transferable buffers (published only against an acknowledgement), and derives the statistics, milestones, thumbnails and snapshots. The main thread only uploads textures and draws.
- **Scene** (`src/scene/`): instanced cells whose colour, glow, height and shape come from per-cell textures; a darkfield set, shadows, depth of field and bloom; a per-frame light budget on commitment flashes and embers; adaptive quality that steps the resolution down only while that makes frames faster, drops a tier when the main thread is the bottleneck, and recovers once frames keep up with the display again.
- **HUD** (`src/ui/`): the specimen log (a narrator whose every number is read from live statistics), the legend, the timeline and the inspector.
- **URL parameters:** `seed`, `t` (fast-forward, up to 2,000,000), `view` (1–8, or a stain id: `cells`, `depth`, `energy`, `age`, `midline`, `ap`, `activator`, `inhibitor`), `apart=1`, `cam=specimen|close|map`, `q=auto|high|medium|low`. For development, `engine=v09` runs the v0.9 rules in the 3D view and `mock=N` runs a synthetic engine with N cells (up to 25,000). Both load from `dev/`, so they work locally and on GitHub Pages but not on embryo.yamcom.net.

### Parameters

```
totalEnergy      250,000   the fixed pot
founders         37        the disk dx² + dy² ≤ 10; each draws a lifespan (500 ± 75) and a starting activator (0.3–0.6)
divThresh        30 / 42   stem / other types
divCooldown      14        ticks of age (age restarts at birth, at division, when a stem cell takes a fate
                           and when mesoderm specialises)
diffAge          12        age a cell must pass before Rule 3 may change its fate
shareRate        0.05      per neighbour pair, per tick
lifespan         500 × type factor ± 75 (stem 300, ecto 650, meso 450, endo 700, neural 1250, muscle 800, vessel 900),
                 drawn at birth and redrawn when a stem cell takes a fate or mesoderm specialises
death            tip 0.08 per tick; orphan energy radius 2
bandFrac         0.15 / 0.30 / 0.85 of the embryo's depth (minimums 1 / 2 / 6)
hysteresis       embryo-depth deadband ±1, depth margin ±1, persistence 6, terminal reversion 150
gates            neural: midline and A–P > 0.18; muscle > 1.2×, vessel < 0.8× the mean activator at that depth, after 40 ticks
diffusion        rates 0.03 / 0.325 / 0.234 / 0.208 (activator, inhibitor, midline, A–P), decay 0.96 per tick;
                 the inhibitor in 2 stable sub-steps
kinetics         a += 0.01·a² / ((b + 0.001)(1 + 0.02·a²)) + 0.0005 ± 0.01 noise;  b += 0.01·a² − 0.02·b
                 (live cells only; both capped at 8)
positional       midline 0.01·exp(−dx² / 392), σ 14 cells; A–P 0.01·(cy − y) / 20 on the anterior side, 0 behind
deposits         ecto +0.002 midline; neural +0.012 midline, +0.008 A–P; meso and muscle +0.004 A–P
at T 0           an A–P stripe of 0.08·r at r = 1…6 cells from the founders' centre toward the anterior
```

The complete `PARAMS` and `FIELD_INFO`, the per-tick order, and the audit changelog are in [docs/engine-v1.md](docs/engine-v1.md).

## Development Journey

This simulation went through 9 major iterations to get the energy model right, then a rebuild:

| Version | Problem | Solution |
|---------|---------|----------|
| v0.1 | Growth stalls at ~74 cells | Energy siloed, no redistribution |
| v0.2 | Stalls at ~3K cells | Added energy diffusion, still insufficient |
| v0.3 | Total extinction | Added death/recycling, but substrate too dilute |
| v0.4 | Gaussian substrate helps | Energy still leaks through metabolism + death waste |
| v0.5 | 75% energy loss over time | Metabolism → substrate (closed loop), but substrate diffuses into void |
| v0.6 | All energy drains to 0 | Removed substrate, energy only in cells — but metabolism still a sink |
| v0.7 | **First sustained life** | Zero metabolism, division = only cost, 99%+ conservation |
| v0.8 | Only ectoderm + vessel | Daughters copied parent type — fixed: all daughters born STEM |
| v0.9 | "All 7 types, 100% conservation" (muscle never actually formed) | BFS depth for layering, isolation pressure for compaction |
| v1.0 | An audit of v0.9 logged 46 findings (some overlapping; two confirmed something was fine) | Rebuilt engine: exact conservation, stable diffusion, real Turing kinetics, depth from the exterior; 3D darkfield app |

The key insight at each stage: **every energy flow must have a destination**. Metabolism that vanishes, death waste that disappears, substrate that diffuses into empty space — all of these are invisible leaks that eventually drain the system.

The v1.0 audit found that v0.9 had not quite got there, and that several of its results were numerical artifacts:

- **"100% conservation, zero sinks" was false.** A cell dying with no neighbour destroyed its energy: 0.44–0.62% of the total was gone by T 100,000. v1.0 routes it to cells two steps away or to a shared pool, and conservation is now exact.
- **Every v0.9 vessel was an artifact.** The inhibitor's diffusion was numerically unstable and flipped between two values every tick in a one-cell checkerboard. v1.0 sub-steps it.
- **v0.9 never formed muscle.** Its activator had a single stable fixed point, so no pattern could form. v1.0 uses real Gierer–Meinhardt kinetics, and muscle blocks appear (about 6–10% of cells).
- **v0.9's layering came from holes, not the surface.** Its depth counted every interior death-hole as a surface (72% of its fate decisions used a hole-shortened depth), and fates were fixed once, so the embryo was over 90% ectoderm around T 600. v1.0 measures depth from the exterior and re-reads it continuously.

## Conceptual Framework

This project grew from a thought experiment about the simulation hypothesis:

> If the universe is a computation, organisms inside would experience consistent conservation laws, reproducible chemistry, and evolutionary history. Grid symmetries would appear as fundamental physics to internal observers, not design choices.

The simulation makes a small, concrete version of this: starting from an energy conservation law (the "physics") and a few cell rules (the "chemistry"), a layered, embryo-like body grows. Not all of it emerges. The rules do know about germ layers and tissue types: Rule 3 hands them out by depth, and the head–tail axis is given to the cells. Cells never move, so there is no gastrulation, only layering by position. What organises itself is listed under [What is local, and what is not](#what-is-local-and-what-is-not): the Turing pattern and the muscle blocks it carves, the embryo's size, its turnover, and a stem core that keeps renewing itself.

This relationship between **global symmetry → conservation law → local breaking → emergent complexity** is, arguably, the deepest pattern in nature. The Embryo Engine is a toy illustration of it, not a proof. Its conservation law is exact, but it is bookkeeping (every unit one cell gives, another receives), not a consequence of a symmetry. The Turing pattern breaks symmetry on its own; the head–tail axis is broken by hand. And it proves nothing about whether we live in a simulation.

## Running Locally

Any static file server works; there is nothing to build or install.

```sh
python3 -m http.server
# then open http://localhost:8000
```

The page loads three.js from jsDelivr and its fonts from Google Fonts, so it needs a network connection. It also needs a browser with WebGL 2 and module workers; other browsers are offered the classic 2D version.

Tests (37 tests, about 17 s; last run on Node 26): the engine's conservation, determinism, snapshot round-trip, depth, orphan-energy, performance and biology checks, the worker's fast-forward contract, the keyboard and URL contracts, and the specimen log's honesty contract.

```sh
node --test test/
```

`dev/` holds harnesses for the scene (`dev/scene.html`), the HUD (`dev/hud.html`) and the worker (`dev/worker.html`); open them from the local server, for example http://localhost:8000/dev/scene.html.

## Deploying

- **Cloudflare** ([embryo.yamcom.net](https://embryo.yamcom.net)): run `wrangler deploy` from the repository root. `wrangler.jsonc` serves the repository root as Workers static assets on the `embryo.yamcom.net` custom domain, and `.assetsignore` keeps out what is not the app: the README and its screenshot, `docs/`, `dev/`, `test/`, `embryo-engine.jsx` and the config files. Wrangler is not a project dependency: install it globally, or use `npx wrangler deploy`. In a fork, change or remove `routes` first, since the custom domain belongs to this project.
- **GitHub Pages** serves `main` from the repository root as it is (`.nojekyll` is included), at https://yamcomnet.github.io/embryo-engine/.
- **Link previews** use `og-card.jpg` (1200 × 630), which `index.html` references by its embryo.yamcom.net URL.

## Legacy

- [`classic.html`](classic.html) is v0.9 in 2D, the page that was live before v1.0, kept as it was apart from pinned CDN versions (numerical artifacts and all).
- [`embryo-engine.jsx`](embryo-engine.jsx) is the original v0.9 single-file React component, first shared as a claude.ai artifact. It runs anywhere React with hooks runs and needs nothing beyond React.
- `?engine=v09` runs the v0.9 rules (ported in `dev/engine-v09-adapter.js`) in the 3D view, locally or on GitHub Pages.

## License

[MIT](LICENSE) © 2026 Thomas Yambasu
