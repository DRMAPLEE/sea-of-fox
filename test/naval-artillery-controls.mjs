import assert from 'node:assert/strict';
import { Quaternion, Vector3 } from '../src/engine/index.js';
import {
	batteryDirection, broadsideDirection, cannonBelongsToBattery, driverTraverseFromLook,
	effectiveArtilleryPattern, traverseFromLook,
} from '../src/game/NavalArtillery.js';

const boat = new Quaternion();
const rightwardMouse = 100;

for ( const side of [ 1, - 1 ] ) {

	const angle = traverseFromLook( side, 0, rightwardMouse );
	const centre = broadsideDirection( side, 0, boat, new Vector3() );
	const moved = broadsideDirection( side, angle, boat, new Vector3() );
	// Camera right while looking out over a broadside is forward x world-up.
	const cameraRight = new Vector3().crossVectors( centre, new Vector3( 0, 1, 0 ) );
	assert.ok( moved.sub( centre ).dot( cameraRight ) > 0, `${ side > 0 ? 'port' : 'starboard' } battery follows screen-right input` );

}

assert.ok( traverseFromLook( 1, 0, 1e9 ) <= 50 * Math.PI / 180 );
assert.ok( traverseFromLook( - 1, 0, 1e9 ) >= - 50 * Math.PI / 180 );

for ( const battery of [ 'port', 'bow', 'starboard' ] ) {

	const angle = driverTraverseFromLook( 0, rightwardMouse );
	const centre = batteryDirection( battery, 0, boat, new Vector3() );
	const moved = batteryDirection( battery, angle, boat, new Vector3() );
	const cameraRight = new Vector3().crossVectors( centre, new Vector3( 0, 1, 0 ) );
	assert.ok( moved.sub( centre ).dot( cameraRight ) > 0, `${ battery } driver battery follows screen-right input` );

}

const bow = batteryDirection( 'bow', 0, boat, new Vector3() );
assert.ok( bow.z > 0.999 && Math.abs( bow.x ) < 1e-9, 'bow battery fires along boat-local +Z' );
assert.ok( driverTraverseFromLook( 0, 1e9 ) <= 50 * Math.PI / 180 );

const deckPort = { side: 'port', control: 'deck' };
const helmPort = { side: 'port', control: 'helm' };
assert.equal( cannonBelongsToBattery( deckPort, 'port', 'deck' ), true );
assert.equal( cannonBelongsToBattery( deckPort, 'port', 'helm' ), false );
assert.equal( cannonBelongsToBattery( helmPort, 'port', 'helm' ), true );
assert.equal( effectiveArtilleryPattern( true, 'port', 'circle' ), 'line' );
assert.equal( effectiveArtilleryPattern( true, 'starboard', 'circle' ), 'line' );
assert.equal( effectiveArtilleryPattern( true, 'bow', 'circle' ), 'circle' );

console.log( 'naval artillery controls passed' );
