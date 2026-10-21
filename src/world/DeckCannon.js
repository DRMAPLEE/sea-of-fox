import { Color, Group, Mesh, Quaternion, SphereGeometry, Vector3 } from '../engine/index.js';
import { Material } from '../engine/render/Material.js';
import { loadStaticGLTF } from '../engine/loaders/StaticGLTF.js';
import { LAYERS } from '../core/SceneRenderer.js';

const _origin = new Vector3();
const _forward = new Vector3();
const _velocity = new Vector3();
const _rotation = new Quaternion();
const _up = new Vector3( 0, 1, 0 );
const _assets = new Map();

function cannonAsset( url ) {

	if ( ! _assets.has( url ) ) _assets.set( url, loadStaticGLTF( url ) );
	return _assets.get( url );

}

// Authored broadside cannon mounted in a boat-local frame (+X port, +Y up, +Z bow).
// The source glTF exposes a Muzzle node whose local +Z points out of the barrel.
export class DeckCannon {

	constructor( { length = 4.2, audioUrl = null } = {} ) {

		this.length = length;
		this.audioUrl = audioUrl;
		this.group = new Group();
		this.group.name = 'DeckCannon';
		this.recoil = new Group();
		this.recoil.name = 'DeckCannonRecoil';
		this.group.add( this.recoil );
		this.asset = null;
		this.muzzle = null;
		this.flash = null;
		this.flashMaterial = null;
		this.light = null;
		this._shotTime = - 1;
		this._voices = [];
		this._voiceIndex = 0;

	}

	async load( url ) {

		// Every gun shares the decoded textures, materials and geometry; only its scene nodes,
		// recoil transform and muzzle flash are unique.
		const imported = await cannonAsset( url );
		const size = imported.bounds.getSize( new Vector3() );
		const center = imported.bounds.getCenter( new Vector3() );
		if ( ! ( size.x > 0.1 ) ) throw new Error( 'DeckCannon: imported model has invalid bounds' );

		const scale = this.length / size.x;
		const asset = imported.group.clone( true );
		asset.name = 'DeckCannonVisual';
		asset.scale.setScalar( scale );
		// Put the carriage on y=0 and its footprint centre at the mount origin. The cannon's
		// authored forward direction is +X after its glTF node transform, matching port on the boat.
		asset.position.set( - center.x * scale, - imported.bounds.min.y * scale, - center.z * scale );
		this.recoil.add( asset );

		const muzzle = asset.getObjectByName( 'Muzzle' );
		if ( ! muzzle ) throw new Error( 'DeckCannon: the glTF has no Muzzle node' );

		const flashMaterial = new Material( {
			name: 'cannon-muzzle-flash',
			lit: false,
			color: new Color( 1.0, 0.18, 0.015 ),
			emissive: new Color( 7.0, 1.6, 0.08 ),
			opacity: 0,
			transparent: true,
			blending: 'additive',
			depthWrite: false,
			receiveShadows: false,
		} );
		const flash = new Mesh( new SphereGeometry( 0.1, 12, 8 ), flashMaterial );
		flash.name = 'CannonMuzzleFlash';
		flash.position.z = 0.12;
		flash.scale.set( 0.7, 0.7, 2.7 );
		flash.visible = false;
		flash.frustumCulled = false;
		flash.layers.set( LAYERS.TRANSPARENT );
		muzzle.add( flash );

		this.asset = asset;
		this.muzzle = muzzle;
		this.flash = flash;
		this.flashMaterial = flashMaterial;
		this.materials = imported.materials;
		return this;

	}

	mount( parent, position, heading = 0 ) {

		this.group.position.copy( position );
		this.group.rotation.y = heading;
		parent.add( this.group );
		return this;

	}

	addLight( lights ) {

		if ( ! lights || ! this.muzzle || this.light ) return this.light;
		const cannon = this;
		this.light = lights.add( {
			position: new Vector3(),
			color: new Color( 1.0, 0.22, 0.025 ),
			intensity: 210,
			range: 18,
			kind: 'cannonFlash',
			alwaysOn: true,
			enabled: false,
			scale: 0,
			update() {

				const t = cannon._shotTime;
				this.enabled = t >= 0 && t < 0.2;
				if ( ! this.enabled ) {

					this.scale = 0;
					return;

				}
				cannon.muzzle.getWorldPosition( this.position );
				cannon.muzzle.getWorldQuaternion( _rotation );
				_forward.set( 0, 0, 1 ).applyQuaternion( _rotation ).normalize();
				this.position.addScaledVector( _forward, 0.16 );
				// A near-instant white-hot peak followed by the slower orange gas glow.
				const attack = Math.min( 1, t / 0.012 );
				this.scale = attack * Math.exp( - t * 18 );

			},
		} );
		return this.light;

	}

	fire( spray = null, sound = true ) {

		if ( ! this.muzzle ) return false;
		this._shotTime = 0;
		this.flash.visible = true;
		this.flashMaterial.opacity = 1;

		this.muzzle.getWorldPosition( _origin );
		this.muzzle.getWorldQuaternion( _rotation );
		_forward.set( 0, 0, 1 ).applyQuaternion( _rotation ).normalize();
		_origin.addScaledVector( _forward, 0.1 );

		// Reuse the existing GPU particle field for the fast smoke plug and the slower cloud.
		if ( spray ) {

			_velocity.copy( _forward ).multiplyScalar( 15 ).addScaledVector( _up, 1.5 );
			spray.emit( _origin, _velocity, 120, 0.1, 3, { spread: 4.2, jitter: 0.22, life: 1.25, sizeJitter: 0.75 } );
			_velocity.copy( _forward ).multiplyScalar( 5 ).addScaledVector( _up, 1.8 );
			spray.emit( _origin, _velocity, 70, 0.32, 1, { spread: 2.2, jitter: 0.3, life: 3.2, sizeJitter: 0.7 } );

		}

		if ( sound ) this._playSound();
		return true;

	}

	update( dt ) {

		if ( this._shotTime < 0 ) return;
		this._shotTime += Math.max( 0, dt );
		const t = this._shotTime;
		const kickDuration = 0.075;
		const returnDuration = 0.52;
		let offset;

		if ( t <= kickDuration ) {

			const p = t / kickDuration;
			offset = 0.28 * ( 1 - Math.pow( 1 - p, 3 ) );

		} else {

			const p = Math.min( ( t - kickDuration ) / returnDuration, 1 );
			offset = 0.28 * Math.pow( 1 - p, 3 );
			if ( p >= 1 ) this._shotTime = - 1;

		}

		// The barrel fires along boat-local +X, so the carriage kicks toward -X.
		this.recoil.position.x = - offset;
		if ( t < 0.12 ) {

			const fade = 1 - t / 0.12;
			const pulse = 0.75 + 0.5 * Math.sin( Math.min( 1, t / 0.12 ) * Math.PI );
			this.flashMaterial.opacity = fade;
			this.flash.scale.set( 0.7 * pulse, 0.7 * pulse, 2.7 * pulse );

		} else this.flash.visible = false;

		if ( this._shotTime < 0 ) {

			this.recoil.position.set( 0, 0, 0 );
			this.flash.visible = false;

		}

	}

	_playSound() {

		if ( ! this.audioUrl || typeof Audio !== 'function' ) return;
		if ( this._voices.length === 0 ) {

			for ( let i = 0; i < 4; i ++ ) {

				const voice = new Audio( this.audioUrl );
				voice.preload = 'auto';
				voice.volume = 0.82;
				this._voices.push( voice );

			}

		}
		const voice = this._voices[ this._voiceIndex ];
		this._voiceIndex = ( this._voiceIndex + 1 ) % this._voices.length;
		voice.currentTime = 0;
		voice.play().catch( ( error ) => {

			if ( error.name !== 'AbortError' ) console.warn( 'cannon sound failed', error );

		} );

	}

}
