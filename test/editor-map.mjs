import assert from 'node:assert/strict';
import { TerrainPatchTracker, createMapDocument, validateMapDocument } from '../src/editor/MapDocument.js';
import { TerrainEditor } from '../src/editor/TerrainEditor.js';

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

const paintTerrain = {
	res: 3, texel: 1, origin: - 1.5,
	heights: new Float32Array( 9 ), rock: new Float32Array( 9 ),
	sand: new Uint8Array( 9 ), path: new Uint8Array( 9 ), seagrass: new Uint8Array( 9 ), rubble: new Uint8Array( 9 ),
	meadow: new Uint8Array( 9 ), forest: new Uint8Array( 9 ), snow: new Uint8Array( 9 ),
};
const paintTracker = new TerrainPatchTracker( paintTerrain );
const paintEditor = new TerrainEditor( { terrain: paintTerrain, gpu: {}, tracker: paintTracker } );
paintTerrain.snow[ 4 ] = 255;
paintTerrain.forest[ 4 ] = 255;
paintEditor._paint( 'sand', 4, 255, 1, false, 1, 1 );
assert.ok( paintTerrain.sand[ 4 ] > 150, 'one default-strength material dab is immediately visible' );
assert.ok( paintTerrain.snow[ 4 ] < 10 && paintTerrain.forest[ 4 ] < 10, 'a new surface material clears competing painted overlays' );
const sandBeforeErase = paintTerrain.sand[ 4 ];
paintEditor._paint( 'sand', 4, 255, 1, true, 1, 1 );
assert.ok( paintTerrain.sand[ 4 ] < sandBeforeErase, 'inverse painting erases only the selected material' );

console.log( 'editor map patches passed' );
