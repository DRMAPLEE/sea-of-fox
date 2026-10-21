import assert from 'node:assert/strict';
import { Group, Vector3 } from '../src/engine/index.js';
import { DynamicMeshCollider } from '../src/world/DynamicMeshCollider.js';
import { Colliders } from '../src/world/Colliders.js';

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

const rayT = collider.raycastSegment( new Vector3( - 3, 1, 0 ), new Vector3( 3, 1, 0 ) );
assert.ok( Math.abs( rayT - 0.5 ) < 1e-6 );

// Static authored mesh through the world collision registry, including transform and scale.
const root = new Group();
root.position.set( 10, 2, 0 );
root.scale.setScalar( 2 );
root.updateWorldMatrix( true, false );
const world = new Colliders();
world.addMesh( collider, root, { solid: true, walkable: true } );
assert.ok( Math.abs( world.groundHeightAt( 12, 0, 4 ) - 2 ) < 1e-6 );
assert.ok( Math.abs( world.raycast( new Vector3( 7, 4, 0 ), new Vector3( 1, 0, 0 ), 8 ) - 3 ) < 1e-6 );
const worldCapsule = new Vector3( 9.8, 2.5, 0 );
assert.equal( world.resolveCapsule( worldCapsule, 0.3, 1.5, 0 ), true );
assert.ok( worldCapsule.x < 9.71 );

console.log( 'dynamic mesh collider passed' );
