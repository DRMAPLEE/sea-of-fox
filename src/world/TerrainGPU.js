import { Vector3, Vector4 } from '../engine/math/index.js';
import { Texture } from '../engine/gpu/Texture.js';
import { generateMipmaps } from '../engine/gpu/Mipmaps.js';
import { ShaderModule, UniformBlock } from '../engine/gpu/Shader.js';
import { ComputeKernel } from '../engine/gpu/Compute.js';
import { commonModule } from '../engine/render/wgsl/common.js';
import { G } from '../engine/render/Frame.js';
import { WORLD } from './WorldLayout.js';
import { ARCHIPELAGO } from './Archipelago.js';
import { bakeTerrainMaps, buildShadowHeights } from './terrain/TerrainBake.js';
import { getDetailTexture } from './terrain/DetailTextures.js';
import { detailBinding } from './terrain/TerrainShading.js';

const TERRAIN_CRATERS = 32;

// GPU-side terrain data shared by every shader that needs ground height:
// ocean (depth attenuation / hiding under land), shore waves, terrain mesh,
// particles, water queries.
//
// Textures (all over the terrain domain unless noted):
//   heightTexture  R32F   exact heights, bilinear filtering done manually (heightAt)
//   normalTexture  RGBA8  macro normal xz (encoded), rock mask, baked ambient occlusion (mipmapped)
//   splatTexture   RGBA8  loose sand, worn ground / paths, gullies (land) or seagrass (seabed),
//                         seabed rubble / the eroded beach scarp face on land (mipmapped)
//   detailTexture  RGBA8  512^2 tileable detail heights (rock, soil, sand, fbm), see DetailTextures
//   shadowHeightTexture R16F 512^2 (4 m) heights with max-mips (input of the sun shadow bake)
//   sunShadowTexture    RGBA16F storage 512^2: 'shadow top' height and occluder distance toward the
//                       key light, re-baked on the GPU when G.sunDir moves (updateSunShadow)
//
// WGSL module (`terrainGPU.module`, prefix `terrain`), usable from any stage unless noted:
//   terrainUvOf( xz: vec2f ) -> vec2f                   domain uv (0..1) of a world xz
//   terrainHeightAt( xz: vec2f ) -> f32                 exact bilinear height (-90 outside the domain)
//   terrainNormalRock( xz: vec2f ) -> vec4f             macro normal xz (-1..1), rock mask, AO — fragment only
//                                                       (implicit derivatives); terrainNormalRockLevel( xz, level )
//   terrainNormalAt( xz: vec2f ) -> vec3f               unit macro normal (mip 0, any stage)
//   terrainSplat( xz: vec2f ) -> vec4f                  sand, paths, gullies / seagrass, rubble — fragment only;
//                                                       terrainSplatLevel( xz, level )
//   terrainShoreSample( xz: vec2f ) -> vec4f            shore field (T, dirX, dirZ, exposure), bilinear
//   terrainSunShadowAt( P: vec3f ) -> f32               heightfield sun shadow: 0 in the hills' shadow .. 1 lit
// Bindings: terrainParams (TerrainParams: origin, size, res, shoreRes, sunBake, sunBaked), terrainHeightTex,
// terrainNormalTex, terrainSplatTex, terrainDetailTex (tileable: sample with smpLinearRepeat / smpAnisoRepeat),
// terrainShoreTex, terrainSunShadowTex.
const SUN_N = 512;
const SUN_T0 = 24; // m: nearer occluders are left to the shadow map / N.L
const SUN_DT0 = 6;
const SUN_GROWTH = 1.22;
const SUN_STEPS = 24; // reaches ~3 km

function dataTexture( data, width, height, format, label, mips = false ) {

	const tex = new Texture( { label, width, height, format, mips, usage: [ 'sample', 'copyDst' ], data } );
	tex.getGPU();
	if ( mips === true ) generateMipmaps( tex );
	return tex;

}

export class TerrainGPU {

	constructor( terrain, shoreField ) {

		this.terrain = terrain;
		const res = terrain.res;
		const t0 = performance.now();

		// heights: R32F, loaded with manual bilinear filtering (no sampler / float filtering needed)
		this.heightTexture = dataTexture( terrain.heights, res, res, 'r32float', 'terrainHeights' );

		const maps = bakeTerrainMaps( terrain );
		// trilinear, clamp to edge (smpLinearClamp), linear data (no colour space)
		this.normalTexture = dataTexture( maps.normal, res, res, 'rgba8unorm', 'terrainNormalRockAO', true );
		this.splatTexture = dataTexture( maps.splat, res, res, 'rgba8unorm', 'terrainSplat', true );
		this.biomeTexture = dataTexture( this._packBiomes(), res, res, 'rgba8unorm', 'terrainBiomes', true );
		this.detailTexture = getDetailTexture();

		// coarse heights for the sun shadow march (half float is filterable everywhere)
		const sh = buildShadowHeights( terrain, 4 );
		const st = new Texture( { label: 'terrainShadowHeights', width: sh.levels[ 0 ].width, height: sh.levels[ 0 ].height, format: 'r16float', mips: sh.levels.length, usage: [ 'sample', 'copyDst' ] } );
		st.getGPU();
		sh.levels.forEach( ( l, i ) => st.upload( l.data, { mip: i, width: l.width, height: l.height } ) );
		this.shadowHeightTexture = st;
		this.shadowTexel = sh.texel;
		this.maxHeight = sh.maxHeight;

		this.size = terrain.size;
		this.origin = terrain.origin;
		this.res = res;

		this.uniforms = new UniformBlock( 'TerrainParams', {
			origin: [ 'f32', terrain.origin ],
			size: [ 'f32', terrain.size ],
			res: [ 'f32', res ],
			shoreRes: [ 'f32', 1 ],
			sunBake: [ 'vec3f', new Vector3( 0, 1, 0 ) ],
			sunBaked: [ 'f32', 0 ], // 0 until the first bake: everything lit
			craters: [ `vec4f[${ TERRAIN_CRATERS }]`, Array.from( { length: TERRAIN_CRATERS }, () => new Vector4() ) ],
			craterShapes: [ `vec4f[${ TERRAIN_CRATERS }]`, Array.from( { length: TERRAIN_CRATERS }, () => new Vector4( 1, 0, 0, 0 ) ) ],
			craterCount: [ 'f32', 0 ],
			craterPad: [ 'vec3f', new Vector3() ],
		}, { label: 'terrainParams' } );
		// three-style handles (terOrigin / terSize / terSunBake / terSunBaked)
		this.uOrigin = this.uniforms.fields.origin;
		this.uSize = this.uniforms.fields.size;

		// placeholder until the shore field is set (1 texel, no waves)
		this.shoreTexture = dataTexture( new Float32Array( [ 1e4, 0, 0, 0 ] ), 1, 1, 'rgba32float', 'terrainShoreField' );
		if ( shoreField ) this.setShoreField( shoreField );
		this._initSunShadow();
		this._craterCursor = 0;

		this.module = new ShaderModule( {
			name: 'terrain',
			deps: [ commonModule ],
			uniforms: this.uniforms,
			bindings: {
				terrainHeightTex: { texture: this.heightTexture, sampleType: 'unfilterable-float' },
				terrainNormalTex: { texture: this.normalTexture },
				terrainSplatTex: { texture: this.splatTexture },
				terrainBiomeTex: { texture: this.biomeTexture },
				terrainDetailTex: detailBinding(),
				terrainShoreTex: { texture: () => this.shoreTexture, sampleType: 'unfilterable-float' },
				terrainSunShadowTex: { texture: this.sunShadowTexture },
			},
			code: TERRAIN_WGSL,
		} );

		// the former TerrainLightingModel: multiplies the key light by the heightfield sun shadow.
		// Materials add it to `modules` and set the define MATERIAL_SUN_MODULATION: 1.
		this.sunModulationModule = new ShaderModule( {
			name: 'terrainSunModulation',
			deps: [ this.module ],
			code: 'fn materialSunModulation( P: vec3f, N: vec3f ) -> vec3f { return vec3f( terrainSunShadowAt( P ) ); }',
		} );

		this.timings = { ...maps.ms, detail: this.detailTexture.userData.ms, total: performance.now() - t0 };

	}

	addCrater( x, z, radius = 4.2, depth = 1.3, dirX = 1, dirZ = 0, obliquity = 0, phase = null ) {

		const index = this._craterCursor;
		const dl = Math.hypot( dirX, dirZ ) || 1;
		const craterPhase = phase ?? ( ( Math.sin( x * 0.013 + z * 0.017 ) * 0.5 + 0.5 ) * Math.PI * 2 );
		this.uniforms.fields.craters.value[ index ].set( x, z, radius, depth );
		this.uniforms.fields.craterShapes.value[ index ].set( dirX / dl, dirZ / dl, Math.min( 0.92, Math.max( 0, obliquity ) ), craterPhase );
		this._craterCursor = ( index + 1 ) % TERRAIN_CRATERS;
		this.uniforms.fields.craterCount.value = Math.min( TERRAIN_CRATERS, this.uniforms.fields.craterCount.value + 1 );
		this._sunBaked = false;
		this.uSunBaked.value = 0;

	}

	// ------------------------------------------------------------ heightfield sun shadow

	// World-space shadow map of the terrain for the key light: for every 4 m cell the lowest height
	// that still sees the light past the terrain (max over the march of h(q) - t * tan(elevation))
	// and the distance to that occluder (penumbra width). One texture fetch gives soft, long hill
	// shadows for any point - terrain, rocks, buildings, plants - far beyond the shadow map range.
	_initSunShadow() {

		// nearest + textureLoad (manual bilinear in terrainSunShadowAt): no sampler needed, every lit
		// material includes this lookup
		this.sunShadowTexture = new Texture( { label: 'terrainSunShadow', width: SUN_N, height: SUN_N, format: 'rgba16float', usage: [ 'sample', 'storage' ] } );
		this.uSunBake = this.uniforms.fields.sunBake;
		this.uSunBaked = this.uniforms.fields.sunBaked;
		this._sunBaked = false;

		const invTexel = 1 / this.shadowTexel;
		this.sunShadowKernel = new ComputeKernel( {
			label: 'Terrain Sun Shadow',
			modules: [ commonModule ],
			bindings: {
				terrainParams: { uniform: this.uniforms },
				terrainShadowHeights: { texture: this.shadowHeightTexture },
				terrainSunShadowOut: { storageTexture: this.sunShadowTexture, access: 'write' },
			},
			workgroupSize: [ 8, 8, 1 ],
			code: /* wgsl */`
@compute @workgroup_size( WG_X, WG_Y, WG_Z )
fn main( @builtin( global_invocation_id ) gid: vec3u ) {
	if ( gid.x >= ${ SUN_N }u || gid.y >= ${ SUN_N }u ) { return; }
	let ij = vec2f( gid.xy );
	let xz = ( ij + 0.5 ) / ${ SUN_N }.0 * terrainParams.size + terrainParams.origin;
	let L = terrainParams.sunBake;
	let lxz = max( length( L.xz ), 1e-4 );
	let dir = L.xz / lxz;
	let tanEl = L.y / lxz;
	var top = -1e4;
	var occ = 0.0;
	var t = f32( ${ SUN_T0 } );
	var dt = f32( ${ SUN_DT0 } );
	for ( var i = 0; i < ${ SUN_STEPS }; i++ ) {
		let q = xz + dir * t;
		let uv = ( q - terrainParams.origin ) / terrainParams.size;
		let hq = textureSampleLevel( terrainShadowHeights, smpLinearClamp, uv, log2( max( dt * ${ invTexel.toFixed( 8 ) }, 1.0 ) ) ).x;
		let v = hq - t * tanEl;
		if ( v > top ) {
			top = v;
			occ = t;
		}
		dt *= ${ SUN_GROWTH };
		t += dt;
	}
	textureStore( terrainSunShadowOut, vec2u( gid.xy ), vec4f( top, occ, 0.0, 1.0 ) );
}
`,
		} );

	}

	// Re-bake the sun shadow map when the key light moved (cheap: ~6 M texture fetches).
	// `renderer` is unused (kept for the call sites); the dispatch records into the frame encoder.
	updateSunShadow( renderer, force = false ) {

		const L = G.sunDir.value;
		if ( ! force && this._sunBaked && L.angleTo( this.uSunBake.value ) < 0.0015 ) return false;
		this.uSunBake.value.copy( L );
		this.sunShadowKernel.dispatch( [ SUN_N / 8, SUN_N / 8, 1 ] );
		this._sunBaked = true;
		this.uSunBaked.value = 1;
		return true;

	}

	setShoreField( f ) {

		this.shoreRes = f.res;
		if ( this.shoreTexture.width !== f.res ) {

			this.shoreTexture.destroy();
			this.shoreTexture = dataTexture( f.data, f.res, f.res, 'rgba32float', 'terrainShoreField' );

		} else {

			this.shoreTexture.upload( f.data );

		}

		this.uniforms.fields.shoreRes.value = f.res;

	}

	// Upload only the edited rectangle of the CPU height field. The editor calls this while a
	// brush is moving; the more expensive normal/AO/splat/shadow maps are rebuilt when the stroke
	// ends via rebuildDerived(). Coordinates are height-map texel coordinates.
	updateHeightRegion( { x0, y0, x1, y1 } ) {

		const res = this.terrain.res;
		x0 = Math.max( 0, Math.floor( x0 ) );
		y0 = Math.max( 0, Math.floor( y0 ) );
		x1 = Math.min( res - 1, Math.ceil( x1 ) );
		y1 = Math.min( res - 1, Math.ceil( y1 ) );
		if ( x1 < x0 || y1 < y0 ) return false;
		const width = x1 - x0 + 1, height = y1 - y0 + 1;
		const src = this.terrain.heights;
		const data = new Float32Array( width * height );
		for ( let y = 0; y < height; y ++ ) {

			const from = ( y0 + y ) * res + x0;
			data.set( src.subarray( from, from + width ), y * width );

		}
		this.heightTexture.upload( data, { x: x0, y: y0, width, height } );
		return true;

	}

	// Recreate every terrain-derived texture after an edit. This is intentionally a stroke-end
	// operation: horizon AO and the shadow-height mip chain inspect a large part of the island.
	rebuildDerived() {

		const maps = bakeTerrainMaps( this.terrain );
		this.normalTexture.upload( maps.normal );
		this.splatTexture.upload( maps.splat );
		this.biomeTexture.upload( this._packBiomes() );
		generateMipmaps( this.normalTexture );
		generateMipmaps( this.splatTexture );
		generateMipmaps( this.biomeTexture );

		const sh = buildShadowHeights( this.terrain, 4 );
		sh.levels.forEach( ( level, mip ) => this.shadowHeightTexture.upload( level.data, {
			mip, width: level.width, height: level.height,
		} ) );
		this.shadowTexel = sh.texel;
		this.maxHeight = sh.maxHeight;
		this._sunBaked = false;
		this.uSunBaked.value = 0;
		this.timings = { ...this.timings, ...maps.ms };
		return maps.ms;

	}

	_packBiomes() {

		const t = this.terrain, n = t.res * t.res;
		const data = new Uint8Array( n * 4 );
		for ( let i = 0; i < n; i ++ ) {

			const o = i * 4;
			data[ o ] = t.meadow?.[ i ] || 0;
			data[ o + 1 ] = t.forest?.[ i ] || 0;
			data[ o + 2 ] = t.snow?.[ i ] || 0;
			// Reserved climate channel: the authored/spawn island is the unchanged tropical baseline.
			// Analytic satellite islands provide their own non-zero climate value in terrainBiome().
			data[ o + 3 ] = 0;

		}
		return data;

	}

}

const SATELLITES = ARCHIPELAGO.slice( 1 );
const SATELLITE_SHAPE = { atoll: 1, volcanic: 2, twins: 3, crescent: 4, glacial: 5, faroe: 6 };
const SATELLITE_CLIMATE = { tropical: 0, temperate: 1, polar: 2 };
const wgslVec4Array = ( rows ) => rows.map( ( row ) => `vec4f( ${ row.map( ( n ) => Number( n ).toFixed( 1 ) ).join( ', ' )} )` ).join( ',\n\t' );
const SATELLITE_FRAMES_WGSL = wgslVec4Array( SATELLITES.map( ( island ) => [ island.x, island.z, island.rx, island.rz ] ) );
const SATELLITE_META_WGSL = wgslVec4Array( SATELLITES.map( ( island ) => [
	SATELLITE_SHAPE[ island.kind ], SATELLITE_CLIMATE[ island.climate ], island.variant,
	island.kind === 'atoll' ? 0.04 : island.climate === 'polar' ? 0.82 : island.climate === 'temperate' ? 0.55 : 0.72,
] ) );

const TERRAIN_WGSL = /* wgsl */`
const TERRAIN_WORLD_PERIOD: f32 = ${ WORLD.worldPeriod.toFixed( 1 ) };
const TERRAIN_SATELLITE_COUNT: u32 = ${ SATELLITES.length }u;
const TERRAIN_SATELLITE_FRAMES = array<vec4f, ${ SATELLITES.length }>(
	${ SATELLITE_FRAMES_WGSL }
);
// shape (atoll/volcanic/twins/crescent/glacial/faroe), climate (warm/temperate/polar), variant, rock.
const TERRAIN_SATELLITE_META = array<vec4f, ${ SATELLITES.length }>(
	${ SATELLITE_META_WGSL }
);

fn terrainWrapXZ( xz: vec2f ) -> vec2f {
	let half = TERRAIN_WORLD_PERIOD * 0.5;
	return xz - floor( ( xz + vec2f( half ) ) / TERRAIN_WORLD_PERIOD ) * TERRAIN_WORLD_PERIOD;
}

// (normalised radius, polar angle, downrange cosine, irregular rim-height multiplier).
// This is the GPU twin of TerrainData.craterProfileDelta: a slightly offset, direction-aware
// crater frame with a non-circular edge, derived from the shell's horizontal impact direction.
fn terrainCraterFrame( worldXZ: vec2f, crater: vec4f, shape: vec4f ) -> vec4f {
	var dv = terrainWrapXZ( worldXZ ) - crater.xy;
	dv -= round( dv / TERRAIN_WORLD_PERIOD ) * TERRAIN_WORLD_PERIOD;
	dv += shape.xy * crater.z * shape.z * 0.055;
	let along = dot( dv, shape.xy ) / max( crater.z, 0.01 ) / ( 1.0 + shape.z * 0.13 );
	let cross = dot( dv, vec2f( -shape.y, shape.x ) ) / max( crater.z, 0.01 ) / ( 1.0 - shape.z * 0.035 );
	let angle = atan2( cross, along );
	let downrange = cos( angle );
	let edge = 1.0 + sin( angle * 5.0 + shape.w ) * 0.055
		+ sin( angle * 9.0 - shape.w * 0.73 ) * 0.03
		+ cos( angle * 13.0 + shape.w * 0.37 ) * 0.018
		+ downrange * shape.z * 0.055;
	let rimNoise = 0.82 + 0.18 * sin( angle * 7.0 - shape.w * 1.31 )
		+ 0.1 * sin( angle * 11.0 + shape.w * 0.41 );
	return vec4f( length( vec2f( along, cross ) ) / max( edge, 0.82 ), angle, downrange, rimNoise );
}

fn terrainCraterDelta( worldXZ: vec2f ) -> f32 {
	var delta = 0.0;
	for ( var i = 0; i < ${ TERRAIN_CRATERS }; i++ ) {
		if ( f32( i ) >= terrainParams.craterCount ) { break; }
		let crater = terrainParams.craters[ i ];
		let shape = terrainParams.craterShapes[ i ];
		let cf = terrainCraterFrame( worldXZ, crater, shape );
		if ( cf.x < 1.5 ) {
			// Constant-slope excavation cavity, irregular low rim and a thin discontinuous ejecta apron.
			let bowl = -crater.w * max( 0.0, 1.0 - cf.x / 0.82 );
			let rim = crater.w * 0.185 * cf.w * smoothstep( 0.68, 0.88, cf.x ) * ( 1.0 - smoothstep( 0.88, 1.09, cf.x ) );
			let lobes = 0.55 + 0.45 * smoothstep( -0.35, 0.8,
				sin( cf.y * 3.0 + shape.w * 0.6 ) * sin( cf.y * 5.0 - shape.w ) );
			let direction = 0.72 + shape.z * 0.38 * max( cf.z, -0.25 );
			let apron = crater.w * 0.042 * lobes * direction
				* smoothstep( 0.91, 1.04, cf.x ) * ( 1.0 - smoothstep( 1.04, 1.48, cf.x ) );
			delta += bowl + rim + apron;
		}
	}
	return delta;
}

// Add the dynamic crater slope to the baked terrain normal. Evaluated only in the tiny affected
// area by Terrain.js, so four extra height-field probes do not tax the rest of the landscape.
fn terrainCraterNormal( worldXZ: vec2f, baseN: vec3f ) -> vec3f {
	let e = 0.16;
	let gx = ( terrainCraterDelta( worldXZ + vec2f( e, 0.0 ) ) - terrainCraterDelta( worldXZ - vec2f( e, 0.0 ) ) ) / ( 2.0 * e );
	let gz = ( terrainCraterDelta( worldXZ + vec2f( 0.0, e ) ) - terrainCraterDelta( worldXZ - vec2f( 0.0, e ) ) ) / ( 2.0 * e );
	let ny = max( baseN.y, 0.05 );
	return normalize( vec3f( baseN.x / ny - gx, 1.0, baseN.z / ny - gz ) );
}

// Permanent blast scorching. This is deliberately separate from the height delta so material
// layers applied later (especially polar snow and glacier ice) cannot paint over the impact mark.
fn terrainCraterScorch( worldXZ: vec2f ) -> f32 {
	var scorch = 0.0;
	for ( var i = 0; i < ${ TERRAIN_CRATERS }; i++ ) {
		if ( f32( i ) >= terrainParams.craterCount ) { break; }
		let crater = terrainParams.craters[ i ];
		let shape = terrainParams.craterShapes[ i ];
		let cf = terrainCraterFrame( worldXZ, crater, shape );
		let core = 1.0 - smoothstep( 0.56, 0.93, cf.x );
		let burntRim = smoothstep( 0.56, 0.76, cf.x ) * ( 1.0 - smoothstep( 0.98, 1.14, cf.x ) ) * 0.86;
		let lobes = smoothstep( -0.2, 0.72,
			sin( cf.y * 3.0 + shape.w * 0.6 ) * sin( cf.y * 5.0 - shape.w ) );
		let outer = 1.0 - smoothstep( 1.04, 1.34 + lobes * 0.2 + max( cf.z, 0.0 ) * shape.z * 0.16, cf.x );
		let ejecta = smoothstep( 0.84, 1.0, cf.x ) * outer * mix( 0.12, 0.42, lobes );
		scorch = max( scorch, max( core, max( burntRim, ejecta ) ) );
	}
	return saturate( scorch );
}

fn terrainUvOf( xz: vec2f ) -> vec2f {
	return ( terrainWrapXZ( xz ) - terrainParams.origin ) / terrainParams.size;
}

fn terrainEllipseQ( p: vec2f, c: vec2f, r: vec2f ) -> f32 {
	return length( ( p - c ) / r );
}

fn terrainSegmentDistance( p: vec2f, a: vec2f, b: vec2f ) -> f32 {
	let ab = b - a;
	let t = clamp( dot( p - a, ab ) / max( dot( ab, ab ), 1e-4 ), 0.0, 1.0 );
	return length( p - a - ab * t );
}

fn terrainFaroeFjord( p: vec2f, frame: vec4f, variant: f32 ) -> f32 {
	let angle = ( variant - 2.0 ) * 0.12; let c = cos( angle ); let s = sin( angle );
	let d = p - frame.xy;
	let q = vec2f( d.x * c + d.y * s, -d.x * s + d.y * c );
	let r = min( frame.z, frame.w );
	let west = 1.0 - smoothstep( r * 0.075, r * 0.145, terrainSegmentDistance( q, vec2f( -frame.z * 1.16, -frame.w * 0.24 ), vec2f( -frame.z * 0.08, frame.w * 0.02 ) ) );
	let east = 1.0 - smoothstep( r * 0.065, r * 0.13, terrainSegmentDistance( q, vec2f( frame.z * 1.15, frame.w * 0.3 ), vec2f( frame.z * 0.16, frame.w * 0.1 ) ) );
	let hanging = 1.0 - smoothstep( r * 0.045, r * 0.09, terrainSegmentDistance( q, vec2f( -frame.z * 0.18, frame.w * 1.08 ), vec2f( -frame.z * 0.08, frame.w * 0.38 ) ) );
	return max( west, max( east, hanging * 0.72 ) );
}

fn terrainSatelliteMeta( island: f32 ) -> vec4f {
	return TERRAIN_SATELLITE_META[ u32( island ) - 1u ];
}

fn terrainSatelliteFrame( island: f32 ) -> vec4f {
	return TERRAIN_SATELLITE_FRAMES[ u32( island ) - 1u ];
}

// d (signed coast distance), q (shape radius), island index, rock. The authored home island stays
// in its texture; all other islands are analytic across the 60 km torus.
fn terrainSatelliteData( worldXZ: vec2f ) -> vec4f {
	let p = terrainWrapXZ( worldXZ );
	var best = vec4f( 1e5, 1e5, 0.0, 0.0 );
	for ( var i = 0u; i < TERRAIN_SATELLITE_COUNT; i++ ) {
		let frame = TERRAIN_SATELLITE_FRAMES[ i ]; let satInfo = TERRAIN_SATELLITE_META[ i ];
		let local = p - frame.xy; let v = local / frame.zw;
		let q0 = length( v ); let a = atan2( v.y, v.x );
		var d = 1e5; var q = q0;
		if ( satInfo.x == 1.0 ) {
			let coast = 1.0 + sin( a * 5.0 + 0.4 ) * 0.075 + sin( a * 11.0 - 0.9 ) * 0.035;
			let lagoon = 0.42 + sin( a * 3.0 - 0.3 ) * 0.025;
			d = max( ( q0 - coast ) * min( frame.z, frame.w ), ( lagoon - q0 ) * min( frame.z, frame.w ) ); q = q0 / coast;
		} else if ( satInfo.x == 2.0 ) {
			let coast = 1.0 + sin( a * 3.0 + 0.6 ) * 0.13 + sin( a * 7.0 - 0.8 ) * 0.055;
			d = ( q0 - coast ) * min( frame.z, frame.w ); q = q0 / coast;
		} else if ( satInfo.x == 3.0 ) {
			let qa = terrainEllipseQ( p, frame.xy + vec2f( -frame.z * 0.29, -frame.w * 0.18 ), vec2f( frame.z * 0.52, frame.w * 0.56 ) );
			let qb = terrainEllipseQ( p, frame.xy + vec2f( frame.z * 0.32, frame.w * 0.22 ), vec2f( frame.z * 0.47, frame.w * 0.66 ) );
			let qn = terrainEllipseQ( p, frame.xy + vec2f( frame.z * 0.02, frame.w * 0.02 ), vec2f( frame.z * 0.56, frame.w * 0.36 ) );
			let ds = vec3f( ( qa - 1.0 ) * frame.w * 0.56, ( qb - 1.0 ) * frame.z * 0.47, ( qn - 1.0 ) * frame.w * 0.36 );
			d = min( ds.x, min( ds.y, ds.z ) ); q = select( select( qn, qb, ds.y <= ds.z ), qa, ds.x <= min( ds.y, ds.z ) );
		} else if ( satInfo.x == 4.0 ) {
			let turn = -0.32 + satInfo.z * 0.07; let ca = cos( turn ); let sa = sin( turn );
			let r = vec2f( local.x * ca - local.y * sa, local.x * sa + local.y * ca );
			let qo = length( r / frame.zw ); let qc = length( ( r - vec2f( frame.z * 0.13, frame.w * 0.46 ) ) / vec2f( frame.z * 0.58, frame.w * 0.63 ) );
			d = max( ( qo - 1.0 ) * min( frame.z, frame.w ), -( qc - 1.0 ) * frame.w * 0.63 ); q = qo;
		} else if ( satInfo.x == 6.0 ) {
			let coast = 1.0 + sin( a * 5.0 + satInfo.z * 0.8 ) * 0.075 + sin( a * 11.0 - 0.9 ) * 0.03;
			let fjord = terrainFaroeFjord( p, frame, satInfo.z );
			// A zero fjord mask means no cut. Feeding -4 into max() here used to cap all non-fjord
			// inland distance at four metres and reduced every Faroe plateau to flat ground.
			let fjordCut = select( -1e5, fjord * min( frame.z, frame.w ) * 0.1 - 4.0, fjord > 0.0 );
			d = max( ( q0 - coast ) * min( frame.z, frame.w ), fjordCut ); q = q0 / coast;
		} else {
			let phase = satInfo.z * 0.73;
			let coast = 1.0 + sin( a * 4.0 - 0.5 + phase ) * 0.1 + sin( a * 9.0 + 0.7 - phase ) * 0.045 + cos( a * 13.0 + phase ) * 0.025;
			d = ( q0 - coast ) * min( frame.z, frame.w ); q = q0 / coast;
		}
		if ( d < best.x ) { best = vec4f( d, q, f32( i + 1u ), satInfo.w ); }
	}
	return best;
}

fn terrainLatticeHash( p: vec2i, seed: u32 ) -> f32 {
	var h = ( bitcast<u32>( p.x ) * 0x8da6b343u ) ^ ( bitcast<u32>( p.y ) * 0xd8163841u ) ^ ( seed * 0xcb1ab31fu );
	h ^= h >> 13u;
	h *= 0x85ebca6bu;
	h ^= h >> 16u;
	return f32( h ) / 4294967295.0 * 2.0 - 1.0;
}

fn terrainValueNoise( p: vec2f, seed: u32 ) -> f32 {
	let cell = vec2i( floor( p ) );
	let f = fract( p );
	let u = f * f * f * ( f * ( f * 6.0 - 15.0 ) + 10.0 );
	let a = terrainLatticeHash( cell, seed );
	let b = terrainLatticeHash( cell + vec2i( 1, 0 ), seed );
	let c = terrainLatticeHash( cell + vec2i( 0, 1 ), seed );
	let d = terrainLatticeHash( cell + vec2i( 1, 1 ), seed );
	return mix( mix( a, b, u.x ), mix( c, d, u.x ), u.y );
}

// Domain-warped Musgrave ridged multifractal. Keep this byte-for-byte structurally equivalent to
// satelliteGeology in Archipelago.js so analytic rendering and CPU collision stay aligned.
fn terrainSatelliteGeology( xz: vec2f, kind: f32 ) -> vec3f {
	let seed = u32( kind ) * 101u + 17u;
	let wx = xz.x + terrainValueNoise( xz / 430.0, seed + 11u ) * 135.0;
	let wz = xz.y + terrainValueNoise( xz / 430.0 + vec2f( 19.7, -31.1 ), seed + 29u ) * 135.0;
	let warped = vec2f( wx, wz );
	var sum = 0.0; var amp = 1.0; var frequency = 1.0; var weight = 1.0; var norm = 0.0;
	for ( var octave = 0u; octave < 4u; octave++ ) {
		var ridgeSignal = 1.0 - abs( terrainValueNoise( warped / 190.0 * frequency, seed + octave * 47u ) );
		ridgeSignal *= ridgeSignal;
		ridgeSignal *= weight;
		sum += ridgeSignal * amp;
		norm += amp;
		weight = saturate( ridgeSignal * 2.05 );
		frequency *= 2.03;
		amp *= 0.52;
	}
	return vec3f( sum / norm, terrainValueNoise( warped / 330.0, seed + 71u ), terrainValueNoise( warped / 72.0, seed + 89u ) );
}

fn terrainSatelliteMultifractalFromGeology( geology: vec3f, core: f32 ) -> f32 {
	let mountain = pow( max( 0.0, ( geology.x - 0.22 ) / 0.78 ), 1.22 );
	return core * ( mountain * 17.0 + geology.y * 3.5 + geology.z * 0.9 );
}

fn terrainGlacierEllipse( p: vec2f, c0: vec2f, radii: vec2f, angle: f32 ) -> f32 {
	let d = p - c0; let c = cos( angle ); let s = sin( angle );
	let r = vec2f( d.x * c + d.y * s, -d.x * s + d.y * c );
	return 1.0 - smoothstep( 0.72, 1.06, length( r / radii ) );
}

fn terrainPolarGlacier( xz: vec2f, coastQ: f32, island: f32 ) -> f32 {
	let frame = terrainSatelliteFrame( island ); let satInfo = terrainSatelliteMeta( island );
	let angle = ( satInfo.z - 3.0 ) * 0.11; let ca = cos( angle ); let sa = sin( angle );
	let d = xz - frame.xy;
	let p = vec2f( d.x * ca + d.y * sa, -d.x * sa + d.y * ca );
	let scale = vec2f( frame.z / 1000.0, frame.w / 850.0 );
	let cap = terrainGlacierEllipse( p, vec2f( 0.0, -35.0 * scale.y ), vec2f( 560.0, 455.0 ) * scale, 0.05 ) * 0.9;
	let eastTongue = terrainGlacierEllipse( p, vec2f( 245.0 * scale.x, 135.0 * scale.y ), vec2f( 570.0, 175.0 ) * scale, 0.42 );
	let westTongue = terrainGlacierEllipse( p, vec2f( -285.0 * scale.x, -85.0 * scale.y ), vec2f( 520.0, 160.0 ) * scale, -0.38 );
	let crown = max( 0.0, 1.0 - coastQ );
	return saturate( max( cap, max( eastTongue, westTongue ) ) * smoothstep( 0.045, 0.18, crown ) );
}

fn terrainSatelliteEscarpmentsFromGeology( geology: vec3f, core: f32, kind: f32 ) -> f32 {
	let satInfo = terrainSatelliteMeta( kind );
	var amplitude = 8.0;
	if ( satInfo.x == 1.0 ) { amplitude = 3.5; }
	if ( satInfo.y == 1.0 ) { amplitude = 10.0; }
	if ( satInfo.y == 2.0 ) { amplitude = 11.0; }
	let strata = geology.x + geology.y * 0.13 + geology.z * 0.035;
	let face = 0.38 + smoothstep( -0.3, 0.48, geology.y ) * 0.62;
	let steps = ( smoothstep( 0.38, 0.435, strata ) * 0.62
		+ smoothstep( 0.59, 0.64, strata ) * 0.88 ) * amplitude * face;
	let crest = pow( max( 0.0, ( geology.x - 0.48 ) / 0.52 ), 2.4 );
	let ridgeGate = smoothstep( 0.08, 0.24, core ) * ( 1.0 - smoothstep( 0.9, 1.0, core ) );
	return ( steps + crest * amplitude * 1.35 ) * ridgeGate;
}

fn terrainSatelliteBareRock( xz: vec2f, coastQ: f32, kind: f32 ) -> f32 {
	if ( kind <= 0.0 ) { return 0.0; }
	let satInfo = terrainSatelliteMeta( kind );
	var threshold = 0.46;
	if ( satInfo.x == 1.0 ) { threshold = 0.63; }
	if ( satInfo.y == 1.0 ) { threshold = 0.54; }
	if ( satInfo.y == 2.0 ) { threshold = 0.5; }
	let geology = terrainSatelliteGeology( xz, kind );
	let field = geology.x * 0.76 + ( geology.y * 0.5 + 0.5 ) * 0.16 + ( geology.z * 0.5 + 0.5 ) * 0.08;
	let crown = max( 0.0, 1.0 - coastQ );
	return smoothstep( threshold, 0.78, field ) * smoothstep( 0.055, 0.16, crown );
}

fn terrainAnalyticHeight( xz: vec2f ) -> f32 {
	let s = terrainSatelliteData( xz );
	let satInfo = terrainSatelliteMeta( s.z );
	let frame = terrainSatelliteFrame( s.z );
	let d = s.x;
	if ( d >= 0.0 ) {
		var depth = select( d * 0.05, 3.5 + ( d - 70.0 ) * 0.06, d >= 70.0 );
		depth = select( depth, 14.9 + ( d - 260.0 ) * 0.07, d >= 260.0 );
		depth = select( depth, 45.7 + ( d - 700.0 ) * 0.05, d >= 700.0 );
		var seabed = -min( depth, 85.0 ) + sin( xz.x * 0.013 + xz.y * 0.009 ) * smoothstep( 60.0, 400.0, d ) * 2.0;
		if ( satInfo.x == 6.0 ) {
			let fjord = terrainFaroeFjord( terrainWrapXZ( xz ), frame, satInfo.z );
			let basin = fjord * smoothstep( 0.04, 0.24, 1.0 - s.y ) * ( 1.0 - smoothstep( 0.78, 0.96, s.y ) );
			seabed -= basin * 16.0;
		}
		return seabed;
	}
	let e = -d;
	var h = select( e * 0.068, 2.584 + ( e - 38.0 ) * 0.03, e >= 38.0 );
	h = select( h, 3.544 + ( e - 70.0 ) * 0.075, e >= 70.0 );
	h = select( h, 15.544 + ( e - 230.0 ) * 0.04, e >= 230.0 );
	let spine = max( 0.0, 1.0 - s.y );
	// Fjord water can lie close to the island centre, where the radial spine is still large. Grow the
	// plateau from the real signed shoreline so distant LOD triangles cannot form saw teeth.
	let faroeShoreCore = select( spine, spine * smoothstep( 0.0, 96.0, e ), satInfo.x == 6.0 );
	let reliefCore = select( faroeShoreCore, min( 1.0, e / 70.0 ), satInfo.x == 1.0 );
	let geology = terrainSatelliteGeology( xz, s.z );
	let fantasyRidges = terrainSatelliteMultifractalFromGeology( geology, reliefCore );
	h += fantasyRidges * 0.12;
	let escarpments = terrainSatelliteEscarpmentsFromGeology( geology, reliefCore, s.z );
	if ( satInfo.x == 1.0 ) { h = min( 4.2, h * 0.72 ) + fantasyRidges * 1.4 + escarpments; }
	if ( satInfo.y == 0.0 && satInfo.x != 1.0 ) {
		let p1 = exp( -pow( ( xz.x - frame.x + frame.z * 0.14 ) / ( frame.z * 0.34 ), 2.0 ) - pow( ( xz.y - frame.y + frame.w * 0.08 ) / ( frame.w * 0.38 ), 2.0 ) );
		let p2 = exp( -pow( ( xz.x - frame.x - frame.z * ( 0.26 + ( satInfo.z - floor( satInfo.z / 2.0 ) * 2.0 ) * 0.05 ) ) / ( frame.z * 0.27 ), 2.0 ) - pow( ( xz.y - frame.y - frame.w * 0.24 ) / ( frame.w * 0.29 ), 2.0 ) );
		let p3 = exp( -pow( ( xz.x - frame.x + frame.z * 0.32 ) / ( frame.z * 0.23 ), 2.0 ) - pow( ( xz.y - frame.y - frame.w * 0.27 ) / ( frame.w * 0.26 ), 2.0 ) );
		h += spine * 18.0 + p1 * 58.0 + p2 * 38.0 + p3 * 27.0 + fantasyRidges + escarpments;
	}
	if ( satInfo.y == 1.0 ) {
		let benches = ( smoothstep( 0.1, 0.14, faroeShoreCore ) + smoothstep( 0.34, 0.39, faroeShoreCore ) * 0.8 + smoothstep( 0.62, 0.68, faroeShoreCore ) * 0.55 ) * 5.0;
		h += smoothstep( 0.015, 0.14, faroeShoreCore ) * 17.0 + pow( faroeShoreCore, 1.22 ) * 27.0 + benches + fantasyRidges * 1.3 + escarpments;
	}
	if ( satInfo.y == 2.0 ) {
		let glacier = terrainPolarGlacier( xz, s.y, s.z );
		let crags = max( 0.0, fantasyRidges ) * 1.65;
		h += smoothstep( 0.02, 0.16, spine ) * 12.0 + pow( spine, 1.35 ) * 95.0
			+ crags * ( 1.0 - glacier * 0.82 ) + escarpments * ( 1.0 - glacier * 0.42 )
			+ glacier * ( 7.0 + spine * 11.0 );
	}
	return h;
}

fn terrainDetailed( p: vec2f ) -> bool {
	let f = ( p - terrainParams.origin ) / terrainParams.size * terrainParams.res - 0.5;
	return f.x >= 0.0 && f.y >= 0.0 && f.x < terrainParams.res - 1.0 && f.y < terrainParams.res - 1.0;
}

// Remote-island ecological bands.  The seabed is always sediment first; warm and temperate
// shallows can grow patchy seagrass, then the land moves through beach, meadow/forest and rock.
fn terrainSatelliteSplat( p: vec2f ) -> vec4f {
	let a = terrainSatelliteData( p );
	let satInfo = terrainSatelliteMeta( a.z );
	let h = terrainAnalyticHeight( p );
	let depth = -h;
	let polar = satInfo.y == 2.0;
	let temperate = satInfo.y == 1.0;
	var beachTop = 5.2;
	if ( temperate ) { beachTop = 2.8; }
	if ( polar ) { beachTop = 3.6; }
	if ( satInfo.x == 1.0 ) { beachTop = 3.8; }
	var sand = 1.0 - smoothstep( 1.2, beachTop, h );
	if ( h < 0.0 ) { sand = 1.0; }
	let seaPatch = sin( p.x * 0.014 + p.y * 0.009 ) * sin( p.y * 0.021 - p.x * 0.006 ) * 0.5 + 0.5;
	var seagrass = smoothstep( 1.3, 2.6, depth ) * ( 1.0 - smoothstep( 8.5, 13.0, depth )) * smoothstep( 0.28, 0.62, seaPatch );
	if ( polar || h >= 0.0 ) { seagrass = 0.0; }
	var rubble = select( 0.0, smoothstep( 2.0, 4.0, depth ) * ( 1.0 - smoothstep( 12.0, 17.0, depth ) ) * a.w * smoothstep( 0.58, 0.82, 1.0 - seaPatch ), h < 0.0 );
	// Polar shallows are uninterrupted black frozen sand. Rock fragments begin only above the
	// waterline, where the terrain material scatters them across the exposed strand.
	if ( polar ) { rubble = 0.0; }
	return vec4f( sand, 0.0, seagrass, rubble );
}

// exact bilinear height at world xz (matches TerrainData.heightAt)
fn terrainHeightAt( xz: vec2f ) -> f32 {
	let p = terrainWrapXZ( xz );
	let res = terrainParams.res;
	let f = ( p - terrainParams.origin ) / terrainParams.size * res - 0.5;
	if ( !terrainDetailed( p ) ) { return terrainAnalyticHeight( p ) + terrainCraterDelta( p ); }
	let fc = clamp( f, vec2f( 0.0 ), vec2f( res - 1.001 ) );
	let i = floor( fc );
	let t = fract( fc );
	let ii = vec2i( i );
	let a = textureLoad( terrainHeightTex, ii, 0 ).x;
	let b = textureLoad( terrainHeightTex, ii + vec2i( 1, 0 ), 0 ).x;
	let c = textureLoad( terrainHeightTex, ii + vec2i( 0, 1 ), 0 ).x;
	let d = textureLoad( terrainHeightTex, ii + vec2i( 1, 1 ), 0 ).x;
	let h = mix( mix( a, b, t.x ), mix( c, d, t.x ), t.y );
	return h + terrainCraterDelta( p );
}

// filtered normal (xz components), rock mask, ambient occlusion
fn terrainNormalRock( xz: vec2f ) -> vec4f {
	let p = terrainWrapXZ( xz );
	if ( !terrainDetailed( p ) ) {
		let e = 2.0;
		let gx = ( terrainAnalyticHeight( p + vec2f( e, 0.0 ) ) - terrainAnalyticHeight( p - vec2f( e, 0.0 ) ) ) / ( 2.0 * e );
		let gz = ( terrainAnalyticHeight( p + vec2f( 0.0, e ) ) - terrainAnalyticHeight( p - vec2f( 0.0, e ) ) ) / ( 2.0 * e );
		let n = normalize( vec3f( -gx, 1.0, -gz ) );
		let a = terrainSatelliteData( p );
		var exposed = terrainSatelliteBareRock( p, a.y, a.z );
		if ( terrainSatelliteMeta( a.z ).y == 2.0 ) { exposed *= 1.0 - terrainPolarGlacier( p, a.y, a.z ) * 0.72; }
		let rock = max( a.w * smoothstep( 0.05, 0.3, 1.0 - n.y ), exposed );
		return vec4f( n.x, n.z, rock, 1.0 );
	}
	let s = textureSample( terrainNormalTex, smpLinearClamp, terrainUvOf( p ) );
	return vec4f( s.xy * 2.0 - 1.0, s.z, s.w );
}
// explicit mip (e.g. in the vertex stage)
fn terrainNormalRockLevel( xz: vec2f, level: f32 ) -> vec4f {
	let p = terrainWrapXZ( xz );
	if ( !terrainDetailed( p ) ) {
		let e = max( 2.0, exp2( level ) );
		let gx = ( terrainAnalyticHeight( p + vec2f( e, 0.0 ) ) - terrainAnalyticHeight( p - vec2f( e, 0.0 ) ) ) / ( 2.0 * e );
		let gz = ( terrainAnalyticHeight( p + vec2f( 0.0, e ) ) - terrainAnalyticHeight( p - vec2f( 0.0, e ) ) ) / ( 2.0 * e );
		let n = normalize( vec3f( -gx, 1.0, -gz ) ); let a = terrainSatelliteData( p );
		var exposed = terrainSatelliteBareRock( p, a.y, a.z );
		if ( terrainSatelliteMeta( a.z ).y == 2.0 ) { exposed *= 1.0 - terrainPolarGlacier( p, a.y, a.z ) * 0.72; }
		let rock = max( a.w * smoothstep( 0.05, 0.3, 1.0 - n.y ), exposed );
		return vec4f( n.x, n.z, rock, 1.0 );
	}
	let s = textureSampleLevel( terrainNormalTex, smpLinearClamp, terrainUvOf( p ), level );
	return vec4f( s.xy * 2.0 - 1.0, s.z, s.w );
}
fn terrainNormalAt( xz: vec2f ) -> vec3f {
	let nr = terrainNormalRockLevel( xz, 0.0 );
	return normalize( vec3f( nr.x, sqrt( max( 1.0 - nr.x * nr.x - nr.y * nr.y, 0.0025 ) ), nr.y ) );
}

// loose sand, worn ground / paths, gullies (land) or seagrass (seabed), seabed rubble (the
// eroded beach scarp face on land)
fn terrainSplat( xz: vec2f ) -> vec4f {
	let p = terrainWrapXZ( xz );
	if ( !terrainDetailed( p ) ) { return terrainSatelliteSplat( p ); }
	return textureSample( terrainSplatTex, smpLinearClamp, terrainUvOf( p ) );
}
fn terrainSplatLevel( xz: vec2f, level: f32 ) -> vec4f {
	let p = terrainWrapXZ( xz );
	if ( !terrainDetailed( p ) ) { return terrainSatelliteSplat( p ); }
	return textureSampleLevel( terrainSplatTex, smpLinearClamp, terrainUvOf( p ), level );
}

// authored biome overrides: meadow, forest, snow, reserved
fn terrainBiome( xz: vec2f ) -> vec4f {
	let p = terrainWrapXZ( xz );
	if ( !terrainDetailed( p ) ) {
		let a = terrainSatelliteData( p ); let h = terrainAnalyticHeight( p );
		let satInfo = terrainSatelliteMeta( a.z );
		if ( satInfo.y == 2.0 ) {
			// Keep the polar climate mask across the visible submarine shelf. Previously this branch
			// only ran on land, so the first submerged metre abruptly fell back to tropical yellow sand.
			// Fade it before the deep ocean so the glacial island does not tint its whole Voronoi sector.
			let polarShelf = 1.0 - smoothstep( 550.0, 900.0, max( a.x, 0.0 ) );
			// No tundra band: black frozen strand hands directly to the glacier tongues and snowfields.
			let glacier = select( 0.0, terrainPolarGlacier( p, a.y, a.z ), a.x < 0.0 );
			let exposed = terrainSatelliteBareRock( p, a.y, a.z ) * ( 1.0 - glacier * 0.72 );
			let snow = select( 0.0, max( glacier * 0.98, smoothstep( 3.4, 9.0, h ) * ( 0.88 + 0.12 * smoothstep( 0.45, 0.9, 1.0 - a.y ) ) ) * ( 1.0 - exposed * 0.96 ), a.x < 0.0 );
			// Green is unused for polar vegetation and carries the dedicated glacier material mask.
			return vec4f( select( 0.0, 1.0, a.x < 0.0 ), glacier, snow, polarShelf );
		}
		if ( satInfo.y == 1.0 ) { return vec4f( 0.72, 0.0, 0.0, 0.55 ); }
		if ( satInfo.y == 0.0 && satInfo.x != 1.0 ) { return vec4f( smoothstep( 62.0, 88.0, h ) * 0.7, 0.0, 0.0, 0.0 ); }
		return vec4f( 0.0 );
	}
	return textureSample( terrainBiomeTex, smpLinearClamp, terrainUvOf( p ) );
}

// shore field: (T, dirX, dirZ, exposure), bilinear via loads (float32 data)
fn terrainShoreSample( xz: vec2f ) -> vec4f {
	let p = terrainWrapXZ( xz );
	if ( !terrainDetailed( p ) ) {
		// The authored island owns a Fast-Marching shore field. Generated islands do not have a
		// texture bake, so reconstruct a smooth local field from their analytic signed coast distance.
		// The finite-difference normal bends the incoming swell toward the beach while the facing term
		// suppresses breakers on lee shores. This avoids the old uniform rings glued to every coast.
		let satData = terrainSatelliteData( p );
		let coastDistance = satData.x;
		if ( coastDistance > 520.0 || coastDistance < -95.0 ) { return vec4f( 1e4, 0.0, 0.0, 0.0 ); }
		let eps = 5.0;
		let gx = terrainSatelliteData( p + vec2f( eps, 0.0 ) ).x - terrainSatelliteData( p - vec2f( eps, 0.0 ) ).x;
		let gz = terrainSatelliteData( p + vec2f( 0.0, eps ) ).x - terrainSatelliteData( p - vec2f( 0.0, eps ) ).x;
		let outward = normalize( vec2f( gx, gz ) + vec2f( 1e-5, 0.0 ) );
		let shoreward = -outward;
		let swell = normalize( vec2f( ${ WORLD.swellDir.x.toFixed( 7 ) }, ${ WORLD.swellDir.y.toFixed( 7 ) } ) );
		let facing = smoothstep( -0.12, 0.72, dot( shoreward, swell ) );
		let coastNoise = terrainValueNoise( p / 310.0, u32( satData.z ) * 67u + 19u ) * 0.5 + 0.5;
		let coastGate = ( 1.0 - smoothstep( 310.0, 500.0, coastDistance ) ) * smoothstep( -95.0, -22.0, coastDistance );
		let exposure = facing * coastGate * mix( 0.78, 1.0, coastNoise );

		// Deep water keeps the ocean swell direction. Across the shoaling shelf it refracts toward
		// the local coast normal and slows with sqrt(g*d), matching the Eikonal field's convention.
		let waterDistance = max( coastDistance, 0.0 );
		let refract = 1.0 - smoothstep( 28.0, 230.0, waterDistance );
		let travelDir = normalize( mix( swell, shoreward, refract * 0.9 ) + vec2f( 1e-5, 0.0 ) );
		let c0 = sqrt( 9.81 * 25.0 );
		let depth = max( -terrainAnalyticHeight( p ), 0.3 );
		let cNear = sqrt( 9.81 * min( depth, 25.0 ) );
		let coastPoint = p - outward * coastDistance;
		let shoreTime = dot( coastPoint, swell ) / c0 + terrainParams.size;
		let meanSpeed = max( mix( c0, cNear, 0.68 ), 1.7 );
		let travelTime = shoreTime - waterDistance / meanSpeed;
		return vec4f( travelTime, travelDir * exposure, shoreTime );
	}
	let res = terrainParams.shoreRes;
	let f = ( p - terrainParams.origin ) / terrainParams.size * res - 0.5;
	let fc = clamp( f, vec2f( 0.0 ), vec2f( max( res - 1.001, 0.0 ) ) );
	let i = floor( fc );
	let t = fract( fc );
	let ii = vec2i( i );
	let mx = vec2i( max( i32( res ) - 1, 0 ) );
	let a = textureLoad( terrainShoreTex, ii, 0 );
	let b = textureLoad( terrainShoreTex, min( ii + vec2i( 1, 0 ), mx ), 0 );
	let c = textureLoad( terrainShoreTex, min( ii + vec2i( 0, 1 ), mx ), 0 );
	let d = textureLoad( terrainShoreTex, min( ii + vec2i( 1, 1 ), mx ), 0 );
	return mix( mix( a, b, t.x ), mix( c, d, t.x ), t.y );
}

// 0 (in the terrain's shadow) .. 1 (lit) for a world position, soft penumbra that widens with the
// occluder distance
fn terrainSunShadowAt( P: vec3f ) -> f32 {
	if ( !terrainDetailed( terrainWrapXZ( P.xz ) ) ) { return 1.0; }
	let N = f32( textureDimensions( terrainSunShadowTex ).x );
	let st = clamp( terrainUvOf( P.xz ) * N - 0.5, vec2f( 0.0 ), vec2f( N - 1.001 ) );
	let i = vec2i( floor( st ) );
	let t = fract( st );
	let s = mix(
		mix( textureLoad( terrainSunShadowTex, i, 0 ), textureLoad( terrainSunShadowTex, i + vec2i( 1, 0 ), 0 ), t.x ),
		mix( textureLoad( terrainSunShadowTex, i + vec2i( 0, 1 ), 0 ), textureLoad( terrainSunShadowTex, i + vec2i( 1, 1 ), 0 ), t.x ),
		t.y
	);
	let w = s.y * 0.012 + 0.35;
	return mix( 1.0, smoothstep( -w, w, P.y - s.x ), terrainParams.sunBaked );
}
`;
