import assert from 'node:assert/strict';
import { Quaternion, Vector3 } from '../src/engine/index.js';
import { Player } from '../src/player/Player.js';

const player = {
	boat: {
		quaternion: new Quaternion(),
		position: new Vector3( 0, 0, 0 ),
		velocity: new Vector3( 1, 0, 2 ),
	},
	position: new Vector3( 4, - 500, 8 ),
	velocity: new Vector3(),
	deckVel: new Vector3( 2, - 5, 3 ),
	waterH: 0,
	waterMean: null,
	mode: 'deck',
	floating: false,
	_camY: 10,
	audio: null,
	deckToWorld() {},
};

Player.prototype.fallFromDeckIntoWater.call( player );
assert.equal( player.mode, 'swim' );
assert.equal( player.floating, true );
assert.equal( player.position.y, - 0.75, 'a bad deck fall is recovered near the water surface' );
assert.deepEqual( player.velocity.toArray(), [ 3, - 5, 5 ], 'deck and boat velocities carry into the water' );
assert.deepEqual( player.deckVel.toArray(), [ 0, 0, 0 ] );
assert.equal( player.waterMean, 0 );

console.log( 'player deck controls passed' );
