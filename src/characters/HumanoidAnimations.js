// Shared animation semantics for every humanoid character. Gameplay code asks for an action
// (walk, climb, aim, etc.) instead of depending on an asset's clip names. A profile supplies
// ordered aliases, so another rig can be integrated without changing player or NPC controllers.

export const HUMANOID_ACTION = Object.freeze( {
	IDLE: 'idle',
	WALK: 'walk',
	RUN: 'run',
	CLIMB: 'climb',
	JUMP: 'jump',
	RUN_JUMP: 'runJump',
	ATTACK: 'attack',
	HELM_GUN: 'helmGun',
	GUN_AIM: 'gunAim',
	GUN_AIM_RUN: 'gunAimRun',
	SWIM_IDLE: 'swimIdle',
	SWIM: 'swim',
	TURN_LEFT: 'turnLeft',
	TURN_RIGHT: 'turnRight',
} );

const ONE_HAND_HELM_CLIP = '_01a163ba_fc28_750c_b945_00466db56007';
const STANDING_GUN_CLIP = '_01a163bc_8840_7681_9518_8f26e8f970d5';

export const GHOST_CAPTAIN_PROFILE = Object.freeze( {
	idle: [ 'Idle_3' ],
	walk: [ 'Walking' ],
	run: [ 'Running' ],
	climb: [ 'Fast_Ladder_Climb' ],
	jump: [ 'Regular_Jump', 'Leap_of_Faith' ],
	runJump: [ 'Jump_Over_Obstacle_2', 'Regular_Jump' ],
	attack: [ 'Triple_Combo_Attack' ],
	// Meshy left the two standing firearm clips with UUID names. They remain isolated here so
	// gameplay never depends on opaque asset names. The revised asset explicitly names its
	// moving firearm animation, allowing all humanoids to share an accurate moving-aim state.
	helmGun: [ ONE_HAND_HELM_CLIP, 'Idle_3' ],
	gunAim: [ STANDING_GUN_CLIP, ONE_HAND_HELM_CLIP, 'Idle_3' ],
	gunAimRun: [ 'Run_and_Shoot', 'Running' ],
	swimIdle: [ 'Swim_Idle', 'Idle_3' ],
	swim: [ 'Swim_Forward', 'Walking' ],
	turnLeft: [ 'Idle_Turn_Left', 'Idle_3' ],
	turnRight: [ 'Idle_Turn_Right', 'Idle_3' ],
} );

export function resolveHumanoidProfile( clipNames, profile = GHOST_CAPTAIN_PROFILE ) {

	const exact = new Set( clipNames );
	const folded = new Map( clipNames.map( ( name ) => [ name.toLowerCase(), name ] ) );
	const resolved = {};
	for ( const action of Object.values( HUMANOID_ACTION ) ) {

		const aliases = profile[ action ] || [];
		resolved[ action ] = aliases.find( ( name ) => exact.has( name ) )
			|| aliases.map( ( name ) => folded.get( name.toLowerCase() ) ).find( Boolean )
			|| null;

	}
	return resolved;

}

export class HumanoidAnimator {

	constructor( model, profile = GHOST_CAPTAIN_PROFILE ) {

		this.model = model;
		this.clips = resolveHumanoidProfile( model.clipNames(), profile );
		this.action = null;
		this.oneShot = null;
		model.onClipEnd = ( name ) => {

			if ( name !== this.oneShot ) return;
			this.oneShot = null;
			this.action = null;

		};
		this.set( HUMANOID_ACTION.IDLE, { fade: 0.01 } );

	}

	set( action, { fade = 0.22, speed = 1, loop = true, restart = false } = {} ) {

		if ( this.oneShot && action !== HUMANOID_ACTION.ATTACK ) return false;
		const clip = this.clips[ action ] || this.clips.idle;
		if ( ! clip || ( ! restart && this.action === action && this.model.current === clip ) ) return false;
		this.action = action;
		this.oneShot = loop ? null : clip;
		this.model.play( clip, { fade, speed, loop, from: restart ? 0 : undefined } );
		return true;

	}

	attack() {

		return this.set( HUMANOID_ACTION.ATTACK, { fade: 0.12, loop: false, restart: true } );

	}

	update( dt ) {

		this.model.update( dt );

	}

}
