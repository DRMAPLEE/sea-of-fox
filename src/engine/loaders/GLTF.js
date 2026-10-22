// Binary glTF (.glb) reader for skinned, animated characters (engine side of loaders; the debris
// scans use the smaller world/debris/GLB.js). Returns plain data, no GPU objects:
//
//   const gltf = await loadGLB( url )            // or parseGLB( arrayBuffer )
//   gltf.nodes[ i ]  = { name, children: [ ... ], t: [ x, y, z ], r: [ x, y, z, w ], s: [ x, y, z ], mesh, skin }
//   gltf.roots       = scene root node indices
//   gltf.meshes[ i ] = [ { attributes: { POSITION: { array, itemSize, normalized }, ... }, indices, material } ]
//   gltf.skins[ i ]  = { joints: [ node indices ], inverseBindMatrices: Float32Array( 16 * n ) }
//   gltf.animations  = [ { name, duration, channels: [ { node, path: 'translation' | 'rotation' | 'scale', times, values } ] } ]
//   gltf.materials   = the glTF material objects (name, pbrMetallicRoughness, normalTexture, alphaMode, ...)
//   gltf.images[ i ] = { bytes: Uint8Array, mimeType }  (decode with decodeImage)
//
// Handled: embedded buffer, interleaved / packed accessors of every component type (normalized
// or not), node TRS or matrix, LINEAR / STEP samplers (CUBICSPLINE keeps the values, drops the
// tangents), and KHR_draco_mesh_compression. Not handled: external buffers, meshopt, sparse
// accessors, morph targets.
//
// Asset hooks for headless runs (no fetch of relative URLs / no image decoding in Node):
//   globalThis.__assetFile( url ) -> ArrayBuffer, globalThis.__assetImage( bytes, mimeType ) -> { data, width, height }

import { Matrix4, Quaternion, Vector3 } from '../math/index.js';
const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const ARRAYS = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const NORM = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 };
let dracoPromise = null;

function jsonChunk( buffer ) {

	const dv = new DataView( buffer );
	const length = dv.getUint32( 8, true );
	for ( let o = 12; o < length; ) {

		const len = dv.getUint32( o, true ), type = dv.getUint32( o + 4, true );
		if ( type === 0x4E4F534A ) return JSON.parse( new TextDecoder().decode( new Uint8Array( buffer, o + 8, len ) ) );
		o += 8 + len;

	}
	throw new Error( 'GLB: no JSON chunk' );

}

async function dracoDecoder() {

	if ( ! dracoPromise ) dracoPromise = Promise.all( [
		import( 'draco3dgltf/draco_decoder_gltf_nodejs.js' ),
		import( 'draco3dgltf/draco_decoder_gltf.wasm?url' ),
	] ).then( ( [ decoderModule, wasmModule ] ) => Promise.all( [ decoderModule.default, fetch( wasmModule.default ) ] ) )
		.then( ( [ createDracoDecoderModule, response ] ) => {

			if ( ! response.ok ) throw new Error( `Draco decoder ${ response.status }` );
			return Promise.all( [ createDracoDecoderModule, response.arrayBuffer() ] );

		} )
		.then( ( [ createDracoDecoderModule, wasmBinary ] ) => createDracoDecoderModule( { wasmBinary } ) );
	return dracoPromise;

}

export async function loadGLB( url ) {

	let buffer;
	if ( globalThis.__assetFile ) buffer = await globalThis.__assetFile( url );
	else {

		const res = await fetch( url );
		if ( ! res.ok ) throw new Error( 'GLB: ' + url + ' ' + res.status );
		buffer = await res.arrayBuffer();

	}

	const json = jsonChunk( buffer );
	const decoder = ( json.extensionsUsed || [] ).includes( 'KHR_draco_mesh_compression' ) ? await dracoDecoder() : null;
	return parseGLB( buffer, decoder );

}

export function parseGLB( buffer, draco = null ) {

	const dv = new DataView( buffer );
	if ( dv.getUint32( 0, true ) !== 0x46546C67 ) throw new Error( 'GLB: bad magic' );
	const length = dv.getUint32( 8, true );
	let json = null, bin = null;
	for ( let o = 12; o < length; ) {

		const len = dv.getUint32( o, true ), type = dv.getUint32( o + 4, true );
		if ( type === 0x4E4F534A ) json = JSON.parse( new TextDecoder().decode( new Uint8Array( buffer, o + 8, len ) ) );
		else if ( type === 0x004E4942 ) bin = new Uint8Array( buffer, o + 8, len );
		o += 8 + len;

	}

	if ( ! json ) throw new Error( 'GLB: no JSON chunk' );
	const supportedRequired = new Set( [ 'EXT_texture_webp', ...( draco ? [ 'KHR_draco_mesh_compression' ] : [] ) ] );
	const unsupported = ( json.extensionsRequired || [] ).filter( ( name ) => ! supportedRequired.has( name ) );
	if ( unsupported.length ) throw new Error( 'GLB: unsupported extensions ' + unsupported.join( ', ' ) );

	const viewBytes = ( i ) => {

		const bv = json.bufferViews[ i ];
		if ( bv.buffer !== 0 || ! bin ) throw new Error( 'GLB: external buffers are not supported' );
		return new Uint8Array( bin.buffer, bin.byteOffset + ( bv.byteOffset || 0 ), bv.byteLength );

	};

	// accessor -> tightly packed typed array
	const read = ( i ) => {

		const a = json.accessors[ i ];
		if ( a.sparse ) throw new Error( 'GLB: sparse accessors are not supported' );
		const n = COMPONENTS[ a.type ];
		const Arr = ARRAYS[ a.componentType ];
		const out = new Arr( a.count * n );
		if ( a.bufferView !== undefined ) {

			const bv = json.bufferViews[ a.bufferView ];
			const bytes = viewBytes( a.bufferView );
			const base = bytes.byteOffset + ( a.byteOffset || 0 );
			const size = Arr.BYTES_PER_ELEMENT;
			const stride = bv.byteStride || n * size;
			if ( stride === n * size && base % size === 0 ) out.set( new Arr( bytes.buffer, base, a.count * n ) );
			else {

				const src = new DataView( bytes.buffer );
				const get = {
					5120: ( o ) => src.getInt8( o ), 5121: ( o ) => src.getUint8( o ), 5122: ( o ) => src.getInt16( o, true ),
					5123: ( o ) => src.getUint16( o, true ), 5125: ( o ) => src.getUint32( o, true ), 5126: ( o ) => src.getFloat32( o, true ),
				}[ a.componentType ];
				for ( let k = 0; k < a.count; k ++ ) for ( let c = 0; c < n; c ++ ) out[ k * n + c ] = get( base + k * stride + c * size );

			}

		}

		return { array: out, itemSize: n, normalized: !! a.normalized, componentType: a.componentType };

	};

	// normalized integers -> floats
	const readFloat = ( i ) => {

		const r = read( i );
		if ( r.array instanceof Float32Array ) return r.array;
		const f = new Float32Array( r.array.length );
		const k = r.normalized ? 1 / NORM[ r.componentType ] : 1;
		for ( let j = 0; j < f.length; j ++ ) f[ j ] = Math.max( r.array[ j ] * k, - 1 );
		return f;

	};

	const decodeDracoPrimitive = ( extension ) => {

		if ( ! draco ) throw new Error( 'GLB: Draco mesh requires the asynchronous loadGLB() path' );
		const encoded = viewBytes( extension.bufferView );
		const buffer = new draco.DecoderBuffer();
		buffer.Init( new Int8Array( encoded.buffer, encoded.byteOffset, encoded.byteLength ), encoded.byteLength );
		const decoder = new draco.Decoder();
		const mesh = new draco.Mesh();
		const status = decoder.DecodeBufferToMesh( buffer, mesh );
		if ( ! status.ok() || mesh.ptr === 0 ) {

			const message = status.error_msg ? status.error_msg() : 'unknown error';
			draco.destroy( mesh ); draco.destroy( decoder ); draco.destroy( buffer );
			throw new Error( 'GLB: Draco decode failed: ' + message );

		}

		const attributes = {};
		for ( const semantic in extension.attributes ) {

			const attribute = decoder.GetAttributeByUniqueId( mesh, extension.attributes[ semantic ] );
			const itemSize = attribute.num_components();
			const values = new draco.DracoFloat32Array();
			decoder.GetAttributeFloatForAllPoints( mesh, attribute, values );
			const array = new Float32Array( mesh.num_points() * itemSize );
			for ( let i = 0; i < array.length; i ++ ) array[ i ] = values.GetValue( i );
			draco.destroy( values );
			attributes[ semantic ] = { array, itemSize, normalized: false, componentType: 5126 };

		}

		const indices = new Uint32Array( mesh.num_faces() * 3 );
		const face = new draco.DracoInt32Array();
		for ( let i = 0; i < mesh.num_faces(); i ++ ) {

			decoder.GetFaceFromMesh( mesh, i, face );
			indices[ i * 3 ] = face.GetValue( 0 );
			indices[ i * 3 + 1 ] = face.GetValue( 1 );
			indices[ i * 3 + 2 ] = face.GetValue( 2 );

		}
		draco.destroy( face ); draco.destroy( mesh ); draco.destroy( decoder ); draco.destroy( buffer );
		return { attributes, indices };

	};

	const m = new Matrix4(), t = new Vector3(), q = new Quaternion(), s = new Vector3();
	const nodes = ( json.nodes || [] ).map( ( n ) => {

		let T = n.translation || [ 0, 0, 0 ], R = n.rotation || [ 0, 0, 0, 1 ], S = n.scale || [ 1, 1, 1 ];
		if ( n.matrix ) {

			m.fromArray( n.matrix ).decompose( t, q, s );
			T = [ t.x, t.y, t.z ]; R = [ q.x, q.y, q.z, q.w ]; S = [ s.x, s.y, s.z ];

		}

		return { name: n.name || '', children: n.children || [], t: T.slice(), r: R.slice(), s: S.slice(), mesh: n.mesh, skin: n.skin };

	} );

	const meshes = ( json.meshes || [] ).map( ( me ) => me.primitives.map( ( p ) => {

		const compressed = p.extensions?.KHR_draco_mesh_compression;
		const decoded = compressed ? decodeDracoPrimitive( compressed ) : null;
		const attributes = decoded?.attributes || {};
		if ( ! compressed ) for ( const k in p.attributes ) attributes[ k ] = read( p.attributes[ k ] );
		if ( p.targets && p.targets.length ) console.warn( 'GLB: morph targets are ignored' );
		return { attributes, indices: decoded?.indices || ( p.indices !== undefined ? read( p.indices ).array : null ), material: p.material, mode: p.mode ?? 4 };

	} ) );

	const skins = ( json.skins || [] ).map( ( sk ) => ( {
		name: sk.name || '',
		joints: sk.joints,
		skeleton: sk.skeleton,
		inverseBindMatrices: sk.inverseBindMatrices !== undefined ? readFloat( sk.inverseBindMatrices ) : identities( sk.joints.length ),
	} ) );

	const animations = ( json.animations || [] ).map( ( an ) => {

		let duration = 0;
		const channels = [];
		for ( const ch of an.channels ) {

			if ( ch.target.node === undefined || ch.target.path === 'weights' ) continue;
			const smp = an.samplers[ ch.sampler ];
			const times = readFloat( smp.input );
			let values = readFloat( smp.output );
			const w = ch.target.path === 'rotation' ? 4 : 3;
			if ( smp.interpolation === 'CUBICSPLINE' ) {

				// keep the value of each (in-tangent, value, out-tangent) triple
				const v = new Float32Array( times.length * w );
				for ( let k = 0; k < times.length; k ++ ) for ( let c = 0; c < w; c ++ ) v[ k * w + c ] = values[ ( k * 3 + 1 ) * w + c ];
				values = v;

			}

			duration = Math.max( duration, times[ times.length - 1 ] );
			channels.push( { node: ch.target.node, path: ch.target.path, times, values, step: smp.interpolation === 'STEP' } );

		}

		// clips exported from a frame range start at t0 > 0: shift to 0
		let t0 = Infinity;
		for ( const c of channels ) t0 = Math.min( t0, c.times[ 0 ] );
		if ( t0 > 0 && t0 < Infinity ) {

			for ( const c of channels ) for ( let k = 0; k < c.times.length; k ++ ) c.times[ k ] -= t0;
			duration -= t0;

		}

		return { name: an.name || 'clip', duration, channels };

	} );

	const images = ( json.images || [] ).map( ( im ) => ( { bytes: im.bufferView !== undefined ? viewBytes( im.bufferView ) : null, mimeType: im.mimeType, uri: im.uri } ) );
	const scene = json.scenes ? json.scenes[ json.scene || 0 ] : null;
	const roots = scene ? scene.nodes : nodes.map( ( _, i ) => i ).filter( ( i ) => ! nodes.some( ( n ) => n.children.includes( i ) ) );

	return { json, nodes, roots, meshes, skins, animations, materials: json.materials || [], textures: json.textures || [], images };

}

function identities( n ) {

	const a = new Float32Array( n * 16 );
	for ( let i = 0; i < n; i ++ ) a[ i * 16 ] = a[ i * 16 + 5 ] = a[ i * 16 + 10 ] = a[ i * 16 + 15 ] = 1;
	return a;

}

// Decoded RGBA8 pixels (top row first) of an embedded image.
export async function decodeImage( bytes, mimeType ) {

	if ( globalThis.__assetImage ) return globalThis.__assetImage( bytes, mimeType );
	const bmp = await createImageBitmap( new Blob( [ bytes ], { type: mimeType } ), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' } );
	const cv = new OffscreenCanvas( bmp.width, bmp.height );
	const ctx = cv.getContext( '2d', { willReadFrequently: true } );
	ctx.drawImage( bmp, 0, 0 );
	const width = bmp.width, height = bmp.height;
	const d = ctx.getImageData( 0, 0, width, height ).data;
	// (read the size first: a closed ImageBitmap reports 0 x 0)
	bmp.close && bmp.close();
	return { data: new Uint8Array( d.buffer, d.byteOffset, d.byteLength ), width, height };

}
