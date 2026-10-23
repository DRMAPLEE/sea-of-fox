import { Vector3, Euler, Color, MathUtils, Mesh } from './engine/index.js';
import { GPU } from './engine/gpu/GPU.js';
import { SunShadows } from './engine/render/Shadows.js';
import { FrameUniforms } from './engine/render/Frame.js';

import { Engine } from './core/Engine.js';
import { Input } from './core/Input.js';
import { CDLOD } from './core/CDLOD.js';
import { G } from './core/Globals.js';
import { Profiler } from './core/Profiler.js';
import { SceneRenderer, LAYERS } from './core/SceneRenderer.js';
import { DEPTH_FORMAT } from './engine/render/SceneRenderer.js';
import { installDebugViews } from './core/DebugViews.js';

import { Atmosphere, SUN_ILLUMINANCE } from './sky/Atmosphere.js';
import { Sky, sunDirectionFromTime } from './sky/Sky.js';
import { Clouds } from './sky/Clouds.js';
import { SkyProClouds } from './sky/SkyProClouds.js';
import { Environment } from './sky/Environment.js';

import { TerrainData } from './world/TerrainData.js';
import { TerrainGPU } from './world/TerrainGPU.js';
import { Terrain } from './world/Terrain.js';
import { computeShoreField } from './world/ShoreField.js';
import { WORLD, wrapWorldCoordinate, wrappedWorldDelta, wrapWorldPosition } from './world/WorldLayout.js';
import { ARCHIPELAGO, buildIslandShoreStrip, islandCoastFrame, islandDistance } from './world/Archipelago.js';
import { Colliders } from './world/Colliders.js';
import { Village } from './world/Village.js';
import { Reef } from './world/Reef.js';
import { BoatModel } from './world/BoatModel.js';
import { DeckCannon } from './world/DeckCannon.js';
import { Rocks } from './world/Rocks.js';
import { Debris } from './world/Debris.js';
import { Wildlife } from './world/wildlife/Wildlife.js';
import { Whale } from './world/marine/Whale.js';

import { OceanFFT } from './ocean/OceanFFT.js';
import { WaterSurface } from './ocean/WaterSurface.js';
import { WaterMaterial } from './ocean/WaterMaterial.js';
import { createFoamTexture } from './ocean/FoamTexture.js';
import { ShoreWaves } from './ocean/ShoreWaves.js';
import { ShoreSim } from './ocean/ShoreSim.js';
import { Caustics } from './ocean/Caustics.js';
import { installUnderwaterLighting } from './ocean/UnderwaterLighting.js';
import { RefractionPass } from './ocean/RefractionPass.js';
import { installGroundBounce } from './materials/GroundBounce.js';
import { LocalLights, addVillageLights, addBoatLights, addTallShipLights } from './materials/LocalLights.js';
import { WaterQuery } from './ocean/WaterQuery.js';
import { Breakers } from './ocean/Breakers.js';
import { SurfFoam } from './ocean/SurfFoam.js';
import { Spray } from './fx/Spray.js';
import { SeaDetail } from './ocean/SeaDetail.js';
import { MarineSnow } from './fx/MarineSnow.js';
import { AirMotes } from './fx/AirMotes.js';
import { ParticleWaterspouts, WaterspoutField } from './fx/Waterspouts.js';
import { Waterspouts } from './fx/WaterspoutColumn.js';

import { Underwater, LENS_REACH } from './post/Underwater.js';
import { PostFX } from './post/PostFX.js';
import { AirHaze } from './post/AirHaze.js';
import { FlyCamera } from './player/FlyCamera.js';
import { Player } from './player/Player.js';
import { Game } from './game/Game.js';
import { NavalArtillery } from './game/NavalArtillery.js';
import { STAND } from './game/FishStand.js';
import { CHANDLERY } from './game/Chandlery.js';
import { BoatController } from './player/BoatController.js';
import { BoatSpray } from './player/BoatSpray.js';
import { WakeSim } from './ocean/WakeSim.js';
import { Vegetation } from './world/Vegetation.js';
import { SoundScape } from './audio/SoundScape.js';
import { updateCameraVelocity, useStaticVelocity } from './post/CameraVelocity.js';

const _up = new Vector3( 0, 1, 0 );
const REGIONAL_WEATHER_ISLANDS = ARCHIPELAGO.filter( ( island ) => island.climate === 'polar' || island.climate === 'temperate' );
const REGIONAL_WEATHER_ENTER = 1800;
const REGIONAL_WEATHER_EXIT = 2300;
const REGIONAL_CLOUD_STATES = {
	// Polar weather can still roll a crystalline clear day, but also has the strongest overcast.
	polar: [ 0.2, 0.36, 0.55, 0.74, 0.9, 0.98 ],
	// The Faroe belt is the maritime-temperate transition: changeable and cloudier on average than
	// the tropics, without inheriting permanent polar gloom.
	temperate: [ 0.28, 0.42, 0.56, 0.68, 0.8, 0.9 ],
};

export class App {

	constructor() {

		this.settings = {
			timeOfDay: 16.2,
			sunAzimuth: 0, // degrees: turns the sun's daily path about the vertical
			timeSpeed: 0, // hours per real second
			exposure: 0.55,
			renderScale: 1, // internal resolution (the temporal upscaler reconstructs the output), Performance tab
		};
		this._worldShift = { dx: 0, dz: 0 };
		this.qs = new URLSearchParams( location.search );

	}

	async init( onProgress = () => {} ) {

		const qs = this.qs;
		// report a stage, then let the page paint it before the (synchronous) stage work starts
		const progress = async ( p, text, until ) => {

			onProgress( p, text, until );
			if ( typeof requestAnimationFrame === 'function' ) await new Promise( ( r ) => requestAnimationFrame( () => setTimeout( r, 0 ) ) );

		};
		await progress( 0.02, '正在启动 WebGPU…' );
		const engine = this.engine = new Engine( document.getElementById( 'app' ) );
		await engine.init();
		// systems take `renderer` first as in the three.js version: it is the Engine now (GPU access is global)
		const renderer = engine;
		const { scene, camera } = engine;
		// the near clip plane is the lens: it slices the water surface at the waterline (see Underwater)
		camera.near = 0.1;
		camera.updateProjectionMatrix();
		this.renderer = renderer;
		this.scene = scene;
		this.camera = camera;

		this.input = new Input( engine.domElement );
		this.fly = new FlyCamera( camera, engine.domElement, this.input );
		this.fly.setPose( new Vector3( 20, 6, - 20 ), Math.PI * 0.9, - 0.12 );

		// ---------------------------------------------------------------- sky
		await progress( 0.04, '正在生成大气层…' );
		this.atmosphere = new Atmosphere( renderer );
		this.sky = new Sky( this.atmosphere );
		if ( ! qs.has( 'noClouds' ) ) {

			// sky-pro-webgpu's clouds ("Partly cloudy"); ?oldClouds: the previous ones
			this.clouds = qs.has( 'oldClouds' ) ? new Clouds( renderer, this.atmosphere ) : new SkyProClouds( renderer, this.atmosphere );
			if ( this.clouds.ready ) await this.clouds.ready;
			this.sky.clouds = this.clouds;
			this._normalCloudCoverage = this.clouds.coverage.value;
			this._regionalWeatherActive = false;
			this._regionalWeatherIsland = null;
			this._regionalWeatherUntil = 0;

		}

		// 3 cascades: 0-10 m (~1 cm texels, fine contact detail), 10-60 m, 60-400 m (rough far shadows);
		// contact-hardening filter sized by the sun's disc on the near cascade. Each cascade's depth range
		// is its light margin (200 m) + its extent, which keeps the depth bias small in metres.
		// Shadows come from the opaque and the late (transparent-pass) layers.
		this.csm = this.shadows = new SunShadows( { size: 2048, splits: [ 10, 60, 400 ], lightMargin: 200, normalBias: [ 0.015, 0.06, 0.3 ], bias: 0.00002 } );
		this.shadows.layerMask = ( 1 << LAYERS.OPAQUE ) | ( 1 << LAYERS.TRANSPARENT );

		this.environment = new Environment( renderer, scene, this.sky );

		// ---------------------------------------------------------------- island
		await progress( 0.06, '正在塑造岛屿…' );
		this.terrainData = new TerrainData();
		this.colliders = new Colliders();
		// the village flattens building pads into the heightmap: build it before any terrain
		// data is derived (shore field, GPU textures, meshes)
		await progress( 0.12, '正在建造村庄…' );
		this.village = new Village( { scene, terrain: this.terrainData, colliders: this.colliders } );
		if ( qs.has( 'map' ) && ! qs.has( 'editor' ) ) {

			await progress( 0.13, '正在加载自定义地图…' );
			const runtime = await import( './editor/RuntimeMap.js' );
			this.mapDocument = await runtime.loadRuntimeMapDocument( qs.get( 'map' ) );
			this.mapTerrainTracker = runtime.applyRuntimeTerrain( this.terrainData, this.mapDocument );

		}
		if ( ! qs.has( 'noVeg' ) ) {

			await progress( 0.14, '正在种植岛屿植被…' );
			this.vegetation = new Vegetation( { scene, terrain: this.terrainData, village: this.village } );
			useStaticVelocity( this.vegetation.group );

		}

		await progress( 0.19, '正在生成涌浪…' );
		this.shoreField = computeShoreField( this.terrainData, { res: 512, swellDir: [ WORLD.swellDir.x, WORLD.swellDir.y ] } );
		this.terrainGPU = new TerrainGPU( this.terrainData, this.shoreField );
		// terrain and rocks apply the heightfield sun shadow (long hill shadows) in their own lighting
		this.terrain = new Terrain( { scene, terrainData: this.terrainData, terrainGPU: this.terrainGPU, renderer } );
		this.rocks = new Rocks( { scene, terrain: this.terrain, village: this.village, colliders: this.colliders } );
		// driftwood (CC0 photoscans), wrack, pebbles and village clutter
		this.debris = new Debris( { scene, terrain: this.terrain, village: this.village, vegetation: this.vegetation, rocks: this.rocks, colliders: this.colliders } );
		// these apply the heightfield sun shadow in their own lighting model (see UnderwaterLighting)
		this.terrain.mesh.material.appliesHillShadow = true;
		this.rocks.material.appliesHillShadow = true;

		await progress( 0.23, '正在生成珊瑚礁…' );
		this.reef = new Reef( { scene, terrain: this.terrainData, shoreField: this.shoreField } );
		if ( this.mapDocument ) {

			await progress( 0.24, '正在放置自定义实体…' );
			const { loadRuntimeEntities } = await import( './editor/RuntimeMap.js' );
			this.mapEntities = await loadRuntimeEntities( this, this.mapDocument );

		}

		this.boat = new BoatModel();
		scene.add( this.boat.group );
		this.boat.group.position.copy( WORLD.boatDock.position );
		this.boat.group.rotation.y = WORLD.boatDock.heading;

		// A second, independently driveable boat. Its authored visual is ten times the original
		// boat's length and is moored to port (+X / screen-left when facing out to sea).
		// The model is a three-masted pirate ship (black sails, gun deck); all anchors below were
		// re-measured against it: main deck y≈3.0, waist y≈5.0, poop deck y≈6.9, forecastle y≈10.9,
		// rails at |x|≈6.9, wheel on the poop deck at z≈-27.7 (mizzen mast z≈-31.7).
		this.tallShip = new BoatModel();
		this.tallShip.group.name = 'TallShip';
		this.tallShip.displayName = 'pirate ship';
		// The trigger stays beside the pier while boardPoint is the landing position on deck.
		this.tallShip.directBoard = false;
		this.tallShip.boardAroundHull = true;
		this.tallShip.boardHeight = 0.8;
		this.tallShip.boardTriggerPoint = new Vector3( - 10, 0.8, 0 );
		this.tallShip.boardPoint.set( - 3.8, 3.0, - 5.5 );
		this.tallShip.boardPoints = [
			new Vector3( - 3.8, 3.0, - 5.5 ), new Vector3( 3.8, 3.0, - 5.5 ),
			new Vector3( - 3.8, 3.0, 2.2 ), new Vector3( 3.8, 3.0, 2.2 ),
			new Vector3( - 4.2, 5.0, - 13.3 ), new Vector3( 4.2, 5.0, - 13.3 ),
			new Vector3( 0, 7.0, - 27.7 ),
		];
		this.tallShip.boardRadius = 4;
		this.tallShip.boardVerticalRange = 3;
		this.tallShip.helmPoint = new Vector3( 0, 6.9, - 29.5 );
		this.tallShip.helmEye.set( 0, 8.55, - 29.5 );
		this.tallShip.helmAccessPoints = [
			new Vector3( - 3.2, 6.3, - 28.2 ), new Vector3( 3.2, 6.3, - 28.2 ),
			new Vector3( - 1.6, 6.3, - 27.2 ), new Vector3( 1.6, 6.3, - 27.2 ),
			new Vector3( 0, 6.3, - 29.5 ),
		];
		this.tallShip.helmExitPoint = new Vector3( - 2.2, 6.9, - 28.8 );
		this.tallShip.helmReach = 2.8;
		this.tallShip.helmVerticalReach = 1.45;
		this.tallShip.helmMinY = 4.8;
		this.tallShip.helmMaxY = 7.8;
		this.tallShip.deckStepHeight = 0.9;
		this.tallShip.deckJumpSpeed = 5.2;
		this.tallShip.exitPoints = [
			new Vector3( - 6.9, 3.5, - 4.4 ), new Vector3( - 6.9, 3.5, - 17.7 ),
			new Vector3( 6.9, 3.5, - 4.4 ), new Vector3( 6.9, 3.5, - 17.7 ),
		];
		this.tallShip.cameraScale = 10;
		this.tallShip.cameraDistance = 100;
		this.tallShip.cameraTargetY = 10;
		this.tallShip.uprightRate = 4.5;
		this.tallShip.angularDamping = 5;
		scene.add( this.tallShip.group );
		this.tallShip.group.position.copy( WORLD.tallShipDock.position );
		this.tallShip.group.rotation.y = WORLD.tallShipDock.heading;
		const base = ( import.meta.env && import.meta.env.BASE_URL ) || '/';
		try {

			await progress( 0.27, '正在装配海盗船…' );
			// sinkModel 1.7: the model's painted waterline is ~1.7 model units above the keel
			await this.tallShip.loadVisual( base + 'models/boat/tall-ship.glb', { sizeMultiplier: 10, sinkModel: 1.7 } );

		} catch ( error ) {

			console.warn( 'tall ship model failed to load; using the procedural fallback', error );
			this.tallShip.group.scale.setScalar( 10 );

		}
		if ( this.tallShip.importedVisual ) try {

			await progress( 0.285, '正在安装甲板火炮…' );
			// Measured against the pirate ship's geometry: small 1.8 m guns on the waist side shelf,
			// barrels poking out through the open balustrade (rail top y≈3.9 model, no clipping).
			// Stations avoid the mizzen shrouds, the mainmast and its shroud group. Mirrored for a
			// four-gun broadside on each side.
			const stations = [
				{ y: 2.83, z: - 16.0 },
				{ y: 2.83, z: - 19.2 },
				{ y: 2.82, z: - 14.2 },
				{ y: 2.84, z: - 10.0 },
			];
			this.tallShipCannons = [];
			for ( const side of [ 1, - 1 ] ) for ( const station of stations ) {

				const cannon = new DeckCannon( { length: 3.5, audioUrl: base + 'audio/heavy-shot.mp3' } );
				await cannon.load( base + 'models/cannon/cannon-with-muzzle.glb' );
				cannon.side = side > 0 ? 'port' : 'starboard';
				cannon.control = 'deck';
				cannon.mount( this.tallShip.group, new Vector3( side * 4.1, station.y, station.z ), side > 0 ? 0 : Math.PI );
				this.tallShipCannons.push( cannon );

			}
			// The helm controls a separate enclosed gun deck: six guns per side, lower in the hull.
			// These are not the four exposed guns used by a player standing at a deck battery.
			const cabinStations = [ - 22.0, - 16.6, - 11.2, - 5.8, - 0.4, 5.0 ];
			for ( const side of [ 1, - 1 ] ) for ( const z of cabinStations ) {

				const cannon = new DeckCannon( { length: 3.5, audioUrl: base + 'audio/heavy-shot.mp3' } );
				await cannon.load( base + 'models/cannon/cannon-with-muzzle.glb' );
				cannon.side = side > 0 ? 'port' : 'starboard';
				cannon.control = 'helm';
				cannon.mount( this.tallShip.group, new Vector3( side * 4.8, 0.65, z ), side > 0 ? 0 : Math.PI );
				this.tallShipCannons.push( cannon );

			}
			// A paired chase battery sits on the forecastle and fires over the bow (+Z).
			for ( const x of [ - 1.55, 1.55 ] ) {

				const cannon = new DeckCannon( { length: 3.5, audioUrl: base + 'audio/heavy-shot.mp3' } );
				await cannon.load( base + 'models/cannon/cannon-with-muzzle.glb' );
				cannon.side = 'bow';
				cannon.battery = 'bow';
				cannon.control = 'helm';
				cannon.mount( this.tallShip.group, new Vector3( x, 10.9, 18.4 ), - Math.PI / 2 );
				this.tallShipCannons.push( cannon );

			}
			this._nextBroadside = 'port';

		} catch ( error ) {

			console.warn( 'deck cannons failed to load', error );
			this.tallShipCannons = [];

		}

		// ---------------------------------------------------------------- ocean
		await progress( 0.3, '正在模拟海洋…' );
		this.fft = new OceanFFT( renderer );
		if ( this.reef.setOcean ) this.reef.setOcean( this.fft ); // coral / sea fan sway follows the simulated swell
		this.foamTexture = createFoamTexture( renderer );
		this.oceanLOD = new CDLOD( { gridSize: Number( qs.get( 'G' ) || 32 ), leafSize: 8, levels: 12, minY: - 25, maxY: 25 } );
		this.surface = new WaterSurface( { fft: this.fft, cdlod: this.oceanLOD, foamTexture: this.foamTexture } );
		this.waterspoutField = qs.has( 'noWaterspouts' ) ? null : new WaterspoutField();
		this.surface.waterspouts = this.waterspoutField;
		this.stormWeather = { x: 0, z: 0, wind: 0, rain: 0, bgm: 0 };
		this.rainIntensity = 0;
		this._stormCoverageBase = null;
		this.surface.terrain = this.terrainGPU;
		this.seaDetail = new SeaDetail();
		this.surface.detail = this.seaDetail;
		this.shore = new ShoreWaves( this.terrainGPU );
		this.surface.shore = this.shore;
		this.caustics = qs.has( 'noCaustics' ) ? null : new Caustics( renderer, this.fft );
		if ( this.caustics ) this.caustics.detail = this.seaDetail;

		if ( ! qs.has( 'noSim' ) ) {

			this.shoreSim = new ShoreSim( renderer, { terrainGPU: this.terrainGPU, shore: this.shore } );
			this.surface.shoreSim = this.shoreSim;
			// WGSL: fn terrainWetness( xz: vec2f, h: f32 ) -> vec2f (x = wetness, y = sand foam)
			this.terrain.wetness = {
				modules: [ this.shoreSim.module ],
				code: /* wgsl */`
fn terrainWetness( xz: vec2f, h: f32 ) -> vec2f {
	let s = shoreSimSample( xz );
	let inside = shoreSimInside( shoreSimUvOf( xz ) );
	// outside the simulated region fall back to a static damp band
	let band = smoothstep( 0.45, 0.0, h );
	// foam left on the sand: the lace the water carried, stranded and popping (ShoreSim.sandFoam)
	return vec2f( max( s.y, band * ( 1.0 - inside ) ), shoreSimSandFoam( xz, s, h ) );
}`,
			};
			this.terrain.finalizeMaterial();
			// surf-zone foam look (whitewater, lace) used by the water shader
			this.surfFoam = new SurfFoam( { shoreSim: this.shoreSim } );
			this.surface.foamShading = ( args ) => this.surfFoam.shading( args );

		}

		// how much of the underwater lighting each group needs (sampler budget, see UnderwaterLighting)
		const underwaterMode = ( root, m ) => root && root.traverse( ( o ) => {

			if ( o.material ) for ( const mat of Array.isArray( o.material ) ? o.material : [ o.material ] ) mat.underwaterLighting = m;

		} );
		underwaterMode( this.village.group, 'lite' );
		underwaterMode( this.boat.group, 'lite' );
		underwaterMode( this.tallShip.group, 'lite' );
		if ( this.vegetation ) underwaterMode( this.vegetation.group, 'none' );

		this.underwaterLighting = installUnderwaterLighting( {
			fft: this.fft, caustics: this.caustics, clouds: this.clouds, terrain: this.terrainGPU,
			shore: this.shore, surface: this.surface, shoreSim: this.shoreSim,
		} );

		// sunlight bounced off the ground (one diffuse bounce, re-baked with the terrain sun shadow)
		installGroundBounce( { terrain: this.terrainGPU, clouds: this.clouds } );
		this.sceneRenderer = new SceneRenderer( engine.meshRenderer, scene, camera );
		// the water's refraction source: the scene below the water only, half resolution
		this.refraction = new RefractionPass( { meshRenderer: engine.meshRenderer, scene, camera, sceneRenderer: this.sceneRenderer, scale: 0.5 } );
		this.sceneRenderer.onBeforeWater = () => this.refraction.render( G.seaLevel.value );
		if ( this.sky.background ) this.sceneRenderer.background = this.sky.background;
		// lanterns, lamp posts, path lights, lit windows, the boat's cabin / navigation lights and the
		// flashlight (L): nearest few packed into one small uniform array each frame
		this.localLights = new LocalLights();
		addVillageLights( this.localLights, this.village );
		addBoatLights( this.localLights, this.boat );
		for ( const cannon of this.tallShipCannons || [] ) cannon.addLight( this.localLights );
		if ( this.tallShip.importedVisual ) addTallShipLights( this.localLights, this.tallShip );
		else addBoatLights( this.localLights, this.tallShip );
		// rough, large or heavily overdrawn surfaces (ground, rocks, debris, foliage) take the local
		// lights as Lambert only; the village, pier and boat get the full BRDF (glints on wet wood, metal)
		for ( const root of [ this.terrain.mesh, this.rocks.group, this.debris && this.debris.group, this.vegetation && this.vegetation.group ] ) if ( root ) root.traverse( ( o ) => {

			if ( o.material ) for ( const m of Array.isArray( o.material ) ? o.material : [ o.material ] ) m.localLightsCheap = true;

		} );
		// the sea is not drawn inside the boat (its hull volume masks the surface)
		this.sceneRenderer.addHullMask( this.boat.createHullVolumeGeometry(), this.boat.group );
		this.waterMaterial = new WaterMaterial( {
			surface: this.surface, sky: this.sky, sceneCopy: this.sceneRenderer.opaqueCopy, sceneDepthHalf: this.sceneRenderer.opaqueDepthHalf.texture, refraction: this.refraction,
			hullMask: this.sceneRenderer.hullMaskRT.texture, hullMaskActive: this.sceneRenderer.hullMaskActive,
		} );
		this.waterMaterial.clouds = this.clouds;
		this.ocean = new Mesh( this.oceanLOD.geometry, this.waterMaterial );
		this.ocean.frustumCulled = false;
		this.ocean.receiveShadow = true;
		this.ocean.layers.set( LAYERS.WATER );
		// Thin alpha-tested meshes (nets, cloth, wire traps) are drawn in the late pass: the screen-space
		// AO and the refraction copy only see the opaque pass, so they neither smear dark AO halos over
		// what is behind them nor receive the noisy AO of their own strands. The boat's window glass is
		// blended: in the late pass it goes over the water seen through it (drawn earlier it would be
		// painted over by the water).
		this.scene.traverse( ( o ) => {

			if ( o.isMesh && ( o.name === 'village_fabric' || o.name === 'village_nets' || o.name === 'boat-trap' || o.name === 'boat-glass' ) ) o.layers.set( LAYERS.TRANSPARENT );

		} );
		// Terrain and water place their vertices in the vertex shader (CDLOD), so three's default motion
		// vectors (previous frame = raw grid position) are garbage there. Both are still in the world or
		// nearly so: camera-only reprojection of the real world position is what the temporal resolve needs.
		// ( the water material writes its own velocity + waterline mask outputs )
		useStaticVelocity( this.terrain.mesh );
		useStaticVelocity( this.rocks.group );
		scene.add( this.ocean );

		this.query = new WaterQuery( renderer, this.surface );

		this.marineSnow = new MarineSnow( { fft: this.fft, query: this.query } );
		scene.add( this.marineSnow.mesh );

		// ---- surf: plunging lips along the beach + spray particles (the breakers emit on the GPU;
		// spray.emit() / emitAlongPoints() for boat bow spray and splashes)
		this.spray = new Spray( renderer, { query: this.query, terrain: this.terrainGPU, sceneCopy: this.sceneRenderer.opaqueCopy, clouds: this.clouds } );
		scene.add( this.spray.mesh );
		if ( this.reef.setSpray ) this.reef.setSpray( this.spray ); // splashes of leaping fish
		this.breakers = new Breakers( renderer, {
			surface: this.surface, shore: this.shore, terrainData: this.terrainData, sky: this.sky,
			spray: this.spray, clouds: this.clouds,
		} );
		scene.add( this.breakers.mesh );
		// One camera-local breaker strip is reused by every generated island. The main island keeps
		// its authored full beach strip above; remote coastlines wake this one only when explored.
		const firstSatellite = ARCHIPELAGO[ 1 ];
		const satelliteStations = buildIslandShoreStrip( firstSatellite, firstSatellite.x + firstSatellite.rx * 1.2, firstSatellite.z, { count: 601, spacing: 0.8 } );
		this.satelliteBreakers = new Breakers( renderer, {
			surface: this.surface, shore: this.shore, terrainData: this.terrainData, sky: this.sky,
			spray: this.spray, clouds: this.clouds, stationSet: satelliteStations,
		} );
		this.satelliteBreakers.active = false;
		scene.add( this.satelliteBreakers.mesh );
		// The shared spray material can consult one crest field for shadows; retain the authored
		// beach's field while both breaker systems still emit into the same spray/foam ring.
		this.spray.waveShadow = this.breakers.sprayShadowModule;
		// dust, pollen, salt aerosol, seed fluff and gnats drifting around the camera
		this.airMotes = new AirMotes( { terrain: this.terrainGPU, clouds: this.clouds, csm: this.csm, reversedDepth: true } );
		scene.add( this.airMotes.mesh );
		// No default storm: the continuous blue-black column and its outer spray shell stay hidden
		// until random weather or the chart spawns an analytical Rankine vortex.
		if ( this.waterspoutField ) {

			this.waterspouts = new Waterspouts( { field: this.waterspoutField } );
			scene.add( this.waterspouts.mesh );
			this.waterspoutParticles = new ParticleWaterspouts( { spray: this.spray, field: this.waterspoutField } );
			scene.add( this.waterspoutParticles.mesh );

		}
		this.boatCtl = new BoatController( { model: this.boat, query: this.query, terrain: this.terrainData, colliders: this.colliders, waterspouts: this.waterspoutField } );
		this.tallShipCtl = new BoatController( { model: this.tallShip, query: this.query, terrain: this.terrainData, colliders: this.colliders, dock: WORLD.tallShipDock, waterspouts: this.waterspoutField } );
		this.boatCtls = [ this.boatCtl, this.tallShipCtl ];
		this.boatSpray = new BoatSpray( { boat: this.boatCtl, spray: this.spray } );
		// humpback cruising the deep water around the island (model fetched from public/models/whale)
		this.whale = new Whale( { scene, terrain: this.terrainData, query: this.query, spray: this.spray } );
		try {

			await this.whale.load();
			if ( this.reef && this.reef.setWhale ) this.reef.setWhale( this.whale ); // escort fish, foam and slick

		} catch ( e ) {

			console.warn( 'whale model failed to load', e );
			this.whale = null;

		}

		// interactive wake around the boat (Kelvin pattern, bow/stern waves, prop wash foam)
		this.wake = new WakeSim( renderer, { terrainGPU: this.terrainGPU, boat: this.boatCtl, colliders: this.colliders } );
		this.surface.wake = this.wake;
		this.player = new Player( { camera, input: this.input, terrain: this.terrainData, colliders: this.colliders, query: this.query, boat: this.boatCtl, boats: this.boatCtls, reef: this.reef } );
		try {

			await progress( 0.33, '正在登上海灵猎犬船长…' );
			const avatar = await this.player.loadAvatar( base + 'models/characters/spectral-sea-hound.glb' );
			scene.add( avatar.group );
			await avatar.loadEquipment( {
				gunUrl: base + 'models/weapons/wild-west-gun.glb',
				swordUrl: base + 'models/weapons/sword.glb',
			} );

		} catch ( error ) {

			console.warn( 'player avatar failed to load', error );

		}
		this.artillery = new NavalArtillery( {
			app: this,
			boat: this.tallShipCtl,
			cannons: this.tallShipCannons || [],
			modelUrl: base + 'models/cannon/artillery-projectile.glb',
		} );
		try {

			await this.artillery.load();

		} catch ( error ) {

			console.warn( 'artillery projectile failed to load; using cannonball fallback', error );

		}
		this.artillery.attachPlayer( this.player );
		// birds, beach crabs, sanderlings (after spray / query / boat, which they use)
		this.wildlife = new Wildlife( {
			scene, renderer, terrain: this.terrainData, terrainGPU: this.terrainGPU, shore: this.shore,
			village: this.village, colliders: this.colliders, vegetation: this.vegetation, boat: this.boatCtl, boatModel: this.boat,
			query: this.query, spray: this.spray, csm: this.csm,
		} );
		this.freeCam = qs.has( 'fly' );

		// ---------------------------------------------------------------- post
		await progress( 0.34, '正在准备着色器…' );
		this.underwater = new Underwater( {
			depthTexture: this.sceneRenderer.sceneRT.depthTexture, maskTexture: this.sceneRenderer.waterMaskTexture,
			query: this.query, caustics: this.caustics, fft: this.fft,
		} );
		// the camera's height above the water in the same frame (GPU query): decides the side the surface
		// is seen from where the triangle facing can't be trusted
		this.waterMaterial.cameraWaterHeightNode = this.query.cameraState().x;
		// aerial perspective, marine haze and volumetric sun shafts (post)
		this.haze = qs.has( 'noHaze' ) ? null : new AirHaze( {
			depthTexture: this.sceneRenderer.sceneRT.depthTexture, underwater: this.underwater, atmosphere: this.atmosphere,
			sky: this.sky, clouds: this.clouds, terrain: this.terrainGPU, csm: this.csm,
		} );
		this.post = new PostFX( renderer, { sceneRenderer: this.sceneRenderer, camera, underwater: this.underwater, clouds: this.clouds, sunDir: this.atmosphere.sunDir, haze: this.haze } );
		G.exposure.value = this.settings.exposure;
		if ( qs.has( 'scale' ) ) this.settings.renderScale = Number( qs.get( 'scale' ) ) || 1;
		this.setRenderScale( this.settings.renderScale );

		// ---------------------------------------------------------------- audio
		// recorded field recordings (public/audio, credits in public/audio/CREDITS.md); ?noAudio turns it off
		this.audio = qs.has( 'noAudio' ) || qs.has( 'editor' ) ? null : new SoundScape();
		this.player.setActionAudio( this.audio );
		// the fishing game (rod, bites, catch, cooler, fish stand)
		this.game = new Game( this );
		// the lanterns at Joe's fish stand and Marta's chandlery (lit from dusk like the village lamps);
		// positions are in each stall's frame (x right, z toward the customer), turned by its yaw
		for ( const [ s, lx, ly, lz ] of [ [ STAND, - 0.9, 1.85, 0.1 ], [ CHANDLERY, - 0.75, 1.58, - 1.45 ] ] ) {

			const c = Math.cos( s.yaw ), sn = Math.sin( s.yaw );
			const x = s.x + lx * c + lz * sn, z = s.z - lx * sn + lz * c;
			this.localLights.add( { position: new Vector3( x, this.terrainData.heightAt( s.x, s.z ) + ly, z ), color: new Color( 1.0, 0.72, 0.42 ), intensity: 5 * 1.5, range: 11, kind: 'lantern', flicker: 0.08 } );

		}

		this.boatCtl.onSlam = ( s ) => this.audio && this.audio.hullSlap( s );
		this.tallShipCtl.onSlam = ( s ) => this.audio && this.audio.hullSlap( s );
		engine.domElement.addEventListener( 'click', () => {

			if ( window.__ui && window.__ui.isPointerOverUI ) return;
			this.input.requestLock();
			if ( this.audio ) this.audio.resume();

		} );

		this.profiler = new Profiler( renderer );
		this.profiler.track( 'fft rows', this.fft.rowKernel );
		this.profiler.track( 'fft columns', this.fft.columnKernel );
		this.profiler.track( 'sky view', this.atmosphere.skyViewKernel );

		this.updateSun();
		installDebugViews( this );
		window.__app = this;
		this.gpu = GPU; // console / test access

		// ---- compile pipelines asynchronously (keeps the page responsive), then prime a few
		// frames behind the loading screen so any remaining first-use stalls happen there
		// stage weights: in the browser the pipeline compile below takes far longer than everything before it
		await progress( 0.36, '正在编译着色器…', 0.95 );
		await this.precompile();
		await progress( 0.96, '正在预热场景…' );
		for ( let i = 0; i < 2; i ++ ) {

			this.frame( 1 / 60 );
			await GPU.queue.onSubmittedWorkDone();

		}

	}

	// Build every pipeline up front, then wait for the GPU (keeps first-use compiles behind the loading
	// screen). The precompile frame visits every mesh of every pass, hidden or out of view, and the
	// pipelines compile in parallel in the background (GPU.renderPipeline); the refraction pass and
	// the hull mask are forced on so their variants are built too.
	async precompile() {

		const mr = this.engine.meshRenderer;
		const refr = this.refraction.enabled;
		// compute / post pipelines were requested while the systems were built: let them finish first
		// (the frame below would otherwise compile each one again, synchronously); the post chain
		// builds its passes on first use, so build it now
		if ( ! this.post._built ) {

			this.post._build();
			this.post._outW = 0; // as PostFX.beginFrame: size the new targets

		}

		await GPU.pipelinesReady();
		mr.precompiling = true;
		this.refraction.enabled = true;
		const sr = this.sceneRenderer, hm = sr.hullMaskRT;
		if ( sr.hullMasks.length ) mr.render( sr.hullMaskScene, {
			label: 'hull mask', kind: 'color', camera: this.camera, colorViews: [ hm.texture.view() ], colorFormats: hm.formats,
			clearColors: [ [ 0, 0, 0, 0 ] ], depthView: hm.depthTexture.view(), depthFormat: DEPTH_FORMAT, clearDepth: 0, cull: false,
		} );
		try {

			// both water variants: with the hull-mask discard (a hull on screen) and without
			for ( const hull of [ 0, 1 ] ) {

				this.waterMaterial.hullOverride = hull;
				this.frame( 1 / 60 );

			}

		} catch ( e ) {

			console.warn( 'precompile failed', e );

		}

		this.waterMaterial.hullOverride = null;
		mr.precompiling = false;
		this.refraction.enabled = refr;
		await GPU.pipelinesReady();
		await GPU.queue.onSubmittedWorkDone();

	}

	// ---------------------------------------------------------------- sun / sky

	updateSun() {

		const s = this.settings;
		const dir = sunDirectionFromTime( s.timeOfDay ).applyAxisAngle( _up, MathUtils.degToRad( s.sunAzimuth || 0 ) );
		// the sky is always scattered sunlight, even with the sun below the horizon (twilight)
		this.atmosphere.sunDir.value.copy( dir );
		// below the horizon the moon takes over as the key light
		const night = MathUtils.smoothstep( - dir.y, 0.02, 0.18 );
		G.night.value = night;
		this.sky.starIntensity.value = night;
		const moon = new Vector3( - dir.x, Math.abs( dir.y ) * 0.8 + 0.25, - dir.z ).normalize();
		this.sky.moonDir.value.copy( moon );

		// key light: the sun until it is well below the horizon (it gives no direct light in
		// twilight anyway), then the moon
		const light = dir.y > - 0.07 ? dir : moon;
		G.sunDir.value.copy( light );

	}

	applyAtmosphereReadback() {

		const a = this.atmosphere;
		if ( ! a.sunTransmittance ) return;
		const sunTrue = a.sunDir.value;
		const sunUp = sunTrue.y > - 0.07; // same switch as updateSun()
		const T = a.sunTransmittance;
		const horizonFade = MathUtils.smoothstep( sunTrue.y, - 0.03, 0.02 );
		let c;
		if ( sunUp ) c = new Color( T[ 0 ], T[ 1 ], T[ 2 ] ).multiplyScalar( SUN_ILLUMINANCE * horizonFade );
		else c = new Color( 0.6, 0.7, 1.0 ).multiplyScalar( 0.12 * G.night.value );
		G.sunColor.value.copy( c );
		const irr = a.skyIrradiance;
		const nightAmb = 0.012 * G.night.value;
		G.skyIrradiance.value.setRGB( irr[ 0 ] + nightAmb * 0.6, irr[ 1 ] + nightAmb * 0.7, irr[ 2 ] + nightAmb );
		G.horizonColor.value.setRGB( a.horizon[ 0 ], a.horizon[ 1 ], a.horizon[ 2 ] );

	}

	// T: let the day run (about 8 minutes per day) or stop it
	toggleTime() {

		const s = this.settings;
		if ( s.timeSpeed !== 0 ) {

			this._timeSpeed = s.timeSpeed;
			s.timeSpeed = 0;

		} else {

			s.timeSpeed = this._timeSpeed || 0.05;

		}

		if ( this.ui ) {

			this.ui.s.advance = s.timeSpeed !== 0;
			this.ui.ui.refresh();
			this.ui.ui.toast( s.timeSpeed !== 0 ? 'Time running' : 'Time paused' );

		}

	}

	// Free (debug) camera on F; the walker / boat resumes where it was left.
	setFreeCam( on ) {

		if ( on === this.freeCam ) return;
		this.freeCam = on;
		if ( on ) {

			const e = new Euler().setFromQuaternion( this.camera.quaternion, 'YXZ' );
			this.fly.setPose( this.camera.position.clone(), e.y, e.x );
			this.fly.velocity.set( 0, 0, 0 );

		} else if ( this.player.mode !== 'boat' && this.player.mode !== 'deck' ) {

			this.dropPlayerAtCamera();

		}

	}

	// Leaving the free camera: the player continues from where the camera is, facing the same way,
	// and falls from there (swimming at once if the camera is under water).
	dropPlayerAtCamera() {

		const p = this.player, c = this.camera.position;
		const e = new Euler().setFromQuaternion( this.camera.quaternion, 'YXZ' );
		p.yaw = e.y;
		p.pitch = MathUtils.clamp( e.x, - 1.5, 1.5 );
		p.velocity.set( 0, 0, 0 );
		const ground = Math.max( this.terrainData.heightAt( c.x, c.z ), this.colliders.groundHeightAt( c.x, c.z, c.y ) );
		const water = this.cameraWaterHeight ?? 0;
		if ( c.y < water ) {

			p.mode = 'swim';
			p.position.set( c.x, Math.max( c.y - 0.16, ground + 0.3 ), c.z );

		} else {

			// drop from where the camera is: gravity brings you down onto the ground or a deck, or into
			// the sea (the walker starts swimming once it is out of its depth)
			p.mode = 'walk';
			p.position.set( c.x, Math.max( c.y - 1.62, ground ), c.z );
			p.grounded = false;

		}

		p.waterH = water;
		p.waterMean = water;
		p._characterCameraReady = false;

	}

	// Move the active vessel to navigable water, or an on-foot player to safe dry ground near a
	// chart waypoint. The radial search makes island-centre waypoints useful without beaching a ship.
	fastTravelTo( x, z ) {

		x = wrapWorldCoordinate( x ); z = wrapWorldCoordinate( z );
		const p = this.player, terrain = this.terrainData;
		if ( ! p || ! terrain ) return false;
		if ( this.freeCam ) this.setFreeCam( false );
		if ( this.artillery?.active ) this.artillery.exit();
		this.artillery?.setDriverFiring( p, false );
		this.game?.cancelLine( true );
		this.game?.rod?.equip( false );

		const findNear = ( wantLand ) => {

			const suitable = ( px, pz ) => wantLand ? terrain.heightAt( px, pz ) >= 1 : terrain.heightAt( px, pz ) <= - 3;
			if ( suitable( x, z ) ) return { x, z };
			for ( let radius = 40; radius <= 1500; radius += 40 ) for ( let i = 0; i < 32; i ++ ) {

				const angle = i / 32 * Math.PI * 2;
				const px = wrapWorldCoordinate( x + Math.cos( angle ) * radius );
				const pz = wrapWorldCoordinate( z + Math.sin( angle ) * radius );
				if ( suitable( px, pz ) ) return { x: px, z: pz };

			}
			return { x, z };

		};

		const aboard = p.mode === 'boat' || p.mode === 'deck';
		if ( aboard ) {

			const target = findNear( false ), boat = p.boat || this.boatCtl;
			boat.position.set( target.x, 0, target.z );
			boat.velocity.set( 0, 0, 0 );
			boat.angular.set( 0, 0, 0 );
			boat.throttle = 0;
			boat.rpm = 0;
			boat.moored = false;
			boat.apply();
			p.velocity.set( 0, 0, 0 );
			p.deckVel.set( 0, 0, 0 );
			p.camInit = false;
			if ( p.mode === 'deck' ) p.deckToWorld();
			else boat.toWorld( boat.model.helmEye, p.position ).addScaledVector( _up, - 1.62 );
			return { ...target, mode: 'boat' };

		}

		const target = findNear( true ), ground = terrain.heightAt( target.x, target.z );
		p.mode = ground >= 0 ? 'walk' : 'swim';
		p.position.set( target.x, ground >= 0 ? ground + 0.05 : - 0.2, target.z );
		p.velocity.set( 0, 0, 0 );
		p.grounded = ground >= 0;
		p.floating = ground < 0;
		p.waterH = p.waterMean = 0;
		p._camY = null;
		p._characterCameraReady = false;
		return { ...target, mode: p.mode };

	}

	// ---------------------------------------------------------------- loop

	start() {

		this.engine.start( ( dt, t ) => this.frame( dt, t ) );

	}

	updateFPS( dt ) {

		const f = this._fps || ( this._fps = { el: document.getElementById( 'fps' ), acc: 0, n: 0, worst: 0 } );
		f.acc += dt;
		f.n ++;
		f.worst = Math.max( f.worst, dt );
		if ( f.acc >= 0.5 ) {

			const fps = f.n / f.acc;
			let text = `${ fps.toFixed( 0 ) } fps · ${ ( 1000 * f.acc / f.n ).toFixed( 1 ) } ms · max ${ ( f.worst * 1000 ).toFixed( 1 ) } ms`;
			if ( this.profiler && this.profiler.enabled ) {

				const p = this.profiler.result;
				text += ` · GPU c ${ p.compute.toFixed( 2 ) } r ${ p.render.toFixed( 2 ) }`;

			}

			if ( f.el ) f.el.textContent = text;
			this.fps = fps;
			f.acc = 0;
			f.n = 0;
			f.worst = 0;

		}

	}

	frame( dt ) {

		const t0 = performance.now();
		this._frame( dt );
		const ms = performance.now() - t0;
		this.cpuMs = this.cpuMs === undefined ? ms : this.cpuMs * 0.95 + ms * 0.05;

	}

	updateRegionalWeather() {

		if ( ! this.clouds || REGIONAL_WEATHER_ISLANDS.length === 0 ) return;
		const p = this.camera.position;
		let distance = Infinity;
		let nearest = null;
		for ( const island of REGIONAL_WEATHER_ISLANDS ) {

			const dx = wrappedWorldDelta( island.x, p.x );
			const dz = wrappedWorldDelta( island.z, p.z );
			const coastDistance = Math.hypot( dx, dz ) - Math.max( island.rx, island.rz );
			if ( coastDistance < distance ) { distance = coastDistance; nearest = island; }

		}
		const now = performance.now();
		// Hysteresis avoids repeatedly rebuilding the volumetric history at the cell edge. Once inside,
		// each island rolls independent weather every 2-5 minutes: clear polar light, broken cloud and
		// overcast are all possible instead of forcing permanent cloud cover.
		if ( this._regionalWeatherActive && distance > REGIONAL_WEATHER_EXIT ) {

			this._regionalWeatherActive = false;
			this._regionalWeatherIsland = null;
			this._regionalWeatherUntil = 0;
			this.clouds.coverage.value = this._normalCloudCoverage;

		} else if ( ! this._regionalWeatherActive && distance < REGIONAL_WEATHER_ENTER ) {

			this._normalCloudCoverage = this.clouds.coverage.value;
			this._regionalWeatherActive = true;
			this._regionalWeatherUntil = 0;

		} else if ( ! this._regionalWeatherActive ) this._normalCloudCoverage = this.clouds.coverage.value;

		if ( this._regionalWeatherActive && nearest && ( nearest.id !== this._regionalWeatherIsland || now >= this._regionalWeatherUntil ) ) {

			this._regionalWeatherIsland = nearest.id;
			this._regionalWeatherUntil = now + ( 120 + Math.random() * 180 ) * 1000;
			const states = REGIONAL_CLOUD_STATES[ nearest.climate ];
			this.clouds.coverage.value = states[ Math.floor( Math.random() * states.length ) ];

		}
	}

	updateStormWeather( dt ) {

		const clouds = this.clouds;
		const storm = this.stormWeather;
		const local = this.waterspoutField?.weatherAt( this.camera.position );
		if ( local?.spout ) {

			storm.x = local.spout.x;
			storm.z = local.spout.y;
			storm.wind = local.wind;
			storm.bgm = local.bgm;

		} else {

			storm.wind = 0;
			storm.bgm = 0;

		}

		let coverage = clouds?.coverage.value ?? 0;
		if ( clouds && local ) {

			this._stormCoverageBase = coverage;
			coverage = Math.max( coverage, coverage + ( 0.995 - coverage ) * local.cloud );
			clouds.coverage.value = coverage;

		}

		// Any fully spread cloud deck rains, whether it came from a waterspout cell or regional
		// weather.  Ease both onset and decay so sound and lens droplets never hard-cut at a radius.
		const rainTarget = MathUtils.smoothstep( coverage, 0.88, 0.98 );
		const response = rainTarget > this.rainIntensity ? 1.35 : 0.32;
		this.rainIntensity += ( rainTarget - this.rainIntensity ) * ( 1 - Math.exp( - dt * response ) );
		storm.rain = this.rainIntensity;
		clouds?.setStormDeck?.( coverage >= 0.9 && ( local?.cloud ?? 0 ) > 0.12 );

		if ( this.ui?.s && clouds && this.ui.s.clouds !== coverage ) {

			this.ui.s.clouds = coverage;
			this.ui.ui.refresh();

		}

	}

	updateIslandEcology() {

		const p = this.camera.position;
		let nearest = null, nearestDistance = Infinity;
		for ( let i = 1; i < ARCHIPELAGO.length; i ++ ) {

			const source = ARCHIPELAGO[ i ];
			const dx = wrappedWorldDelta( source.x, p.x ), dz = wrappedWorldDelta( source.z, p.z );
			if ( Math.abs( dx ) > source.rx + 1800 || Math.abs( dz ) > source.rz + 1800 ) continue;
			// Present a seam-adjacent copy in the camera's current torus cell so birds, fish and
			// breaker geometry remain physically close to the viewer as the terrain shader wraps.
			const nearX = p.x - dx, nearZ = p.z - dz;
			const island = nearX === source.x && nearZ === source.z ? source : { ...source, x: nearX, z: nearZ };
			const distance = Math.abs( islandDistance( island, p.x, p.z ).d );
			if ( distance < nearestDistance ) { nearestDistance = distance; nearest = island; }

		}
		const active = nearestDistance < 1450 ? nearest : null;
		const state = this._islandEcology || ( this._islandEcology = { island: null, breakersX: Infinity, breakersZ: Infinity, lifeX: Infinity, lifeZ: Infinity } );
		if ( ! active ) {

			this.satelliteBreakers.active = false;
			if ( state.island ) {

				this.reef.setFishHabitat( 0, 0 );
				this.wildlife.setIslandHabitat( null );
				state.island = null;

			}
			return;

		}
		const coast = islandCoastFrame( active, p.x, p.z, {} );
		const changed = state.island !== active.id;
		if ( changed || Math.hypot( coast.x - state.breakersX, coast.z - state.breakersZ ) > 70 ) {

			this.satelliteBreakers.setStationSet( buildIslandShoreStrip( active, coast.x, coast.z, { count: 601, spacing: 0.8 } ) );
			state.breakersX = coast.x; state.breakersZ = coast.z;

		}
		this.satelliteBreakers.active = true;
		if ( changed || Math.hypot( coast.x - state.lifeX, coast.z - state.lifeZ ) > 500 ) {

			const fishX = coast.x + coast.nx * 72, fishZ = coast.z + coast.nz * 72;
			this.reef.setFishHabitat( fishX - WORLD.reef.center.x, fishZ - WORLD.reef.center.z );
			this.wildlife.setIslandHabitat( active, coast );
			state.lifeX = coast.x; state.lifeZ = coast.z;

		}
		state.island = active.id;

	}

	_frame( dt ) {

		GPU.beginFrame();
		FrameUniforms.fields.frameIndex.value = GPU.frame;
		const s = this.settings;
		this.updateFPS( dt );
		G.dt.value = dt;
		G.time.value += dt;
		if ( s.timeSpeed !== 0 ) s.timeOfDay = ( s.timeOfDay + dt * s.timeSpeed + 24 ) % 24;

		// ---- player / boat (boat physics first so the cameras follow this frame's pose)
		const helmUsesFireMode = ! this.freeCam && this.artillery?.canDriverFire( this.player );
		if ( this.input.hit( 'KeyF' ) && ! helmUsesFireMode ) {

			if ( this.artillery?.active ) this.artillery.exit();
			this.setFreeCam( ! this.freeCam );

		}
		if ( this.input.hit( 'KeyT' ) ) this.toggleTime();
		if ( this.input.hit( 'KeyL' ) ) {

			const on = this.localLights.toggleFlashlight();
			if ( this.ui ) this.ui.ui.toast( on ? 'Flashlight on' : 'Flashlight off' );

		}

		if ( this.input.hit( 'KeyU' ) && this.audio ) {

			this.audio.setMuted( ! this.audio.muted );
			if ( this.ui ) this.ui.ui.toast( this.audio.muted ? 'Sound off' : 'Sound on' );

		}
		for ( const boat of this.boatCtls ) {

			boat.update( dt );
			const shift = wrapWorldPosition( boat.position, this._worldShift );
			if ( shift.dx || shift.dz ) {

				boat.apply();
				// The chase camera is smoothed in world space; carry its history through the seam so
				// it does not attempt to fly 20 km across the chart after the boat wraps.
				if ( this.player?.boat === boat && this.player.camPos ) {

					this.player.camPos.x += shift.dx;
					this.player.camPos.z += shift.dz;

				}

			}

		}
		this.boatSpray.update( dt );
		this.wake.update( dt );
		if ( this.freeCam ) {

			this.fly.update( dt );
			wrapWorldPosition( this.camera.position, this._worldShift );

		} else {

			this.player.update( dt );
			const shift = wrapWorldPosition( this.player.position, this._worldShift );
			if ( shift.dx || shift.dz ) {

				this.camera.position.x += shift.dx;
				this.camera.position.z += shift.dz;

			}

		}
		if ( this.player.mode !== 'cannon' ) this.artillery?.updateWorld( dt );
		this.game.update( dt );
		this.updateSun();

		this.atmosphere.update( dt, this.camera.position.y );
		this.applyAtmosphereReadback();

		// ---- water simulation
		this.waterspoutField?.update( dt, this.camera.position );
		this.fft.update( dt );
		this.seaDetail.update( dt );
		this.query.setCamera( this.camera.position.x, this.camera.position.z );
		for ( const boat of this.boatCtls ) boat.queueQueries();
		this.query.update();
		if ( this.query.cpuValid ) {

			const h0 = this.query.cpu[ 0 ];
			const h = Number.isFinite( h0 ) ? h0 : ( this.cameraWaterHeight ?? 0 );
			G.cameraUnderwater.value = this.camera.position.y < h - LENS_REACH ? 1 : 0;
			G.cameraWaterHeight.value = h;
			this.cameraWaterHeight = h;

		}

		if ( this.caustics ) this.caustics.update();
		// drawn while any part of the view can be under water (the specks above the surface are dropped)
		this.marineSnow.update( this.camera, this.camera.position.y < ( this.cameraWaterHeight ?? 0 ) + LENS_REACH );
		this.airMotes.update( dt, this.camera, this.cameraWaterHeight ?? 0 );
		if ( this.shoreSim ) this.shoreSim.update();
		this.underwaterLighting.update( this.camera );
		this.updateIslandEcology();
		this.breakers.update( this.camera );
		this.satelliteBreakers.update( this.camera );
		if ( this.waterspouts ) this.waterspouts.update( dt, this.camera );
		if ( this.waterspoutParticles ) this.waterspoutParticles.update( dt, this.camera );
		this.spray.update();
		if ( this.clouds ) {

			// Regional weather owns the baseline.  The storm overlay is recomputed from that baseline
			// each frame, preventing a previous 100% cover value from becoming permanent weather.
			if ( this._stormCoverageBase !== null ) {

				this.clouds.coverage.value = this._stormCoverageBase;
				this._stormCoverageBase = null;

			}
			this.updateRegionalWeather();
			this.updateStormWeather( dt );
			this.clouds.update( dt, this.camera );

		}
		this.environment.update( dt );

		// ---- world
		this.oceanLOD.update( this.camera );
		this.terrain.update( this.camera );
		this.rocks.update( this.camera );
		this.debris.update( this.camera );
		this.reef.update( dt, this.camera.position );
		this.village.update( dt );
		if ( this.vegetation ) this.vegetation.update( dt, this.camera );
		if ( this.whale ) this.whale.update( dt, this.camera );
		this.boat.update( dt );
		this.tallShip.update( dt );
		for ( const cannon of this.tallShipCannons || [] ) cannon.update( dt );
		this.wildlife.update( dt, this.camera, this.freeCam ? null : this.player );
		this.localLights.update( this.camera, dt );

		// ---- render
		G.exposure.value = s.exposure;
		updateCameraVelocity( this.camera );
		this.post.lens.update( dt, this.camera.position.y < ( this.cameraWaterHeight ?? 0 ), this.rainIntensity );
		if ( this.post.flare ) {

			this.post.flare.setDepthHeight( this.sceneRenderer.sceneRT.height );
			this.post.flare.update( this.camera, dt, { aboveWater: this.camera.position.y > ( this.cameraWaterHeight ?? 0 ) - 0.02 } );

		}

		// the post chain sets the TAAU jitter + internal size and writes the camera into the frame
		// uniforms (setFrameCamera); shadows then render with this frame's sun and camera
		this.post.beginFrame();
		this.underwater.updateCamera( this.camera );
		this.shadows.render( this.scene, this.engine.meshRenderer, this.shadows.update( this.camera, G.sunDir.value ) );
		this.sceneRenderer.render();
		if ( this.post.flare ) this.post.flare.kernel.dispatch( 1 );
		this.post.render();
		this.post.endFrame();
		GPU.submit();
		this.profiler.update( dt );

		this.updateAudio( dt );
		if ( this.ui ) this.ui.update( dt );
		this.input.endFrame();

	}

	// Internal render resolution relative to the output (0.5..1), set by hand: changing it re-creates
	// the scene / post / cloud targets, so nothing adjusts it automatically.
	setRenderScale( v ) {

		const scale = MathUtils.clamp( Math.round( v * 20 ) / 20, 0.5, 1 );
		this.settings.renderScale = scale;
		this.post.setScale( scale );
		if ( this.clouds ) this.clouds.resolutionScale = scale;

	}

	updateAudio( dt ) {

		if ( ! this.audio || ! this.audio.enabled ) return;
		const cam = this.camera;
		const p = cam.position;
		const f = this._af || ( this._af = { fwd: new Vector3(), up: new Vector3() } );
		cam.getWorldDirection( f.fwd );
		f.up.set( 0, 1, 0 ).applyQuaternion( cam.quaternion );
		const h = this.cameraWaterHeight ?? 0;
		const coast = this.terrainData.coastDistance( p.x, p.z ).d;
		this.audio.update( dt, {
			listener: { position: p, forward: f.fwd, up: f.up },
			underwater: p.y < h ? 1 : 0,
			depthBelowSurface: Math.max( 0, h - p.y ),
			surfIntensity: Math.min( 1, this.shore.amplitude.value / 0.6 ),
			distanceToShore: Math.abs( coast ),
			coastDistance: coast,
			waveHeight: this.shore.amplitude.value * 2,
			windSpeed: G.windSpeed.value,
			windDir: G.windDir.value,
			daylight: 1 - G.night.value,
			nearPier: Math.abs( p.x - WORLD.pier.x ) < 12 && p.z > WORLD.pier.zStart - 5 && p.z < WORLD.pier.zEnd + 8,
			storm: this.stormWeather,
			boat: {
				active: this.player.boat.driven, rpm: this.player.boat.rpm, throttle: this.player.boat.throttle, speed: this.player.boat.velocity.length(),
				position: this.player.boat.model.group.position, listenerInside: this.player.mode === 'boat' && this.player.camMode === 'first',
			},
		} );

	}

	spawnStormAt( x, z ) {

		if ( ! this.waterspoutField ) return - 1;
		return this.waterspoutField.spawnAt( wrapWorldCoordinate( x ), wrapWorldCoordinate( z ) );

	}

}
