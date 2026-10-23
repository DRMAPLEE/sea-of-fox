import { Group, Matrix4, Vector3 } from '../engine/index.js';
import { loadStaticGLTF } from '../engine/loaders/StaticGLTF.js';
import { HUMANOID_ACTION } from './HumanoidAnimations.js';

const RIGHT_HAND_NAMES = [ 'mixamorig:RightHand', 'RightHand', 'right_hand', 'hand_r' ];
const _boneMatrix = new Matrix4();
const _boneScale = new Vector3();

// Static equipment attached to an animated CPU bone transform. SkinnedModel evaluates the whole
// skeleton on the CPU before uploading joint matrices, so the exact same pose can drive props.
export class HumanoidEquipment {

	constructor( model ) {

		this.model = model;
		this.handNode = RIGHT_HAND_NAMES.map( ( name ) => model.gltf.nodes.findIndex( ( node ) => node.name === name ) ).find( ( index ) => index >= 0 ) ?? - 1;
		this.socket = new Group();
		this.socket.name = 'RightHandEquipmentSocket';
		model.group.add( this.socket );
		this.items = new Map();
		this.mode = null;

	}

	async add( id, url, { length = 1, grip = [ 0, 0, 0 ], rotation = [ 0, 0, 0 ], offset = [ 0, 0, 0 ] } = {} ) {

		const asset = await loadStaticGLTF( url );
		const size = asset.bounds.getSize( new Vector3() );
		const span = Math.max( size.x, size.y, size.z );
		const mount = new Group();
		mount.name = `Equipment:${ id }`;
		mount.position.set( offset[ 0 ], offset[ 1 ], offset[ 2 ] );
		mount.rotation.set( rotation[ 0 ], rotation[ 1 ], rotation[ 2 ] );
		mount.scale.setScalar( span > 1e-5 ? length / span : 1 );
		asset.group.position.set( - grip[ 0 ], - grip[ 1 ], - grip[ 2 ] );
		asset.group.traverse( ( object ) => {

			if ( object.material ) object.material.underwaterLighting = 'lite';

		} );
		mount.add( asset.group );
		mount.visible = false;
		this.socket.add( mount );
		this.items.set( id, mount );
		return mount;

	}

	setMode( action ) {

		this.mode = action;
		const gun = action === HUMANOID_ACTION.HELM_GUN || action === HUMANOID_ACTION.GUN_AIM || action === HUMANOID_ACTION.GUN_AIM_RUN;
		const sword = action === HUMANOID_ACTION.ATTACK;
		if ( this.items.has( 'gun' ) ) this.items.get( 'gun' ).visible = gun;
		if ( this.items.has( 'sword' ) ) this.items.get( 'sword' ).visible = sword;

	}

	update( action ) {

		if ( this.handNode < 0 ) return;
		_boneMatrix.fromArray( this.model.world, this.handNode * 16 ).decompose( this.socket.position, this.socket.quaternion, _boneScale );
		this.socket.scale.copy( _boneScale );
		this.setMode( action );

	}

}
