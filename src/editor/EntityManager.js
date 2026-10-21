import { Box3, BoxGeometry, Color, CylinderGeometry, Group, Mesh, Sphere, SphereGeometry, TorusGeometry, Vector3 } from '../engine/index.js';
import { standard } from '../materials/Materials.js';
import { createStaticGLTF } from '../engine/loaders/StaticGLTF.js';
import { parseGLB } from '../engine/loaders/GLTF.js';
import { DynamicMeshCollider } from '../world/DynamicMeshCollider.js';

const _point = new Vector3();
const _sphere = new Sphere();

function uid( prefix = 'entity' ) {

	return `${ prefix }-${ Date.now().toString( 36 ) }-${ Math.random().toString( 36 ).slice( 2, 8 ) }`;

}

function bytesToBase64( bytes ) {

	let out = '';
	for ( let i = 0; i < bytes.length; i += 0x8000 ) out += String.fromCharCode( ...bytes.subarray( i, i + 0x8000 ) );
	return btoa( out );

}

function base64ToBuffer( value ) {

	const raw = atob( value );
	const bytes = new Uint8Array( raw.length );
	for ( let i = 0; i < raw.length; i ++ ) bytes[ i ] = raw.charCodeAt( i );
	return bytes.buffer;

}

function material( name, hex, opacity = 1 ) {

	return standard( {
		name, color: new Color().setHex( hex ), roughness: 0.78, metalness: 0.02,
		opacity, transparent: opacity < 1, depthWrite: opacity >= 1, side: opacity < 1 ? 'double' : 'front',
	} );

}

function mesh( geometry, mat, { x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1 } = {} ) {

	const value = new Mesh( geometry, mat );
	value.position.set( x, y, z );
	value.scale.set( sx, sy, sz );
	value.castShadow = true;
	value.receiveShadow = true;
	return value;

}

function crateFactory() {

	const root = new Group();
	const wood = material( 'editorCrate', 0x8f6f49 );
	root.add( mesh( new BoxGeometry( 1.8, 1.45, 1.5 ), wood, { y: 0.725 } ) );
	const band = material( 'editorCrateBand', 0x343a38 );
	root.add( mesh( new BoxGeometry( 1.88, 0.12, 1.58 ), band, { y: 0.3 } ) );
	root.add( mesh( new BoxGeometry( 1.88, 0.12, 1.58 ), band, { y: 1.15 } ) );
	return root;

}

function beaconFactory() {

	const root = new Group();
	const stone = material( 'editorBeaconStone', 0x8c918c );
	const cap = material( 'editorBeaconCap', 0x334b4c );
	root.add( mesh( new CylinderGeometry( 0.75, 1.05, 4.8, 12 ), stone, { y: 2.4 } ) );
	root.add( mesh( new CylinderGeometry( 1.05, 0.92, 0.3, 12 ), cap, { y: 4.9 } ) );
	root.add( mesh( new SphereGeometry( 0.48, 16, 8 ), material( 'editorBeaconLight', 0xb8d8c9 ), { y: 5.55 } ) );
	return root;

}

function boulderFactory() {

	const root = new Group();
	root.add( mesh( new SphereGeometry( 1.2, 10, 7 ), material( 'editorBoulder', 0x686d66 ), { y: 0.88, sx: 1.2, sy: 0.78, sz: 0.95 } ) );
	return root;

}

const BUILT_INS = [
	{ id: 'crate', name: '木箱', category: '道具', factory: crateFactory, size: [ 1.9, 1.5, 1.6 ] },
	{ id: 'beacon', name: '航标塔', category: '建筑', factory: beaconFactory, size: [ 2.1, 6.1, 2.1 ] },
	{ id: 'boulder', name: '巨石', category: '自然', factory: boulderFactory, size: [ 2.9, 2.1, 2.3 ] },
];

export class EntityManager {

	constructor( { app, onChange = () => {}, onSelect = () => {}, interactive = true } ) {

		this.app = app;
		this.scene = app.scene;
		this.terrain = app.terrainData;
		this.colliders = app.colliders;
		this.onChange = onChange;
		this.onSelect = onSelect;
		this.interactive = interactive;
		this.assets = new Map( BUILT_INS.map( ( asset ) => [ asset.id, asset ] ) );
		this.importedAssets = [];
		this.entities = [];
		this.selected = null;
		this.helperMaterial = interactive ? material( 'editorCollider', 0x8fc7bd, 0.2 ) : null;
		this.selectionMaterial = interactive ? material( 'editorSelection', 0xb6d8d0, 0.72 ) : null;
		this.colliderHelper = null;
		this.selectionRing = null;
		if ( interactive ) {

			this.selectionRing = mesh( new TorusGeometry( 1, 0.035, 5, 48 ), this.selectionMaterial );
			this.selectionRing.rotation.x = Math.PI / 2;
			this.selectionRing.visible = false;
			this.selectionRing.castShadow = false;
			this.selectionRing.receiveShadow = false;
			this.scene.add( this.selectionRing );

		}

	}

	listAssets() {

		return [ ...this.assets.values() ];

	}

	async importAsset( file ) {

		const buffer = await file.arrayBuffer();
		const imported = await createStaticGLTF( parseGLB( buffer ) );
		const size = imported.bounds.getSize( new Vector3() );
		const id = uid( 'asset' );
		const asset = {
			id, name: file.name.replace( /\.glb$/i, '' ) || '导入模型', category: '导入',
			factory: () => imported.group.clone( true ),
			size: [ Math.max( 0.1, size.x ), Math.max( 0.1, size.y ), Math.max( 0.1, size.z ) ],
			groundOffset: - imported.bounds.min.y,
			data: bytesToBase64( new Uint8Array( buffer ) ),
		};
		this.assets.set( id, asset );
		this.importedAssets.push( asset );
		return asset;

	}

	async loadAssets( assets = [] ) {

		for ( const saved of assets ) {

			const imported = await createStaticGLTF( parseGLB( base64ToBuffer( saved.data ) ) );
			const asset = {
				...saved,
				factory: () => imported.group.clone( true ),
				data: saved.data,
			};
			this.assets.set( asset.id, asset );
			this.importedAssets.push( asset );

		}

	}

	resetImportedAssets() {

		for ( const asset of this.importedAssets ) this.assets.delete( asset.id );
		this.importedAssets.length = 0;

	}

	add( assetId, x, z, saved = null ) {

		const asset = this.assets.get( assetId );
		if ( ! asset ) throw new Error( `找不到实体资源 ${ assetId}` );
		const visual = asset.factory();
		const root = new Group();
		root.name = `${ this.interactive ? 'Editor' : 'Map' }Entity:${ asset.name }`;
		visual.position.y = asset.groundOffset || 0;
		root.add( visual );
		const size = asset.size || [ 1, 1, 1 ];
		const data = saved ? structuredClone( saved ) : {
			id: uid(), assetId, name: asset.name,
			position: [ x, this.terrain.heightAt( x, z ), z ], rotationY: 0, scale: 1,
			snapToTerrain: true,
			collider: { type: 'box', size: [ ...size ], offsetY: size[ 1 ] * 0.5, solid: true, walkable: false },
		};
		root.position.fromArray( data.position );
		root.rotation.y = data.rotationY || 0;
		root.scale.setScalar( data.scale || 1 );
		this.scene.add( root );
		const entity = { data, root, visual, asset, colliderRef: null, meshCollider: null };
		this.entities.push( entity );
		this._syncCollider( entity );
		if ( this.interactive ) this.select( entity );
		this.onChange();
		return entity;

	}

	select( entity ) {

		this.selected = entity || null;
		this._updateHelpers();
		this.onSelect( this.selected );

	}

	removeSelected() {

		const entity = this.selected;
		if ( ! entity ) return false;
		this._removeCollider( entity );
		entity.root.removeFromParent();
		this.entities.splice( this.entities.indexOf( entity ), 1 );
		this.select( null );
		this.onChange();
		return true;

	}

	clear() {

		for ( const entity of [ ...this.entities ] ) {

			this._removeCollider( entity );
			entity.root.removeFromParent();

		}
		this.entities.length = 0;
		this.select( null );

	}

	updateSelected( patch ) {

		const entity = this.selected;
		if ( ! entity ) return;
		Object.assign( entity.data, patch );
		if ( entity.data.snapToTerrain ) entity.data.position[ 1 ] = this.terrain.heightAt( entity.data.position[ 0 ], entity.data.position[ 2 ] );
		entity.root.position.fromArray( entity.data.position );
		entity.root.rotation.y = entity.data.rotationY || 0;
		entity.root.scale.setScalar( entity.data.scale || 1 );
		this._syncCollider( entity );
		this._updateHelpers();
		this.onChange();

	}

	moveSelectedTo( x, z ) {

		if ( ! this.selected ) return;
		const y = this.selected.data.snapToTerrain ? this.terrain.heightAt( x, z ) : this.selected.data.position[ 1 ];
		this.updateSelected( { position: [ x, y, z ] } );

	}

	pick( ray ) {

		let best = null, bestDistance = Infinity;
		for ( const entity of this.entities ) {

			const size = entity.asset.size || [ 1, 1, 1 ];
			const scale = entity.data.scale || 1;
			_sphere.center.set( entity.root.position.x, entity.root.position.y + size[ 1 ] * scale * 0.5, entity.root.position.z );
			_sphere.radius = Math.max( ...size ) * scale * 0.65;
			const hit = ray.intersectSphere( _sphere, _point );
			if ( ! hit ) continue;
			const distance = ray.origin.distanceToSquared( hit );
			if ( distance < bestDistance ) { bestDistance = distance; best = entity; }

		}
		return best;

	}

	_removeCollider( entity ) {

		const ref = entity.colliderRef;
		if ( ! ref ) return;
		const list = ref.kind === 'box' ? this.colliders.boxes : ref.kind === 'cylinder' ? this.colliders.cylinders : this.colliders.meshes;
		const index = list.indexOf( ref.value );
		if ( index >= 0 ) list.splice( index, 1 );
		entity.colliderRef = null;

	}

	_syncCollider( entity ) {

		this._removeCollider( entity );
		const c = entity.data.collider;
		if ( ! c || c.type === 'none' ) return;
		const p = entity.data.position, scale = entity.data.scale || 1;
		if ( c.type === 'mesh' ) {

			entity.root.updateWorldMatrix( true, true );
			entity.meshCollider ||= DynamicMeshCollider.fromObject( entity.visual, entity.root );
			const value = this.colliders.addMesh( entity.meshCollider, entity.root, {
				solid: c.solid !== false, walkable: !! c.walkable, tag: `editor:${ entity.data.id }`,
			} );
			entity.colliderRef = { kind: 'mesh', value };

		} else if ( c.type === 'cylinder' ) {

			const radius = Math.max( 0.05, ( c.radius || c.size?.[ 0 ] * 0.5 || 0.5 ) * scale );
			const height = Math.max( 0.05, ( c.height || c.size?.[ 1 ] || 1 ) * scale );
			const value = this.colliders.addCylinder( p[ 0 ], p[ 2 ], radius, p[ 1 ] + ( c.offsetY || 0 ) * scale - height * 0.5, p[ 1 ] + ( c.offsetY || 0 ) * scale + height * 0.5, { tag: `editor:${ entity.data.id }` } );
			entity.colliderRef = { kind: 'cylinder', value };

		} else {

			const size = c.size || [ 1, 1, 1 ];
			const center = new Vector3( p[ 0 ], p[ 1 ] + ( c.offsetY || size[ 1 ] * 0.5 ) * scale, p[ 2 ] );
			const half = new Vector3( size[ 0 ] * scale * 0.5, size[ 1 ] * scale * 0.5, size[ 2 ] * scale * 0.5 );
			const value = this.colliders.addBox( center, half, entity.data.rotationY || 0, { solid: c.solid !== false, walkable: !! c.walkable, tag: `editor:${ entity.data.id }` } );
			entity.colliderRef = { kind: 'box', value };

		}

	}

	_updateHelpers() {

		if ( ! this.interactive ) return;
		this.colliderHelper?.removeFromParent();
		this.colliderHelper = null;
		const entity = this.selected;
		if ( ! entity ) {

			this.selectionRing.visible = false;
			return;

		}
		const p = entity.data.position, scale = entity.data.scale || 1;
		const assetSize = entity.asset.size || [ 1, 1, 1 ];
		this.selectionRing.visible = true;
		this.selectionRing.position.set( p[ 0 ], p[ 1 ] + 0.04, p[ 2 ] );
		this.selectionRing.scale.setScalar( Math.max( assetSize[ 0 ], assetSize[ 2 ] ) * scale * 0.68 );
		const c = entity.data.collider;
		if ( ! c || c.type === 'none' ) return;
		let helper;
		if ( c.type === 'mesh' ) return;
		if ( c.type === 'cylinder' ) {

			const radius = ( c.radius || c.size?.[ 0 ] * 0.5 || 0.5 ) * scale;
			const height = ( c.height || c.size?.[ 1 ] || 1 ) * scale;
			helper = mesh( new CylinderGeometry( radius, radius, height, 20 ), this.helperMaterial );
			helper.position.set( p[ 0 ], p[ 1 ] + ( c.offsetY || 0 ) * scale, p[ 2 ] );

		} else {

			const size = c.size || [ 1, 1, 1 ];
			helper = mesh( new BoxGeometry( size[ 0 ] * scale, size[ 1 ] * scale, size[ 2 ] * scale ), this.helperMaterial );
			helper.position.set( p[ 0 ], p[ 1 ] + ( c.offsetY || size[ 1 ] * 0.5 ) * scale, p[ 2 ] );
			helper.rotation.y = entity.data.rotationY || 0;

		}
		helper.castShadow = false;
		helper.receiveShadow = false;
		this.colliderHelper = helper;
		this.scene.add( helper );

	}

	serializeEntities() {

		return this.entities.map( ( entity ) => structuredClone( entity.data ) );

	}

	serializeAssets() {

		return this.importedAssets.map( ( asset ) => ( {
			id: asset.id, name: asset.name, category: asset.category, size: asset.size,
			groundOffset: asset.groundOffset || 0, data: asset.data,
		} ) );

	}

	async loadEntities( saved = [] ) {

		for ( const data of saved ) this.add( data.assetId, data.position[ 0 ], data.position[ 2 ], data );
		this.select( null );

	}

	dispose() {

		this.clear();
		this.selectionRing?.removeFromParent();
		this.colliderHelper?.removeFromParent();
		this.helperMaterial?.dispose?.();
		this.selectionMaterial?.dispose?.();

	}

}
