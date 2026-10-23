// Semantic action sounds shared by the player and every humanoid NPC. Controllers emit an
// action event; SoundScape decides how it is spatialised and which recording is played.
export class HumanoidActionAudio {

	constructor( sound = null ) {

		this.sound = sound;

	}

	setSound( sound ) {

		this.sound = sound;

	}

	step( position, { running = false, climbing = false } = {} ) {

		this.sound?.humanoidFootstep( position, { running, climbing } );

	}

	sword( position ) {

		this.sound?.humanoidSword( position );

	}

	gunshot( position ) {

		this.sound?.humanoidGunshot( position );

	}

}
