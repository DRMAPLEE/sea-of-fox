import assert from 'node:assert/strict';
import { Vector3 } from '../src/engine/index.js';
import { DynamicMeshCollider } from '../src/world/DynamicMeshCollider.js';

// Two floor triangles and two vertical wall triangles.
const collider = new DynamicMeshCollider( new Float32Array( [
	- 5, 0, - 5, 5, 0, - 5, 5, 0, 5,
	- 5, 0, - 5, 5, 0, 5, - 5, 0, 5,
	0, 0, - 5, 0, 3, 5, 0, 0, 5,
	0, 0, - 5, 0, 3, - 5, 0, 3, 5,
] ), { leafSize: 2 } );

assert.equal( collider.groundHeightAt( 2, 0, 1 ), 0 );

const floorBottom = new Vector3( 2, 0.15, 0 );
const floorTop = new Vector3( 2, 1.65, 0 );
const floor = collider.resolveSegment( floorBottom, floorTop, 0.25 );
assert.equal( floor.hit, true );
assert.equal( floor.grounded, true );
assert.ok( Math.abs( floorBottom.y - 0.2501 ) < 1e-5 );

const wallBottom = new Vector3( - 0.1, 0.5, 0 );
const wallTop = new Vector3( - 0.1, 2, 0 );
const wall = collider.resolveSegment( wallBottom, wallTop, 0.3 );
assert.equal( wall.hit, true );
assert.ok( Math.abs( wallBottom.x + 0.3001 ) < 1e-5 );

console.log( 'dynamic mesh collider passed' );
