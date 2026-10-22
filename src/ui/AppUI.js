import * as THREE from '../engine/index.js';
import { UI } from './UI.js';
import { G } from '../core/Globals.js';
import { GroundBounce } from '../materials/GroundBounce.js';

// Binds the Tidewater UI (panel + HUD) to the running app.
const SEA = {
	Calm: { wind: 3.5, fetch: 40, chop: 0.75, swell: 0.28, surf: 0.18, period: 11, whitecaps: 0.2 },
	Breezy: { wind: 7, fetch: 120, chop: 0.9, swell: 0.48, surf: 0.34, period: 9, whitecaps: 0.5 },
	Choppy: { wind: 12, fetch: 300, chop: 1.05, swell: 0.68, surf: 0.56, period: 8.5, whitecaps: 0.75 },
	Storm: { wind: 20, fetch: 900, chop: 1.2, swell: 1.0, surf: 0.9, period: 12, whitecaps: 1 },
};
const SEA_LABELS = { Calm: '平静', Breezy: '微风', Choppy: '风浪', Storm: '风暴' };

export class AppUI {

	constructor( app, ui = new UI() ) {

		this.app = app;
		this.ui = ui;
		const fft = app.fft;
		const shore = app.shore;

		// ---- plain values the controls bind to; onChange pushes them into the simulation
		const s = this.s = {
			wind: fft.local.windSpeed,
			windDir: fft.local.windDirection,
			fetch: fft.local.fetch,
			chop: fft.choppiness.value,
			swell: fft.swell.scale,
			whitecaps: 0.5,
			clarity: 1,
			surf: shore.amplitude.value,
			period: shore.period.value,
			gamma: shore.gamma.value,
			curl: shore.curl.value,
			caustics: app.caustics ? app.caustics.strength.value : 1,
			time: app.settings.timeOfDay,
			advance: app.settings.timeSpeed !== 0,
			timeSpeed: app.settings.timeSpeed || 0.05,
			clouds: app.clouds ? app.clouds.coverage.value : 0.45,
			cirrus: app.clouds && app.clouds.cirrus ? app.clouds.cirrus.value : 0.5,
			exposure: 0,
			fov: app.camera.fov,
			camMode: 'third',
			ao: app.post.params.aoStrength.value,
			bloom: app.post.params.bloom.value,
			flare: app.post.flare ? app.post.flare.strength.value : 1,
			vignette: app.post.params.vignette.value,
			saturation: app.post.params.saturation.value,
			contrast: app.post.params.contrast.value,
			grain: app.post.params.grain.value,
			renderScale: app.settings.renderScale,
			shadows: true,
		};

		const spectrum = () => {

			fft.local.windSpeed = s.wind;
			fft.local.windDirection = s.windDir;
			fft.local.fetch = s.fetch;
			fft.swell.scale = s.swell;
			fft.updateSpectrumUniforms();
			const a = THREE.MathUtils.degToRad( s.windDir );
			G.windDir.value.set( Math.cos( a ), Math.sin( a ) );
			G.windSpeed.value = s.wind;

		};

		const whitecaps = () => {

			// more whitecaps: foam starts at less compression (and more of it in fresh wind), lasts longer.
			// Only crests near breaking (strong compression) foam: a laxer threshold paints every crest line
			// with a white streak, which real open water at these wind speeds doesn't have.
			fft.foamBias.value = 0.5 + 0.16 * s.whitecaps + 0.01 * THREE.MathUtils.clamp( s.wind - 7, - 5, 12 );
			fft.foamDecay.value = 0.6 - 0.35 * s.whitecaps;

		};

		const clarity = () => {

			// scale absorption/scattering around the tropical defaults
			const k = 1 / Math.max( 0.2, s.clarity );
			G.waterAbsorption.value.set( 0.42, 0.075, 0.035 ).multiplyScalar( 0.6 + 0.4 * k );
			G.waterScattering.value.set( 0.012, 0.018, 0.024 ).multiplyScalar( k * k );

		};

		// ---------------------------------------------------------------- Ocean
		const ocean = ui.addTab( 'ocean', '海洋', 'ocean' );
		const sea = ocean.addFolder( '海况', { icon: 'wind' } );
		sea.addPresets( {
			label: '天气状况', active: 'Breezy',
			presets: Object.keys( SEA ).map( ( k ) => ( {
				label: SEA_LABELS[ k ], icon: k.toLowerCase(),
				apply: () => {

					const p = SEA[ k ];
					Object.assign( s, p );
					spectrum();
					whitecaps();
					fft.choppiness.value = s.chop;
					shore.amplitude.value = s.surf;
					shore.period.value = s.period;

				},
			} ) ),
		} );
		sea.addSlider( { label: '风速', object: s, key: 'wind', min: 0.5, max: 30, step: 0.1, unit: '米/秒', tooltip: '海面上方 10 米处的风速，会影响局地风浪、白浪和飞沫。', onChange: () => {

			spectrum();
			whitecaps();

		} } );
		sea.addSlider( { label: '风向', object: s, key: 'windDir', min: 0, max: 360, step: 1, unit: '°', onChange: spectrum } );
		sea.addSlider( { label: '风区长度', object: s, key: 'fetch', min: 5, max: 2000, log: true, unit: '公里', tooltip: '风吹过开阔水面的距离；距离越长，波浪越长、越高。', onChange: spectrum } );
		sea.addSlider( { label: '浪尖锐度', object: s, key: 'chop', min: 0, max: 1.6, step: 0.01, tooltip: '水平位移强度：形成更尖的浪峰和更宽的浪谷。', onChange: ( v ) => { fft.choppiness.value = v; } } );
		sea.addSlider( { label: '海洋涌浪', object: s, key: 'swell', min: 0, max: 2, step: 0.01, onChange: spectrum } );
		sea.addSlider( { label: '白浪', object: s, key: 'whitecaps', min: 0, max: 1, step: 0.01, onChange: whitecaps } );
		const water = ocean.addFolder( '海水', { icon: 'droplet' } );
		water.addSlider( { label: '清澈度', object: s, key: 'clarity', min: 0.3, max: 2, step: 0.01, tooltip: '数值越低，悬浮泥沙和浮游生物越多，水体越绿、越浑浊。', onChange: clarity } );

		// ---------------------------------------------------------------- Shore
		const shoreTab = ui.addTab( 'shore', '海岸', 'shore' );
		const surf = shoreTab.addFolder( '碎浪', { icon: 'wave' } );
		surf.addSlider( { label: '浪高', object: s, key: 'surf', min: 0, max: 1.4, step: 0.01, unit: '米', format: ( v ) => `${ ( v * 2 ).toFixed( 2 ) } 米`, onChange: ( v ) => { shore.amplitude.value = v; } } );
		surf.addSlider( { label: '波浪周期', object: s, key: 'period', min: 5, max: 16, step: 0.1, unit: '秒', onChange: ( v ) => { shore.period.value = v; } } );
		surf.addSlider( { label: '破浪水深比', object: s, key: 'gamma', min: 0.5, max: 1.1, step: 0.01, tooltip: '当浪高超过水深的这一比例时，波浪会破碎。', onChange: ( v ) => { shore.gamma.value = v; } } );
		surf.addSlider( { label: '卷浪', object: s, key: 'curl', min: 0, max: 1.5, step: 0.01, onChange: ( v ) => { shore.curl.value = v; } } );
		if ( app.breakers ) {

			s.spray = app.breakers.params.spray.value;
			s.lip = app.breakers.params.sheet.value;
			surf.addSlider( { label: '浪花飞沫', object: s, key: 'spray', min: 0, max: 2, step: 0.01, tooltip: '破碎浪峰抛出的水滴与水雾。', onChange: ( v ) => { app.breakers.params.spray.value = v; } } );
			surf.addSlider( { label: '浪唇水幕', object: s, key: 'lip', min: 0, max: 1.5, step: 0.01, tooltip: '卷破浪向前抛出的薄层水幕。', onChange: ( v ) => { app.breakers.params.sheet.value = v; } } );

		}

		if ( app.wake ) {

			const boat = shoreTab.addFolder( '船尾浪', { icon: 'wave', open: false } );
			s.wakeHeight = app.wake.amplitude.value;
			s.wakeFoam = app.wake.foamGain.value;
			boat.addSlider( { label: '尾浪高度', object: s, key: 'wakeHeight', min: 0, max: 2, step: 0.01, onChange: ( v ) => { app.wake.amplitude.value = v; } } );
			boat.addSlider( { label: '尾浪泡沫', object: s, key: 'wakeFoam', min: 0, max: 1.5, step: 0.01, onChange: ( v ) => { app.wake.foamGain.value = v; } } );

		}
		if ( app.caustics ) {

			const light = shoreTab.addFolder( '水下焦散', { icon: 'sun', open: false } );
			light.addSlider( { label: '强度', object: s, key: 'caustics', min: 0, max: 2, step: 0.01, onChange: ( v ) => { app.caustics.strength.value = v; } } );

		}

		// ---------------------------------------------------------------- Sky
		const sky = ui.addTab( 'sky', '天空', 'sky' );
		const sun = sky.addFolder( '太阳', { icon: 'clock' } );
		sun.addTimeOfDay( { object: app.settings, key: 'timeOfDay' } );
		sun.addSlider( { label: '太阳方位角', object: app.settings, key: 'sunAzimuth', min: - 180, max: 180, step: 1, format: ( v ) => `${ Math.round( v ) }°`, tooltip: '旋转太阳绕岛运行的路径（0 为真实路径：东升西落）。' } );
		let speed = null;
		sun.addToggle( { label: '时间流逝', object: s, key: 'advance', onChange: ( v ) => {

			app.settings.timeSpeed = v ? s.timeSpeed : 0;
			speed.setVisible( v );

		} } );
		speed = sun.addSlider( { label: '时间速度', object: s, key: 'timeSpeed', min: 0.002, max: 1, log: true, unit: '小时/秒', onChange: ( v ) => { if ( s.advance ) app.settings.timeSpeed = v; } } ).setVisible( s.advance );
		const atmo = sky.addFolder( '大气', { icon: 'cloud' } );
		if ( app.clouds ) atmo.addSlider( { label: '云量', object: s, key: 'clouds', min: 0, max: 1, step: 0.01, format: ( v ) => `${ Math.round( v * 100 ) }%`, onChange: ( v ) => { app.clouds.coverage.value = v; } } );
		if ( app.clouds && app.clouds.cirrus ) atmo.addSlider( { label: '卷云', object: s, key: 'cirrus', min: 0, max: 1, step: 0.01, format: ( v ) => `${ Math.round( v * 100 ) }%`, onChange: ( v ) => { app.clouds.cirrus.value = v; } } );
		if ( app.haze ) {

			s.haze = app.haze.density.value;
			s.shafts = app.haze.shafts.value;
			atmo.addSlider( { label: '海雾', object: s, key: 'haze', min: 0, max: 4, step: 0.05, tooltip: '空气透视与海雾密度（1 表示海平面能见度约 20 公里，0 表示空气完全清澈）。', onChange: ( v ) => { app.haze.density.value = v; } } );
			atmo.addSlider( { label: '阳光束', object: s, key: 'shafts', min: 0, max: 3, step: 0.05, tooltip: '雾中的体积光束与耶稣光，包括棕榈、码头、山丘和云层的阴影；0 为关闭。', onChange: ( v ) => { app.haze.shafts.value = v; } } );

		}
		if ( app.airMotes ) {

			s.air = app.airMotes.intensity.value;
			atmo.addSlider( { label: '空气微粒', object: s, key: 'air', min: 0, max: 2, step: 0.01, tooltip: '漂浮的尘埃、花粉、盐雾、种子绒毛和小飞虫，会在逆光中显现；0 为关闭。', onChange: ( v ) => { app.airMotes.intensity.value = v; } } );

		}

		atmo.addSlider( { label: '曝光', object: s, key: 'exposure', min: - 3, max: 3, step: 0.1, unit: 'EV', onChange: ( v ) => { app.settings.exposure = 0.55 * Math.pow( 2, v ); } } );

		// ---------------------------------------------------------------- Camera
		const cam = ui.addTab( 'camera', '镜头', 'camera' );
		const view = cam.addFolder( '视角', { icon: 'camera' } );
		view.addSelect( { label: '船上镜头', object: s, key: 'camMode', options: [ { label: '第一人称', value: 'first' }, { label: '第三人称', value: 'third' } ], onChange: ( v ) => { app.player.camMode = v; } } );
		view.addSlider( { label: '视野范围', object: s, key: 'fov', min: 35, max: 100, step: 1, unit: '°', onChange: ( v ) => {

			app.camera.fov = v;
			app.camera.updateProjectionMatrix();

		} } );
		view.addButton( { label: '自由镜头（F）', icon: 'camera', onClick: () => app.setFreeCam( ! app.freeCam ) } );

		// ---------------------------------------------------------------- Effects
		const fx = ui.addTab( 'effects', '特效', 'effects' );
		const post = fx.addFolder( '后期处理', { icon: 'sparkles' } );
		const P = app.post.params;
		post.addSlider( { label: '环境光遮蔽', object: s, key: 'ao', min: 0, max: 1.5, step: 0.01, onChange: ( v ) => { P.aoStrength.value = v; } } );
		s.bounce = GroundBounce.strength.value;
		post.addSlider( { label: '地面反射光', object: s, key: 'bounce', min: 0, max: 2, step: 0.01, tooltip: '阳光经地面和亮色沙滩反射，照亮码头、屋檐、船体与树干的背光面；0 为关闭。', onChange: ( v ) => { GroundBounce.strength.value = v; } } );
		s.sharpen = P.sharpen.value;
		post.addSlider( { label: '锐化', object: s, key: 'sharpen', min: 0, max: 1, step: 0.01, tooltip: '时间抗锯齿之后的对比度自适应锐化。', onChange: ( v ) => { P.sharpen.value = v; } } );
		if ( app.post.motionBlur ) {

			const mb = app.post.motionBlur.shutter;
			s.motionBlur = mb.value;
			post.addSlider( { label: '运动模糊', object: s, key: 'motionBlur', min: 0, max: 1, step: 0.05, format: ( v ) => v > 0 ? `${ Math.round( v * 360 ) }°` : '关闭', tooltip: '镜头与物体的运动模糊，以快门角度表示（180° 为电影感）；0 为关闭。', onChange: ( v ) => { mb.value = v; } } );

		}

		post.addSlider( { label: '泛光', object: s, key: 'bloom', min: 0, max: 0.3, step: 0.005, onChange: ( v ) => { P.bloom.value = v; } } );
		if ( app.post.flare ) post.addSlider( { label: '镜头光晕', object: s, key: 'flare', min: 0, max: 2, step: 0.05, onChange: ( v ) => { app.post.flare.strength.value = v; } } );
		post.addSlider( { label: '饱和度', object: s, key: 'saturation', min: 0.5, max: 1.5, step: 0.01, onChange: ( v ) => { P.saturation.value = v; } } );
		post.addSlider( { label: '对比度', object: s, key: 'contrast', min: 0.8, max: 1.3, step: 0.01, onChange: ( v ) => { P.contrast.value = v; } } );
		post.addSlider( { label: '暗角', object: s, key: 'vignette', min: 0, max: 1, step: 0.01, onChange: ( v ) => { P.vignette.value = v; } } );
		post.addSlider( { label: '胶片颗粒', object: s, key: 'grain', min: 0, max: 0.06, step: 0.001, onChange: ( v ) => { P.grain.value = v; } } );

		// ---------------------------------------------------------------- Performance
		const perf = ui.addTab( 'performance', '性能', 'performance' );
		const live = perf.addFolder( '实时数据', { icon: 'gauge' } );
		live.addInfo( { label: '帧率', get: () => `${ ( app.fps || 0 ).toFixed( 0 ) } 帧/秒` } );
		live.addInfo( { label: '每帧 CPU 时间', get: () => `${ ( app.cpuMs || 0 ).toFixed( 2 ) } 毫秒` } );
		live.addInfo( { label: '渲染尺寸', get: () => `${ app.sceneRenderer.width } × ${ app.sceneRenderer.height }` } );
		const quality = perf.addFolder( '画质', { icon: 'layers' } );
		quality.addSlider( { label: '渲染比例', object: s, key: 'renderScale', min: 0.5, max: 1, step: 0.05, format: ( v ) => `${ Math.round( v * 100 ) }%`, tooltip: '内部渲染分辨率；时间超分辨率会重建到完整输出分辨率。', onChange: ( v ) => app.setRenderScale( v ) } );
		// anti-aliasing: the TAA with 2..16 jitter positions averaged per pixel, or none
		s.aa = app.post.aaMode === 'none' ? 0 : app.post.taau.jitterPhaseOverride;
		quality.addSelect( { label: '抗锯齿', object: s, key: 'aa', tooltip: '时间抗锯齿：连续帧会为每个像素平均多个亚像素采样位置，也能平滑抖动渐隐和阴影噪点。更多采样不会增加单帧成本，但稳定画面需要更多帧。', options: [ { label: '关闭', value: 0 }, { label: '2 倍', value: 2 }, { label: '4 倍', value: 4 }, { label: '8 倍', value: 8 }, { label: '16 倍', value: 16 } ], onChange: ( v ) => {

			const n = Number( v );
			app.post.aaMode = n > 0 ? 'taa' : 'none';
			if ( n > 0 ) app.post.taau.jitterPhaseOverride = n;

		} } );
		quality.addToggle( { label: '阴影', object: s, key: 'shadows', onChange: ( v ) => { app.shadows.enabled = v; } } );
		s.ssr = true;
		quality.addToggle( { label: '水面反射', object: s, key: 'ssr', tooltip: '水面上码头、船只与山丘的屏幕空间反射。', onChange: ( v ) => { app.waterMaterial.params.ssr.value = v ? 1 : 0; } } );

		this._t = 0;

	}

	// per-frame HUD
	update( dt ) {

		const app = this.app;
		const ui = this.ui;
		ui.setStats( { fps: app.fps, frameMs: dt * 1000 } );
		this.s.renderScale = app.post.scale;

		const p = app.player;
		if ( app.freeCam ) {

			ui.setMode( '自由镜头' );
			ui.setPrompt( 'F', '步行模式' );
			ui.setBoatGauges( { visible: false } );
			ui.setDepth( { visible: false } );
			return;

		}

		const mode = p.mode === 'boat' ? `驾船 · ${ p.camMode === 'first' ? '第一' : '第三' }人称`
			: p.mode === 'deck' ? '甲板行走'
			: p.mode === 'swim' ? ( app.camera.position.y < ( app.cameraWaterHeight ?? 0 ) - 0.3 ? '潜水' : '游泳' ) : '步行';
		ui.setMode( mode );
		if ( p.prompt ) ui.setPrompt( p.prompt.key, p.prompt.text );
		else ui.setPrompt( null );

		const b = p.boat || app.boatCtl;
		if ( p.mode === 'boat' ) {

			const f = b.forward( new THREE.Vector3() );
			ui.setBoatGauges( {
				visible: true,
				throttle: b.throttle,
				rpm: b.rpm,
				speedKnots: b.speed * 1.94384,
				heading: ( THREE.MathUtils.radToDeg( Math.atan2( f.x, - f.z ) ) + 360 ) % 360,
			} );

		} else ui.setBoatGauges( { visible: false } );

		const depth = ( app.cameraWaterHeight ?? 0 ) - app.camera.position.y;
		ui.setDepth( { visible: p.mode === 'swim' && depth > 0.3, meters: depth } );

	}

}
