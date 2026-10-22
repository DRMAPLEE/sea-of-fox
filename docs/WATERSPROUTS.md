# Waterspouts

Tidewater models a waterspout as one coupled air–water–sea system. `WaterspoutField` owns the
centres and intensity used by four consumers: the continuous column, the ocean mesh, GPU water-height
queries, and boat dynamics. A visual effect can therefore never drift away from its gameplay
hazard.

## What the player should see

A real mature waterspout is not a solid pipe of incompressible water reaching the cloud. For the
game's deliberately exaggerated visual language, however, the lifted-water region is represented by
one dense deep-ocean blue-black continuous column. Its real mesh carries a raised screw thread whose full
crest reuses the ocean's tileable lace-foam texture in strongly neutral greys, making rotation and the
sea-to-cloud connection legible from kilometres away.

The staged scene is:

1. a dark, pressure-depressed patch and rotating spiral pattern on the sea;
2. rapidly steepening three-armed waves and foam streaks over a roughly 875 m game-scale influence radius;
3. a bright raised spray ring around the 100 m game-scale core;
4. one thick blue-black water column with a continuous cold foam-white helical ridge;
5. the column continuing into the lowered 650 m storm-cloud base.

Up to two spawned spouts render as independent indexed screw meshes, with the original rising-water
particle plume layered around each mesh as an outer spray and mist shell. The particles never form
the primary silhouette. The default scene starts with no storm and every effect hidden; a cell
appears only through the random weather timer or the chart action. The surrounding flow remains a
Rankine-combined vortex (solid-body rotation inside the core and circulation/r outside) with radial
inflow and updraft, while the visible mesh rotates as a single coherent mass.

## Free surface and rough sea

For steady rotating flow, radial pressure balance gives the free-surface relation

```
dh/dr = v_theta^2 / (g r)
```

The shader integrates a softened Rankine-like profile into a finite pressure bowl, capped at a
4.8 m centre depression for mesh and fixed-point-query stability. An outward-travelling rotating multi-arm wave field,
short chop and a raised breaking ring are added on top. The same displacement enters
`WaterQuery`, so hull buoyancy samples encounter the actual troughs and crests seen on screen rather
than a separate invisible approximation. Per-pixel finite differences preserve steep normals,
foam and aeration when the distant ocean mesh becomes coarse.

## Vessels

Within the enlarged 875 m game-scale hazard, near-surface flow has both tangential and inward
components. A boat therefore spirals
rather than sliding directly toward the centre. The hull load uses quadratic relative-current drag,

```
F_D = 1/2 rho C_D A |u_water - u_boat| (u_water - u_boat)
```

applied below the centre of mass, while vortex wind drag is applied above it. This produces yaw and
heel as well as translation. Existing multi-point buoyancy supplies heave, pitch and roll from the
violent wave field. Forces are acceleration-capped for integrator stability, and ordinary moorings
part once the local current exceeds 5.5 m/s.

## Sources and parameter choices

- Golden, *Waterspout Wind, Temperature and Pressure Structure Deduced from Aircraft Measurements*
  (1977): 5–10 m/s vertical motion and a Rankine-combined vortex accounting for about 75% of the
  measured pressure deficit. <https://doi.org/10.1175/1520-0493(1977)105%3C0725:WWTAPS%3E2.0.CO;2>
- NASA, *Waterspouts at Key West* observations: conical intense spray, a cylindrical spray column
  rising hundreds of feet and a visible surface swirl. <https://ntrs.nasa.gov/citations/20110023766>
- NOAA waterspout photography/report: eye, spiral-banded spray vortex and asymmetric outflow bands.
  <https://repository.library.noaa.gov/view/noaa/17641>
- TU Delft, *On the free-surface vortex-driven motion of buoyant particles*: free-surface vortex
  particle motion and quadratic drag modelling. <https://doi.org/10.1016/j.ijmultiphaseflow.2020.103437>
- Ueno, Murai and Yamamoto, *Visualization of Fine Particle Behavior in Artificial Tornado* (2003):
  equilibrium-radius particle concentration and Rankine-vortex capture.
  <https://doi.org/10.3154/jvs.23.Supplement1_57>
- US National Weather Service waterspout lifecycle: dark spot, spiral pattern, spray ring and mature
  waterspout; a mature spray ring indicates winds above roughly 40 kt.
  <https://www.weather.gov/key/waterspouts>

Runtime controls:

- append `?noWaterspouts` to disable the field, sea response, boat forces and columns;
- call `app.waterspouts.setIntensity(value)` to scale optical density and field strength;
- call `app.waterspoutField.velocityAt(position, target)` for air velocity;
- call `app.waterspoutField.surfaceVelocityAt(position, target)` for the near-surface current.
- open the archipelago chart, set a waypoint and choose **Spawn storm** to add a cell (up to two,
  then replace the oldest cell);
- otherwise the random timer adds a cell every 3–6 minutes when a slot is free;
- each storm lasts 12 minutes: 1 minute forming, 8 minutes at mature strength and 3 minutes fading;
- full cloud coverage drives the supplied rain/thunder loop and lens droplets, local wind is
  spatialised at the nearest cell, and the danger BGM fades in through the perception radius.
