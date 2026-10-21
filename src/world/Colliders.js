import * as THREE from '../engine/index.js';

// Lightweight collision world for the character controller and boat.
// Boxes are oriented around Y only. Walkable boxes (decks, floors, stairs) act as ground.
export class Colliders {

	constructor() {

		this.boxes = [];
		this.cylinders = [];
		this.meshes = [];
		this._v = new THREE.Vector3();
		this._a = new THREE.Vector3();
		this._b = new THREE.Vector3();
		this._world = new THREE.Vector3();
		this._before = new THREE.Vector3();
		this._inverse = new THREE.Matrix4();

	}

	// center: world center, half: half extents (x, y, z) in the box's local frame, rotY: yaw (radians)
	addBox( center, half, rotY = 0, { walkable = false, solid = true, tag = '' } = {} ) {

		const b = {
			center: center.clone(), half: half.clone(), rotY,
			cos: Math.cos( rotY ), sin: Math.sin( rotY ),
			walkable, solid, tag,
			top: center.y + half.y, bottom: center.y - half.y,
			radius: Math.hypot( half.x, half.z ),
		};
		this.boxes.push( b );
		return b;

	}

	addCylinder( x, z, radius, yMin, yMax, { tag = '' } = {} ) {

		const c = { x, z, radius, yMin, yMax, tag };
		this.cylinders.push( c );
		return c;

	}

	addMesh( collider, object, { walkable = true, solid = true, tag = '' } = {} ) {

		const value = { collider, object, walkable, solid, tag };
		this.meshes.push( value );
		return value;

	}

	_toLocal( b, x, z ) {

		const dx = x - b.center.x, dz = z - b.center.z;
		return [ dx * b.cos - dz * b.sin, dx * b.sin + dz * b.cos ];

	}

	_toWorldDir( b, lx, lz ) {

		return [ lx * b.cos + lz * b.sin, - lx * b.sin + lz * b.cos ];

	}

	// Highest walkable surface under (x, z) not higher than maxY.
	groundHeightAt( x, z, maxY, pad = 0 ) {

		let best = - Infinity;
		for ( const b of this.boxes ) {

			if ( ! b.walkable || b.top > maxY ) continue;
			if ( Math.abs( x - b.center.x ) > b.radius + pad + 0.01 || Math.abs( z - b.center.z ) > b.radius + pad + 0.01 ) continue;
			const [ lx, lz ] = this._toLocal( b, x, z );
			if ( Math.abs( lx ) <= b.half.x + pad && Math.abs( lz ) <= b.half.z + pad ) best = Math.max( best, b.top );

		}
		for ( const m of this.meshes ) {

			if ( ! m.walkable ) continue;
			m.object.updateWorldMatrix( true, false );
			this._inverse.copy( m.object.matrixWorld ).invert();
			this._a.set( x, maxY, z ).applyMatrix4( this._inverse );
			const localY = m.collider.groundHeightAt( this._a.x, this._a.z, this._a.y );
			if ( ! Number.isFinite( localY ) ) continue;
			this._world.set( this._a.x, localY, this._a.z ).applyMatrix4( m.object.matrixWorld );
			if ( this._world.y <= maxY + 1e-4 ) best = Math.max( best, this._world.y );

		}

		return best;

	}

	// Push a vertical capsule (feet at pos.y) out of solid geometry. Returns true if collided.
	resolveCapsule( pos, radius, height, stepHeight = 0.35 ) {

		let hit = false;
		for ( const b of this.boxes ) {

			if ( ! b.solid ) continue;
			if ( pos.y + height < b.bottom || pos.y + stepHeight > b.top ) continue;
			if ( Math.abs( pos.x - b.center.x ) > b.radius + radius || Math.abs( pos.z - b.center.z ) > b.radius + radius ) continue;
			const [ lx, lz ] = this._toLocal( b, pos.x, pos.z );
			const cx = Math.max( - b.half.x, Math.min( b.half.x, lx ) );
			const cz = Math.max( - b.half.z, Math.min( b.half.z, lz ) );
			let dx = lx - cx, dz = lz - cz;
			const d2 = dx * dx + dz * dz;
			if ( d2 >= radius * radius ) continue;
			let nx, nz, pen;
			if ( d2 > 1e-8 ) {

				const d = Math.sqrt( d2 );
				nx = dx / d; nz = dz / d; pen = radius - d;

			} else {

				// center inside box: push out along the smallest axis
				const px = b.half.x - Math.abs( lx ), pz = b.half.z - Math.abs( lz );
				if ( px < pz ) { nx = Math.sign( lx ) || 1; nz = 0; pen = px + radius; } else { nx = 0; nz = Math.sign( lz ) || 1; pen = pz + radius; }

			}

			const [ wx, wz ] = this._toWorldDir( b, nx, nz );
			pos.x += wx * pen;
			pos.z += wz * pen;
			hit = true;

		}

		for ( const c of this.cylinders ) {

			if ( pos.y + height < c.yMin || pos.y + stepHeight > c.yMax ) continue;
			const dx = pos.x - c.x, dz = pos.z - c.z;
			const r = c.radius + radius;
			const d2 = dx * dx + dz * dz;
			if ( d2 >= r * r ) continue;
			const d = Math.sqrt( d2 ) || 1e-4;
			pos.x = c.x + dx / d * r;
			pos.z = c.z + dz / d * r;
			hit = true;

		}
		for ( const m of this.meshes ) {

			if ( ! m.solid ) continue;
			m.object.updateWorldMatrix( true, false );
			const matrix = m.object.matrixWorld;
			const scale = matrix.getMaxScaleOnAxis() || 1;
			this._inverse.copy( matrix ).invert();
			this._a.set( pos.x, pos.y + radius, pos.z ).applyMatrix4( this._inverse );
			this._b.set( pos.x, pos.y + Math.max( radius, height - radius ), pos.z ).applyMatrix4( this._inverse );
			this._before.copy( this._a );
			const contact = m.collider.resolveSegment( this._a, this._b, radius / scale, { iterations: 5 } );
			if ( ! contact.hit ) continue;
			this._a.applyMatrix4( matrix );
			this._before.applyMatrix4( matrix );
			pos.add( this._a.sub( this._before ) );
			hit = true;

		}

		return hit;

	}

	// Segment/ray against solid boxes and cylinders; returns the nearest distance, or maxDist when
	// unobstructed. `dir` is expected to be normalized.
	raycast( origin, dir, maxDist, pad = 0 ) {

		let best = maxDist;
		for ( const b of this.boxes ) {

			if ( ! b.solid ) continue;
			const ox = origin.x - b.center.x, oz = origin.z - b.center.z, oy = origin.y - b.center.y;
			const lox = ox * b.cos - oz * b.sin, loz = ox * b.sin + oz * b.cos;
			const ldx = dir.x * b.cos - dir.z * b.sin, ldz = dir.x * b.sin + dir.z * b.cos;
			let tmin = 0, tmax = best;
			const slab = ( o, d, h ) => {

				if ( Math.abs( d ) < 1e-8 ) return Math.abs( o ) <= h;
				let t1 = ( - h - o ) / d, t2 = ( h - o ) / d;
				if ( t1 > t2 ) { const t = t1; t1 = t2; t2 = t; }
				tmin = Math.max( tmin, t1 );
				tmax = Math.min( tmax, t2 );
				return tmin <= tmax;

			};

			if ( slab( lox, ldx, b.half.x + pad ) && slab( oy, dir.y, b.half.y + pad ) && slab( loz, ldz, b.half.z + pad ) ) best = Math.min( best, tmin );

		}
		for ( const c of this.cylinders ) {

			const ox = origin.x - c.x, oz = origin.z - c.z;
			const radius = c.radius + pad, yMin = c.yMin - pad, yMax = c.yMax + pad;
			if ( ox * ox + oz * oz <= radius * radius && origin.y >= yMin && origin.y <= yMax ) {

				best = 0;
				continue;

			}
			const a = dir.x * dir.x + dir.z * dir.z;
			if ( a > 1e-10 ) {

				const b = 2 * ( ox * dir.x + oz * dir.z );
				const cc = ox * ox + oz * oz - radius * radius;
				const disc = b * b - 4 * a * cc;
				if ( disc >= 0 ) {

					const root = Math.sqrt( disc );
					const t0 = ( - b - root ) / ( 2 * a ), t1 = ( - b + root ) / ( 2 * a );
					for ( const t of [ t0, t1 ] ) if ( t >= 0 && t < best ) {

						const y = origin.y + dir.y * t;
						if ( y >= yMin && y <= yMax ) best = t;

					}

				}

			}
			if ( Math.abs( dir.y ) > 1e-10 ) for ( const y of [ yMin, yMax ] ) {

				const t = ( y - origin.y ) / dir.y;
				if ( t < 0 || t >= best ) continue;
				const x = ox + dir.x * t, z = oz + dir.z * t;
				if ( x * x + z * z <= radius * radius ) best = t;

			}

		}
		for ( const m of this.meshes ) {

			if ( ! m.solid ) continue;
			m.object.updateWorldMatrix( true, false );
			this._inverse.copy( m.object.matrixWorld ).invert();
			this._a.copy( origin ).applyMatrix4( this._inverse );
			this._b.copy( origin ).addScaledVector( dir, best ).applyMatrix4( this._inverse );
			const t = m.collider.raycastSegment( this._a, this._b );
			if ( Number.isFinite( t ) ) best *= t;

		}

		return best;

	}

}
