import { Vector3 } from '../engine/math/index.js';
import { BufferAttribute, BufferGeometry } from '../engine/geometry/index.js';
import { Group, Mesh } from '../engine/scene/index.js';
import { Material } from '../engine/render/Material.js';
import { LAYERS } from '../engine/render/SceneRenderer.js';
import { makeLaceTexture } from '../ocean/SurfFoam.js';

const MAX_COLUMNS = 2;
const HEIGHT_SEGMENTS = 192;
const RADIAL_SEGMENTS = 64;

// Build one actual screw-shaped surface in local space. The helical ridge is part of the mesh,
// not particles and not a painted spiral, so rotating the object visibly rotates its silhouette.
function createScrewGeometry() {

	const rings = HEIGHT_SEGMENTS + 1;
	const sides = RADIAL_SEGMENTS + 1;
	const positions = new Float32Array( rings * sides * 3 );
	const normals = new Float32Array( rings * sides * 3 );
	const uvs = new Float32Array( rings * sides * 2 );
	let v = 0;
	for ( let y = 0; y < rings; y ++ ) {

		const q = y / HEIGHT_SEGMENTS;
		const taper = 0.52 + 0.48 * Math.pow( q, 0.76 );
		for ( let r = 0; r < sides; r ++ ) {

			const u = r / RADIAL_SEGMENTS;
			const a = u * Math.PI * 2;
			const phase = a - q * Math.PI * 18;
			const thread = Math.pow( 0.5 + 0.5 * Math.cos( phase ), 5 );
			const radius = taper * ( 0.84 + thread * 0.30 + Math.sin( q * Math.PI * 11 ) * 0.035 );
			const ca = Math.cos( a ), sa = Math.sin( a );
			positions[ v * 3 ] = ca * radius;
			positions[ v * 3 + 1 ] = q;
			positions[ v * 3 + 2 ] = sa * radius;
			const ny = Math.sin( phase ) * thread * 0.62;
			const il = 1 / Math.hypot( ca, ny, sa );
			normals[ v * 3 ] = ca * il;
			normals[ v * 3 + 1 ] = ny * il;
			normals[ v * 3 + 2 ] = sa * il;
			uvs[ v * 2 ] = u;
			uvs[ v * 2 + 1 ] = q;
			v ++;

		}

	}

	const index = new Uint32Array( HEIGHT_SEGMENTS * RADIAL_SEGMENTS * 6 );
	let k = 0;
	for ( let y = 0; y < HEIGHT_SEGMENTS; y ++ ) {

		for ( let r = 0; r < RADIAL_SEGMENTS; r ++ ) {

			const a = y * sides + r;
			const b = a + sides;
			index[ k ++ ] = a;
			index[ k ++ ] = b;
			index[ k ++ ] = a + 1;
			index[ k ++ ] = a + 1;
			index[ k ++ ] = b;
			index[ k ++ ] = b + 1;

		}

	}

	const geometry = new BufferGeometry();
	geometry.name = 'WaterspoutScrewColumn';
	geometry.setAttribute( 'position', new BufferAttribute( positions, 3 ) );
	geometry.setAttribute( 'normal', new BufferAttribute( normals, 3 ) );
	geometry.setAttribute( 'uv', new BufferAttribute( uvs, 2 ) );
	geometry.setIndex( new BufferAttribute( index, 1 ) );
	geometry.computeBoundingSphere();
	return geometry;

}

function createColumnMaterial( seed ) {

	return new Material( {
		name: 'WaterspoutDeepOceanColumn',
		lit: false,
		transparent: true,
		// The column is a dense mass of lifted seawater.  Writing depth and drawing only the outward
		// shell prevents the far side from showing through as pale overlapping glass sheets.
		depthWrite: true,
		depthTest: true,
		side: 'front',
		blending: 'premultiplied',
		velocityWeight: 0,
		underwaterLighting: 'none',
		receiveShadows: false,
		uniforms: {
			strength: [ 'f32', 0 ],
			seed: [ 'f32', seed ],
		},
		textures: { columnLace: makeLaceTexture() },
		surface: /* wgsl */`
	let q = in.uv.y;
	let N = normalize( in.N );
	let NdV = clamp( dot( N, in.V ), 0.0, 1.0 );
	let fresnel = pow( 1.0 - NdV, 3.2 );
	let azimuth = in.uv.x * PI * 2.0;
	let ridge = pow( 0.5 + 0.5 * cos( azimuth - q * PI * 18.0 ), 5.0 );
	let slowVein = 0.5 + 0.5 * sin( azimuth * 3.0 - q * 29.0 + frame.time * 1.45 );
	// Dense deep-ocean blue-black, opaque enough to keep the kilometre-scale column readable
	// against an overcast horizon and the pale outer spray shell.
	let darkWater = vec3f( 0.0025, 0.012, 0.022 );
	let deepBlue = vec3f( 0.004, 0.043, 0.078 );
	let ridgeBlue = vec3f( 0.014, 0.120, 0.195 );
	var color = mix( darkWater, deepBlue, 0.26 + 0.24 * slowVein );
	color = mix( color, ridgeBlue, ridge * 0.48 );
	color += vec3f( 0.014, 0.072, 0.105 ) * fresnel;
	// Reuse the actual surf-zone lace texture on the raised screw.  Its cell strands, bubbles and
	// soft density channel give the thread the same broken, granular structure as wave foam.  The
	// geometric ridge remains continuous; the texture changes tone, not the thread's silhouette.
	let laceUV = vec2f( in.uv.x * 7.0 + mat.seed, q * 82.0 - frame.time * 0.34 );
	let lace = textureSample( columnLace, smpAnisoRepeat, laceUV );
	let strand = 1.0 - smoothstep( 0.10, 0.62, lace.r );
	let bubbles = smoothstep( 0.34, 0.82, lace.g );
	let foamTexture = clamp( strand * 0.48 + bubbles * 0.32 + lace.b * 0.38, 0.0, 1.0 );
	// Fully neutral greys: deep pores and raised bubbly strands, with no cyan tint or paper-white
	// emission.  A nonzero floor keeps the helical band unbroken at a distance.
	let foamGrey = mix( vec3f( 0.32 ), vec3f( 0.72 ), 0.28 + foamTexture * 0.72 );
	// The visible foam thread occupies roughly one fifth of the former angular width.  Ridge is
	// already the fifth power of the screw wave; selecting only its very crest narrows the band
	// without shrinking the water column or weakening the physical helical displacement.
	let whiteThread = smoothstep( 0.975, 0.997, ridge );
	color = mix( color, foamGrey, whiteThread );
	let footFade = smoothstep( 0.0, 0.006, q );
	let cloudFade = 1.0 - smoothstep( 0.988, 1.0, q ) * 0.16;
	// Optical density reaches full strength as soon as a spawned column is visible.  Lifecycle
	// strength still fades it during the final decay, but distance never turns it into glass.
	let presence = smoothstep( 0.0, 0.25, mat.strength );
	let alpha = ( 0.975 + fresnel * 0.02 ) * presence * footFade * cloudFade;
	if ( alpha < 0.002 ) { discard; }
	s.albedo = color * alpha;
	s.alpha = alpha;
`,
		output: 'r.color = vec4f( s.albedo, s.alpha );',
	} );

}

export class Waterspouts {

	constructor( { field } = {} ) {

		if ( ! field ) throw new Error( 'Waterspouts requires a WaterspoutField' );
		this.field = field;
		this.spouts = field.spouts;
		this.uniforms = field.uniforms;
		this.mesh = new Group();
		this.mesh.name = 'WaterspoutContinuousColumns';
		this.columns = [];
		this.materials = [];
		this._turn = 0;
		const geometry = createScrewGeometry();

		for ( let i = 0; i < MAX_COLUMNS; i ++ ) {

			const material = createColumnMaterial( i * 2.71 );
			const column = new Mesh( geometry, material );
			column.name = `WaterspoutScrewColumn${ i + 1 }`;
			column.visible = false;
			column.frustumCulled = false;
			column.castShadow = false;
			column.receiveShadow = false;
			column.renderOrder = 19;
			column.layers.set( LAYERS.TRANSPARENT );
			this.mesh.add( column );
			this.columns.push( column );
			this.materials.push( material );

		}

		this.update( 0 );

	}

	set enabled( value ) { this.mesh.visible = !! value; }
	get enabled() { return this.mesh.visible; }

	setIntensity( value ) { this.field.setIntensity( value ); }

	update( dt ) {

		this._turn = ( this._turn + dt * 1.55 ) % ( Math.PI * 2 );
		const intensity = this.field.uniforms.fields.intensity.value;
		for ( let i = 0; i < MAX_COLUMNS; i ++ ) {

			const column = this.columns[ i ];
			const active = i < this.field.count;
			column.visible = active;
			if ( ! active ) continue;
			const spec = this.spouts[ i ];
			const strength = this.field._strengthAtAge( this.field.ages[ i ] ) * intensity;
			column.position.set( spec.x, - 1.5, spec.y );
			column.scale.set( spec.z * 0.075, spec.z + 4, spec.z * 0.075 );
			column.rotation.y = this._turn + spec.w;
			this.materials[ i ].uniforms.strength.value = Math.max( 0, Math.min( 1, strength ) );

		}

	}

	velocityAt( position, target = new Vector3() ) {

		return this.field.velocityAt( position, target );

	}

}
