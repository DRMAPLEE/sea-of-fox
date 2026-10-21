import { Color, Group, Mesh, SphereGeometry, TorusGeometry, Vector3 } from '../engine/index.js';
import { Material } from '../engine/render/Material.js';
import { loadStaticGLTF } from '../engine/loaders/StaticGLTF.js';
import { LAYERS } from '../core/SceneRenderer.js';

const GRAVITY = 9.81;
const MAX_RANGE = 2000;
const MIN_RANGE = 100;
const MAX_TRAVERSE = 50 * Math.PI / 180;
const RELOAD_SECONDS = 6;
// A deliberately tight grouping around the selected point. The former 58 m footprint read more
// like area bombardment than one four-gun broadside.
const CIRCLE_RADIUS = 5.8;
const LINE_SPACING = 42;

const _origin = new Vector3();
const _target = new Vector3();
const _velocity = new Vector3();
const _direction = new Vector3();
const _forward = new Vector3();
const _right = new Vector3();
const _up = new Vector3( 0, 1, 0 );
const _look = new Vector3();
const _cameraWant = new Vector3();
const _cameraTarget = new Vector3();

export function ballisticVelocity( origin, target, flightTime, out = new Vector3() ) {

	const t = Math.max( 0.1, flightTime );
	return out.subVectors( target, origin ).multiplyScalar( 1 / t ).addScaledVector( _up, 0.5 * GRAVITY * t );

}

export function broadsideDirection( side, angle, boatQuaternion, out = new Vector3() ) {

	const a = Math.max( - MAX_TRAVERSE, Math.min( MAX_TRAVERSE, angle ) );
	// Boat frame: +Z bow, +X port. Angle sweeps fore/aft around the selected broadside.
	return out.set( side * Math.cos( a ), 0, Math.sin( a ) ).applyQuaternion( boatQuaternion ).setY( 0 ).normalize();

}

function artilleryMaterial( name, color, emissive, opacity = 1 ) {

	return new Material( {
		name,
		lit: opacity >= 1,
		color: new Color( color ),
		emissive: new Color( emissive ),
		opacity,
		transparent: opacity < 1,
		blending: opacity < 1 ? 'additive' : 'none',
		depthWrite: opacity >= 1,
		receiveShadows: false,
	} );

}

function smokeMaterial() {

	return new Material( {
		name: 'artillery-fluid-smoke',
		lit: false,
		color: new Color( 0x171b1d ),
		emissive: new Color( 0x090605 ),
		opacity: 0,
		transparent: true,
		blending: 'normal',
		depthWrite: false,
		side: 'double',
		receiveShadows: false,
		uniforms: { heat: [ 'f32', 1 ] },
		surface: /* wgsl */`
	let q = in.P * 0.21;
	let n = sin( q.x * 2.1 + frame.time * 0.36 ) * sin( q.y * 1.7 - frame.time * 0.21 )
		+ sin( q.z * 2.7 + q.x * 0.8 ) * 0.55 + sin( ( q.x + q.y + q.z ) * 4.3 ) * 0.22;
	let billow = smoothstep( -0.82, 0.58, n );
	let softEdge = pow( sat( abs( dot( normalize( in.N ), normalize( in.V ) ) ) ), 0.72 );
	s.alpha *= billow * softEdge;
	let hot = mat.heat * smoothstep( -0.1, 1.15, n );
	s.albedo = mix( vec3f( 0.025, 0.03, 0.032 ), vec3f( 0.22, 0.065, 0.012 ), hot );
	s.emissive = vec3f( 2.8, 0.24, 0.012 ) * hot * hot;
`,
	} );

}

export class NavalArtillery {

	constructor( { app, boat, cannons, modelUrl } ) {

		this.app = app;
		this.scene = app.scene;
		this.camera = app.camera;
		this.input = app.input;
		this.boat = boat;
		this.cannons = cannons;
		this.modelUrl = modelUrl;
		this.player = null;
		this.active = false;
		this.side = 1;
		this.angle = 0;
		this.range = 650;
		this.pattern = 'circle';
		this.viewMode = 'overhead';
		this.reload = 0;
		this.salvo = [];
		this.shells = [];
		this.explosions = [];
		this._lmb = false;
		this._hud = null;
		this._projectileTemplate = null;
		this._cameraReady = false;

		this.guide = new Group();
		this.guide.name = 'ArtilleryAimGuide';
		this.guide.visible = false;
		this.scene.add( this.guide );

		this.guideMaterial = artilleryMaterial( 'artillery-trajectory', 0xa8efff, 0x36b8e8, 0.72 );
		this.impactMaterial = artilleryMaterial( 'artillery-damage-radius', 0xff2d21, 0xff0900, 0.9 );
		const dotGeo = new SphereGeometry( 0.85, 8, 5 );
		this.trajectoryDots = [];
		for ( let i = 0; i <= 28; i ++ ) {

			const dot = new Mesh( dotGeo, this.guideMaterial );
			dot.layers.set( LAYERS.TRANSPARENT );
			dot.castShadow = false;
			dot.frustumCulled = false;
			this.trajectoryDots.push( dot );
			this.guide.add( dot );

		}
		const ringGeo = new TorusGeometry( 1, 0.045, 7, 64 );
		this.impactRings = [];
		for ( let i = 0; i < 4; i ++ ) {

			const ring = new Mesh( ringGeo, this.impactMaterial );
			ring.layers.set( LAYERS.TRANSPARENT );
			ring.rotation.x = Math.PI / 2;
			ring.castShadow = false;
			ring.frustumCulled = false;
			this.impactRings.push( ring );
			this.guide.add( ring );

		}

		this._smokeSphere = new SphereGeometry( 1, 14, 9 );

	}

	async load() {

		const imported = await loadStaticGLTF( this.modelUrl );
		const size = imported.bounds.getSize( new Vector3() );
		const center = imported.bounds.getCenter( new Vector3() );
		const span = Math.max( size.x, size.y, size.z );
		if ( ! ( span > 0.01 ) ) throw new Error( 'NavalArtillery: projectile model has invalid bounds' );
		// The mounted guns are 3.5 m long; a ~50 cm visual profile stays readable in the high
		// fire-control view while remaining much smaller than the barrel and carriage.
		const scale = 0.5 / span;
		const root = imported.group.clone( true );
		root.name = 'ArtilleryProjectileVisual';
		root.scale.setScalar( scale );
		root.position.set( - center.x * scale, - center.y * scale, - center.z * scale );
		root.traverse( ( object ) => {

			if ( object.material ) object.material.underwaterLighting = 'lite';

		} );
		this._projectileTemplate = root;
		return this;

	}

	attachPlayer( player ) {

		this.player = player;
		player.artillery = this;

	}

	stationFor( player ) {

		if ( player.boat !== this.boat || player.mode !== 'deck' || player.busy ) return null;
		let best = null;
		for ( const side of [ 1, - 1 ] ) {

			// The midpoint of each four-gun battery is the interaction station. Height is deliberately
			// loose because the imported deck has several walkable levels around the gun ports.
			const point = _target.set( side * 3.4, 2.95, - 14.8 );
			const dx = player.deckPos.x - point.x, dz = player.deckPos.z - point.z;
			const distance = Math.hypot( dx, dz );
			if ( distance < 4.4 && Math.abs( player.deckPos.y - point.y ) < 2.2 && ( ! best || distance < best.distance ) ) best = { side, distance };

		}
		return best;

	}

	offerFromDeck( player ) {

		const station = this.stationFor( player );
		if ( ! station ) return false;
		const name = station.side > 0 ? '左舷' : '右舷';
		player.prompt = { key: 'E', text: `使用${ name }炮组` };
		if ( this.input.hit( 'KeyE' ) ) {

			this.enter( player, station.side );
			return true;

		}
		return false;

	}

	enter( player, side ) {

		this.player = player;
		this.side = side >= 0 ? 1 : - 1;
		this.angle = 0;
		this.viewMode = 'overhead';
		this.active = true;
		this._cameraReady = false;
		this._lmb = !! this.input.mouseDown;
		player.mode = 'cannon';
		player.boat = this.boat;
		player.velocity.set( 0, 0, 0 );
		player.deckVel.set( 0, 0, 0 );
		this.guide.visible = true;
		this.app.audio?.artilleryReady();
		this._showHUD( true );
		this.app.ui?.ui?.toast( `${ this.side > 0 ? '左舷' : '右舷' }炮组就位`, 1300 );

	}

	exit() {

		if ( ! this.active || ! this.player ) return;
		const player = this.player;
		this.active = false;
		this.guide.visible = false;
		this._showHUD( false );
		player.mode = 'deck';
		player.deckYaw = this.side > 0 ? - Math.PI / 2 : Math.PI / 2;
		player.pitch = - 0.05;
		player._camY = null;
		player.deckToWorld();

	}

	update( dt ) {

		this.reload = Math.max( 0, this.reload - dt );
		this._updateQueued( dt );
		this._updateShells( dt );
		this._updateExplosions( dt );
		if ( ! this.active ) return;

		const player = this.player;
		const inp = this.input;
		const look = inp.consumeLook();
		this.angle = Math.max( - MAX_TRAVERSE, Math.min( MAX_TRAVERSE, this.angle - look.x * 0.0017 ) );
		this.range = Math.max( MIN_RANGE, Math.min( MAX_RANGE, this.range - look.y * 3.2 ) );

		if ( inp.hit( 'KeyE' ) || inp.hit( 'Escape' ) ) {

			this.exit();
			return;

		}
		if ( inp.hit( 'KeyQ' ) || inp.hit( 'KeyR' ) ) {

			this.pattern = this.pattern === 'circle' ? 'line' : 'circle';
			this.app.ui?.ui?.toast( this.pattern === 'circle' ? '圆形范围打击' : '横排范围打击', 950 );

		}
		if ( inp.hit( 'KeyV' ) ) {

			this.viewMode = this.viewMode === 'overhead' ? 'gun' : 'overhead';
			this._cameraReady = false;
			this.app.ui?.ui?.toast( this.viewMode === 'overhead' ? '船体上空火控视角' : '甲板炮组视角', 950 );

		}

		const lmb = !! inp.mouseDown && inp.enabled;
		if ( lmb && ! this._lmb ) this.fireSalvo();
		this._lmb = lmb;
		player.prompt = { key: 'E', text: '退出炮位   ·   V 切视角   ·   鼠标 瞄准   ·   左键 齐射' };

		this._aimPoint( _target );
		this._updateGuide( _target );
		this._updateCamera( dt, _target );
		this._updateHUD();

	}

	updateWorld( dt ) {

		// Projectiles keep flying after the player leaves the station.
		if ( this.active ) return;
		this.reload = Math.max( 0, this.reload - dt );
		this._updateQueued( dt );
		this._updateShells( dt );
		this._updateExplosions( dt );

	}

	_aimPoint( out ) {

		broadsideDirection( this.side, this.angle, this.boat.quaternion, _direction );
		out.copy( this.boat.position ).addScaledVector( _direction, this.range );
		const terrainY = this.app.terrainData?.heightAt( out.x, out.z );
		out.y = Number.isFinite( terrainY ) && terrainY > 0 ? terrainY + 0.35 : 0.3;
		return out;

	}

	_guideOrigin( out ) {

		// The fire-control solution is intentionally presented from the ship's centre rather than
		// any one muzzle, so the shared broadside arc is stable while the hull moves and rolls.
		return this.boat.toWorld( new Vector3( 0, 7.5, 0 ), out );

	}

	_flightTime( origin, target ) {

		const d = Math.hypot( target.x - origin.x, target.z - origin.z );
		return Math.max( 2.7, Math.min( 7.2, 2.3 + d / 410 ) );

	}

	_updateGuide( target ) {

		const origin = this._guideOrigin( _origin );
		const flightTime = this._flightTime( origin, target );
		ballisticVelocity( origin, target, flightTime, _velocity );
		for ( let i = 0; i < this.trajectoryDots.length; i ++ ) {

			const t = flightTime * i / ( this.trajectoryDots.length - 1 );
			this.trajectoryDots[ i ].position.copy( origin ).addScaledVector( _velocity, t ).addScaledVector( _up, - 0.5 * GRAVITY * t * t );
			this.trajectoryDots[ i ].scale.setScalar( 0.75 + i * 0.035 );

		}
		broadsideDirection( this.side, this.angle, this.boat.quaternion, _forward );
		_right.set( - _forward.z, 0, _forward.x );
		for ( let i = 0; i < this.impactRings.length; i ++ ) {

			const ring = this.impactRings[ i ];
			const visible = this.pattern === 'line' || i === 0;
			ring.visible = visible;
			if ( ! visible ) continue;
			ring.position.copy( target );
			if ( this.pattern === 'line' ) ring.position.addScaledVector( _right, ( i - 1.5 ) * LINE_SPACING );
			ring.position.y = this._impactHeight( ring.position ) + 0.18;
			ring.scale.setScalar( CIRCLE_RADIUS );

		}

	}

	_updateCamera( dt, aimPoint ) {

		broadsideDirection( this.side, this.angle, this.boat.quaternion, _direction );
		const scale = this.boat.model.cameraScale || 1;
		this.boat.toWorld( new Vector3( 0, this.boat.model.cameraTargetY || 10, 0 ), _cameraTarget );
		if ( this.viewMode === 'gun' ) {

			// Eye point immediately inboard of the selected battery: the player is standing beside
			// the guns and looking along their current traverse direction.
			this.boat.toWorld( new Vector3( this.side * 2.65, 6.65, - 14.7 ), _cameraWant );

		} else {

			// Stay directly above the ship in X/Z. Height grows with range so both the ship and the
			// final ballistic guide point remain in frame from 100 m all the way to 2 km.
			_cameraWant.copy( _cameraTarget ).addScaledVector( _up, Math.max( 12 * scale, this.range * 1.05 ) );

		}
		if ( ! this._cameraReady ) {

			this.player.camPos.copy( _cameraWant );
			this._cameraReady = true;

		}
		this.player.camPos.lerp( _cameraWant, 1 - Math.exp( - dt * 5 ) );
		this.camera.position.copy( this.player.camPos );
		if ( this.viewMode === 'gun' ) {

			_look.copy( this.camera.position ).addScaledVector( _direction, 320 );
			_look.y -= 7;

		} else {

			_look.copy( _cameraTarget ).lerp( aimPoint, 0.5 );
			_look.y = _cameraTarget.y;

		}
		this.camera.lookAt( _look );
		this.boat.toWorld( new Vector3( this.side * 3.4, 2.95, - 14.8 ), this.player.position );

	}

	fireSalvo() {

		if ( this.reload > 0 || this.salvo.length ) {

			this.app.ui?.ui?.toast( `装填中 ${ Math.ceil( this.reload ) } 秒`, 850 );
			return false;

		}
		const guns = this.cannons.filter( ( cannon ) => ( cannon.side === 'port' ? 1 : - 1 ) === this.side );
		if ( ! guns.length ) return false;
		const centre = this._aimPoint( new Vector3() ).clone();
		broadsideDirection( this.side, this.angle, this.boat.quaternion, _forward );
		_right.set( - _forward.z, 0, _forward.x );

		for ( let i = 0; i < guns.length; i ++ ) {

			const target = centre.clone();
			if ( this.pattern === 'circle' ) {

				const a = i / guns.length * Math.PI * 2 + 0.35;
				target.x += Math.cos( a ) * CIRCLE_RADIUS * 0.62;
				target.z += Math.sin( a ) * CIRCLE_RADIUS * 0.62;

			} else target.addScaledVector( _right, ( i - ( guns.length - 1 ) / 2 ) * LINE_SPACING );
			target.y = this._impactHeight( target );
			this.salvo.push( { gun: guns[ i ], target, delay: i * 0.11 } );

		}
		this.reload = RELOAD_SECONDS;
		this.app.ui?.ui?.toast( `${ this.side > 0 ? '左舷' : '右舷' }齐射！`, 900 );
		return true;

	}

	_updateQueued( dt ) {

		for ( let i = this.salvo.length - 1; i >= 0; i -- ) {

			const shot = this.salvo[ i ];
			shot.delay -= dt;
			if ( shot.delay > 0 ) continue;
			this._spawnShell( shot.gun, shot.target );
			this.salvo.splice( i, 1 );

		}

	}

	_spawnShell( gun, target ) {

		if ( gun.muzzle ) gun.muzzle.getWorldPosition( _origin );
		else this.boat.toWorld( gun.group.position, _origin );
		const origin = _origin.clone();
		const flightTime = this._flightTime( origin, target );
		const velocity = ballisticVelocity( origin, target, flightTime, new Vector3() );
		const root = new Group();
		root.name = 'ArtilleryProjectile';
		if ( this._projectileTemplate ) root.add( this._projectileTemplate.clone( true ) );
		else {

			const fallback = new Mesh( new SphereGeometry( 0.25, 12, 8 ), artilleryMaterial( 'cannonball', 0x24272a, 0x090b0c ) );
			fallback.castShadow = true;
			root.add( fallback );

		}
		root.position.copy( origin );
		root.scale.setScalar( 1 );
		this.scene.add( root );
		const voice = this.app.audio?.artilleryFlight( origin ) || null;
		this.shells.push( { root, position: origin, velocity, age: 0, flightTime, target: target.clone(), voice } );
		gun.fire( this.app.spray, !! this.app.audio && ! this.app.audio.muted );

	}

	_updateShells( dt ) {

		for ( let i = this.shells.length - 1; i >= 0; i -- ) {

			const shell = this.shells[ i ];
			shell.age += dt;
			if ( shell.age >= shell.flightTime ) {

				this._explode( shell.target );
				this.app.audio?.stopArtilleryVoice( shell.voice );
				shell.root.removeFromParent();
				this.shells.splice( i, 1 );
				continue;

			}
			shell.velocity.y -= GRAVITY * dt;
			shell.position.addScaledVector( shell.velocity, dt );
			shell.root.position.copy( shell.position );
			_look.copy( shell.position ).add( shell.velocity );
			shell.root.lookAt( _look );
			this.app.audio?.moveArtilleryVoice( shell.voice, shell.position );

		}

	}

	_explode( point ) {

		const root = new Group();
		root.name = 'ArtilleryFluidExplosion';
		root.position.copy( point );
		this.scene.add( root );

		const smoke = smokeMaterial();
		const puffs = [];
		for ( let i = 0; i < 22; i ++ ) {

			const a = i * 2.399963 + Math.sin( i * 17.13 ) * 0.38;
			const radial = 0.6 + ( ( i * 37 ) % 11 ) / 11 * 3.2;
			const puff = new Mesh( this._smokeSphere, smoke );
			puff.position.set( Math.cos( a ) * radial, 1 + ( i % 5 ) * 0.45, Math.sin( a ) * radial );
			puff.layers.set( LAYERS.TRANSPARENT );
			puff.frustumCulled = false;
			puff.rotation.set( a * 0.21, a, a * 0.37 );
			root.add( puff );
			const speed = 2.2 + ( ( i * 19 ) % 13 ) / 13 * 4.8;
			puffs.push( {
				mesh: puff,
				velocity: new Vector3( Math.cos( a ) * speed, 5.5 + ( i % 7 ) * 0.75, Math.sin( a ) * speed ),
				base: 1.4 + ( ( i * 29 ) % 17 ) / 17 * 2.4,
				phase: a,
			} );

		}
		this.explosions.push( { root, smoke, puffs, age: 0 } );
		this.app.audio?.artilleryExplosion( point );
		if ( this.app.spray ) {

			_velocity.set( 0, 13, 0 );
			this.app.spray.emit( point, _velocity, 260, 0.7, 3, { spread: 18, jitter: 3, life: 2.4, sizeJitter: 0.9 } );
			_velocity.set( 0, 5, 0 );
			this.app.spray.emit( point, _velocity, 150, 1.15, 1, { spread: 8, jitter: 5, life: 4.2, sizeJitter: 0.85 } );

		}

	}

	_updateExplosions( dt ) {

		for ( let i = this.explosions.length - 1; i >= 0; i -- ) {

			const explosion = this.explosions[ i ];
			explosion.age += dt;
			const smokeP = Math.min( 1, explosion.age / 7.2 );
			const fadeIn = Math.min( 1, explosion.age / 0.08 );
			const fadeOut = 1 - Math.max( 0, ( smokeP - 0.68 ) / 0.32 );
			explosion.smoke.opacity = 0.28 * fadeIn * fadeOut;
			explosion.smoke.uniforms.heat.value = Math.max( 0, 1 - explosion.age / 1.65 );
			for ( const puff of explosion.puffs ) {

				// Semi-Lagrangian-looking advection: buoyant rise, velocity diffusion and a decaying
				// tangential confinement force keep the plume rolling instead of expanding uniformly.
				const x = puff.mesh.position.x, z = puff.mesh.position.z;
				const invR = 1 / Math.max( 1, Math.hypot( x, z ) );
				const confinement = ( 1 - smokeP ) * 3.8;
				puff.velocity.x += - z * invR * confinement * dt;
				puff.velocity.z += x * invR * confinement * dt;
				puff.velocity.x += Math.sin( explosion.age * 2.1 + puff.phase ) * dt * 0.8;
				puff.velocity.z += Math.cos( explosion.age * 1.7 + puff.phase ) * dt * 0.8;
				puff.velocity.x *= Math.exp( - dt * 0.42 );
				puff.velocity.z *= Math.exp( - dt * 0.42 );
				puff.velocity.y += ( 2.1 - puff.velocity.y ) * ( 1 - Math.exp( - dt * 0.7 ) );
				puff.mesh.position.addScaledVector( puff.velocity, dt );
				puff.mesh.rotation.y += dt * ( 0.18 + puff.phase * 0.015 );
				puff.mesh.rotation.x += dt * 0.09;
				const spread = puff.base * ( 0.65 + 2.35 * ( 1 - Math.pow( 1 - smokeP, 2 ) ) );
				puff.mesh.scale.set( spread * 1.08, spread, spread * 0.94 );

			}
			if ( smokeP >= 1 ) {

				explosion.root.removeFromParent();
				explosion.smoke.dispose();
				this.explosions.splice( i, 1 );

			}

		}

	}

	_impactHeight( point ) {

		const y = this.app.terrainData?.heightAt( point.x, point.z );
		return Number.isFinite( y ) && y > 0 ? y + 0.35 : 0.3;

	}

	_createHUD() {

		if ( this._hud || typeof document === 'undefined' ) return;
		const style = document.createElement( 'style' );
		style.textContent = `
.na-hud{position:absolute;inset:0;display:none;pointer-events:none;color:#dff9ff;font:600 13px/1.25 ui-monospace,SFMono-Regular,Menlo,monospace;text-shadow:0 2px 5px #00151d;z-index:16}
.na-hud.is-on{display:block}.na-readout{position:absolute;left:50%;top:6%;transform:translateX(-50%);display:flex;gap:16px;align-items:center;padding:8px 14px;border:1px solid rgba(154,231,245,.25);border-radius:3px;background:rgba(3,20,27,.58);backdrop-filter:blur(8px)}
.na-range{font-size:16px;color:#fff1b9}.na-range-meter{width:150px}.na-range-limits{display:flex;justify-content:space-between;margin-bottom:3px;font-size:9px;color:rgba(223,249,255,.58)}.na-range-track{display:block;height:3px;background:rgba(255,255,255,.15);overflow:hidden}.na-range-track i{display:block;height:100%;background:#ffe083;box-shadow:0 0 7px #ffb12e;transform-origin:left}.na-mode{color:#aeefff}.na-reload{position:absolute;left:50%;bottom:12%;transform:translateX(-50%);min-width:280px;text-align:center}.na-bar{display:block;height:3px;margin-top:7px;background:rgba(255,255,255,.16);overflow:hidden}.na-bar i{display:block;height:100%;width:100%;background:#8eeaff;transform-origin:left}.na-help{position:absolute;right:4%;top:50%;transform:translateY(-50%);text-align:right;color:rgba(223,249,255,.72);line-height:1.8}.na-help b{color:#fff1b9}
`;
		document.head.append( style );
		const hud = document.createElement( 'div' );
		hud.className = 'na-hud';
		hud.innerHTML = `<div class="na-readout"><span class="na-side"></span><span class="na-range"></span><span class="na-range-meter"><span class="na-range-limits"><i>100 m</i><i>2 km</i></span><span class="na-range-track"><i></i></span></span><span class="na-mode"></span></div><div class="na-reload"><span></span><em class="na-bar"><i></i></em></div><div class="na-help">鼠标水平　调整炮向 ±50°<br><b>鼠标上下</b>　调整 100 m–2 km<br><b>V</b>　上空 / 炮组视角<br><b>左键</b>　整舷齐射<br><b>Q</b>　圆形 / 横排<br><b>E</b>　退出炮位</div>`;
		( this.app.ui?.ui?.hud || document.getElementById( 'app' ) || document.body ).append( hud );
		this._hud = hud;
		this._hudSide = hud.querySelector( '.na-side' );
		this._hudRange = hud.querySelector( '.na-range' );
		this._hudMode = hud.querySelector( '.na-mode' );
		this._hudRangeBar = hud.querySelector( '.na-range-track i' );
		this._hudReload = hud.querySelector( '.na-reload span' );
		this._hudBar = hud.querySelector( '.na-bar i' );

	}

	_showHUD( show ) {

		this._createHUD();
		this._hud?.classList.toggle( 'is-on', show );

	}

	_updateHUD() {

		this._createHUD();
		if ( ! this._hud ) return;
		this._hudSide.textContent = this.side > 0 ? '左舷炮组' : '右舷炮组';
		this._hudRange.textContent = `${ Math.round( this.range ) } m`;
		this._hudRangeBar.style.transform = `scaleX(${ ( this.range - MIN_RANGE ) / ( MAX_RANGE - MIN_RANGE ) })`;
		this._hudMode.textContent = this.pattern === 'circle' ? '○ 圆形散布' : '━ 横排散布';
		this._hudReload.textContent = this.reload > 0 ? `装填中 · ${ this.reload.toFixed( 1 ) } s` : '火炮就绪';
		this._hudBar.style.transform = `scaleX(${ 1 - this.reload / RELOAD_SECONDS })`;

	}

}
