import { Vector3, Vector4 } from '../engine/math/index.js';
import { PlaneGeometry } from '../engine/geometry/index.js';
import { Mesh } from '../engine/scene/Mesh.js';
import { Material } from '../engine/render/Material.js';
import { UniformBlock, ShaderModule } from '../engine/gpu/Shader.js';
import { LAYERS } from '../engine/render/SceneRenderer.js';
import { SPRAY } from './Spray.js';

// Game-scale waterspouts built from an analytical Rankine-combined flow field.  The visible
// column is intentionally a continuous procedural tube, not a cloud of particle cards: a raised
// helical ridge deforms the silhouette so the whole blue-black mass reads as a turning screw.
const MAX_SPOUTS = 2;
const PARTICLES_PER_SPOUT = 24576;
const COLUMN_PARTICLES = 21504;
const SPRAY_PARTICLES = 2048;
const STORM_LIFETIME = 12 * 60;
const FORMATION_TIME = 60;
const DECAY_START = 9 * 60;
export const WATERSPOUT_SCALE = 5;

const DEFAULT_SPOUTS = [
	// x, z, visible height, phase.  The closest one frames the view down the starting pier.
	new Vector4( - 260, 420, 155 * WATERSPOUT_SCALE, 0.2 ),
	new Vector4( 520, 920, 190 * WATERSPOUT_SCALE, 2.4 ),
];

const waterspoutModule = new ShaderModule( {
	name: 'waterspoutCommon',
	code: /* wgsl */`
fn waterspoutHash( n: f32 ) -> f32 {
	let p = fract( n * 0.1031 );
	return fract( p * ( p + 33.33 ) * ( p + p ) );
}

fn waterspoutHash4( n: f32 ) -> vec4f {
	return vec4f(
		waterspoutHash( n + 1.7 ), waterspoutHash( n + 19.1 ),
		waterspoutHash( n + 47.7 ), waterspoutHash( n + 91.3 )
	);
}

// Rankine-combined tangential speed: finite at the axis and non-singular outside the core.
fn waterspoutTangentialSpeed( radius: f32, core: f32, peak: f32 ) -> f32 {
	return select( peak * core / max( radius, 0.1 ), peak * radius / core, radius < core );
}
`,
} );

// Shared physical field.  WaterSurface, WaterQuery, boats and the column renderer all consume
// this one block so that the visible water column, the sea-surface vortex and gameplay forces stay
// locked to the same centres.  The free-surface term follows dh/dr = v_theta^2 / (g r), softened
// into a finite Rankine core and capped at a game-readable (but still severe) 4.8 m depression.
export class WaterspoutField {

	constructor( { count = 0, spouts = DEFAULT_SPOUTS } = {} ) {

		this.count = Math.max( 0, Math.min( MAX_SPOUTS, count ) );
		this.spouts = Array.from( { length: MAX_SPOUTS }, ( _, i ) => ( spouts[ i ] || DEFAULT_SPOUTS[ i ] ).clone() );
		this.uniforms = new UniformBlock( 'WaterspoutParams', {
			spouts: [ `vec4f[${ MAX_SPOUTS }]`, this.spouts ],
			activeCount: [ 'u32', this.count ],
			strengths: [ 'vec4f', new Float32Array( 4 ) ],
			intensity: [ 'f32', 1 ],
			scale: [ 'f32', WATERSPOUT_SCALE ],
			maxDistance: [ 'f32', 9000 ],
		}, { label: 'waterspouts' } );
		this._refreshTimer = 180 + Math.random() * 180;
		this.ages = new Float32Array( MAX_SPOUTS );
		if ( this.count > 0 ) this.ages.fill( FORMATION_TIME, 0, this.count );
		this._syncStrengths();

		this.module = new ShaderModule( {
			name: 'waterspoutField',
			deps: [ waterspoutModule ],
			uniforms: this.uniforms,
			uniformName: 'waterspout',
			code: /* wgsl */`
// xyz = Lagrangian displacement, w = breaking/spray foam coverage.  The broad wave band is a
// rotating three-armed disturbance rather than circular sine rings: mature waterspouts show a
// dark spot, spiral surface streaks and a white spray ring around the core.
fn waterspoutWaterAt( p: vec2f ) -> vec4f {
	var result = vec4f( 0.0 );
	for ( var i = 0u; i < ${ MAX_SPOUTS }u; i++ ) {
		if ( i >= waterspout.activeCount ) { continue; }
		let spec = waterspout.spouts[ i ];
		let strength = waterspout.strengths[ i ];
		if ( strength <= 0.0001 ) { continue; }
		let d = p - spec.xy;
		let r = max( length( d ), 0.05 );
		let radial = d / r;
		let tangent = vec2f( - radial.y, radial.x );
		let S = waterspout.scale;
		let outer = ( 1.0 - smoothstep( 120.0 * S, 175.0 * S, r ) ) * strength;
		if ( outer <= 0.0 ) { continue; }

		let core = 11.0 * S;
		let core2 = core * core;
		let angle = atan2( d.y, d.x );
		// Negative time with positive radial wavenumber carries the crests outward from the core.
		// This only changes wave propagation; the underlying current and boat suction remain inward.
		let phase = r / S * 0.34 + angle * 3.0 - frame.time * 3.6 / sqrt( S ) + spec.w;
		let phase2 = r / S * 0.71 - angle * 2.0 - frame.time * 5.4 / sqrt( S ) + spec.w * 1.7;
		let clearAxis = smoothstep( 3.5 * S, 12.0 * S, r );
		let waveBand = outer * clearAxis;
		let waveScale = sqrt( S );

		// A pressure-supported free-surface bowl.  This profile is the integral of a smoothed
		// Rankine-like tangential field, with the innermost value limited for mesh/query stability.
		let depression = - 4.8 * waveScale * core2 / ( r * r + core2 ) * outer;
		let spiral = ( sin( phase ) * 1.55 + sin( phase2 ) * 0.52 ) * waveBand * waveScale;
		let chop = sin( r / S * 1.35 + angle * 7.0 - frame.time * 7.2 ) * 0.34 * waveScale * outer;
		let sprayRing = exp( - pow( ( r - 20.0 * S ) / ( 9.0 * S ), 2.0 ) ) * strength;
		let ringLift = sprayRing * ( 0.65 + 0.55 * sin( phase + 0.8 ) ) * waveScale;

		// Horizontal orbital motion makes the geometry itself corkscrew instead of only changing
		// its shading.  It is deliberately bounded so the fixed-point Eulerian query remains stable.
		let orbital = ( cos( phase ) * 1.45 + cos( phase2 ) * 0.42 ) * waveScale;
		let swirl = sin( phase ) * 0.78 * waveScale;
		let convergence = ( 0.72 + max( sin( phase ), 0.0 ) * 0.9 ) * waveScale * outer;
		let horizontal = ( radial * ( orbital - convergence ) + tangent * swirl ) * waveBand;
		result.x += horizontal.x;
		result.z += horizontal.y;
		result.y += depression + spiral + chop + ringLift;

		let breaking = max( sin( phase ) - 0.23, 0.0 ) * waveBand * 0.82;
		let streak = max( sin( phase2 ) - 0.48, 0.0 ) * outer * 0.35;
		result.w += sprayRing * 1.15 + breaking + streak;
	}
	result.x *= waterspout.intensity;
	result.y *= waterspout.intensity;
	result.z *= waterspout.intensity;
	result.w = clamp( result.w * waterspout.intensity, 0.0, 1.8 );
	return result;
}
`,
		} );

	}

	setIntensity( value ) {

		this.uniforms.fields.intensity.value = Math.max( 0, value );

	}

	_strengthAtAge( age ) {

		if ( age < FORMATION_TIME ) {

			const t = Math.max( 0, age / FORMATION_TIME );
			const smooth = t * t * ( 3 - 2 * t );
			// A spawned cell is already visible; the first minute grows it from a substantial spray
			// column to full maturity instead of making the map action appear to do nothing.
			return 0.3 + smooth * 0.7;

		}
		if ( age < DECAY_START ) return 1;
		const t = Math.max( 0, Math.min( 1, ( age - DECAY_START ) / ( STORM_LIFETIME - DECAY_START ) ) );
		return 1 - t * t * ( 3 - 2 * t );

	}

	_syncStrengths() {

		const values = this.uniforms.fields.strengths.value;
		for ( let i = 0; i < MAX_SPOUTS; i ++ ) values[ i ] = i < this.count ? this._strengthAtAge( this.ages[ i ] ) : 0;

	}

	spawnAt( x, z, { height = null } = {} ) {

		let i;
		if ( this.count < MAX_SPOUTS ) {

			i = this.count ++;
			this.uniforms.fields.activeCount.value = this.count;

		} else {

			i = this.ages[ 0 ] >= this.ages[ 1 ] ? 0 : 1;

		}
		const s = this.spouts[ i ];
		s.set( x, z, height || ( 155 + Math.random() * 75 ) * WATERSPOUT_SCALE, Math.random() * Math.PI * 2 );
		this.ages[ i ] = 0;
		this._syncStrengths();
		this._refreshTimer = Math.max( this._refreshTimer, 90 );
		return i;

	}

	// Refresh one cell every 3–6 minutes, far enough away to be discovered but close enough for the
	// cloud wall and audio to announce it before the hazardous current reaches the player.
	update( dt, focus ) {

		for ( let i = this.count - 1; i >= 0; i -- ) {

			this.ages[ i ] += dt;
			if ( this.ages[ i ] < STORM_LIFETIME ) continue;
			for ( let j = i; j < this.count - 1; j ++ ) {

				this.spouts[ j ].copy( this.spouts[ j + 1 ] );
				this.ages[ j ] = this.ages[ j + 1 ];

			}
			this.count --;
			this.uniforms.fields.activeCount.value = this.count;

		}
		this._syncStrengths();
		if ( ! focus ) return;
		this._refreshTimer -= dt;
		if ( this._refreshTimer > 0 ) return;
		if ( this.count >= MAX_SPOUTS ) {

			this._refreshTimer = 30;
			return;

		}
		const a = Math.random() * Math.PI * 2;
		const d = 3200 + Math.random() * 5200;
		this.spawnAt( focus.x + Math.cos( a ) * d, focus.z + Math.sin( a ) * d );
		this._refreshTimer = 180 + Math.random() * 180;

	}

	_closest( position ) {

		let best = null, bestIndex = - 1, bestR2 = Infinity;
		for ( let i = 0; i < this.count; i ++ ) {

			const s = this.spouts[ i ];
			const dx = position.x - s.x, dz = position.z - s.y;
			const r2 = dx * dx + dz * dz;
			if ( r2 < bestR2 ) { best = s; bestIndex = i; bestR2 = r2; }

		}
		return { spout: best, index: bestIndex, r2: bestR2 };

	}

	nearest( position ) {

		const q = this._closest( position );
		return q.spout ? { spout: q.spout, index: q.index, strength: this._strengthAtAge( this.ages[ q.index ] ), distance: Math.sqrt( q.r2 ) } : null;

	}

	weatherAt( position ) {

		const q = this.nearest( position );
		if ( ! q ) return { distance: Infinity, cloud: 0, wind: 0, bgm: 0, spout: null };
		const smoothOut = ( inner, outer ) => {

			const t = Math.max( 0, Math.min( 1, ( q.distance - inner ) / ( outer - inner ) ) );
			return 1 - t * t * ( 3 - 2 * t );

		};
		return {
			...q,
			cloud: smoothOut( 1200, 6000 ) * q.strength,
			wind: smoothOut( 700, 4200 ) * q.strength,
			bgm: smoothOut( 2200, 6500 ) * q.strength,
		};

	}

	// Airflow used by spray/debris and by the wind load above a boat's waterline.
	velocityAt( position, target = new Vector3() ) {

		const { spout: s, index, r2 } = this._closest( position );
		if ( ! s ) return target.set( 0, 0, 0 );
		const r = Math.sqrt( r2 );
		const scale = WATERSPOUT_SCALE;
		if ( r > 145 * scale || position.y < - 3 || position.y > s.z ) return target.set( 0, 0, 0 );
		const q = Math.max( 0, Math.min( 1, position.y / s.z ) );
		const core = 5 * scale + ( s.z * 0.075 - 5 * scale ) * Math.pow( q, 0.8 );
		const peak = 43 * ( 1 - q * 0.28 );
		const outerFade = 1 - Math.max( 0, Math.min( 1, ( r - 120 * scale ) / ( 25 * scale ) ) ) ** 2;
		const tangential = ( r < core ? peak * r / core : peak * core / Math.max( r, 0.1 ) ) * outerFade;
		const invR = 1 / Math.max( r, 0.1 );
		const envelope = 1 - Math.min( r / ( 145 * scale ), 1 );
		const inflow = ( 2.0 + 8.0 * envelope ) * envelope * ( 1 - q * 0.65 );
		const intensity = this.uniforms.fields.intensity.value * this._strengthAtAge( this.ages[ index ] );
		return target.set(
			- ( position.z - s.y ) * invR * tangential - ( position.x - s.x ) * invR * inflow,
			9.0 * Math.max( 0, 1 - r / ( 95 * scale ) ) * ( 1 - q * 0.35 ),
			( position.x - s.x ) * invR * tangential - ( position.z - s.y ) * invR * inflow
		).multiplyScalar( intensity );

	}

	// Near-surface rotating convergence.  This is intentionally stronger and broader than the
	// visible core: floating bodies first spiral inward, then encounter the steep spray-ring seas.
	surfaceVelocityAt( position, target = new Vector3() ) {

		const { spout: s, index, r2 } = this._closest( position );
		if ( ! s ) return target.set( 0, 0, 0 );
		const r = Math.sqrt( r2 );
		const scale = WATERSPOUT_SCALE;
		if ( r > 175 * scale ) return target.set( 0, 0, 0 );
		const invR = 1 / Math.max( r, 0.1 );
		const core = 11 * scale;
		const peak = 24;
		const fadeT = Math.max( 0, Math.min( 1, ( r - 135 * scale ) / ( 40 * scale ) ) );
		const outerFade = 1 - fadeT * fadeT * ( 3 - 2 * fadeT );
		const tangential = ( r < core ? peak * r / core : peak * core / Math.max( r, 0.1 ) ) * outerFade;
		const envelope = Math.max( 0, 1 - r / ( 175 * scale ) );
		// Gameplay-tuned suction: retain the rotating path but give the inward component enough
		// authority to overcome a powered boat once it commits to the inner storm field.
		const inflow = ( 1.5 + 16.5 * envelope * envelope ) * outerFade;
		const intensity = this.uniforms.fields.intensity.value * this._strengthAtAge( this.ages[ index ] );
		return target.set(
			( - ( position.z - s.y ) * invR * tangential - ( position.x - s.x ) * invR * inflow ) * intensity,
			0,
			( ( position.x - s.x ) * invR * tangential - ( position.z - s.y ) * invR * inflow ) * intensity
		);

	}

}

// Secondary mist/spray shell layered around the continuous screw column.  It uses the original
// rising-particle treatment, while WaterspoutColumn remains the opaque primary silhouette.
export class ParticleWaterspouts {

	constructor( { spray = null, field = null, count = 0, spouts = DEFAULT_SPOUTS } = {} ) {

		this.spray = spray;
		this.field = field || new WaterspoutField( { count, spouts } );
		this.spouts = this.field.spouts;
		this._emitCarry = new Float32Array( MAX_SPOUTS );
		this._emitPos = new Vector3();
		this._emitVel = new Vector3();
		this.uniforms = this.field.uniforms;

		const material = new Material( {
			name: 'Waterspouts',
			modules: [ this.field.module ],
			lit: false,
			transparent: true,
			depthWrite: false,
			depthTest: true,
			side: 'double',
			blending: 'premultiplied',
			underwaterLighting: 'none',
			receiveShadows: false,
			varyings: {
				vSpoutUV: 'vec2f',
				vSpoutColor: 'vec4f',
				vSpoutShape: 'vec4f', // kind, seed, life fraction, edge softness
			},
			vertex: /* wgsl */`
	let instance = v.instance;
	let sid = instance / ${ PARTICLES_PER_SPOUT }u;
	let lid = instance - sid * ${ PARTICLES_PER_SPOUT }u;
	let aliveSpout = sid < waterspout.activeCount;
	let spec = waterspout.spouts[ sid ];
	let stormStrength = waterspout.strengths[ sid ];
	let id = f32( lid );
	let h = waterspoutHash4( id * 1.731 + f32( sid ) * 173.17 );
	let kind = select( select( 2.0, 1.0, lid < ${ COLUMN_PARTICLES + SPRAY_PARTICLES }u ), 0.0, lid < ${ COLUMN_PARTICLES }u );
	let isColumn = kind < 0.5;
	let isWaterStream = isColumn && lid < ${ Math.floor( COLUMN_PARTICLES * 0.5 ) }u;
	let isSpray = kind > 0.5 && kind < 1.5;
	let H = spec.z;
	let phase = spec.w;
	let t = frame.time;
	let S = waterspout.scale;
	let visualScale = sqrt( S );

	// Life is tied to the measured 5-10 m/s updraft: H / life remains in that band.
	let columnLife = mix( H / 9.5, H / 6.0, h.z );
	let sprayLife = mix( 2.4, 5.2, h.z );
	let streakLife = mix( 3.5, 8.0, h.z );
	let life = select( select( streakLife, sprayLife, isSpray ), columnLife, isColumn );
	// Birth and azimuth use independent sequences; coupling them produces visibly regular helices.
	let birth = waterspoutHash( id * 2.773 + f32( sid ) * 91.31 + 11.7 );
	let age = fract( t / life + birth ) * life;
	let q = age / life;

	// Funnel centre leans downwind and has two gentle vortex-wave bends.  The sea-level end stays
	// anchored while the upper plume responds to the larger-scale wind.
	let yq = select( select( h.y * 0.08, pow( q, 0.72 ) * 0.11, isSpray ), q, isColumn );
	let y = frame.seaLevel + yq * H;
	let lean = frame.windDir * ( yq * yq * H * 0.075 );
	let bend = vec2f(
		sin( yq * 8.0 + t * 0.19 + phase ),
		cos( yq * 6.5 + t * 0.16 + phase * 1.7 )
	) * ( 0.7 + yq * 3.2 );
	let centre = spec.xy + lean + bend;

	// The equilibrium shell concentrates droplets away from the exact axis.  It widens upward,
	// while radial inflow slowly tightens each rising trajectory.
	let funnelRadius = mix( 7.0 * S, H * 0.18, pow( yq, 0.72 ) );
	let shell = mix( 0.12, 1.08, sqrt( h.y ) );
	// Half the column particles form three coherent, slightly thick helical water bands.  The rest
	// fill the turbulent spray shell, so the eye can read seawater being carried upward without
	// turning the whole funnel into three artificial-looking ropes.
	let streamShell = mix( 0.68, 0.92, h.y ) * ( 0.94 + 0.06 * sin( h.z * 37.0 + q * 16.0 ) );
	let columnR = funnelRadius * select( shell, streamShell, isWaterStream ) * mix( 1.0, 0.72, q );
	let sprayR = mix( 26.0 * S, 5.0 * S, q ) * mix( 0.65, 1.25, h.y );
	let streakR = ( mix( 5.0, 39.0, h.y ) + sin( q * 6.283 + h.z * 9.0 ) * 2.0 ) * S;
	let radius = select( select( streakR, sprayR, isSpray ), columnR, isColumn );

	// Rankine core radius expands with altitude.  Integrating v_theta/r gives the particle angle.
	let core = mix( 3.0 * S, H * 0.075, pow( yq, 0.8 ) );
	let peak = mix( 30.0, 48.0, h.w ) * mix( 1.0, 0.72, yq );
	let omega = waterspoutTangentialSpeed( radius, core, peak ) / max( radius, 0.25 );
	let randomAzimuth = h.x * 6.2831853;
	let streamArm = floor( h.x * 3.0 ) * ( 6.2831853 / 3.0 ) + ( h.y - 0.5 ) * 0.48;
	let turn = age * omega + phase + select( randomAzimuth, streamArm, isWaterStream );
	let wobble = sin( age * mix( 1.8, 3.4, h.z ) + h.w * 20.0 ) * mix( 0.1, 0.42, yq );
	let turbulence = sin( age * 2.17 + h.y * 51.0 ) * 0.16 + sin( yq * 19.0 - t * 0.71 + h.z * 83.0 ) * 0.22;
	let angle = turn + wobble + turbulence;
	let radial = vec2f( cos( angle ), sin( angle ) );
	var p = vec3f( centre.x + radial.x * radius, y, centre.y + radial.y * radius );

	// Base spray is lofted water; surface streaks skim the convergence ring.
	let sprayArc = sin( q * PI );
	p.y += select( select( 0.08 + h.z * 0.18, sprayArc * mix( 4.0, 16.0, h.w ), isSpray ), 0.0, isColumn );
	let tangent = vec3f( - radial.y, 0.0, radial.x );
	let verticalV = select( select( 0.0, cos( q * PI ) * 7.0, isSpray ), H / life, isColumn );
	let velocity = tangent * waterspoutTangentialSpeed( radius, core, peak ) + vec3f( 0.0, verticalV, 0.0 );

	let toCam = frame.cameraPos - p;
	let dist = max( length( toCam ), 0.1 );
	let Vd = toCam / dist;
	let pixel = dist * 2.0 / max( frame.proj[ 1 ][ 1 ] * frame.resolution.y, 1.0 );
	let columnSize = mix( 0.9, 3.1, h.w ) * mix( 1.0, 1.9, yq ) * select( 1.0, 1.22, isWaterStream );
	let baseSize = select( select( mix( 0.18, 0.48, h.w ), mix( 0.5, 1.5, h.w ), isSpray ), columnSize, isColumn ) * visualScale;
	let halfX = max( baseSize, pixel * 0.85 );
	let motionStretch = select( 0.0, min( length( velocity ) * 0.028, baseSize * 2.2 ), isSpray || isColumn );
	let halfY = halfX + motionStretch;
	var axisY = select( vec3f( 0.0, 1.0, 0.0 ), normalize( velocity + vec3f( 0.0, 0.01, 0.0 ) ), length( velocity ) > 0.1 );
	let axisX = normalize( cross( axisY, Vd ) + vec3f( 1e-5, 0.0, 0.0 ) );
	axisY = normalize( cross( Vd, axisX ) );
	let corner = v.position.xy;
	let world = p + axisX * ( corner.x * halfX ) + axisY * ( corner.y * halfY );

	let sunSide = 0.72 + 0.28 * max( dot( - Vd, frame.sunDir ), 0.0 );
	let light = frame.skyIrradiance * 0.82 + frame.sunColor * ( 0.11 * sunSide );
	let upper = vec3f( 0.25, 0.29, 0.34 );
	let seaWater = vec3f( 0.34, 0.75, 0.88 );
	let brightWater = vec3f( 0.90, 0.98, 1.02 );
	let risingWater = mix( brightWater, seaWater, smoothstep( 0.04, 0.62, yq ) );
	let columnColor = mix( risingWater, upper, smoothstep( 0.68, 0.94, yq ) );
	let sprayColor = vec3f( 1.03, 1.08, 1.10 );
	let streakColor = vec3f( 0.78, 0.88, 0.92 );
	let tint = select( select( streakColor, sprayColor, isSpray ), columnColor, isColumn );
	let lifeFade = smoothstep( 0.0, 0.08, q ) * ( 1.0 - smoothstep( 0.78, 1.0, q ) );
	// Keep the upper neck visible so the rotating column joins the low cloud deck instead of
	// dissolving in clear air just below it.
	let altitudeFade = select( 1.0, mix( 1.0, 0.58, smoothstep( 0.88, 1.0, yq ) ), isColumn );
	let distanceFade = smoothstep( waterspout.maxDistance, waterspout.maxDistance * 0.72, dist );
	let lowerColumn = mix( 1.12, 0.62, smoothstep( 0.0, 0.68, yq ) ) * select( 1.0, 1.25, isWaterStream );
	let baseAlpha = select( select( 0.22, 0.62, isSpray ), mix( lowerColumn, 0.38, smoothstep( 0.72, 1.0, yq ) ), isColumn );
	let alpha = baseAlpha * lifeFade * altitudeFade * distanceFade * waterspout.intensity * stormStrength;

	o.vSpoutUV = corner;
	o.vSpoutColor = vec4f( tint * light, alpha );
	o.vSpoutShape = vec4f( kind, h.w, q, select( 3.2, 2.35, isColumn ) );
	v.useWorld = true;
	v.worldPos = select( vec3f( 0.0, -1e5, 0.0 ), world, aliveSpout && alpha > 1e-4 );
	v.worldNormal = Vd;
	// The plume owns its motion vectors; this greatly reduces TAA smearing at the silhouette.
	v.prevWorldPos = v.worldPos - velocity * frame.dt;
`,
			surface: /* wgsl */`
	let uv = in.vs.vSpoutUV;
	let shapeInfo = in.vs.vSpoutShape;
	let kind = shapeInfo.x;
	let isColumn = kind < 0.5;
	let isSpray = kind > 0.5 && kind < 1.5;
	let r2 = dot( uv, uv );
	let seed = shapeInfo.y;
	let life = shapeInfo.z;
	let fibres = 0.72 + 0.28 * sin( uv.y * 9.0 + uv.x * 3.0 + seed * 37.0 + life * 13.0 );
	let clumps = 0.78 + 0.22 * sin( uv.x * 11.0 - uv.y * 5.0 + seed * 71.0 );
	let gaussian = exp( - r2 * shapeInfo.w );
	let columnShape = gaussian * fibres * clumps;
	let sprayShape = max( gaussian - 0.035, 0.0 ) * ( 0.72 + clumps * 0.28 );
	let streakShape = exp( - abs( uv.y ) * 3.0 - uv.x * uv.x * 1.7 ) * fibres;
	let shape = select( select( streakShape, sprayShape, isSpray ), columnShape, isColumn );
	let alpha = in.vs.vSpoutColor.w * shape;
	if ( r2 > 1.0 || alpha < 0.002 ) { discard; }
	s.albedo = in.vs.vSpoutColor.rgb * alpha;
	s.emissive = vec3f( 0.0 );
	s.alpha = alpha;
`,
			output: 'r.color = vec4f( s.albedo, s.alpha );',
		} );

		const geometry = new PlaneGeometry( 2, 2 );
		geometry.instanceCount = 0;
		this.geometry = geometry;
		this.material = material;
		this.mesh = new Mesh( geometry, material );
		this.mesh.name = 'Waterspouts';
		this.mesh.frustumCulled = false;
		this.mesh.castShadow = false;
		this.mesh.receiveShadow = false;
		this.mesh.renderOrder = 19;
		this.mesh.layers.set( LAYERS.TRANSPARENT );

	}

	set enabled( value ) {

		this.mesh.visible = !! value;

	}

	get enabled() {

		return this.mesh.visible;

	}

	setIntensity( value ) {

		this.field.setIntensity( value );

	}

	// Keep the existing physically shaded spray system involved at close range.  These droplets
	// are deliberately sparse: the analytical mesh supplies the plume, while Spray supplies bright
	// water beads that inherit Tidewater's normal lighting, soft intersections and foam deposition.
	update( dt, camera ) {

		const wantedInstances = PARTICLES_PER_SPOUT * this.field.count;
		if ( this.geometry.instanceCount !== wantedInstances ) this.geometry.instanceCount = wantedInstances;
		if ( ! this.mesh.visible || ! this.spray || ! camera ) return;
		for ( let i = 0; i < this.field.count; i ++ ) {

			const s = this.spouts[ i ];
			const dx = camera.position.x - s.x, dz = camera.position.z - s.y;
			if ( dx * dx + dz * dz > 650 * 650 ) continue;
			const strength = this.field._strengthAtAge( this.field.ages[ i ] );
			this._emitCarry[ i ] += dt * 180 * strength;
			const n = Math.floor( this._emitCarry[ i ] );
			if ( n <= 0 ) continue;
			this._emitCarry[ i ] -= n;
			this._emitPos.set( s.x, 1.2, s.y );
			this._emitVel.set( 0, 7.5, 0 );
			this.spray.emit( this._emitPos, this._emitVel, n, 0.5, SPRAY.SPRAY, {
				spread: 5.5 * WATERSPOUT_SCALE,
				jitter: 14,
				life: 4.8,
				sizeJitter: 0.75,
			} );

		}

	}

	// CPU-side version shared with gameplay systems.
	velocityAt( position, target = new Vector3() ) {

		return this.field.velocityAt( position, target );

	}

}

export { Waterspouts } from './WaterspoutColumn.js';
