import { Box3, Matrix4, Vector3 } from '../engine/index.js';

// Triangle-accurate collision for rigid moving scenery. Triangles and the BVH stay in the
// object's local frame: a moving/rotating boat only changes the query transform, never the tree.

const EPS = 1e-8;
const _matrix = new Matrix4();
const _inverse = new Matrix4();
const _point = new Vector3();

function closestPointTriangle( p, a, b, c, out, ab, ac, ap, bp, cp ) {

	ab.subVectors( b, a );
	ac.subVectors( c, a );
	ap.subVectors( p, a );
	const d1 = ab.dot( ap ), d2 = ac.dot( ap );
	if ( d1 <= 0 && d2 <= 0 ) return out.copy( a );

	bp.subVectors( p, b );
	const d3 = ab.dot( bp ), d4 = ac.dot( bp );
	if ( d3 >= 0 && d4 <= d3 ) return out.copy( b );

	const vc = d1 * d4 - d3 * d2;
	if ( vc <= 0 && d1 >= 0 && d3 <= 0 ) return out.copy( a ).addScaledVector( ab, d1 / ( d1 - d3 ) );

	cp.subVectors( p, c );
	const d5 = ab.dot( cp ), d6 = ac.dot( cp );
	if ( d6 >= 0 && d5 <= d6 ) return out.copy( c );

	const vb = d5 * d2 - d1 * d6;
	if ( vb <= 0 && d2 >= 0 && d6 <= 0 ) return out.copy( a ).addScaledVector( ac, d2 / ( d2 - d6 ) );

	const va = d3 * d6 - d5 * d4;
	if ( va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0 ) {

		out.subVectors( c, b );
		return out.multiplyScalar( ( d4 - d3 ) / ( ( d4 - d3 ) + ( d5 - d6 ) ) ).add( b );

	}

	const denom = 1 / ( va + vb + vc );
	return out.copy( a ).addScaledVector( ab, vb * denom ).addScaledVector( ac, vc * denom );

}

function closestSegmentSegment( p1, q1, p2, q2, out1, out2, d1, d2, r ) {

	d1.subVectors( q1, p1 );
	d2.subVectors( q2, p2 );
	r.subVectors( p1, p2 );
	const a = d1.dot( d1 ), e = d2.dot( d2 ), f = d2.dot( r );
	let s, t;
	if ( a <= EPS && e <= EPS ) { s = 0; t = 0; }
	else if ( a <= EPS ) { s = 0; t = Math.max( 0, Math.min( 1, f / e ) ); }
	else {

		const c = d1.dot( r );
		if ( e <= EPS ) { t = 0; s = Math.max( 0, Math.min( 1, - c / a ) ); }
		else {

			const b = d1.dot( d2 ), denom = a * e - b * b;
			s = denom !== 0 ? Math.max( 0, Math.min( 1, ( b * f - c * e ) / denom ) ) : 0;
			t = ( b * s + f ) / e;
			if ( t < 0 ) { t = 0; s = Math.max( 0, Math.min( 1, - c / a ) ); }
			else if ( t > 1 ) { t = 1; s = Math.max( 0, Math.min( 1, ( b - c ) / a ) ); }

		}

	}
	out1.copy( p1 ).addScaledVector( d1, s );
	out2.copy( p2 ).addScaledVector( d2, t );

}

function segmentTriangleIntersection( p, q, a, b, c, out, edge1, edge2, dir, cross, offset ) {

	edge1.subVectors( b, a );
	edge2.subVectors( c, a );
	dir.subVectors( q, p );
	cross.crossVectors( dir, edge2 );
	const det = edge1.dot( cross );
	if ( Math.abs( det ) < EPS ) return false;
	const inv = 1 / det;
	offset.subVectors( p, a );
	const u = offset.dot( cross ) * inv;
	if ( u < 0 || u > 1 ) return false;
	cross.crossVectors( offset, edge1 );
	const v = dir.dot( cross ) * inv;
	if ( v < 0 || u + v > 1 ) return false;
	const t = edge2.dot( cross ) * inv;
	if ( t < 0 || t > 1 ) return false;
	out.copy( p ).addScaledVector( dir, t );
	return true;

}

function collectTriangles( object, relativeTo ) {

	relativeTo.updateWorldMatrix( true, true );
	_inverse.copy( relativeTo.matrixWorld ).invert();
	const data = [];
	object.traverse( ( child ) => {

		const geometry = child.geometry;
		const position = geometry?.getAttribute?.( 'position' );
		if ( ! position ) return;
		_matrix.multiplyMatrices( _inverse, child.matrixWorld );
		const index = geometry.index;
		const count = index ? index.count : position.count;
		for ( let i = 0; i + 2 < count; i += 3 ) {

			for ( let k = 0; k < 3; k ++ ) {

				const vi = index ? index.getX( i + k ) : i + k;
				_point.fromBufferAttribute( position, vi ).applyMatrix4( _matrix );
				data.push( _point.x, _point.y, _point.z );

			}

		}

	} );
	return new Float32Array( data );

}

export class DynamicMeshCollider {

	static fromObject( object, relativeTo = object, options = {} ) {

		return new DynamicMeshCollider( collectTriangles( object, relativeTo ), options );

	}

	constructor( triangles, { leafSize = 12 } = {} ) {

		this.triangles = triangles;
		this.triangleCount = Math.floor( triangles.length / 9 );
		this.leafSize = leafSize;
		this.bounds = new Box3().makeEmpty();
		this._triBounds = new Float32Array( this.triangleCount * 6 );
		this._centroids = new Float32Array( this.triangleCount * 3 );
		this._order = new Uint32Array( this.triangleCount );
		for ( let i = 0; i < this.triangleCount; i ++ ) {

			this._order[ i ] = i;
			const o = i * 9, bo = i * 6, co = i * 3;
			let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = - Infinity, maxY = - Infinity, maxZ = - Infinity;
			for ( let k = 0; k < 9; k += 3 ) {

				const x = triangles[ o + k ], y = triangles[ o + k + 1 ], z = triangles[ o + k + 2 ];
				minX = Math.min( minX, x ); minY = Math.min( minY, y ); minZ = Math.min( minZ, z );
				maxX = Math.max( maxX, x ); maxY = Math.max( maxY, y ); maxZ = Math.max( maxZ, z );

			}
			this._triBounds.set( [ minX, minY, minZ, maxX, maxY, maxZ ], bo );
			this._centroids.set( [ ( minX + maxX ) * 0.5, ( minY + maxY ) * 0.5, ( minZ + maxZ ) * 0.5 ], co );
			this.bounds.min.x = Math.min( this.bounds.min.x, minX ); this.bounds.min.y = Math.min( this.bounds.min.y, minY ); this.bounds.min.z = Math.min( this.bounds.min.z, minZ );
			this.bounds.max.x = Math.max( this.bounds.max.x, maxX ); this.bounds.max.y = Math.max( this.bounds.max.y, maxY ); this.bounds.max.z = Math.max( this.bounds.max.z, maxZ );

		}
		this.nodes = [];
		this.root = this.triangleCount ? this._build( 0, this.triangleCount ) : - 1;
		this._scratch = Array.from( { length: 22 }, () => new Vector3() );
		this._stack = [];
		this.lastTriangleTests = 0;

	}

	_build( start, count ) {

		const nodeIndex = this.nodes.length;
		const node = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: - Infinity, maxY: - Infinity, maxZ: - Infinity, start, count, left: - 1, right: - 1 };
		this.nodes.push( node );
		let cminX = Infinity, cminY = Infinity, cminZ = Infinity, cmaxX = - Infinity, cmaxY = - Infinity, cmaxZ = - Infinity;
		for ( let i = start; i < start + count; i ++ ) {

			const tri = this._order[ i ], bo = tri * 6, co = tri * 3, b = this._triBounds, c = this._centroids;
			node.minX = Math.min( node.minX, b[ bo ] ); node.minY = Math.min( node.minY, b[ bo + 1 ] ); node.minZ = Math.min( node.minZ, b[ bo + 2 ] );
			node.maxX = Math.max( node.maxX, b[ bo + 3 ] ); node.maxY = Math.max( node.maxY, b[ bo + 4 ] ); node.maxZ = Math.max( node.maxZ, b[ bo + 5 ] );
			cminX = Math.min( cminX, c[ co ] ); cminY = Math.min( cminY, c[ co + 1 ] ); cminZ = Math.min( cminZ, c[ co + 2 ] );
			cmaxX = Math.max( cmaxX, c[ co ] ); cmaxY = Math.max( cmaxY, c[ co + 1 ] ); cmaxZ = Math.max( cmaxZ, c[ co + 2 ] );

		}
		if ( count <= this.leafSize ) return nodeIndex;
		const ex = cmaxX - cminX, ey = cmaxY - cminY, ez = cmaxZ - cminZ;
		const axis = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2;
		const sorted = Array.from( this._order.subarray( start, start + count ) );
		sorted.sort( ( a, b ) => this._centroids[ a * 3 + axis ] - this._centroids[ b * 3 + axis ] );
		this._order.set( sorted, start );
		const leftCount = count >> 1;
		node.left = this._build( start, leftCount );
		node.right = this._build( start + leftCount, count - leftCount );
		node.count = 0;
		return nodeIndex;

	}

	_query( minX, minY, minZ, maxX, maxY, maxZ, visit ) {

		if ( this.root < 0 ) return;
		const stack = this._stack;
		stack.length = 0;
		stack.push( this.root );
		while ( stack.length ) {

			const node = this.nodes[ stack.pop() ];
			if ( node.maxX < minX || node.minX > maxX || node.maxY < minY || node.minY > maxY || node.maxZ < minZ || node.minZ > maxZ ) continue;
			if ( node.count ) {

				for ( let i = node.start; i < node.start + node.count; i ++ ) visit( this._order[ i ] );

			} else { stack.push( node.left, node.right ); }

		}

	}

	_triangle( index, a, b, c ) {

		const o = index * 9, t = this.triangles;
		a.fromArray( t, o ); b.fromArray( t, o + 3 ); c.fromArray( t, o + 6 );

	}

	// Push an arbitrary capsule segment out of the local-space triangle mesh. The returned
	// displacement translates both endpoints. Repeating this resolves corners and rail/deck seams.
	resolveSegment( start, end, radius, { iterations = 4 } = {} ) {

		const s = this._scratch;
		const a = s[ 0 ], b = s[ 1 ], c = s[ 2 ], triPoint = s[ 3 ], segPoint = s[ 4 ];
		const q1 = s[ 5 ], q2 = s[ 6 ], e1 = s[ 7 ], e2 = s[ 8 ], r = s[ 9 ];
		const ab = s[ 10 ], ac = s[ 11 ], ap = s[ 12 ], bp = s[ 13 ], cp = s[ 14 ];
		const cross = s[ 15 ], offset = s[ 16 ], normal = s[ 17 ], bestNormal = s[ 18 ], total = s[ 19 ];
		const midpoint = s[ 20 ], centroid = s[ 21 ];
		total.set( 0, 0, 0 );
		let hit = false, grounded = false;
		this.lastTriangleTests = 0;
		for ( let iter = 0; iter < iterations; iter ++ ) {

			const minX = Math.min( start.x, end.x ) - radius, minY = Math.min( start.y, end.y ) - radius, minZ = Math.min( start.z, end.z ) - radius;
			const maxX = Math.max( start.x, end.x ) + radius, maxY = Math.max( start.y, end.y ) + radius, maxZ = Math.max( start.z, end.z ) + radius;
			let bestPen = 0;
			this._query( minX, minY, minZ, maxX, maxY, maxZ, ( tri ) => {

				this.lastTriangleTests ++;
				this._triangle( tri, a, b, c );
				let bestD2 = Infinity;
				if ( segmentTriangleIntersection( start, end, a, b, c, q1, e1, e2, r, cross, offset ) ) {

					segPoint.copy( q1 ); triPoint.copy( q1 ); bestD2 = 0;

				} else {

					closestPointTriangle( start, a, b, c, q1, ab, ac, ap, bp, cp );
					let d2 = q1.distanceToSquared( start );
					if ( d2 < bestD2 ) { bestD2 = d2; segPoint.copy( start ); triPoint.copy( q1 ); }
					closestPointTriangle( end, a, b, c, q1, ab, ac, ap, bp, cp );
					d2 = q1.distanceToSquared( end );
					if ( d2 < bestD2 ) { bestD2 = d2; segPoint.copy( end ); triPoint.copy( q1 ); }
					closestSegmentSegment( start, end, a, b, q1, q2, e1, e2, r );
					d2 = q1.distanceToSquared( q2 );
					if ( d2 < bestD2 ) { bestD2 = d2; segPoint.copy( q1 ); triPoint.copy( q2 ); }
					closestSegmentSegment( start, end, b, c, q1, q2, e1, e2, r );
					d2 = q1.distanceToSquared( q2 );
					if ( d2 < bestD2 ) { bestD2 = d2; segPoint.copy( q1 ); triPoint.copy( q2 ); }
					closestSegmentSegment( start, end, c, a, q1, q2, e1, e2, r );
					d2 = q1.distanceToSquared( q2 );
					if ( d2 < bestD2 ) { bestD2 = d2; segPoint.copy( q1 ); triPoint.copy( q2 ); }

				}
				if ( bestD2 >= radius * radius ) return;
				const distance = Math.sqrt( Math.max( bestD2, 0 ) );
				const pen = radius - distance;
				if ( pen <= bestPen ) return;
				normal.subVectors( segPoint, triPoint );
				if ( normal.lengthSq() <= EPS ) {

					normal.crossVectors( ab.subVectors( b, a ), ac.subVectors( c, a ) ).normalize();
					midpoint.addVectors( start, end ).multiplyScalar( 0.5 );
					centroid.copy( a ).add( b ).add( c ).multiplyScalar( 1 / 3 );
					const side = normal.dot( midpoint.sub( centroid ) );
					if ( side < - EPS || ( Math.abs( side ) <= EPS && normal.y < 0 ) ) normal.negate();

				} else normal.multiplyScalar( 1 / distance );
				bestPen = pen;
				bestNormal.copy( normal );

			} );
			if ( bestPen <= 0 ) break;
			const push = bestPen + 1e-4;
			start.addScaledVector( bestNormal, push );
			end.addScaledVector( bestNormal, push );
			total.addScaledVector( bestNormal, push );
			hit = true;
			if ( bestNormal.y > 0.45 ) grounded = true;

		}
		return { hit, grounded, displacement: total, normal: bestNormal };

	}

	// Highest triangle surface under an X/Z point. maxY keeps roofs and decks above the player's
	// current step height from snapping the character upward.
	groundHeightAt( x, z, maxY, minY = this.bounds.min.y, minNormalY = 0.45 ) {

		let best = - Infinity;
		const s = this._scratch, a = s[ 0 ], b = s[ 1 ], c = s[ 2 ], ab = s[ 3 ], ac = s[ 4 ], n = s[ 5 ];
		this._query( x - 1e-4, minY, z - 1e-4, x + 1e-4, maxY, z + 1e-4, ( tri ) => {

			this._triangle( tri, a, b, c );
			const x0 = a.x, z0 = a.z, x1 = b.x, z1 = b.z, x2 = c.x, z2 = c.z;
			const denom = ( z1 - z2 ) * ( x0 - x2 ) + ( x2 - x1 ) * ( z0 - z2 );
			if ( Math.abs( denom ) < EPS ) return;
			const u = ( ( z1 - z2 ) * ( x - x2 ) + ( x2 - x1 ) * ( z - z2 ) ) / denom;
			const v = ( ( z2 - z0 ) * ( x - x2 ) + ( x0 - x2 ) * ( z - z2 ) ) / denom;
			const w = 1 - u - v;
			if ( u < - 1e-5 || v < - 1e-5 || w < - 1e-5 ) return;
			n.crossVectors( ab.subVectors( b, a ), ac.subVectors( c, a ) );
			const len = n.length();
			if ( len <= EPS || Math.abs( n.y ) / len < minNormalY ) return;
			const y = u * a.y + v * b.y + w * c.y;
			if ( y <= maxY + 1e-4 && y >= minY && y > best ) best = y;

		} );
		return best;

	}

}
