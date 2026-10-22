import assert from 'node:assert/strict';
import { ARCHIPELAGO, CLIMATE_COUNTS, buildIslandShoreStrip, faroeFjordMask, islandCoastFrame, islandDistance, polarGlacierMask, sampleSatelliteIslands, satelliteBareRockMask, satelliteEscarpmentRelief, satelliteMultifractalRelief } from '../src/world/Archipelago.js';
import { TerrainData } from '../src/world/TerrainData.js';
import { TerrainGPU } from '../src/world/TerrainGPU.js';
import { WORLD, wrapWorldCoordinate, wrappedWorldDelta } from '../src/world/WorldLayout.js';
import { grassDensityForCover } from '../src/world/vegetation/Scatter.js';
import { CELL as GRASS_CELL, R_FAR as GRASS_RESIDENT_RANGE } from '../src/world/vegetation/GrassField.js';

assert.equal( ARCHIPELAGO.length, 24, 'the chart contains more than twenty islands' );
assert.deepEqual( CLIMATE_COUNTS, { tropical: 12, polar: 7, temperate: 5 }, 'island climates are 50% tropical, about 30% polar and the rest temperate' );
assert.equal( WORLD.worldPeriod, 60000, 'the looping chart has room for six-kilometre sea lanes' );
assert.equal( WORLD.renderRadius, 4000, 'terrain render radius is four kilometres' );
assert.equal( GRASS_CELL, 8, 'grass keeps fine eight-metre spatial tiles' );
assert.equal( GRASS_RESIDENT_RANGE, WORLD.renderRadius, 'grass residency covers the complete visible island rather than a camera bubble' );
assert.equal( wrapWorldCoordinate( WORLD.worldPeriod / 2 + 25 ), - WORLD.worldPeriod / 2 + 25, 'world coordinates wrap at the seam' );
assert.equal( wrappedWorldDelta( 29900, - 29900 ), 200, 'map distances use the short route across the seam' );

for ( let i = 0; i < ARCHIPELAGO.length; i ++ ) for ( let j = i + 1; j < ARCHIPELAGO.length; j ++ ) {

	const a = ARCHIPELAGO[ i ], b = ARCHIPELAGO[ j ];
	const distance = Math.hypot( wrappedWorldDelta( a.x, b.x ), wrappedWorldDelta( a.z, b.z ) );
	assert.ok( distance > 6000, `${ a.name } and ${ b.name } are more than 6 km apart on the torus` );
	const ra = Math.max( a.rx, a.rz );
	const rb = Math.max( b.rx, b.rz );
	assert.ok( distance - ra - rb > 6000, `${ a.name } and ${ b.name } have more than 6 km of navigable sea between their shores` );

}

const satellites = ARCHIPELAGO.slice( 1 );
assert.ok( new Set( satellites.map( ( island ) => island.x ) ).size >= 20, 'islands do not share conspicuous map columns' );
assert.ok( new Set( satellites.map( ( island ) => island.z ) ).size >= 20, 'islands do not share conspicuous map rows' );
assert.ok( satellites.some( ( island ) => island.x % 1000 !== 0 && island.z % 1000 !== 0 ), 'island placement is not locked to a kilometre grid' );

const main = ARCHIPELAGO[ 0 ];
assert.equal( satelliteMultifractalRelief( main.x, main.z, 1, 0 ), 0, 'the generated-island geology never alters the spawn island' );
assert.equal( satelliteEscarpmentRelief( main.x, main.z, 1, 0 ), 0, 'the generated-island escarpments never alter the spawn island' );
assert.equal( satelliteBareRockMask( main.x, main.z, 0, 0 ), 0, 'the generated-island rock field never alters the spawn island' );
for ( const island of ARCHIPELAGO.slice( 1 ) ) assert.ok( island.rx * island.rz >= main.rx * main.rz, `${ island.name } is at least as large as the main island` );

const atoll = ARCHIPELAGO.find( ( island ) => island.kind === 'atoll' );
assert.ok( islandDistance( atoll, atoll.x, atoll.z ).d > 0, 'atoll centre is a lagoon' );
assert.ok( islandDistance( atoll, atoll.x + atoll.rx * 0.75, atoll.z ).d < 0, 'atoll has an emergent ring' );

const volcano = ARCHIPELAGO.find( ( island ) => island.kind === 'volcanic' );
assert.ok( islandDistance( volcano, volcano.x, volcano.z ).d < 0 );
assert.ok( islandDistance( volcano, volcano.x + volcano.rx * 2, volcano.z ).d > 0 );
const coastFrame = islandCoastFrame( volcano, volcano.x + volcano.rx * 1.3, volcano.z + 70 );
assert.ok( Math.abs( islandDistance( volcano, coastFrame.x, coastFrame.z ).d ) < 0.1, 'local ecology projects onto the generated shoreline' );
assert.ok( Math.abs( Math.hypot( coastFrame.nx, coastFrame.nz ) - 1 ) < 1e-5, 'generated shoreline supplies a unit seaward normal' );
const ecologyStrip = buildIslandShoreStrip( volcano, coastFrame.x, coastFrame.z, { count: 101, spacing: 2 } );
assert.equal( ecologyStrip.count, 101, 'the reusable ecology window keeps a fixed GPU station count' );
for ( let i = 0; i < ecologyStrip.count; i += 10 ) {

	const k = i * 4;
	assert.ok( Math.abs( islandDistance( volcano, ecologyStrip.data[ k ], ecologyStrip.data[ k + 1 ] ).d ) < 0.15, 'breaker stations follow the analytic generated coast' );
	assert.ok( Math.abs( Math.hypot( ecologyStrip.data[ k + 2 ], ecologyStrip.data[ k + 3 ] ) - 1 ) < 1e-4, 'breaker station normal remains normalized' );

}

const twins = ARCHIPELAGO.find( ( island ) => island.kind === 'twins' );
assert.ok( islandDistance( twins, twins.x - 260, twins.z - 130 ).d < 0 );
assert.ok( islandDistance( twins, twins.x + 290, twins.z + 160 ).d < 0 );

const crescent = ARCHIPELAGO.find( ( island ) => island.kind === 'crescent' );
assert.ok( islandDistance( crescent, crescent.x, crescent.z ).d > 0, 'crescent centre opens into a cove' );
assert.ok( islandDistance( crescent, crescent.x + 50, crescent.z - 400 ).d < 0, 'crescent has an explorable outer arm' );

const glacial = ARCHIPELAGO.find( ( island ) => island.kind === 'glacial' );
const glacialIndex = ARCHIPELAGO.indexOf( glacial );
assert.ok( glacial.z < - 8000, 'glacial island is placed in the polar south' );
assert.ok( islandDistance( glacial, glacial.x, glacial.z ).d < 0, 'glacial island has a solid explorable interior' );
assert.ok( polarGlacierMask( glacial.x, glacial.z, 0, glacialIndex ) > 0.85, 'polar crown carries a broad central ice cap' );
assert.ok( polarGlacierMask( glacial.x + 420, glacial.z + 220, 0.58, glacialIndex ) > 0.35, 'a glacier tongue flows away from the crown' );
assert.equal( polarGlacierMask( glacial.x, glacial.z + glacial.rz, 1, glacialIndex ), 0, 'the black frozen strand remains clear of glacier ice' );
let sharpestEscarpment = 0;
for ( let z = - 650; z <= 650; z += 20 ) for ( let x = - 800; x <= 800; x += 20 ) {

	const core = Math.max( 0, 1 - Math.hypot( x / glacial.rx, z / glacial.rz ) );
	const nextCore = Math.max( 0, 1 - Math.hypot( ( x + 4 ) / glacial.rx, z / glacial.rz ) );
	const a = satelliteEscarpmentRelief( glacial.x + x, glacial.z + z, core, glacialIndex );
	const b = satelliteEscarpmentRelief( glacial.x + x + 4, glacial.z + z, nextCore, glacialIndex );
	sharpestEscarpment = Math.max( sharpestEscarpment, Math.abs( a - b ) );

}
assert.ok( sharpestEscarpment > 5, 'domain-warped islands include sharp internal escarpments rather than only smooth hills' );
let bareSamples = 0, soilSamples = 0;
for ( let z = - 600; z <= 600; z += 80 ) for ( let x = - 700; x <= 700; x += 80 ) {

	const q = Math.hypot( x / glacial.rx, z / glacial.rz );
	const rock = satelliteBareRockMask( glacial.x + x, glacial.z + z, q, glacialIndex );
	if ( rock > 0.7 ) bareSamples ++;
	if ( rock < 0.05 ) soilSamples ++;

}
assert.ok( bareSamples > 3 && soilSamples > 3, 'generated islands mix random bare-rock patches with covered ground' );

const faroe = ARCHIPELAGO.find( ( island ) => island.kind === 'faroe' );
const fjordX = faroe.x + faroe.rx * 0.7, fjordZ = faroe.z - faroe.rz * 0.1;
assert.ok( faroeFjordMask( faroe, fjordX, fjordZ ) > 0.5, 'Faroe-like island has a long glacial fjord trough' );
assert.ok( islandDistance( faroe, fjordX, fjordZ ).d > 0, 'the fjord cuts navigable water into the basalt plateau' );
let faroeDeepLand = 0;
for ( let z = - 0.75; z <= 0.75; z += 0.15 ) for ( let x = - 0.75; x <= 0.75; x += 0.15 ) {

	if ( islandDistance( faroe, faroe.x + x * faroe.rx, faroe.z + z * faroe.rz ).d < - 120 ) faroeDeepLand ++;

}
assert.ok( faroeDeepLand > 8, 'fjord cuts do not cap the remaining Faroe plateau at a four-metre inland distance' );
assert.ok( grassDensityForCover( { climate: 0, h: 8, bare: 0, snow: 0, meadowPaint: 0, forest: 0, sand: 0 } ) > 0.9, 'open tropical grassland receives dense grass geometry' );
assert.ok( grassDensityForCover( { climate: 0.55, h: 8, bare: 0, snow: 0, meadowPaint: 0, forest: 0, sand: 0 } ) > 0.9, 'temperate Faroe turf receives the same grass geometry' );
assert.equal( grassDensityForCover( { climate: 1, h: 8, bare: 0, snow: 0, meadowPaint: 0, forest: 0, sand: 0 } ), 0, 'polar islands remain vegetation-free' );

const sample = {};
sampleSatelliteIslands( volcano.x, volcano.z, sample );
assert.equal( ARCHIPELAGO[ sample.island ].id, volcano.id );

const craterTerrain = Object.create( TerrainData.prototype );
craterTerrain.craters = [];
craterTerrain.addCrater( 0, 0, 4.2, 1.7 );
assert.ok( craterTerrain.craterDeltaAt( 0, 0 ) < - 1.65, 'artillery crater depresses its centre' );
assert.ok( craterTerrain.craterDeltaAt( 3.4, 0 ) > 0, 'artillery crater raises a visible rim' );
assert.ok( craterTerrain.craterDeltaAt( 5, 0 ) > 0, 'artillery crater deposits a low proximal ejecta apron beyond its rim' );
assert.equal( craterTerrain.craterDeltaAt( 6.4, 0 ), 0, 'artillery deformation ends beyond the ejecta apron' );
const obliqueCrater = Object.create( TerrainData.prototype );
obliqueCrater.craters = [];
obliqueCrater.addCrater( 0, 0, 4.2, 1.3, 1, 0, 0.8, 0.4 );
assert.ok( obliqueCrater.craterDeltaAt( - 0.2, 0 ) < obliqueCrater.craterDeltaAt( 0.2, 0 ), 'oblique impact offsets the deepest excavation slightly uprange' );
assert.notEqual( obliqueCrater.craterDeltaAt( 3.7, 0 ), obliqueCrater.craterDeltaAt( 0, 3.7 ), 'crater rim is irregular rather than a perfect circular ring' );

const packedHomeBiome = TerrainGPU.prototype._packBiomes.call( {
	terrain: { res: 1, meadow: new Uint8Array( 1 ), forest: new Uint8Array( 1 ), snow: new Uint8Array( 1 ) },
} );
assert.equal( packedHomeBiome[ 3 ], 0, 'spawn island keeps the neutral tropical climate channel' );

console.log( 'archipelago generation passed' );
