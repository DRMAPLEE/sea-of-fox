import assert from 'node:assert/strict';
import { TerrainPatchTracker, createMapDocument, validateMapDocument } from '../src/editor/MapDocument.js';

const terrain = {
	heights: new Float32Array( 16 ),
	rock: new Float32Array( 16 ),
	sand: new Uint8Array( 16 ),
	path: new Uint8Array( 16 ),
	seagrass: new Uint8Array( 16 ),
	rubble: new Uint8Array( 16 ),
	meadow: new Uint8Array( 16 ),
	forest: new Uint8Array( 16 ),
	snow: new Uint8Array( 16 ),
};

const tracker = new TerrainPatchTracker( terrain );
tracker.recordOriginal( 'heights', 3, terrain.heights[ 3 ] );
tracker.recordOriginal( 'sand', 9, terrain.sand[ 9 ] );
tracker.recordOriginal( 'snow', 12, terrain.snow[ 12 ] );
terrain.heights[ 3 ] = 12.5;
terrain.sand[ 9 ] = 203;
terrain.snow[ 12 ] = 241;
const patches = tracker.serialize();
assert.equal( patches.heights.count, 1 );
assert.equal( patches.sand.count, 1 );
assert.equal( patches.snow.count, 1 );

tracker.restoreBaseline();
assert.equal( terrain.heights[ 3 ], 0 );
assert.equal( terrain.sand[ 9 ], 0 );
assert.equal( terrain.snow[ 12 ], 0 );
tracker.apply( patches );
assert.equal( terrain.heights[ 3 ], 12.5 );
assert.equal( terrain.sand[ 9 ], 203 );
assert.equal( terrain.snow[ 12 ], 241 );

const document = createMapDocument( { name: 'Test island', terrainPatches: patches, entities: [], assets: [], view: {} } );
assert.equal( validateMapDocument( document ).format, 'tidewater-map' );
assert.throws( () => validateMapDocument( { format: 'other', version: 1 } ) );

console.log( 'editor map patches passed' );
