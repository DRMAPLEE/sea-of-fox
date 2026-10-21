import { BufferAttribute } from '../geometry/BufferAttribute.js';
import { BufferGeometry } from '../geometry/BufferGeometry.js';
import { Texture } from '../gpu/Texture.js';
import { generateMipmaps } from '../gpu/Mipmaps.js';
import { Box3, Color, Vector3 } from '../math/index.js';
import { Material } from '../render/Material.js';
import { Group } from '../scene/Group.js';
import { Mesh } from '../scene/Mesh.js';
import { decodeImage, loadGLB } from './GLTF.js';

// Static glTF scene builder for the custom renderer. The lower-level GLTF loader intentionally
// returns plain data; this turns that data into engine geometry, textures and PBR materials while
// preserving the glTF node hierarchy. Skinned characters continue to use render/Skinning.js.

const _point = new Vector3();

function toFloat( attribute ) {

	if ( attribute.array instanceof Float32Array ) return attribute.array;
	let scale = 1;
	if ( attribute.normalized ) {

		if ( attribute.array instanceof Uint8Array ) scale = 1 / 255;
		else if ( attribute.array instanceof Uint16Array ) scale = 1 / 65535;
		else if ( attribute.array instanceof Int8Array ) scale = 1 / 127;
		else if ( attribute.array instanceof Int16Array ) scale = 1 / 32767;

	}
	return Float32Array.from( attribute.array, ( value ) => Math.max( - 1, value * scale ) );

}

function indexAttribute( indices ) {

	if ( indices instanceof Uint16Array || indices instanceof Uint32Array ) return new BufferAttribute( indices, 1 );
	const ArrayType = indices.length > 65535 ? Uint32Array : Uint16Array;
	return new BufferAttribute( ArrayType.from( indices ), 1 );

}

function materialColor( factor, fallback = [ 1, 1, 1 ] ) {

	const c = factor || fallback;
	return new Color().setRGB( c[ 0 ], c[ 1 ], c[ 2 ] );

}

function staticMaterial( gltfMaterial, textures ) {

	const pbr = gltfMaterial.pbrMetallicRoughness || {};
	const alphaMode = gltfMaterial.alphaMode || 'OPAQUE';
	const bindings = {};
	if ( textures.albedo ) bindings.gltfAlbedo = textures.albedo;
	if ( textures.normal ) bindings.gltfNormal = textures.normal;
	if ( textures.orm ) bindings.gltfOrm = textures.orm;
	if ( textures.emissive ) bindings.gltfEmissive = textures.emissive;

	return new Material( {
		name: 'gltf-' + ( gltfMaterial.name || 'material' ),
		textures: bindings,
		color: materialColor( pbr.baseColorFactor ),
		opacity: pbr.baseColorFactor?.[ 3 ] ?? 1,
		emissive: materialColor( gltfMaterial.emissiveFactor, [ 0, 0, 0 ] ),
		roughness: pbr.roughnessFactor ?? 1,
		metalness: pbr.metallicFactor ?? 1,
		side: gltfMaterial.doubleSided ? 'double' : 'front',
		transparent: alphaMode === 'BLEND',
		alphaTest: alphaMode === 'MASK' ? gltfMaterial.alphaCutoff ?? 0.5 : 0,
		defines: {
			GLTF_ALBEDO: textures.albedo ? 1 : 0,
			GLTF_NORMAL: textures.normal ? 1 : 0,
			GLTF_ORM: textures.orm ? 1 : 0,
			GLTF_EMISSIVE: textures.emissive ? 1 : 0,
		},
		surface: /* wgsl */`
#if GLTF_ALBEDO
	let albedoSample = textureSample( gltfAlbedo, smpAnisoRepeat, in.uv );
	s.albedo *= albedoSample.rgb;
	s.alpha *= albedoSample.a;
#endif
#if GLTF_ORM
	let ormSample = textureSample( gltfOrm, smpAnisoRepeat, in.uv );
	s.roughness *= ormSample.g;
	s.metalness *= ormSample.b;
#endif
#if GLTF_NORMAL
	let normalSample = textureSample( gltfNormal, smpAnisoRepeat, in.uv ).xyz * 2.0 - 1.0;
	s.normal = perturbNormalByMap( in.P, in.N, in.uv, normalSample );
#endif
#if GLTF_EMISSIVE
	s.emissive *= textureSample( gltfEmissive, smpAnisoRepeat, in.uv ).rgb;
#endif
`,
	} );

}

async function textureSet( gltf ) {

	const cache = new Map();
	const texture = async ( info, srgb ) => {

		if ( ! info ) return null;
		const source = gltf.textures[ info.index ]?.source;
		if ( source === undefined ) return null;
		const key = source + ( srgb ? ':srgb' : ':linear' );
		if ( ! cache.has( key ) ) {

			const image = gltf.images[ source ];
			if ( ! image?.bytes ) throw new Error( 'StaticGLTF: external images are not supported' );
			const pixels = await decodeImage( image.bytes, image.mimeType );
			const gpuTexture = new Texture( {
				label: 'gltf-image-' + source,
				width: pixels.width,
				height: pixels.height,
				format: srgb ? 'rgba8unorm-srgb' : 'rgba8unorm',
				data: pixels.data,
				mips: true,
				usage: [ 'sample', 'copyDst' ],
				sampler: 'anisoRepeat',
			} );
			gpuTexture.getGPU();
			generateMipmaps( gpuTexture );
			cache.set( key, gpuTexture );

		}
		return cache.get( key );

	};

	const sets = [];
	for ( const source of gltf.materials ) {

		const pbr = source.pbrMetallicRoughness || {};
		sets.push( {
			albedo: await texture( pbr.baseColorTexture, true ),
			normal: await texture( source.normalTexture, false ),
			orm: await texture( pbr.metallicRoughnessTexture, false ),
			emissive: await texture( source.emissiveTexture, true ),
		} );

	}
	return sets;

}

function geometryFor( primitive ) {

	if ( primitive.mode !== 4 ) throw new Error( `StaticGLTF: primitive mode ${ primitive.mode } is not supported` );
	const source = primitive.attributes;
	if ( ! source.POSITION ) throw new Error( 'StaticGLTF: primitive has no positions' );
	const geometry = new BufferGeometry();
	geometry.setAttribute( 'position', new BufferAttribute( toFloat( source.POSITION ), 3 ) );
	if ( source.NORMAL ) geometry.setAttribute( 'normal', new BufferAttribute( toFloat( source.NORMAL ), 3 ) );
	if ( source.TEXCOORD_0 ) geometry.setAttribute( 'uv', new BufferAttribute( toFloat( source.TEXCOORD_0 ), 2 ) );
	if ( primitive.indices ) geometry.setIndex( indexAttribute( primitive.indices ) );
	if ( ! source.NORMAL ) geometry.computeVertexNormals();
	geometry.computeBoundingBox();
	geometry.computeBoundingSphere();
	return geometry;

}

export async function createStaticGLTF( gltf ) {

	const root = new Group();
	root.name = gltf.json.scenes?.[ gltf.json.scene || 0 ]?.name || 'StaticGLTF';
	const textureSets = await textureSet( gltf );
	const materials = gltf.materials.map( ( source, i ) => staticMaterial( source, textureSets[ i ] ) );
	const nodes = gltf.nodes.map( ( source, i ) => {

		const node = new Group();
		node.name = source.name || `node-${ i }`;
		node.position.set( source.t[ 0 ], source.t[ 1 ], source.t[ 2 ] );
		node.quaternion.set( source.r[ 0 ], source.r[ 1 ], source.r[ 2 ], source.r[ 3 ] );
		node.scale.set( source.s[ 0 ], source.s[ 1 ], source.s[ 2 ] );
		if ( source.mesh !== undefined ) for ( const primitive of gltf.meshes[ source.mesh ] ) {

			const geometry = geometryFor( primitive );
			const material = materials[ primitive.material ] || staticMaterial( {}, {} );
			const mesh = new Mesh( geometry, material );
			mesh.name = node.name + ':mesh';
			mesh.castShadow = true;
			mesh.receiveShadow = true;
			node.add( mesh );

		}
		return node;

	} );

	for ( let i = 0; i < gltf.nodes.length; i ++ ) for ( const child of gltf.nodes[ i ].children ) nodes[ i ].add( nodes[ child ] );
	for ( const index of gltf.roots ) root.add( nodes[ index ] );

	root.updateMatrixWorld( true );
	const bounds = new Box3().makeEmpty();
	root.traverse( ( object ) => {

		const position = object.geometry?.getAttribute?.( 'position' );
		if ( ! position ) return;
		for ( let i = 0; i < position.count; i ++ ) bounds.expandByPoint( _point.fromBufferAttribute( position, i ).applyMatrix4( object.matrixWorld ) );

	} );

	return { group: root, bounds, materials };

}

export async function loadStaticGLTF( url ) {

	return createStaticGLTF( await loadGLB( url ) );

}
