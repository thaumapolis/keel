# Keel — why a ship rights itself

Push a ship over and let go. Watch whether it comes back, and see exactly
why. This is a real buoyancy simulation, not an animation: every frame the
water's upward push is re-integrated from the shape the hull actually has
underwater at that angle, and the ship rolls under the moment that produces.

<!-- Front page image: docs/thumb.png -->

**[▶ Play it live](https://raw.githack.com/thaumapolis/keel/main/index.html)** · [![check](https://github.com/thaumapolis/keel/actions/workflows/check.yml/badge.svg?branch=main)](https://github.com/thaumapolis/keel/actions/workflows/check.yml)

![The ship heeled over: the cyan waterline ring, the buoyancy (blue) and gravity
(gold) markers, the righting-arm readout, and the sea meeting the sky at the horizon.](docs/thumb.png)

## What you're seeing

The bright cyan ring is the **waterplane** — the outline of the water's
surface cut through the hull. It is the shape that does the righting. The blue
dot is the **centre of buoyancy** (where all the water's push acts), the gold
dot is the **centre of gravity** (where the weight acts). When you tip the
ship, the underwater shape changes, so the blue dot slides out toward the low
side while the gold dot stays put. Up on one side, down on the other: that
pair of vertical forces forms a couple that rotates the hull back. The
horizontal gap between them, measured in metres, is the **righting arm (GZ)**.

The chart on the right plots that arm against heel angle for the ship as you
have configured it. Rise, peak, and fall of that curve *is* the ship's
stability story, and you watch the dot on it move as the ship rolls.

## Controls

| Action | Desktop | Touch |
| --- | --- | --- |
| Roll the ship | drag on the sea | drag on the sea |
| Zoom in / out | scroll wheel | pinch |
| Push over & release | button (or press `P`) | button (or tap) |
| Settle it upright | button | button |
| How loaded | `How loaded` slider | `How loaded` slider |
| How high the weight sits | `How high the weight sits` slider | same slider |

The **weight height** is the one that flips the result. It is shown as a
percentage of the *capsizing limit* for the current load. Below 100% the ship
is stable: raise it and the ship goes from stiff (snaps upright fast) to
tender (leans a long way back) to helpless. At or above 100% upright is the
worst position and the ship **lolls** over to one side instead of coming back.

## Try this

1. Note the default: a **stiff** ship, righting arm peaking around **0.54 m**
   near **46°**, unable to float past **66°**. Push it over and release; it
   rocks and settles.
2. Raise **How high the weight sits** to **100%**. The verdict changes and the
   curve flattens to the axis — the critical limit is reached (critical KG ≈
   **1.53 m** above the keel at 55% load).
3. Push the weight past 100% and the ship no longer returns upright: it finds
   a loll angle instead. That is the mechanism the whole view is built to show.

## How it works

- The hull is a lofted surface; `src/hull.js` defines its half-breadth as a
  function of position, and the same function drives both the drawn mesh and
  the physics, so they cannot drift apart.
- `src/sections.js` cuts the heeled hull into transverse columns and
  integrates them (Gauss–Legendre) to find the waterline that floats the
  declared displacement, and the centroid of the submerged volume — the centre
  of buoyancy.
- `src/stability.js` walks heel angles to build the GZ curve and find the
  critical KG; `src/app.js` integrates the roll from the current righting
  moment with damping.
- `src/view3d.js` is a WebGL-free painter's-algorithm rasteriser. It draws
  exactly the state the physics hands it; it does not compute buoyancy itself.

## Limitations, honestly

- **No WebGL.** The 3D view is a CPU software renderer because the browsers
  this project is verified in return null for WebGL. It is a genuine 3D
  projection with a per-pixel depth test, not a 2D fake, but it is shaded per
  face, not per pixel.
- Roll is a single-degree-of-freedom lumped model with a hand-chosen inertia
  and damping, tuned to read as a ship (a few-second roll period). The
  *righting moment* is simulated; the *inertia* is a plausible constant, not a
  derived hydrodynamic one.
- Past about **90°** the waterline solver reports it cannot find a float
  (a bracketing artifact in the solver, not physics — the hull floats fine
  well short of that). Tests avoid that range deliberately.

## Build and run

The shipped artifact is a single self-contained `index.html` (no network, no
sibling files, no browser storage) that runs from `file://` and inside a
sandboxed iframe.

```sh
# open it directly
xdg-open index.html

# or regenerate the artifact from src/
nix develop --command node tools/build.mjs
```

## Test

```sh
nix develop --command ./check.sh
```

That runs one acceptance checklist — build, artifact guarantees (no external
references / no storage / no leftover module syntax), the hydrostatics and
stability model tests, and a Playwright browser test that loads the real
artifact and checks it paints a scene and responds to a push. A missing tool
is a failure, not a skip. The same command is what CI runs.
