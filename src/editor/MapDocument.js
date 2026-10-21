const DB_NAME = 'tidewater-map-editor';
const STORE_NAME = 'maps';
const AUTOSAVE_KEY = 'autosave';

function bytesToBase64( bytes ) {

	let out = '';
	const step = 0x8000;
	for ( let i = 0; i < bytes.length; i += step ) out += String.fromCharCode( ...bytes.subarray( i, i + step ) );
	return btoa( out );

}

function base64ToBytes( value ) {

	const raw = atob( value || '' );
	const out = new Uint8Array( raw.length );
	for ( let i = 0; i < raw.length; i ++ ) out[ i ] = raw.charCodeAt( i );
	return out;

}

function typedBytes( array ) {

	return new Uint8Array( array.buffer, array.byteOffset, array.byteLength );

}

function openDatabase() {

	return new Promise( ( resolve, reject ) => {

		const request = indexedDB.open( DB_NAME, 1 );
		request.onupgradeneeded = () => request.result.createObjectStore( STORE_NAME );
		request.onerror = () => reject( request.error );
		request.onsuccess = () => resolve( request.result );

	} );

}

export async function saveLocalDocument( document ) {

	const db = await openDatabase();
	await new Promise( ( resolve, reject ) => {

		const tx = db.transaction( STORE_NAME, 'readwrite' );
		tx.objectStore( STORE_NAME ).put( document, AUTOSAVE_KEY );
		tx.oncomplete = resolve;
		tx.onerror = () => reject( tx.error );

	} );
	db.close();

}

export async function loadLocalDocument() {

	const db = await openDatabase();
	const value = await new Promise( ( resolve, reject ) => {

		const tx = db.transaction( STORE_NAME, 'readonly' );
		const request = tx.objectStore( STORE_NAME ).get( AUTOSAVE_KEY );
		request.onsuccess = () => resolve( request.result || null );
		request.onerror = () => reject( request.error );

	} );
	db.close();
	return value;

}

// Tracks the first value touched at every texel. A saved map therefore contains only differences
// from Tidewater's procedural base island instead of a 40+ MB copy of every terrain layer.
export class TerrainPatchTracker {

	constructor( terrain ) {

		this.terrain = terrain;
		this.channels = {
			heights: { array: terrain.heights, Type: Float32Array },
			rock: { array: terrain.rock, Type: Float32Array },
			sand: { array: terrain.sand, Type: Uint8Array },
			path: { array: terrain.path, Type: Uint8Array },
			seagrass: { array: terrain.seagrass, Type: Uint8Array },
			rubble: { array: terrain.rubble, Type: Uint8Array },
			meadow: { array: terrain.meadow, Type: Uint8Array },
			forest: { array: terrain.forest, Type: Uint8Array },
			snow: { array: terrain.snow, Type: Uint8Array },
		};
		for ( const [ key, meta ] of Object.entries( this.channels ) ) if ( ! meta.array ) delete this.channels[ key ];
		this.originals = Object.fromEntries( Object.keys( this.channels ).map( ( key ) => [ key, new Map() ] ) );

	}

	recordOriginal( channel, index, value ) {

		const map = this.originals[ channel ];
		if ( map && ! map.has( index ) ) map.set( index, value );

	}

	restoreBaseline() {

		for ( const [ key, map ] of Object.entries( this.originals ) ) {

			const array = this.channels[ key ].array;
			for ( const [ index, value ] of map ) array[ index ] = value;
			map.clear();

		}

	}

	serialize() {

		const result = {};
		for ( const [ key, meta ] of Object.entries( this.channels ) ) {

			const changed = [];
			for ( const [ index, original ] of this.originals[ key ] ) if ( meta.array[ index ] !== original ) changed.push( index );
			if ( ! changed.length ) continue;
			changed.sort( ( a, b ) => a - b );
			const indices = Uint32Array.from( changed );
			const values = new meta.Type( changed.length );
			for ( let i = 0; i < changed.length; i ++ ) values[ i ] = meta.array[ changed[ i ] ];
			result[ key ] = {
				count: changed.length,
				indices: bytesToBase64( typedBytes( indices ) ),
				values: bytesToBase64( typedBytes( values ) ),
			};

		}
		return result;

	}

	apply( patches = {} ) {

		for ( const [ key, patch ] of Object.entries( patches ) ) {

			const meta = this.channels[ key ];
			if ( ! meta || ! patch?.count ) continue;
			const ib = base64ToBytes( patch.indices );
			const vb = base64ToBytes( patch.values );
			const indices = new Uint32Array( ib.buffer, ib.byteOffset, patch.count );
			const values = new meta.Type( vb.buffer, vb.byteOffset, patch.count );
			for ( let i = 0; i < patch.count; i ++ ) {

				const index = indices[ i ];
				if ( index >= meta.array.length ) continue;
				this.recordOriginal( key, index, meta.array[ index ] );
				meta.array[ index ] = values[ i ];

			}

		}

	}

}

export function createMapDocument( { name, terrainPatches, entities, assets, view } ) {

	return {
		format: 'tidewater-map',
		version: 1,
		name: name || 'Untitled island',
		updatedAt: new Date().toISOString(),
		base: { kind: 'procedural', seed: 7, terrainSize: 2048, terrainResolution: 2048 },
		terrainPatches,
		entities,
		assets,
		view,
	};

}

export function validateMapDocument( document ) {

	if ( ! document || document.format !== 'tidewater-map' ) throw new Error( '这不是 Tidewater 地图文件。' );
	if ( document.version !== 1 ) throw new Error( `不支持地图版本 ${ document.version }。` );
	if ( ! Array.isArray( document.entities ) || ! Array.isArray( document.assets ) ) throw new Error( '地图实体数据不完整。' );
	return document;

}
