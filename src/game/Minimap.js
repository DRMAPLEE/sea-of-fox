import { WORLD, wrapWorldCoordinate, wrappedWorldDelta } from '../world/WorldLayout.js';
import { STAND } from './FishStand.js';
import { CHANDLERY } from './Chandlery.js';
import { ARCHIPELAGO, sampleSatelliteIslands, satelliteEscarpmentRelief, satelliteMultifractalRelief } from '../world/Archipelago.js';

// Minimap, lower right: the island baked once from the terrain data into a 2D canvas (depth-tinted
// sea, reef and seagrass, sand, grass and forest by height, rock, paths, village pads, the pier,
// hill shading and a coastline), shown in a round window that turns with the view (forward is up,
// a small N on the rim). Markers: the player (centre arrow), Joe's fish stand, Marta's chandlery
// and the boat; markers beyond the rim sit on it with an arrow. With the fish finder upgrade, a
// couple of soft rings mark the richest water in view.
//
// Per frame it only writes a few CSS transforms. The bake runs in row chunks over the first frames.
//   const map = new Minimap( hudEl, game );  map.update( dt );  map.highlight( [ 'joe', 'marta' ] )

const N = 640; // baked canvas size (px)
const EXT = WORLD.worldPeriod; // one complete, seamlessly wrapping chart cell
const X0 = - EXT / 2, Z0 = - EXT / 2;
const PPM = N / EXT; // canvas px per metre
const ROWS_PER_FRAME = 48;

const CSS = /* css */`
.gm-map { position: absolute; right: var(--tw-edge); bottom: var(--tw-edge); width: calc(184 * var(--tw-u)); height: calc(184 * var(--tw-u));
	border-radius: 50%; padding: calc(5 * var(--tw-u)); pointer-events: none;
	transition: right var(--tw-slow) var(--tw-ease), opacity var(--tw-med) var(--tw-ease); }
.gm-map.is-full { position: fixed; right: 50%; bottom: 50%; width: min(78vw, 78vh); height: min(78vw, 78vh); transform: translate(50%, 50%);
	border-radius: var(--tw-r-lg); padding: calc(10 * var(--tw-u)); z-index: 60; pointer-events:auto; box-shadow: 0 0 0 100vmax rgba(2, 10, 15, .72), 0 24px 80px rgba(0,0,0,.55); }
.gm-map.is-full .gm-map-view { border-radius: calc(var(--tw-r-lg) - 4px); }
.gm-map.is-full .gm-map-view { cursor:crosshair; }
.tw-root[data-panel='open'] .gm-map { right: calc(var(--tw-panel-w) + 2 * var(--tw-3)); }
.tw-root[data-panel='open'] .gm-map.is-full { right: 50%; }
.gm-map-view { position: relative; width: 100%; height: 100%; border-radius: 50%; overflow: hidden; background: #0b2c48;
	box-shadow: inset 0 0 0 1px rgba(255,255,255,0.08), inset 0 0 18px rgba(0,0,0,0.45); }
.gm-map-view canvas { position: absolute; left: 0; top: 0; width: ${ N }px; height: ${ N }px; transform-origin: 0 0; image-rendering: auto; }
.gm-map-vig { position: absolute; inset: 0; border-radius: 50%; pointer-events: none;
	background: radial-gradient(circle at 50% 50%, transparent 58%, rgba(4, 12, 20, 0.45) 100%); }
.gm-map-marks { position: absolute; inset: 0; }
.gm-mk { position: absolute; left: 0; top: 0; width: 0; height: 0; }
.gm-mk > i { position: absolute; left: 0; top: 0; display: grid; place-items: center; width: calc(20 * var(--tw-u)); height: calc(20 * var(--tw-u));
	margin: calc(-10 * var(--tw-u)) 0 0 calc(-10 * var(--tw-u)); border-radius: 50%; font: 700 calc(10 * var(--tw-u)) var(--tw-font); font-style: normal;
	color: #0b1418; box-shadow: 0 1px 3px rgba(0,0,0,0.55), 0 0 0 1.5px rgba(255,255,255,0.85); }
.gm-mk > i svg { width: 64%; height: 64%; }
.gm-mk.is-joe > i { background: var(--tw-sun); }
.gm-mk.is-marta > i { background: var(--tw-aqua); }
.gm-mk.is-boat > i { background: #f2efe6; }
.gm-mk.is-waypoint > i { background:var(--tw-coral); color:#fff; font-size:calc(12 * var(--tw-u)); box-shadow:0 0 0 2px #fff,0 0 18px rgba(255,122,133,.8); }
.gm-mk.is-storm > i { color:#e9fbff; background:#17384c; font-size:calc(15 * var(--tw-u)); box-shadow:0 0 0 1.5px rgba(223,249,255,.9),0 0 18px rgba(114,220,255,.75); animation:gm-storm-spin 3.5s linear infinite; }
@keyframes gm-storm-spin { to { transform:rotate(360deg); } }
.gm-mk > b { position: absolute; left: 0; top: 0; width: 0; height: 0; border-left: calc(5 * var(--tw-u)) solid transparent; border-right: calc(5 * var(--tw-u)) solid transparent;
	border-bottom: calc(7 * var(--tw-u)) solid rgba(255,255,255,0.9); margin: calc(-19 * var(--tw-u)) 0 0 calc(-5 * var(--tw-u)); transform-origin: calc(5 * var(--tw-u)) calc(19 * var(--tw-u)); display: none; }
.gm-mk.is-edge > b { display: block; }
.gm-mk.is-edge > i { transform: scale(0.82); }
.gm-mk.is-hot > i { animation: gm-map-pulse 1.3s var(--tw-ease-io) infinite; }
@keyframes gm-map-pulse { 0%, 100% { box-shadow: 0 1px 3px rgba(0,0,0,0.55), 0 0 0 1.5px rgba(255,255,255,0.85), 0 0 0 0 rgba(255,255,255,0.6); }
	60% { box-shadow: 0 1px 3px rgba(0,0,0,0.55), 0 0 0 1.5px rgba(255,255,255,0.85), 0 0 0 calc(10 * var(--tw-u)) rgba(255,255,255,0); } }
.gm-map-me { position: absolute; left: 50%; top: 50%; width: 0; height: 0; }
.gm-map.is-full .gm-map-me { left: 0; top: 0; }
.gm-map-me svg { position: absolute; width: calc(18 * var(--tw-u)); height: calc(18 * var(--tw-u)); left: calc(-9 * var(--tw-u)); top: calc(-10 * var(--tw-u));
	filter: drop-shadow(0 1px 2px rgba(0,0,0,0.6)); }
.gm-map-n { position: absolute; left: 0; top: 0; width: calc(14 * var(--tw-u)); height: calc(14 * var(--tw-u)); margin: calc(-7 * var(--tw-u)) 0 0 calc(-7 * var(--tw-u));
	border-radius: 50%; display: grid; place-items: center; font: 700 calc(9 * var(--tw-u)) var(--tw-font); color: #0b1418; background: rgba(255,255,255,0.9);
	box-shadow: 0 1px 2px rgba(0,0,0,0.5); }
.gm-map-fish { position: absolute; left: 0; top: 0; width: 0; height: 0; opacity: 0; transition: opacity 600ms var(--tw-ease); }
.gm-map-fish.is-on { opacity: 0.9; }
.gm-map-fish > i { position: absolute; left: calc(-12 * var(--tw-u)); top: calc(-12 * var(--tw-u)); width: calc(24 * var(--tw-u)); height: calc(24 * var(--tw-u));
	border-radius: 50%; border: 1.5px solid rgba(var(--tw-aqua-rgb), 0.9); animation: gm-map-ring 2.2s var(--tw-ease-io) infinite; }
.gm-map-fish > i + i { animation-delay: -1.1s; }
@keyframes gm-map-ring { 0% { transform: scale(0.45); } 100% { transform: scale(1.15); border-color: rgba(var(--tw-aqua-rgb), 0); } }
.gm-map-label { position: absolute; left: 50%; bottom: calc(-2 * var(--tw-u)); transform: translate(-50%, 100%); padding-top: calc(4 * var(--tw-u));
	font: 500 var(--tw-fs-xs) var(--tw-mono); color: var(--tw-ink-3); white-space: nowrap; text-shadow: 0 1px 2px rgba(0,0,0,0.7); display: none; }
.gm-chart-head { position:absolute; left:calc(18 * var(--tw-u)); top:calc(16 * var(--tw-u)); display:none; z-index:4; pointer-events:none;
	font:600 var(--tw-fs-md) var(--tw-font); letter-spacing:.14em; color:var(--tw-ink); text-transform:uppercase; text-shadow:0 2px 5px #00151d; }
.gm-chart-head small { display:block; margin-top:3px; color:var(--tw-ink-3); font:500 var(--tw-fs-xs) var(--tw-mono); letter-spacing:.04em; text-transform:none; }
.gm-chart-actions { position:absolute; left:50%; bottom:calc(16 * var(--tw-u)); z-index:5; display:none; align-items:center; gap:calc(10 * var(--tw-u)); transform:translateX(-50%);
	padding:calc(7 * var(--tw-u)) calc(9 * var(--tw-u)) calc(7 * var(--tw-u)) calc(13 * var(--tw-u)); border:1px solid rgba(255,255,255,.14); border-radius:999px;
	background:rgba(4,18,29,.82); box-shadow:0 8px 30px rgba(0,0,0,.35); color:var(--tw-ink-2); font:500 var(--tw-fs-sm) var(--tw-mono); white-space:nowrap; cursor:default; }
.gm-chart-actions button { border:0; border-radius:999px; padding:calc(7 * var(--tw-u)) calc(14 * var(--tw-u)); color:#08201d; background:var(--tw-aqua);
	font:700 var(--tw-fs-sm) var(--tw-font); cursor:pointer; }
.gm-chart-actions button[data-action='storm'] { color:#e9fbff; background:#24506a; }
.gm-chart-actions button:disabled { opacity:.38; cursor:default; }
.gm-island-label { position:absolute; left:0; top:0; display:none; transform:translate(-50%,-50%); color:#fff; text-align:center; white-space:nowrap;
	font:600 var(--tw-fs-sm) var(--tw-font); text-shadow:0 1px 4px #00151d,0 0 10px #00151d; pointer-events:none; }
.gm-island-label::before { content:''; display:block; width:5px; height:5px; margin:0 auto 4px; border:1px solid rgba(255,255,255,.9); border-radius:50%; background:var(--tw-sun); }
.gm-island-label small { display:block; color:rgba(255,255,255,.66); font:500 var(--tw-fs-xs) var(--tw-mono); }
.gm-map.is-full .gm-chart-head,.gm-map.is-full .gm-island-label { display:block; }
.gm-map.is-full .gm-chart-actions { display:flex; }
.gm-map.is-full .gm-map-vig { background:linear-gradient(rgba(4,12,20,.08),rgba(4,12,20,.2)); border-radius:inherit; }
/* short windows: the settings rail (right, vertically centred) reaches down to the corner */
@media (max-height: 860px) { .gm-map { right: calc(var(--tw-edge) + 58 * var(--tw-u)); } }
@media (max-width: 640px) { .gm-map { width: calc(128 * var(--tw-u)); height: calc(128 * var(--tw-u)); } }
@media (prefers-reduced-motion: reduce) { .gm-mk.is-hot > i, .gm-map-fish > i, .gm-mk.is-storm > i { animation: none; } }
`;

const ICON = {
	fish: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 12c3-4 7-6 11-6 3 0 5 2 7 4l-2 2 2 2c-2 2-4 4-7 4-4 0-8-2-11-6Zm12-1.2a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4Z"/></svg>',
	anchor: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="12" cy="5" r="2"/><path d="M12 7v13M7 11h10M4 14c1 4 4 6 8 6s7-2 8-6"/></svg>',
	boat: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v9H6l6-9Zm1 2 5 7h-5V5ZM3 14h18l-3 5H6l-3-5Z"/></svg>',
};

const h = ( tag, cls, html ) => {

	const e = document.createElement( tag );
	if ( cls ) e.className = cls;
	if ( html !== undefined ) e.innerHTML = html;
	return e;

};

const mix = ( a, b, t ) => [ a[ 0 ] + ( b[ 0 ] - a[ 0 ] ) * t, a[ 1 ] + ( b[ 1 ] - a[ 1 ] ) * t, a[ 2 ] + ( b[ 2 ] - a[ 2 ] ) * t ];
const sat = ( x ) => Math.min( 1, Math.max( 0, x ) );
const smooth = ( e0, e1, x ) => {

	const t = sat( ( x - e0 ) / ( e1 - e0 ) );
	return t * t * ( 3 - 2 * t );

};

// The full chart is 60 km wide, so evaluating the terrain's erosion stack for every open-ocean
// pixel would waste several milliseconds per row.  Preserve the detailed home-island samples and
// use the same signed island silhouettes for the remote chart relief.
const chartSample = { island: 0, islandD: Infinity, islandQ: Infinity };
function chartHeightAt( terrain, x, z ) {

	if ( x >= terrain.origin && z >= terrain.origin && x < - terrain.origin && z < - terrain.origin ) return terrain.heightAt( x, z );
	sampleSatelliteIslands( x, z, chartSample );
	const d = chartSample.islandD;
	const island = ARCHIPELAGO[ chartSample.island ];
	if ( d >= 0 ) return - Math.min( 85, d * 0.055 + 1 );
	const e = - d, q = Math.max( 0, 1 - chartSample.islandQ );
	let h;
	if ( e < 38 ) h = e * 0.068;
	else if ( e < 70 ) h = 2.584 + ( e - 38 ) * 0.03;
	else if ( e < 230 ) h = 3.544 + ( e - 70 ) * 0.075;
	else h = 15.544 + ( e - 230 ) * 0.04;
	const faroeShoreCore = island.kind === 'faroe' ? q * smooth( 0, 96, e ) : q;
	const reliefCore = island.kind === 'atoll' ? Math.min( 1, e / 70 ) : faroeShoreCore;
	const fantasyRidges = satelliteMultifractalRelief( x, z, reliefCore, chartSample.island );
	const escarpments = satelliteEscarpmentRelief( x, z, reliefCore, chartSample.island );
	if ( island.kind === 'atoll' ) h = Math.min( 4.2, h * 0.72 ) + fantasyRidges * 1.4 + escarpments;
	else if ( island.climate === 'tropical' ) {

		const p1 = Math.exp( - ( ( ( x - island.x + island.rx * 0.14 ) / ( island.rx * 0.34 ) ) ** 2 + ( ( z - island.z + island.rz * 0.08 ) / ( island.rz * 0.38 ) ) ** 2 ) );
		const p2 = Math.exp( - ( ( ( x - island.x - island.rx * ( 0.26 + island.variant % 2 * 0.05 ) ) / ( island.rx * 0.27 ) ) ** 2 + ( ( z - island.z - island.rz * 0.24 ) / ( island.rz * 0.29 ) ) ** 2 ) );
		const p3 = Math.exp( - ( ( ( x - island.x + island.rx * 0.32 ) / ( island.rx * 0.23 ) ) ** 2 + ( ( z - island.z - island.rz * 0.27 ) / ( island.rz * 0.26 ) ) ** 2 ) );
		h += q * 18 + p1 * 58 + p2 * 38 + p3 * 27 + fantasyRidges + escarpments;

	} else if ( island.climate === 'temperate' ) {

		const benches = ( smooth( 0.1, 0.14, faroeShoreCore ) + smooth( 0.34, 0.39, faroeShoreCore ) * 0.8 + smooth( 0.62, 0.68, faroeShoreCore ) * 0.55 ) * 5;
		h += smooth( 0.015, 0.14, faroeShoreCore ) * 17 + Math.pow( faroeShoreCore, 1.22 ) * 27 + benches + fantasyRidges * 1.3 + escarpments;

	} else h += smooth( 0.02, 0.16, q ) * 12 + Math.pow( q, 1.35 ) * 95 + Math.max( 0, fantasyRidges ) * 1.65 + escarpments;
	return h;

}

// map palette (sRGB 0..255)
const C = {
	deep: [ 12, 44, 78 ], mid: [ 22, 104, 150 ], shallow: [ 62, 186, 190 ], foam: [ 186, 232, 226 ],
	grassSea: [ 34, 110, 108 ], rubble: [ 30, 84, 104 ],
	sand: [ 232, 216, 172 ], wet: [ 206, 190, 150 ], grass: [ 128, 160, 88 ], scrub: [ 88, 128, 64 ], forest: [ 52, 92, 50 ],
	rock: [ 132, 134, 126 ], snow: [ 224, 236, 239 ], ice: [ 174, 215, 226 ], path: [ 205, 182, 136 ], scarp: [ 176, 146, 104 ], pad: [ 196, 184, 162 ],
	temperate: [ 92, 119, 72 ], blackSand: [ 48, 49, 48 ],
};

export class Minimap {

	constructor( parent, game ) {

		this.game = game;
		const style = h( 'style' );
		style.textContent = CSS;
		document.head.append( style );

		this.el = h( 'div', 'gm-map tw-glass', `<div class="gm-map-view"><canvas width="${ N }" height="${ N }"></canvas><div class="gm-map-vig"></div>
			<div class="gm-map-marks"></div><div class="gm-chart-head">Archipelago chart<small>M close · north is up · opposite edges connect</small></div>
			<div class="gm-map-me"><svg viewBox="0 0 24 24"><path d="M12 2 20 21 12 16.5 4 21Z" fill="#fff" stroke="#0b1418" stroke-width="1.4" stroke-linejoin="round"/></svg></div>
			<div class="gm-chart-actions"><span>Click the chart to set a waypoint</span><button type="button" data-action="travel" disabled>Fast travel</button><button type="button" data-action="storm" disabled>Spawn storm</button></div></div>` );
		this.el.setAttribute( 'aria-hidden', 'true' );
		this.view = this.el.querySelector( '.gm-map-view' );
		this.canvas = this.el.querySelector( 'canvas' );
		this.marks = this.el.querySelector( '.gm-map-marks' );
		this.me = this.el.querySelector( '.gm-map-me' );
		this.navText = this.el.querySelector( '.gm-chart-actions span' );
		this.travelButton = this.el.querySelector( '[data-action="travel"]' );
		this.stormButton = this.el.querySelector( '[data-action="storm"]' );
		parent.append( this.el );
		this.isFull = false;

		const mk = ( kind, icon ) => {

			const e = h( 'div', 'gm-mk is-' + kind, `<b></b><i>${ icon }</i>` );
			this.marks.append( e );
			return { el: e, arrow: e.firstChild };

		};

		this.markers = [
			{ id: 'waypoint', ...mk( 'waypoint', '◆' ), pos: () => this.waypoint },
			{ id: 'joe', ...mk( 'joe', ICON.fish ), pos: () => ( { x: STAND.x, z: STAND.z } ) },
			{ id: 'marta', ...mk( 'marta', ICON.anchor ), pos: () => ( { x: CHANDLERY.x, z: CHANDLERY.z } ) },
			{ id: 'boat', ...mk( 'boat', ICON.boat ), pos: () => {

				const b = game.app.boatCtl;
				return b ? { x: b.position.x, z: b.position.z } : null;

			}, hideWhen: () => {

				const p = game.app.player;
				return ( p.mode === 'boat' || p.mode === 'deck' ) && p.boat === game.app.boatCtl;

			} },
			{ id: 'tall-ship', ...mk( 'boat', ICON.boat ), pos: () => {

				const b = game.app.tallShipCtl;
				return b ? { x: b.position.x, z: b.position.z } : null;

			}, hideWhen: () => {

				const p = game.app.player;
				return ( p.mode === 'boat' || p.mode === 'deck' ) && p.boat === game.app.tallShipCtl;

			} },
			...Array.from( { length: 2 }, ( _, i ) => ( {
				id: `storm-${ i }`, ...mk( 'storm', '↻' ), pos: () => {

					const field = game.app.waterspoutField;
					const s = field && i < field.count ? field.spouts[ i ] : null;
					return s ? { x: s.x, z: s.y } : null;

				},
			} ) ),
		];
		this.waypoint = null;
		this.north = h( 'div', 'gm-map-n', 'N' );
		this.marks.append( this.north );
		this.fish = [ h( 'div', 'gm-map-fish', '<i></i><i></i>' ), h( 'div', 'gm-map-fish', '<i></i><i></i>' ) ];
		this.fish.forEach( ( f ) => this.marks.prepend( f ) );
		this.islandLabels = ARCHIPELAGO.map( ( island ) => {

			const label = h( 'div', 'gm-island-label', `${ island.name }<small>${ island.kind.replace( '-', ' ' ) }</small>` );
			this.marks.append( label );
			return { island, label };

		} );
		this._fishPts = [];
		this._fishT = 0;

		this.radiusM = 110; // world radius shown (m), eased between on foot and at sea
		this._hot = new Set();
		this._size = 0;
		this._bake = { row: 0, ctx: this.canvas.getContext( '2d' ), img: null, h: null, done: false };
		this._bake.img = this._bake.ctx.createImageData( N, N );
		this._bake.h = new Float32Array( N * N );
		// the view's size, kept by a ResizeObserver (reading clientWidth per frame forces a style +
		// layout pass right after last frame's transform writes)
		this._viewSize = - 1;
		if ( typeof ResizeObserver !== 'undefined' ) {

			this._ro = new ResizeObserver( () => {

				this._viewSize = this.view.clientWidth;

			} );
			this._ro.observe( this.view );

		}
		this.el.addEventListener( 'pointerdown', ( event ) => event.stopPropagation() );
		this.view.addEventListener( 'click', ( event ) => {

			event.stopPropagation();
			if ( ! this.isFull || event.target.closest( '.gm-chart-actions' ) ) return;
			const rect = this.view.getBoundingClientRect();
			this.setWaypoint( X0 + ( event.clientX - rect.left ) / rect.width * EXT, Z0 + ( event.clientY - rect.top ) / rect.height * EXT );

		} );
		this.view.addEventListener( 'dblclick', ( event ) => {

			event.preventDefault(); event.stopPropagation();
			if ( this.isFull ) this.fastTravel();

		} );
		this.travelButton.addEventListener( 'click', ( event ) => { event.stopPropagation(); this.fastTravel(); } );
		this.stormButton.addEventListener( 'click', ( event ) => { event.stopPropagation(); this.spawnStorm(); } );

	}

	setWaypoint( x, z ) {

		this.waypoint = { x: wrapWorldCoordinate( x ), z: wrapWorldCoordinate( z ) };
		this.travelButton.disabled = false;
		this.stormButton.disabled = ! this.game.app.waterspoutField;
		this.game.toast( '航点已设置 · 打开海图即可快速旅行', 1800 );
		return this.waypoint;

	}

	spawnStorm() {

		if ( ! this.waypoint ) return false;
		const slot = this.game.app.spawnStormAt( this.waypoint.x, this.waypoint.z );
		if ( slot < 0 ) return false;
		this.game.toast( `Storm cell ${ slot + 1 } spawned at waypoint`, 2200 );
		return true;

	}

	fastTravel() {

		if ( ! this.waypoint ) return false;
		const result = this.game.app.fastTravelTo( this.waypoint.x, this.waypoint.z );
		if ( ! result ) return false;
		this.toggleFull( false );
		this.game.toast( result.mode === 'boat' ? '已快速移动到可航行水域' : '已快速移动到航点', 2200 );
		return true;

	}

	toggleFull( force = ! this.isFull ) {

		this.isFull = !! force;
		this.el.classList.toggle( 'is-full', this.isFull );
		this.el.setAttribute( 'aria-hidden', this.isFull ? 'false' : 'true' );
		this._viewSize = - 1;
		if ( this.isFull && typeof document !== 'undefined' ) document.exitPointerLock?.();
		return this.isFull;

	}

	// style writes only when the value changes
	_setStyle( el, prop, value ) {

		const k = '__gm_' + prop;
		if ( el[ k ] === value ) return;
		el[ k ] = value;
		el.style[ prop ] = value;

	}

	_toggle( el, cls, on ) {

		const k = '__gm_c_' + cls;
		if ( el[ k ] === on ) return;
		el[ k ] = on;
		el.classList.toggle( cls, on );

	}

	highlight( ids = [] ) {

		this._hot = new Set( ids );
		for ( const m of this.markers ) this._toggle( m.el, 'is-hot', this._hot.has( m.id ) );

	}

	// ---- bake (chunked)
	_bakeStep() {

		const B = this._bake;
		if ( B.done ) return;
		const T = this.game.app.terrainData;
		const res = T.res, tex = T.texel, org = T.origin;
		const idx = ( x, z ) => {

			const i = Math.floor( ( x - org ) / tex ), j = Math.floor( ( z - org ) / tex );
			return i < 0 || j < 0 || i >= res || j >= res ? - 1 : j * res + i;

		};

		const d = B.img.data;
		const end = Math.min( N, B.row + ROWS_PER_FRAME );
		for ( let py = B.row; py < end; py ++ ) for ( let px = 0; px < N; px ++ ) {

			const x = X0 + ( px + 0.5 ) / PPM, z = Z0 + ( py + 0.5 ) / PPM;
			const hgt = chartHeightAt( T, x, z );
			B.h[ py * N + px ] = hgt;
			const k = idx( x, z );
			let c;
			if ( hgt < 0 ) {

				const dep = - hgt;
				c = dep < 6 ? mix( C.shallow, C.mid, smooth( 0.3, 6, dep ) ) : mix( C.mid, C.deep, smooth( 6, 40, dep ) );
				if ( k >= 0 ) {

					c = mix( c, C.grassSea, ( T.seagrass[ k ] / 255 ) * 0.55 );
					c = mix( c, C.rubble, ( T.rubble[ k ] / 255 ) * 0.6 );

				}

				c = mix( c, C.foam, smooth( 0.5, 0.0, dep ) * 0.45 );

			} else {

				const rock = k >= 0 ? T.rock[ k ] : 0, sand = k >= 0 ? T.sand[ k ] / 255 : 0;
				let polar = false, temperate = false;
				if ( k < 0 ) {

					sampleSatelliteIslands( x, z, chartSample );
					const island = ARCHIPELAGO[ chartSample.island ];
					polar = island?.climate === 'polar' && chartSample.islandD < 0;
					temperate = island?.climate === 'temperate' && chartSample.islandD < 0;

				}
				c = mix( C.grass, C.scrub, smooth( 4, 16, hgt ) );
				c = mix( c, C.forest, smooth( 12, 40, hgt ) );
				c = mix( c, C.sand, Math.max( sand, smooth( 1.6, 0.4, hgt ) ) );
				c = mix( c, C.wet, smooth( 0.5, 0.0, hgt ) * 0.6 );
				c = mix( c, C.rock, smooth( 0.35, 0.7, rock ) );
				if ( temperate ) c = mix( C.temperate, C.rock, smooth( 26, 58, hgt ) * 0.75 );
				if ( polar ) {

					if ( hgt < 4 ) c = C.blackSand;
					else c = mix( C.ice, C.snow, smooth( 4, 55, hgt ) );

				}
				if ( k >= 0 ) {

					c = mix( c, C.path, ( T.path[ k ] / 255 ) * 0.85 );
					c = mix( c, C.scarp, ( T.scarp[ k ] / 255 ) * 0.5 );

				}

				// hill shading, light from the north-west
				const e = 2.5;
				const gx = ( chartHeightAt( T, x + e, z ) - chartHeightAt( T, x - e, z ) ) / ( 2 * e );
				const gz = ( chartHeightAt( T, x, z + e ) - chartHeightAt( T, x, z - e ) ) / ( 2 * e );
				const nl = ( - gx * - 0.6 + - gz * - 0.6 + 1 * 0.53 ) / Math.sqrt( gx * gx + gz * gz + 1 );
				const s = 0.7 + 0.45 * sat( nl / 0.53 );
				c = [ c[ 0 ] * s, c[ 1 ] * s, c[ 2 ] * s ];

			}

			const o = ( py * N + px ) * 4;
			d[ o ] = c[ 0 ]; d[ o + 1 ] = c[ 1 ]; d[ o + 2 ] = c[ 2 ]; d[ o + 3 ] = 255;

		}

		B.row = end;
		if ( B.row < N ) return;

		// coastline: a thin pale line where the height crosses sea level
		for ( let py = 1; py < N - 1; py ++ ) for ( let px = 1; px < N - 1; px ++ ) {

			const i = py * N + px, a = B.h[ i ] >= 0;
			if ( a && ( B.h[ i - 1 ] < 0 || B.h[ i + 1 ] < 0 || B.h[ i - N ] < 0 || B.h[ i + N ] < 0 ) ) {

				const o = i * 4;
				d[ o ] = d[ o ] * 0.3 + 245 * 0.7; d[ o + 1 ] = d[ o + 1 ] * 0.3 + 241 * 0.7; d[ o + 2 ] = d[ o + 2 ] * 0.3 + 228 * 0.7;

			}

		}

		const ctx = B.ctx;
		ctx.putImageData( B.img, 0, 0 );
		const P = ( x, z ) => [ ( x - X0 ) * PPM, ( z - Z0 ) * PPM ];

		// village pads (house footprints)
		ctx.fillStyle = `rgb(${ C.pad.join( ',' ) })`;
		for ( const p of T.pads || [] ) {

			const [ cx, cy ] = P( p.x, p.z );
			const r = Math.max( 1.5, p.radius * 0.8 * PPM );
			ctx.fillRect( cx - r, cy - r, 2 * r, 2 * r );

		}

		// the pier and its head
		const W = WORLD.pier;
		ctx.fillStyle = '#d9c7a0';
		ctx.strokeStyle = 'rgba(40, 30, 20, 0.55)';
		ctx.lineWidth = 0.6;
		const [ px0, pz0 ] = P( W.x - Math.max( W.width, 3 ) / 2, W.zStart );
		const [ px1, pz1 ] = P( W.x + Math.max( W.width, 3 ) / 2, W.zEnd );
		ctx.fillRect( px0, pz0, px1 - px0, pz1 - pz0 );
		ctx.strokeRect( px0, pz0, px1 - px0, pz1 - pz0 );
		const [ hx0, hz0 ] = P( W.x - W.headWidth / 2, W.zEnd - W.headDepth );
		const [ hx1, hz1 ] = P( W.x + W.headWidth / 2, W.zEnd );
		ctx.fillRect( hx0, hz0, hx1 - hx0, hz1 - hz0 );
		ctx.strokeRect( hx0, hz0, hx1 - hx0, hz1 - hz0 );
		B.done = true;
		B.img = null;

	}

	// ---- per frame
	update( dt ) {

		this._bakeStep();
		const app = this.game.app, cam = app.camera, p = app.player;
		if ( this._viewSize < 0 || ! this._ro ) this._viewSize = this.view.clientWidth;
		const size = this._viewSize;
		if ( ! size ) return;
		const R = size / 2;

		// forward (xz) of the view
		const e = cam.matrixWorld.elements;
		let fx = - e[ 8 ], fz = - e[ 10 ];
		const fl = Math.hypot( fx, fz );
		if ( fl < 1e-4 ) {

			fx = 0; fz = - 1;

		} else {

			fx /= fl; fz /= fl;

		}

		const rx = - fz, rz = fx; // right
		const x = cam.position.x, z = cam.position.z;
		if ( this.waypoint ) {

			const dx = wrappedWorldDelta( x, this.waypoint.x ), dz = wrappedWorldDelta( z, this.waypoint.z );
			const distance = Math.hypot( dx, dz );
			const bearing = ( Math.atan2( dx, - dz ) * 180 / Math.PI + 360 ) % 360;
			this.navText.textContent = `Waypoint · ${ distance < 1000 ? `${ Math.round( distance ) } m` : `${ ( distance / 1000 ).toFixed( 1 ) } km` } · ${ Math.round( bearing ) }°`;

		} else this.navText.textContent = '点击海图设置航点';
		if ( this.isFull ) {

			const chartScale = size / N;
			this._setStyle( this.canvas, 'transform', `scale(${ chartScale })` );
			const chartPlace = ( el, px, pz ) => {

				px = wrapWorldCoordinate( px ); pz = wrapWorldCoordinate( pz );
				const sx = ( px - X0 ) / EXT * size, sy = ( pz - Z0 ) / EXT * size;
				this._setStyle( el, 'transform', `translate(${ sx }px, ${ sy }px)` );

			};
			for ( const m of this.markers ) {

				const q = m.pos();
				const hide = ! q;
				this._setStyle( m.el, 'display', hide ? 'none' : '' );
				if ( q && ! hide ) chartPlace( m.el, q.x, q.z );
				this._toggle( m.el, 'is-edge', false );

			}
			chartPlace( this.me, x, z );
			this._setStyle( this.me.querySelector( 'svg' ), 'transform', `rotate(${ Math.atan2( fx, - fz ) }rad)` );
			this._setStyle( this.north, 'transform', `translate(${ size / 2 }px, ${ 14 }px)` );
			for ( const { island, label } of this.islandLabels ) chartPlace( label, island.x, island.z );
			for ( const fish of this.fish ) this._toggle( fish, 'is-on', false );
			return;

		}
		this._setStyle( this.me, 'transform', '' );
		this._setStyle( this.me.querySelector( 'svg' ), 'transform', '' );

		// zoom: close on foot, wider at sea
		const want = p.mode === 'boat' || p.mode === 'deck' || p.mode === 'swim' ? 240 : 110;
		this.radiusM += ( want - this.radiusM ) * ( 1 - Math.exp( - dt * 1.5 ) );
		const kpm = R / this.radiusM; // css px per metre

		// map: player at the centre, forward up
		const rot = - Math.PI / 2 - Math.atan2( fz, fx );
		const s = kpm / PPM;
		this._setStyle( this.canvas, 'transform', `translate(${ R }px, ${ R }px) rotate(${ rot }rad) scale(${ s }) translate(${ - ( x - X0 ) * PPM }px, ${ - ( z - Z0 ) * PPM }px)` );

		const place = ( el, dx, dz, edgeInset, arrow ) => {

			let sx = ( dx * rx + dz * rz ) * kpm, sy = - ( dx * fx + dz * fz ) * kpm;
			const r = Math.hypot( sx, sy ), max = R - edgeInset;
			const edge = r > max;
			if ( edge ) {

				sx *= max / r; sy *= max / r;

			}

			this._setStyle( el, 'transform', `translate(${ R + sx }px, ${ R + sy }px)` );
			if ( arrow && edge ) this._setStyle( arrow, 'transform', `rotate(${ Math.atan2( sx, - sy ) }rad)` );
			return edge;

		};

		for ( const m of this.markers ) {

			const q = m.pos();
			const hide = ! q || ( m.hideWhen && m.hideWhen() );
			this._setStyle( m.el, 'display', hide ? 'none' : '' );
			if ( hide ) continue;
			const edge = place( m.el, wrappedWorldDelta( x, q.x ), wrappedWorldDelta( z, q.z ), 12, m.arrow );
			this._toggle( m.el, 'is-edge', edge );

		}

		// the N on the rim
		place( this.north, 0, - 1e6, 9 );

		// fish finder: the richest water nearby, refreshed now and then
		const finder = this.game.state.stats.finder;
		this._fishT -= dt;
		if ( finder && this._fishT <= 0 ) {

			this._fishT = 1.5;
			this._fishPts = this._richest( x, z, this.radiusM * 0.85 );

		}

		for ( let i = 0; i < this.fish.length; i ++ ) {

			const q = finder ? this._fishPts[ i ] : null;
			this._toggle( this.fish[ i ], 'is-on', !! q );
			if ( q ) place( this.fish[ i ], q.x - x, q.z - z, 14 );

		}

	}

	// the two richest points on a coarse polar grid around (x, z), at least 25 m apart
	_richest( x, z, r ) {

		const g = this.game, T = g.app.terrainData;
		const pts = [];
		for ( let ring = 1; ring <= 3; ring ++ ) for ( let a = 0; a < 12; a ++ ) {

			const ang = ( a / 12 ) * Math.PI * 2 + ring * 0.4, d = r * ring / 3;
			const px = x + Math.cos( ang ) * d, pz = z + Math.sin( ang ) * d;
			const depth = - T.heightAt( px, pz );
			if ( depth < 1 ) continue;
			const hab = g.habitatAtPoint( px, pz, depth );
			let rich = 0;
			for ( const k in hab ) rich += hab[ k ];
			if ( rich > 0.7 ) pts.push( { x: px, z: pz, rich } );

		}

		pts.sort( ( a, b ) => b.rich - a.rich );
		const out = [];
		for ( const q of pts ) if ( out.every( ( o ) => Math.hypot( o.x - q.x, o.z - q.z ) > 25 ) ) {

			out.push( q );
			if ( out.length === 2 ) break;

		}

		return out;

	}

}
