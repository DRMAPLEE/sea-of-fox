import { Color, Group, Mesh, Quaternion, SphereGeometry, TorusGeometry, Vector3 } from '../engine/index.js';
import { Material } from '../engine/render/Material.js';
import { loadStaticGLTF } from '../engine/loaders/StaticGLTF.js';
import { LAYERS } from '../core/SceneRenderer.js';
import { addVegetationBlast } from '../world/vegetation/VegNodes.js';

const GRAVITY = 9.81;
const MAX_RANGE = 2000;
const MIN_RANGE = 100;
const MAX_TRAVERSE = 50 * Math.PI / 180;
const RELOAD_SECONDS = 6;
// A deliberately tight grouping around the selected point. The former 58 m footprint read more
// like area bombardment than one four-gun broadside.
const CIRCLE_RADIUS = 5.8;
const LINE_SPACING = 42;
const DRIVER_BATTERIES = [ 'port', 'bow', 'starboard' ];
const BATTERY_LABELS = { port: '左舷炮组', bow: '舰首炮组', starboard: '右舷炮组' };

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
const _followCenter = new Vector3();
const _followVelocity = new Vector3();
const _followDirection = new Vector3();
const _shellNext = new Vector3();
const _shellImpact = new Vector3();
const _rayDirection = new Vector3();
const _collisionSample = new Vector3();
const _localStart = new Vector3();
const _localEnd = new Vector3();
const _localProbe = new Vector3();
const _meshStart = new Vector3();
const _meshEnd = new Vector3();
const _inverseBoat = new Quaternion();

export function ballisticVelocity( origin, target, flightTime, out = new Vector3() ) {

	const t = Math.max( 0.1, flightTime );
	return out.subVectors( target, origin ).multiplyScalar( 1 / t ).addScaledVector( _up, 0.5 * GRAVITY * t );

}

export function broadsideDirection( side, angle, boatQuaternion, out = new Vector3() ) {

	const a = Math.max( - MAX_TRAVERSE, Math.min( MAX_TRAVERSE, angle ) );
	// Boat frame: +Z bow, +X port. Angle sweeps fore/aft around the selected broadside.
	return out.set( side * Math.cos( a ), 0, Math.sin( a ) ).applyQuaternion( boatQuaternion ).setY( 0 ).normalize();

}

export function traverseFromLook( side, angle, lookX, sensitivity = 0.0017 ) {

	// The two batteries face opposite directions. Their camera-right axes are therefore mirrored,
	// so the same screen-space mouse movement must apply an opposite local traverse sign.
	const next = angle + lookX * sensitivity * ( side >= 0 ? 1 : - 1 );
	return Math.max( - MAX_TRAVERSE, Math.min( MAX_TRAVERSE, next ) );

}

export function batteryDirection( battery, angle, boatQuaternion, out = new Vector3() ) {

	const baseYaw = battery === 'port' ? Math.PI / 2 : battery === 'starboard' ? - Math.PI / 2 : 0;
	const a = Math.max( - MAX_TRAVERSE, Math.min( MAX_TRAVERSE, angle ) );
	const yaw = baseYaw - a;
	return out.set( Math.sin( yaw ), 0, Math.cos( yaw ) ).applyQuaternion( boatQuaternion ).setY( 0 ).normalize();

}

export function driverTraverseFromLook( angle, lookX, sensitivity = 0.0017 ) {

	return Math.max( - MAX_TRAVERSE, Math.min( MAX_TRAVERSE, angle + lookX * sensitivity ) );

}

export function cannonBelongsToBattery( cannon, battery, control ) {

	return ( cannon.battery || cannon.side ) === battery && ( cannon.control || 'deck' ) === control;

}

export function effectiveArtilleryPattern( driverFiring, battery, pattern ) {

	return driverFiring && ( battery === 'port' || battery === 'starboard' ) ? 'line' : pattern;

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
		this.driverFiring = false;
		this.driverBattery = 'bow';
		this.side = 1;
		this.angle = 0;
		this.range = 650;
		this.pattern = 'circle';
		this.viewMode = 'overhead';
		this.followEnabled = false;
		this.reload = 0;
		this.salvo = [];
		this.shells = [];
		this.explosions = [];
		this._salvoId = 0;
		this._followSalvo = 0;
		this._followImpactTimer = 0;
		this._followImpact = new Vector3();
		this._followHeading = new Vector3( 0, 0, 1 );
		this._baseFov = null;
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
		for ( let i = 0; i < 6; i ++ ) {

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

	canDriverFire( player ) {

		return !! player && player.mode === 'boat' && player.boat === this.boat && this.cannons.some( ( cannon ) => cannon.control === 'helm' );

	}

	setDriverFiring( player, enabled ) {

		const next = !! enabled && this.canDriverFire( player );
		if ( next === this.driverFiring ) return next;
		this.driverFiring = next;
		this.player = player || this.player;
		this._cameraReady = false;
		this._followSalvo = 0;
		this._followImpactTimer = 0;
		if ( next ) {

			this.angle = 0;
			this._baseFov = this.camera.fov;
			this._lmb = !! this.input.mouseDown;
			this.guide.visible = true;
			this._showHUD( true );
			this.app.audio?.artilleryReady();
			this.app.ui?.ui?.toast( `驾驶火控：${ this._batteryLabel() }`, 1100 );

		} else {

			this.guide.visible = false;
			this._showHUD( false );
			if ( this._baseFov !== null ) {

				this.camera.fov = this._baseFov;
				this.camera.updateProjectionMatrix();
				this._baseFov = null;

			}

		}
		return this.driverFiring;

	}

	cycleDriverBattery() {

		const available = DRIVER_BATTERIES.filter( ( battery ) => this._gunsForBattery( battery ).length );
		if ( ! available.length ) return;
		const index = available.indexOf( this.driverBattery );
		this.driverBattery = available[ ( index + 1 + available.length ) % available.length ];
		this.angle = 0;
		this._cameraReady = false;
		this.app.ui?.ui?.toast( this._batteryLabel(), 850 );

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
		this._followSalvo = 0;
		this._followImpactTimer = 0;
		this._baseFov = this.camera.fov;
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
		this._followSalvo = 0;
		this._followImpactTimer = 0;
		this.guide.visible = false;
		this._showHUD( false );
		if ( this._baseFov !== null ) {

			this.camera.fov = this._baseFov;
			this.camera.updateProjectionMatrix();
			this._baseFov = null;

		}
		player.mode = 'deck';
		player.deckYaw = this.side > 0 ? - Math.PI / 2 : Math.PI / 2;
		player.pitch = - 0.05;
		player._camY = null;
		player.deckToWorld();

	}

	update( dt ) {

		this.reload = Math.max( 0, this.reload - dt );
		this._followImpactTimer = Math.max( 0, this._followImpactTimer - dt );
		this._updateQueued( dt );
		this._updateShells( dt );
		this._updateExplosions( dt );
		if ( ! this.active ) return;

		const player = this.player;
		const inp = this.input;
		const look = inp.consumeLook();
		this.angle = traverseFromLook( this.side, this.angle, look.x );
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
		if ( inp.hit( 'KeyG' ) ) {

			this.followEnabled = ! this.followEnabled;
			if ( ! this.followEnabled ) {

				this._followSalvo = 0;
				this._followImpactTimer = 0;

			}
			this.app.ui?.ui?.toast( this.followEnabled ? '逐波跟弹镜头：开启' : '逐波跟弹镜头：关闭', 1100 );

		}

		const lmb = !! inp.mouseDown && inp.enabled;
		if ( lmb && ! this._lmb ) this.fireSalvo();
		this._lmb = lmb;
		player.prompt = { key: 'E', text: '退出炮位   ·   右键 聚焦   ·   G 跟弹   ·   左键 齐射' };

		this._aimPoint( _target );
		this._updateGuide( _target );
		this._updateCamera( dt, _target );
		this._updateHUD();

	}

	updateDriver( dt, look ) {

		if ( ! this.driverFiring || ! this.canDriverFire( this.player ) ) return false;
		const inp = this.input;
		this.angle = driverTraverseFromLook( this.angle, look.x );
		this.range = Math.max( MIN_RANGE, Math.min( MAX_RANGE, this.range - look.y * 3.2 ) );

		if ( inp.hit( 'KeyQ' ) ) this.cycleDriverBattery();
		if ( inp.hit( 'KeyR' ) ) {

			if ( this._effectivePattern() === 'line' && this.driverBattery !== 'bow' ) {

				this.app.ui?.ui?.toast( '舱内舷炮固定为横排齐射', 950 );

			} else {

				this.pattern = this.pattern === 'circle' ? 'line' : 'circle';
				this.app.ui?.ui?.toast( this.pattern === 'circle' ? '圆形范围打击' : '横排范围打击', 950 );

			}

		}
		if ( inp.hit( 'KeyG' ) ) {

			this.followEnabled = ! this.followEnabled;
			if ( ! this.followEnabled ) {

				this._followSalvo = 0;
				this._followImpactTimer = 0;

			}
			this.app.ui?.ui?.toast( this.followEnabled ? '逐波跟弹镜头：开启' : '逐波跟弹镜头：关闭', 1100 );

		}

		const lmb = !! inp.mouseDown && inp.enabled;
		if ( lmb && ! this._lmb ) this.fireSalvo();
		this._lmb = lmb;
		this.player.prompt = { key: 'F', text: '观察模式   ·   Q 切换炮组   ·   左键 齐射' };

		this._aimPoint( _target );
		this._updateGuide( _target );
		this._updateDriverCamera( dt, _target );
		this._updateHUD();
		return true;

	}

	updateWorld( dt ) {

		// Projectiles keep flying after the player leaves the station.
		if ( this.active ) return;
		this.reload = Math.max( 0, this.reload - dt );
		this._followImpactTimer = Math.max( 0, this._followImpactTimer - dt );
		this._updateQueued( dt );
		this._updateShells( dt );
		this._updateExplosions( dt );

	}

	_aimPoint( out ) {

		this._aimDirection( _direction );
		out.copy( this.boat.position ).addScaledVector( _direction, this.range );
		const terrainY = this.app.terrainData?.heightAt( out.x, out.z );
		out.y = Number.isFinite( terrainY ) && terrainY > 0 ? terrainY + 0.35 : 0.3;
		return out;

	}

	_aimDirection( out ) {

		if ( this.driverFiring ) return batteryDirection( this.driverBattery, this.angle, this.boat.quaternion, out );
		return broadsideDirection( this.side, this.angle, this.boat.quaternion, out );

	}

	_batteryName() {

		return this.driverFiring ? this.driverBattery : ( this.side > 0 ? 'port' : 'starboard' );

	}

	_batteryLabel() {

		const battery = this._batteryName();
		if ( this.driverFiring && battery !== 'bow' ) return `${ battery === 'port' ? '左舷' : '右舷' }舱炮组 · 6 门`;
		if ( ! this.driverFiring && battery !== 'bow' ) return `${ battery === 'port' ? '左舷' : '右舷' }甲板炮组`;
		return BATTERY_LABELS[ battery ] || '火炮';

	}

	_gunsForBattery( battery = this._batteryName() ) {

		const control = this.driverFiring ? 'helm' : 'deck';
		return this.cannons.filter( ( cannon ) => cannonBelongsToBattery( cannon, battery, control ) );

	}

	_effectivePattern() {

		return effectiveArtilleryPattern( this.driverFiring, this._batteryName(), this.pattern );

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
		this._aimDirection( _forward );
		_right.set( - _forward.z, 0, _forward.x );
		const pattern = this._effectivePattern();
		const lineCount = pattern === 'line' ? Math.min( this.impactRings.length, this._gunsForBattery().length ) : 1;
		for ( let i = 0; i < this.impactRings.length; i ++ ) {

			const ring = this.impactRings[ i ];
			const visible = i < lineCount;
			ring.visible = visible;
			if ( ! visible ) continue;
			ring.position.copy( target );
			if ( pattern === 'line' ) ring.position.addScaledVector( _right, ( i - ( lineCount - 1 ) / 2 ) * LINE_SPACING );
			ring.position.y = this._impactHeight( ring.position ) + 0.18;
			ring.scale.setScalar( CIRCLE_RADIUS );

		}

	}

	_updateDriverCamera( dt, aimPoint ) {

		if ( this._updateFollowCamera( dt ) ) {

			this.guide.visible = false;
			this._setFov( dt, this._baseFov ?? this.camera.fov );
			return;

		}
		this.guide.visible = true;
		this._aimDirection( _direction );
		const scale = this.boat.model.cameraScale || 1;
		const focusHeld = !! this.input.rightDown && this.input.enabled;
		this.boat.toWorld( new Vector3( 0, this.boat.model.cameraTargetY || 10, 0 ), _cameraTarget );
		if ( focusHeld ) {

			const focusHeight = Math.max( 80, Math.min( 330, this.range * 0.17 ) );
			_cameraWant.copy( aimPoint ).addScaledVector( _up, focusHeight ).addScaledVector( _direction, - focusHeight * 0.12 );

		} else {

			_cameraWant.copy( _cameraTarget ).addScaledVector( _up, Math.max( 12 * scale, this.range * 1.05 ) );

		}
		if ( ! this._cameraReady ) {

			this.player.camPos.copy( _cameraWant );
			this._cameraReady = true;

		}
		this.player.camPos.lerp( _cameraWant, 1 - Math.exp( - dt * 5 ) );
		this.camera.position.copy( this.player.camPos );
		_look.copy( focusHeld ? aimPoint : _cameraTarget ).lerp( aimPoint, focusHeld ? 1 : 0.5 );
		if ( ! focusHeld ) _look.y = _cameraTarget.y;
		this.camera.lookAt( _look );
		this._setFov( dt, this._baseFov ?? this.camera.fov );

	}

	_updateCamera( dt, aimPoint ) {

		if ( this._updateFollowCamera( dt ) ) {

			this.guide.visible = false;
			this._setFov( dt, this._baseFov ?? this.camera.fov );
			this.boat.toWorld( new Vector3( this.side * 3.4, 2.95, - 14.8 ), this.player.position );
			return;

		}
		this.guide.visible = true;
		broadsideDirection( this.side, this.angle, this.boat.quaternion, _direction );
		const scale = this.boat.model.cameraScale || 1;
		const focusHeld = !! this.input.rightDown && this.input.enabled;
		this.boat.toWorld( new Vector3( 0, this.boat.model.cameraTargetY || 10, 0 ), _cameraTarget );
		if ( this.viewMode === 'gun' ) {

			// Eye point immediately inboard of the selected battery: the player is standing beside
			// the guns and looking along their current traverse direction.
			this.boat.toWorld( new Vector3( this.side * 2.65, 6.65, - 14.7 ), _cameraWant );

		} else if ( focusHeld ) {

			// Artillery-map focus: keep the red damage radius and its immediate surroundings large
			// enough to read even when the selected range is close to 2 km.
			const focusHeight = Math.max( 80, Math.min( 330, this.range * 0.17 ) );
			_cameraWant.copy( aimPoint ).addScaledVector( _up, focusHeight ).addScaledVector( _direction, - focusHeight * 0.12 );

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

		} else if ( focusHeld ) {

			_look.copy( aimPoint );

		} else {

			_look.copy( _cameraTarget ).lerp( aimPoint, 0.5 );
			_look.y = _cameraTarget.y;

		}
		this.camera.lookAt( _look );
		const zoomFov = Math.max( 22, ( this._baseFov ?? this.camera.fov ) * 0.48 );
		this._setFov( dt, this.viewMode === 'gun' && focusHeld ? zoomFov : ( this._baseFov ?? this.camera.fov ) );
		this.boat.toWorld( new Vector3( this.side * 3.4, 2.95, - 14.8 ), this.player.position );

	}

	_updateFollowCamera( dt ) {

		if ( ! this.followEnabled || ! this._followSalvo ) return false;
		_followCenter.set( 0, 0, 0 );
		_followVelocity.set( 0, 0, 0 );
		let count = 0;
		for ( const shell of this.shells ) if ( shell.salvoId === this._followSalvo ) {

			_followCenter.add( shell.position );
			_followVelocity.add( shell.velocity );
			count ++;

		}
		if ( count ) {

			_followCenter.multiplyScalar( 1 / count );
			_followVelocity.multiplyScalar( 1 / count );
			_followDirection.set( _followVelocity.x, 0, _followVelocity.z );
			if ( _followDirection.lengthSq() > 0.001 ) this._followHeading.copy( _followDirection.normalize() );
			_cameraWant.copy( _followCenter ).addScaledVector( this._followHeading, - 20 ).addScaledVector( _up, 9 );
			_look.copy( _followCenter ).addScaledVector( _followVelocity.normalize(), 7 );

		} else if ( this._followImpactTimer > 0 ) {

			_cameraWant.copy( this._followImpact ).addScaledVector( this._followHeading, - 24 ).addScaledVector( _up, 12 );
			_look.copy( this._followImpact ).addScaledVector( _up, 3 );

		} else {

			const queued = this.salvo.some( ( shot ) => shot.salvoId === this._followSalvo );
			if ( queued ) return false;
			this._followSalvo = 0;
			return false;

		}
		if ( ! this._cameraReady ) {

			this.player.camPos.copy( _cameraWant );
			this._cameraReady = true;

		}
		this.player.camPos.lerp( _cameraWant, 1 - Math.exp( - dt * 7.5 ) );
		this.camera.position.copy( this.player.camPos );
		this.camera.lookAt( _look );
		return true;

	}

	_setFov( dt, target ) {

		const next = this.camera.fov + ( target - this.camera.fov ) * ( 1 - Math.exp( - dt * 10 ) );
		if ( Math.abs( next - this.camera.fov ) < 0.001 ) return;
		this.camera.fov = next;
		this.camera.updateProjectionMatrix();

	}

	fireSalvo() {

		if ( this.reload > 0 || this.salvo.length ) {

			this.app.ui?.ui?.toast( `装填中 ${ Math.ceil( this.reload ) } 秒`, 850 );
			return false;

		}
		const guns = this._gunsForBattery();
		if ( ! guns.length ) return false;
		const salvoId = ++ this._salvoId;
		const centre = this._aimPoint( new Vector3() ).clone();
		this._aimDirection( _forward );
		_right.set( - _forward.z, 0, _forward.x );
		const pattern = this._effectivePattern();

		for ( let i = 0; i < guns.length; i ++ ) {

			const target = centre.clone();
			if ( pattern === 'circle' ) {

				const a = i / guns.length * Math.PI * 2 + 0.35;
				target.x += Math.cos( a ) * CIRCLE_RADIUS * 0.62;
				target.z += Math.sin( a ) * CIRCLE_RADIUS * 0.62;

			} else target.addScaledVector( _right, ( i - ( guns.length - 1 ) / 2 ) * LINE_SPACING );
			target.y = this._impactHeight( target );
			this.salvo.push( { gun: guns[ i ], target, delay: i * 0.11, salvoId } );

		}
		if ( this.followEnabled ) {

			this._followSalvo = salvoId;
			this._followImpactTimer = 0;

		}
		this.reload = RELOAD_SECONDS;
		this.app.ui?.ui?.toast( `${ this._batteryLabel() }齐射！`, 900 );
		return true;

	}

	_updateQueued( dt ) {

		for ( let i = this.salvo.length - 1; i >= 0; i -- ) {

			const shot = this.salvo[ i ];
			shot.delay -= dt;
			if ( shot.delay > 0 ) continue;
			this._spawnShell( shot.gun, shot.target, shot.salvoId );
			this.salvo.splice( i, 1 );

		}

	}

	_spawnShell( gun, target, salvoId ) {

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
		this.shells.push( { root, position: origin, velocity, age: 0, flightTime, target: target.clone(), voice, salvoId } );
		gun.fire( this.app.spray, !! this.app.audio && ! this.app.audio.muted );

	}

	_updateShells( dt ) {

		for ( let i = this.shells.length - 1; i >= 0; i -- ) {

			const shell = this.shells[ i ];
			const step = Math.min( dt, Math.max( 0, shell.flightTime - shell.age ) );
			shell.age += step;
			shell.velocity.y -= GRAVITY * step;
			_shellNext.copy( shell.position ).addScaledVector( shell.velocity, step );
			if ( this._projectileCollision( shell.position, _shellNext, _shellImpact ) ) {

				this._finishShell( shell, i, _shellImpact );
				continue;

			}
			if ( shell.age >= shell.flightTime - 1e-5 ) {

				this._finishShell( shell, i, shell.target );
				continue;

			}
			shell.position.copy( _shellNext );
			shell.root.position.copy( shell.position );
			_look.copy( shell.position ).add( shell.velocity );
			shell.root.lookAt( _look );
			this.app.audio?.moveArtilleryVoice( shell.voice, shell.position );

		}

	}

	_finishShell( shell, index, point ) {

		this._explode( point );
		const ground = this.app.terrainData?.heightAt( point.x, point.z );
		if ( Number.isFinite( ground ) && ground > 0.05 ) this._scarLand( point, shell.velocity );
		if ( shell.salvoId === this._followSalvo ) {

			this._followImpact.copy( point );
			_followDirection.set( shell.velocity.x, 0, shell.velocity.z );
			if ( _followDirection.lengthSq() > 0.001 ) this._followHeading.copy( _followDirection.normalize() );
			this._followImpactTimer = 0.9;

		}
		this.app.audio?.stopArtilleryVoice( shell.voice );
		shell.root.removeFromParent();
		this.shells.splice( index, 1 );

	}

	_scarLand( point, velocity ) {

		const radius = 4.2;
		const horizontal = Math.hypot( velocity.x, velocity.z );
		const speed = Math.hypot( horizontal, velocity.y ) || 1;
		const dirX = horizontal > 1e-4 ? velocity.x / horizontal : 1;
		const dirZ = horizontal > 1e-4 ? velocity.z / horizontal : 0;
		const obliquity = Math.min( 0.92, horizontal / speed );
		const phase = ( Math.sin( point.x * 0.013 + point.z * 0.017 ) * 0.5 + 0.5 ) * Math.PI * 2;
		addVegetationBlast( point.x, point.z, radius + 2.2 );
		// Rendering, collision, dynamic normals and soot now share one analytic deformation. The old
		// raised circular overlay was the main source of the artificial "painted disc" appearance.
		this.app.terrainData.addCrater( point.x, point.z, radius, 1.3, dirX, dirZ, obliquity, phase );
		this.app.terrainGPU.addCrater( point.x, point.z, radius, 1.3, dirX, dirZ, obliquity, phase );

	}

	_projectileCollision( start, end, out ) {

		const length = _rayDirection.subVectors( end, start ).length();
		if ( length <= 1e-7 ) return false;
		_rayDirection.multiplyScalar( 1 / length );
		let bestT = this._terrainCollisionT( start, end );
		const staticDistance = this.app.colliders?.raycast( start, _rayDirection, length, 0.25 ) ?? length;
		if ( staticDistance < length ) bestT = Math.min( bestT, staticDistance / length );
		for ( const boat of this.app.boatCtls || [] ) {

			if ( boat === this.boat ) continue;
			bestT = Math.min( bestT, this._boatCollisionT( boat, start, end ) );

		}
		if ( ! Number.isFinite( bestT ) ) return false;
		out.copy( start ).lerp( end, Math.max( 0, Math.min( 1, bestT ) ) );
		return true;

	}

	_terrainCollisionT( start, end ) {

		const terrain = this.app.terrainData;
		if ( ! terrain ) return Infinity;
		const distance = start.distanceTo( end );
		const samples = Math.max( 1, Math.min( 64, Math.ceil( distance ) ) );
		const clearanceAt = ( t ) => {

			_collisionSample.copy( start ).lerp( end, t );
			const terrainY = terrain.heightAt( _collisionSample.x, _collisionSample.z );
			const surface = Math.max( 0.3, Number.isFinite( terrainY ) ? terrainY : - Infinity );
			return _collisionSample.y - surface - 0.25;

		};
		let previousT = 0;
		if ( clearanceAt( 0 ) <= 0 ) return 0;
		for ( let i = 1; i <= samples; i ++ ) {

			const t = i / samples;
			if ( clearanceAt( t ) > 0 ) { previousT = t; continue; }
			let lo = previousT, hi = t;
			for ( let n = 0; n < 9; n ++ ) {

				const mid = ( lo + hi ) * 0.5;
				if ( clearanceAt( mid ) <= 0 ) hi = mid;
				else lo = mid;

			}
			return hi;

		}
		return Infinity;

	}

	_boatCollisionT( boat, start, end ) {

		const model = boat.model;
		if ( ! model ) return Infinity;
		_inverseBoat.copy( boat.quaternion ).invert();
		_localStart.copy( start ).sub( boat.position ).applyQuaternion( _inverseBoat );
		_localEnd.copy( end ).sub( boat.position ).applyQuaternion( _inverseBoat );
		const collider = model.meshCollider;
		if ( collider ) {

			if ( ! this._meshSegmentHit( collider, _localStart, _localEnd ) ) return Infinity;
			let lo = 0, hi = 1;
			for ( let i = 0; i < 8; i ++ ) {

				const mid = ( lo + hi ) * 0.5;
				_localProbe.copy( _localStart ).lerp( _localEnd, mid );
				if ( this._meshSegmentHit( collider, _localStart, _localProbe ) ) hi = mid;
				else lo = mid;

			}
			return hi;

		}
		let best = Infinity;
		for ( const box of model.colliders || [] ) {

			if ( box.solid === false || ! box.center || ! box.half ) continue;
			best = Math.min( best, this._segmentBoxT( _localStart, _localEnd, box.center, box.half, 0.25 ) );

		}
		return best;

	}

	_meshSegmentHit( collider, start, end ) {

		_meshStart.copy( start );
		_meshEnd.copy( end );
		return collider.resolveSegment( _meshStart, _meshEnd, 0.25, { iterations: 1 } ).hit;

	}

	_segmentBoxT( start, end, center, half, pad ) {

		let tMin = 0, tMax = 1;
		for ( const axis of [ 'x', 'y', 'z' ] ) {

			const origin = start[ axis ] - center[ axis ];
			const delta = end[ axis ] - start[ axis ];
			const extent = half[ axis ] + pad;
			if ( Math.abs( delta ) < 1e-9 ) {

				if ( Math.abs( origin ) > extent ) return Infinity;
				continue;

			}
			let a = ( - extent - origin ) / delta, b = ( extent - origin ) / delta;
			if ( a > b ) { const swap = a; a = b; b = swap; }
			tMin = Math.max( tMin, a );
			tMax = Math.min( tMax, b );
			if ( tMin > tMax ) return Infinity;

		}
		return tMin >= 0 && tMin <= 1 ? tMin : Infinity;

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
		hud.innerHTML = `<div class="na-readout"><span class="na-side"></span><span class="na-range"></span><span class="na-range-meter"><span class="na-range-limits"><i>100 m</i><i>2 km</i></span><span class="na-range-track"><i></i></span></span><span class="na-mode"></span><span class="na-follow"></span></div><div class="na-reload"><span></span><em class="na-bar"><i></i></em></div><div class="na-help"></div>`;
		( this.app.ui?.ui?.hud || document.getElementById( 'app' ) || document.body ).append( hud );
		this._hud = hud;
		this._hudSide = hud.querySelector( '.na-side' );
		this._hudRange = hud.querySelector( '.na-range' );
		this._hudMode = hud.querySelector( '.na-mode' );
		this._hudFollow = hud.querySelector( '.na-follow' );
		this._hudRangeBar = hud.querySelector( '.na-range-track i' );
		this._hudReload = hud.querySelector( '.na-reload span' );
		this._hudBar = hud.querySelector( '.na-bar i' );
		this._hudHelp = hud.querySelector( '.na-help' );

	}

	_showHUD( show ) {

		this._createHUD();
		this._hud?.classList.toggle( 'is-on', show );

	}

	_updateHUD() {

		this._createHUD();
		if ( ! this._hud ) return;
		this._hudSide.textContent = this._batteryLabel();
		this._hudRange.textContent = `${ Math.round( this.range ) } m`;
		this._hudRangeBar.style.transform = `scaleX(${ ( this.range - MIN_RANGE ) / ( MAX_RANGE - MIN_RANGE ) })`;
		this._hudMode.textContent = this._effectivePattern() === 'circle' ? '○ 圆形散布' : '━ 横排散布';
		this._hudFollow.textContent = this.followEnabled ? '跟弹 开' : '跟弹 关';
		this._hudFollow.style.color = this.followEnabled ? '#ffe083' : 'rgba(223,249,255,.55)';
		this._hudReload.textContent = this.reload > 0 ? `装填中 · ${ this.reload.toFixed( 1 ) } s` : '火炮就绪';
		this._hudBar.style.transform = `scaleX(${ 1 - this.reload / RELOAD_SECONDS })`;
		this._hudHelp.innerHTML = this.driverFiring
			? '鼠标水平　调整炮向 ±50°<br><b>鼠标上下</b>　调整 100 m–2 km<br><b>按住右键</b>　聚焦落点<br><b>Q</b>　切换左舷 / 舰首 / 右舷炮组<br><b>R</b>　舰首炮散布（舷炮固定横排）<br><b>G</b>　开启 / 关闭逐波跟弹<br><b>左键</b>　当前炮组齐射<br><b>F</b>　返回观察模式'
			: '鼠标水平　调整炮向 ±50°<br><b>鼠标上下</b>　调整 100 m–2 km<br><b>按住右键</b>　聚焦落点 / 镜头放大<br><b>V</b>　上空 / 炮组视角<br><b>G</b>　开启 / 关闭逐波跟弹<br><b>左键</b>　整舷齐射<br><b>Q / R</b>　圆形 / 横排<br><b>E</b>　退出炮位';

	}

}
