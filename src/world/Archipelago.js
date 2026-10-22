// Named landmasses used by terrain generation and the nautical chart. The main island keeps its
// hand-authored coastline; the satellites deliberately use different silhouettes.
export const ARCHIPELAGO = [
	{ id: 'tidewater', name: 'Tidewater Island', x: 0, z: - 390, kind: 'high-island', climate: 'tropical', variant: 0, rx: 565, rz: 400 },
	// Polar belt: seven glaciated islands with black frozen strands and independently changing weather.
	{ id: 'white-maw', name: 'White Maw', x: 16700, z: - 16200, kind: 'glacial', climate: 'polar', variant: 0, rx: 1050, rz: 900 },
	{ id: 'rime-crown', name: 'Rime Crown', x: 17200, z: - 24700, kind: 'glacial', climate: 'polar', variant: 1, rx: 1000, rz: 850 },
	{ id: 'polar-crown', name: 'Polar Crown', x: - 29200, z: - 10800, kind: 'glacial', climate: 'polar', variant: 2, rx: 1100, rz: 900 },
	{ id: 'blue-vault', name: 'Blue Vault', x: - 2600, z: - 21100, kind: 'glacial', climate: 'polar', variant: 3, rx: 980, rz: 1100 },
	{ id: 'obsidian-ice', name: 'Obsidian Ice', x: - 25000, z: - 27800, kind: 'glacial', climate: 'polar', variant: 4, rx: 1050, rz: 820 },
	{ id: 'frost-gate', name: 'Frost Gate', x: 8300, z: - 10700, kind: 'glacial', climate: 'polar', variant: 5, rx: 950, rz: 1050 },
	{ id: 'black-glacier', name: 'Black Glacier', x: 7300, z: - 21000, kind: 'glacial', climate: 'polar', variant: 6, rx: 1100, rz: 850 },
	// Maritime-temperate transition belt between the tropical and polar regions: Faroe-inspired
	// turf-covered basalt plateaus dissected by glacial U-valleys and fjords.
	{ id: 'faroe-steps', name: 'Faroe Steps', x: - 24400, z: 4200, kind: 'faroe', climate: 'temperate', variant: 0, rx: 1050, rz: 780 },
	{ id: 'grey-fjords', name: 'Grey Fjords', x: 18900, z: - 3100, kind: 'faroe', climate: 'temperate', variant: 1, rx: 920, rz: 1080 },
	{ id: 'storm-stair', name: 'Storm Stair', x: - 11000, z: - 2200, kind: 'faroe', climate: 'temperate', variant: 2, rx: 1080, rz: 800 },
	{ id: 'gullsound', name: 'Gullsound', x: - 10100, z: 9100, kind: 'faroe', climate: 'temperate', variant: 3, rx: 980, rz: 900 },
	{ id: 'basalt-reach', name: 'Basalt Reach', x: 21400, z: 6200, kind: 'faroe', climate: 'temperate', variant: 4, rx: 1100, rz: 760 },
	// Tropical belt: reef rings, coalesced volcanic massifs, flank-collapse bays and paired cays.
	{ id: 'moonhook', name: 'Moonhook Atoll', x: 15500, z: 22600, kind: 'atoll', climate: 'tropical', variant: 0, rx: 950, rz: 720 },
	{ id: 'red-fang', name: 'Red Fang Island', x: 2100, z: 24900, kind: 'volcanic', climate: 'tropical', variant: 1, rx: 850, rz: 1050 },
	{ id: 'twin-cays', name: 'Twin Cays', x: 24600, z: 22800, kind: 'twins', climate: 'tropical', variant: 2, rx: 1000, rz: 760 },
	{ id: 'whisper', name: 'Whisper Isle', x: - 300, z: 16400, kind: 'crescent', climate: 'tropical', variant: 3, rx: 1050, rz: 720 },
	{ id: 'emerald-scar', name: 'Emerald Scar', x: - 7200, z: 25400, kind: 'volcanic', climate: 'tropical', variant: 4, rx: 900, rz: 1100 },
	{ id: 'sunspire', name: 'Sunspire', x: 15600, z: 13500, kind: 'volcanic', climate: 'tropical', variant: 5, rx: 1100, rz: 820 },
	{ id: 'coral-labyrinth', name: 'Coral Labyrinth', x: - 17200, z: 18700, kind: 'atoll', climate: 'tropical', variant: 6, rx: 1100, rz: 780 },
	{ id: 'jade-horns', name: 'Jade Horns', x: 9700, z: 28800, kind: 'twins', climate: 'tropical', variant: 7, rx: 1050, rz: 800 },
	{ id: 'caldera-bay', name: 'Caldera Bay', x: 29100, z: 11800, kind: 'crescent', climate: 'tropical', variant: 8, rx: 1080, rz: 820 },
	{ id: 'rainmaker', name: 'Rainmaker', x: 9000, z: 4700, kind: 'volcanic', climate: 'tropical', variant: 9, rx: 920, rz: 1120 },
	{ id: 'southern-reef', name: 'Southern Reef', x: 600, z: 7700, kind: 'atoll', climate: 'tropical', variant: 10, rx: 1120, rz: 760 },
];

export const CLIMATE_COUNTS = ARCHIPELAGO.reduce( ( counts, island ) => {

	counts[ island.climate ] = ( counts[ island.climate ] || 0 ) + 1;
	return counts;

}, {} );

function ellipseMask( x, z, cx, cz, rx, rz, angle ) {

	const dx = x - cx, dz = z - cz, c = Math.cos( angle ), s = Math.sin( angle );
	const u = dx * c + dz * s, v = - dx * s + dz * c;
	return 1 - Math.min( 1, Math.max( 0, ( Math.hypot( u / rx, v / rz ) - 0.72 ) / 0.34 ) );

}

function smoothRange( edge0, edge1, value ) {

	const t = Math.min( 1, Math.max( 0, ( value - edge0 ) / ( edge1 - edge0 ) ) );
	return t * t * ( 3 - 2 * t );

}

// Seeded lattice value noise.  This is deliberately mirrored in TerrainGPU so the rendered
// surface, collision queries and vegetation all see the same geology.  The quintic fade is the
// interpolation kernel used by modern gradient/value-noise implementations.
function latticeHash( ix, iz, seed ) {

	let h = Math.imul( ix, 0x8da6b343 ) ^ Math.imul( iz, 0xd8163841 ) ^ Math.imul( seed, 0xcb1ab31f );
	h ^= h >>> 13;
	h = Math.imul( h, 0x85ebca6b );
	h ^= h >>> 16;
	return ( h >>> 0 ) / 4294967295 * 2 - 1;

}

function valueNoise( x, z, seed ) {

	const ix = Math.floor( x ), iz = Math.floor( z );
	const fx = x - ix, fz = z - iz;
	const ux = fx * fx * fx * ( fx * ( fx * 6 - 15 ) + 10 );
	const uz = fz * fz * fz * ( fz * ( fz * 6 - 15 ) + 10 );
	const a = latticeHash( ix, iz, seed ), b = latticeHash( ix + 1, iz, seed );
	const c = latticeHash( ix, iz + 1, seed ), d = latticeHash( ix + 1, iz + 1, seed );
	return ( a + ( b - a ) * ux ) + ( ( c + ( d - c ) * ux ) - ( a + ( b - a ) * ux ) ) * uz;

}

// Musgrave-style ridged multifractal over a domain-warped coordinate. Successive octaves are
// weighted by the previous ridge signal, concentrating fine detail on mountain crests instead of
// covering the whole island with uniform noise.
function satelliteGeology( x, z, kind ) {

	const seed = kind * 101 + 17;
	const wx = x + valueNoise( x / 430, z / 430, seed + 11 ) * 135;
	const wz = z + valueNoise( x / 430 + 19.7, z / 430 - 31.1, seed + 29 ) * 135;
	let sum = 0, amp = 1, frequency = 1, weight = 1, norm = 0;
	for ( let octave = 0; octave < 4; octave ++ ) {

		let signal = 1 - Math.abs( valueNoise( wx / 190 * frequency, wz / 190 * frequency, seed + octave * 47 ) );
		signal *= signal;
		signal *= weight;
		sum += signal * amp;
		norm += amp;
		weight = Math.min( 1, Math.max( 0, signal * 2.05 ) );
		frequency *= 2.03;
		amp *= 0.52;

	}
	return {
		ridge: sum / norm,
		macro: valueNoise( wx / 330, wz / 330, seed + 71 ),
		fine: valueNoise( wx / 72, wz / 72, seed + 89 ),
	};

}

export function satelliteMultifractalRelief( x, z, core, kind ) {

	if ( kind <= 0 || core <= 0 ) return 0;
	const g = satelliteGeology( x, z, kind );
	const mountain = Math.pow( Math.max( 0, ( g.ridge - 0.22 ) / 0.78 ), 1.22 );
	return core * ( mountain * 17 + g.macro * 3.5 + g.fine * 0.9 );

}

// Broad ice cap plus two valley glaciers. `q` is the irregular coast-normalised radius returned by
// islandDistance/sampleSatelliteIslands; the inland gate preserves a continuous black frozen strand.
export function polarGlacierMask( x, z, q, islandIndex = 3 ) {

	const island = ARCHIPELAGO[ islandIndex ];
	if ( ! island || island.climate !== 'polar' ) return 0;
	const angle = ( island.variant - 3 ) * 0.11;
	const dx = x - island.x, dz = z - island.z, c = Math.cos( angle ), s = Math.sin( angle );
	const lx = dx * c + dz * s, lz = - dx * s + dz * c;
	const sx = island.rx / 1000, sz = island.rz / 850;
	const cap = ellipseMask( lx, lz, 0, - 35 * sz, 560 * sx, 455 * sz, 0.05 ) * 0.9;
	const eastTongue = ellipseMask( lx, lz, 245 * sx, 135 * sz, 570 * sx, 175 * sz, 0.42 );
	const westTongue = ellipseMask( lx, lz, - 285 * sx, - 85 * sz, 520 * sx, 160 * sz, - 0.38 );
	const crown = Math.max( 0, 1 - q );
	return Math.min( 1, Math.max( cap, eastTongue, westTongue ) * smoothRange( 0.045, 0.18, crown ) );

}

function segmentDistance( px, pz, ax, az, bx, bz ) {

	const dx = bx - ax, dz = bz - az;
	const t = Math.min( 1, Math.max( 0, ( ( px - ax ) * dx + ( pz - az ) * dz ) / ( dx * dx + dz * dz ) ) );
	return Math.hypot( px - ax - dx * t, pz - az - dz * t );

}

// Glacial inlets cut through the basalt plateau. The two long opposing troughs and shorter hanging
// valley create U-shaped fjords; a weak mouth value is later used as a shallow rock sill.
export function faroeFjordMask( island, x, z ) {

	if ( ! island || island.kind !== 'faroe' ) return 0;
	const a = ( island.variant - 2 ) * 0.12, c = Math.cos( a ), s = Math.sin( a );
	const dx = x - island.x, dz = z - island.z;
	const lx = dx * c + dz * s, lz = - dx * s + dz * c;
	const r = Math.min( island.rx, island.rz );
	const west = 1 - smoothRange( r * 0.075, r * 0.145, segmentDistance( lx, lz, - island.rx * 1.16, - island.rz * 0.24, - island.rx * 0.08, island.rz * 0.02 ) );
	const east = 1 - smoothRange( r * 0.065, r * 0.13, segmentDistance( lx, lz, island.rx * 1.15, island.rz * 0.3, island.rx * 0.16, island.rz * 0.1 ) );
	const hanging = 1 - smoothRange( r * 0.045, r * 0.09, segmentDistance( lx, lz, - island.rx * 0.18, island.rz * 1.08, - island.rx * 0.08, island.rz * 0.38 ) );
	return Math.max( west, east, hanging * 0.72 );

}

// Steep, broken escarpments shared by every generated island.  They are terrace operators over the
// domain-warped ridged multifractal above, so their faces fork and terminate like geological beds
// instead of tracing periodic sine rings.
export function satelliteEscarpmentRelief( x, z, core, kind ) {

	if ( kind <= 0 || core <= 0 ) return 0;
	const island = ARCHIPELAGO[ kind ];
	const amplitude = island?.kind === 'atoll' ? 3.5 : island?.climate === 'polar' ? 11 : island?.climate === 'temperate' ? 10 : 8;
	const g = satelliteGeology( x, z, kind );
	const strata = g.ridge + g.macro * 0.13 + g.fine * 0.035;
	const face = 0.38 + smoothRange( - 0.3, 0.48, g.macro ) * 0.62;
	const steps = ( smoothRange( 0.38, 0.435, strata ) * 0.62
		+ smoothRange( 0.59, 0.64, strata ) * 0.88 ) * amplitude * face;
	const crest = Math.pow( Math.max( 0, ( g.ridge - 0.48 ) / 0.52 ), 2.4 );
	const ridgeGate = smoothRange( 0.08, 0.24, core ) * ( 1 - smoothRange( 0.9, 1, core ) );
	return ( steps + crest * amplitude * 1.35 ) * ridgeGate;

}

// Bare rock follows the same warped ridged geology as the elevation.  A second octave field breaks
// connected ridges into irregular outcrops; deterministic seeds keep saves stable.
export function satelliteBareRockMask( x, z, q, kind ) {

	if ( kind <= 0 ) return 0;
	const island = ARCHIPELAGO[ kind ];
	const threshold = island?.kind === 'atoll' ? 0.63 : island?.climate === 'polar' ? 0.5 : island?.climate === 'temperate' ? 0.54 : 0.46;
	const g = satelliteGeology( x, z, kind );
	const field = g.ridge * 0.76 + ( g.macro * 0.5 + 0.5 ) * 0.16 + ( g.fine * 0.5 + 0.5 ) * 0.08;
	const crown = Math.max( 0, 1 - q );
	return smoothRange( threshold, 0.78, field ) * smoothRange( 0.055, 0.16, crown );

}

const ellipseQ = ( x, z, cx, cz, rx, rz ) => Math.hypot( ( x - cx ) / rx, ( z - cz ) / rz );

function distanceInto( island, x, z, out ) {

	if ( island.kind === 'atoll' ) {

		const dx = ( x - island.x ) / island.rx, dz = ( z - island.z ) / island.rz;
		const q0 = Math.hypot( dx, dz ), a = Math.atan2( dz, dx );
		const coast = 1 + Math.sin( a * 5 + 0.4 ) * 0.075 + Math.sin( a * 11 - 0.9 ) * 0.035;
		const lagoon = 0.42 + Math.sin( a * 3 - 0.3 ) * 0.025;
		// A broad irregular reef ring remains visible even in the coarsest distant terrain LOD.
		out.d = Math.max( ( q0 - coast ) * Math.min( island.rx, island.rz ), ( lagoon - q0 ) * Math.min( island.rx, island.rz ) );
		out.q = q0 / coast; return out;

	}
	if ( island.kind === 'volcanic' ) {

		const dx = ( x - island.x ) / island.rx, dz = ( z - island.z ) / island.rz;
		const q = Math.hypot( dx, dz ), a = Math.atan2( dz, dx );
		const coast = 1 + Math.sin( a * 3 + 0.6 ) * 0.13 + Math.sin( a * 7 - 0.8 ) * 0.055;
		out.d = ( q - coast ) * Math.min( island.rx, island.rz ); out.q = q / coast; return out;

	}
	if ( island.kind === 'twins' ) {

		const qa = ellipseQ( x, z, island.x - island.rx * 0.29, island.z - island.rz * 0.18, island.rx * 0.52, island.rz * 0.56 );
		const qb = ellipseQ( x, z, island.x + island.rx * 0.32, island.z + island.rz * 0.22, island.rx * 0.47, island.rz * 0.66 );
		const qn = ellipseQ( x, z, island.x + island.rx * 0.02, island.z + island.rz * 0.02, island.rx * 0.56, island.rz * 0.36 );
		const da = ( qa - 1 ) * island.rz * 0.56, db = ( qb - 1 ) * island.rx * 0.47, dn = ( qn - 1 ) * island.rz * 0.36;
		if ( da <= db && da <= dn ) { out.d = da; out.q = qa; }
		else if ( db <= dn ) { out.d = db; out.q = qb; }
		else { out.d = dn; out.q = qn; }
		return out;

	}
	if ( island.kind === 'crescent' ) {

		const turn = - 0.32 + island.variant * 0.07, ca = Math.cos( turn ), sa = Math.sin( turn );
		const dx = x - island.x, dz = z - island.z;
		const rx = dx * ca - dz * sa, rz = dx * sa + dz * ca;
		const qo = ellipseQ( rx, rz, 0, 0, island.rx, island.rz );
		const qc = ellipseQ( rx, rz, island.rx * 0.13, island.rz * 0.46, island.rx * 0.58, island.rz * 0.63 );
		out.d = Math.max( ( qo - 1 ) * Math.min( island.rx, island.rz ), - ( qc - 1 ) * island.rz * 0.63 );
		out.q = qo;
		return out;

	}
	if ( island.kind === 'faroe' ) {

		const dx = ( x - island.x ) / island.rx, dz = ( z - island.z ) / island.rz;
		const q0 = Math.hypot( dx, dz ), a = Math.atan2( dz, dx );
		const coast = 1 + Math.sin( a * 5 + island.variant * 0.8 ) * 0.075 + Math.sin( a * 11 - 0.9 ) * 0.03;
		const base = ( q0 - coast ) * Math.min( island.rx, island.rz );
		const fjord = faroeFjordMask( island, x, z );
		// Outside a fjord the cut must contribute no signed-distance constraint. Using `-4` when
		// fjord == 0 capped the entire island's inland distance at four metres, flattening every
		// plateau and mountain that derives its height from that distance.
		const fjordCut = fjord > 0 ? fjord * Math.min( island.rx, island.rz ) * 0.1 - 4 : - Infinity;
		out.d = Math.max( base, fjordCut );
		out.q = q0 / coast; out.fjord = fjord; return out;

	}
	if ( island.kind === 'glacial' ) {

		const dx = ( x - island.x ) / island.rx, dz = ( z - island.z ) / island.rz;
		const q0 = Math.hypot( dx, dz ), a = Math.atan2( dz, dx );
		const phase = island.variant * 0.73;
		const coast = 1 + Math.sin( a * 4 - 0.5 + phase ) * 0.1 + Math.sin( a * 9 + 0.7 - phase ) * 0.045 + Math.cos( a * 13 + phase ) * 0.025;
		out.d = ( q0 - coast ) * Math.min( island.rx, island.rz ); out.q = q0 / coast; return out;

	}
	out.d = Infinity; out.q = Infinity; return out;

}

export function islandDistance( island, x, z ) {

	return distanceInto( island, x, z, { d: Infinity, q: Infinity } );

}

// Project a point onto a generated island's analytic shoreline. `nx/nz` point from land to sea,
// matching islandDistance's signed convention (negative land, positive water). This is shared by
// the roaming ecology systems: audio, birds, fish and the detailed breaker ribbon must all agree
// on the same coast even though the satellite islands do not have the main island's baked field.
export function islandCoastFrame( island, x, z, out = {} ) {

	let px = x, pz = z;
	const eps = 3;
	for ( let k = 0; k < 8; k ++ ) {

		const d = islandDistance( island, px, pz ).d;
		const gx = ( islandDistance( island, px + eps, pz ).d - islandDistance( island, px - eps, pz ).d ) / ( 2 * eps );
		const gz = ( islandDistance( island, px, pz + eps ).d - islandDistance( island, px, pz - eps ).d ) / ( 2 * eps );
		const g2 = gx * gx + gz * gz;
		if ( ! Number.isFinite( d ) || g2 < 1e-8 ) break;
		const step = Math.max( - 180, Math.min( 180, d / g2 ) );
		px -= gx * step;
		pz -= gz * step;
		if ( Math.abs( d ) < 0.015 ) break;

	}
	const gx = islandDistance( island, px + eps, pz ).d - islandDistance( island, px - eps, pz ).d;
	const gz = islandDistance( island, px, pz + eps ).d - islandDistance( island, px, pz - eps ).d;
	const gl = Math.hypot( gx, gz ) || 1;
	out.x = px; out.z = pz;
	out.nx = gx / gl; out.nz = gz / gl;
	out.d = islandDistance( island, x, z ).d;
	return out;

}

function traceCoast( island, start, count, spacing, side ) {

	const points = [];
	let x = start.x, z = start.z, tx = - start.nz * side, tz = start.nx * side;
	for ( let i = 0; i < count; i ++ ) {

		const guessX = x + tx * spacing, guessZ = z + tz * spacing;
		const p = islandCoastFrame( island, guessX, guessZ, {} );
		const ntx = - p.nz * side, ntz = p.nx * side;
		// Keep the contour direction continuous at sharp fjord/crescent turns.
		if ( ntx * tx + ntz * tz < 0 ) { tx = - ntx; tz = - ntz; } else { tx = ntx; tz = ntz; }
		x = p.x; z = p.z;
		points.push( p );

	}
	return points;

}

// A camera-centred, reusable strip of high-detail breaker stations. Keeping only a few hundred
// stations resident gives every generated island the main beach's crest ribbons and spray without
// simulating the complete coastlines of all 23 remote islands every frame.
export function buildIslandShoreStrip( island, x, z, { count = 601, spacing = 0.8 } = {} ) {

	count = Math.max( 3, Math.floor( count ) | 1 );
	const start = islandCoastFrame( island, x, z, {} );
	const half = ( count - 1 ) >> 1;
	const left = traceCoast( island, start, half, spacing, - 1 ).reverse();
	const right = traceCoast( island, start, half, spacing, 1 );
	const points = [ ...left, start, ...right ];
	const data = new Float32Array( points.length * 4 );
	for ( let i = 0; i < points.length; i ++ ) {

		const p = points[ i ], k = i * 4;
		data[ k ] = p.x; data[ k + 1 ] = p.z;
		data[ k + 2 ] = p.nx; data[ k + 3 ] = p.nz;

	}
	return { data, count: points.length, spacing, center: start };

}

// Writes the closest satellite island into an existing object to avoid allocations in the 2 m
// terrain generation loop.
export function sampleSatelliteIslands( x, z, out ) {

	out.island = 0;
	out.islandD = Infinity;
	out.islandQ = Infinity;
	out.islandFjord = 0;
	for ( let i = 1; i < ARCHIPELAGO.length; i ++ ) {

		out.fjord = 0;
		distanceInto( ARCHIPELAGO[ i ], x, z, out );
		if ( out.d >= out.islandD ) continue;
		out.island = i;
		out.islandD = out.d;
		out.islandQ = out.q;
		out.islandFjord = out.fjord || 0;

	}
	return out;

}
