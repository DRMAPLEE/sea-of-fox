import { loadGLB } from '../engine/loaders/GLTF.js';
import { SkinnedModel } from '../engine/render/Skinning.js';
import { HUMANOID_ACTION, HumanoidAnimator, SPECTRAL_SEA_HOUND_PROFILE } from './HumanoidAnimations.js';
import { HumanoidActionAudio } from './HumanoidAudio.js';
import { HumanoidEquipment } from './HumanoidEquipment.js';

export class HumanoidAvatar {

	static async load( url, profile = SPECTRAL_SEA_HOUND_PROFILE, sound = null ) {

		const model = await SkinnedModel.create( await loadGLB( url ) );
		for ( const material of model.materials ) material.underwaterLighting = 'lite';
		const avatar = new HumanoidAvatar( model, profile, sound );
		avatar.model.update( 0 );
		return avatar;

	}

	constructor( model, profile, sound = null ) {

		this.model = model;
		this.group = model.group;
		this.group.name = 'PlayerAvatar';
		this.animator = new HumanoidAnimator( model, profile );
		this.audio = new HumanoidActionAudio( sound );
		this.equipment = new HumanoidEquipment( model );
		this.action = HUMANOID_ACTION.IDLE;

	}

	setAction( action, options ) {

		const changed = this.animator.set( action, options );
		if ( changed ) this.action = action;
		return changed;

	}

	attack() {

		const played = this.animator.attack();
		if ( played ) {

			this.action = HUMANOID_ACTION.ATTACK;
			this.audio.sword( this.group.position );

		}
		return played;

	}

	gunshot() {

		this.audio.gunshot( this.group.position );

	}

	update( dt ) {

		this.animator.update( dt );
		this.equipment.update( this.action );

	}

	async loadEquipment( { gunUrl, swordUrl } ) {

		// The source weapon origins are centred on their full meshes, not their grips. These authored
		// grip points move the handle to the Mixamo right-hand socket; rotations align their long axes
		// with the hand pose used by the supplied firearm and sword animations.
		const jobs = [];
		if ( gunUrl ) jobs.push( this.equipment.add( 'gun', gunUrl, {
			length: 0.62,
			grip: [ - 0.43, - 0.28, - 0.45 ],
			rotation: [ Math.PI / 2, 0, Math.PI / 2 ],
			offset: [ 0.01, - 0.01, 0.015 ],
		} ) );
		if ( swordUrl ) jobs.push( this.equipment.add( 'sword', swordUrl, {
			length: 1.08,
			grip: [ 0, - 0.72, 0 ],
			rotation: [ 0, 0, - Math.PI / 2 ],
			offset: [ 0, - 0.015, 0 ],
		} ) );
		await Promise.all( jobs );
		this.equipment.update( this.action );

	}

}
