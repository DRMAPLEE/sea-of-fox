import * as THREE from '../engine/index.js';

// Shared world layout. Coordinates in meters, y up, sea level y = 0.
// The open ocean lies to the south (+z); the island to the north (-z).
// Sun rises in the east (+x) and sets in the west (-x).
export const WORLD = {
	terrainSize: 2048, // heightmap domain, centered at origin
	terrainRes: 2048,
	// The playable sea is a torus: crossing one edge enters from the opposite edge.  Keeping the
	// period separate from terrainSize lets the hand-authored home island retain its 1 m heightmap
	// while procedural islands and ocean occupy a much larger navigable world.
	worldPeriod: 60000,
	renderRadius: 4000,

	// Central sandy beach inside the bay, shoreline near z ≈ -42 at x = 0.
	beach: { xMin: - 150, xMax: 170 },

	pier: {
		x: 55,
		zStart: - 64, // on dry sand
		zEnd: 40, // end of pier (~4 m depth)
		deckHeight: 2.3, // deck surface above sea level
		width: 2.6,
		headWidth: 14, // T-shaped platform at the end
		headDepth: 7,
	},

	// Where the boat is moored: east side of the pier head, bow pointing south.
	boatDock: { position: new THREE.Vector3( 64.5, 0, 36.5 ), heading: 0 },
	// The tall ship sits to port (+X, visually left while looking out to sea) of the original boat.
	tallShipDock: { position: new THREE.Vector3( 84.5, 0, 36.5 ), heading: 0 },

	village: { center: new THREE.Vector3( 40, 0, - 118 ), radius: 95 },

	reef: { center: new THREE.Vector3( - 78, 0, 58 ), radius: 58 },

	spawn: { position: new THREE.Vector3( 18, 0, - 60 ), yaw: Math.PI }, // kept clear of rocks, plants and debris
	// where the player starts: on the boardwalk up from the pier foot, looking down it toward the pier
	start: { position: new THREE.Vector3( 53.6, 0, - 77 ), yaw: Math.PI },

	// Incoming swell direction (unit, travel direction)
	swellDir: new THREE.Vector2( - 0.12, - 1 ).normalize(),
};

export function wrapWorldCoordinate( value ) {

	const period = WORLD.worldPeriod, half = period * 0.5;
	return ( ( value + half ) % period + period ) % period - half;

}

export function wrappedWorldDelta( from, to ) {

	return wrapWorldCoordinate( to - from );

}

export function wrapWorldPosition( position, out = {} ) {

	const x = wrapWorldCoordinate( position.x ), z = wrapWorldCoordinate( position.z );
	out.dx = x - position.x; out.dz = z - position.z;
	position.x = x; position.z = z;
	return out;

}
