import './editor.css';
import { Box3, Color, Mesh, Ray, TorusGeometry, Vector3 } from '../engine/index.js';
import { standard } from '../materials/Materials.js';
import { computeShoreField } from '../world/ShoreField.js';
import { WORLD } from '../world/WorldLayout.js';
import { Vegetation } from '../world/Vegetation.js';
import { useStaticVelocity } from '../post/CameraVelocity.js';
import { icon } from '../ui/icons.js';
import { EntityManager } from './EntityManager.js';
import { TerrainEditor } from './TerrainEditor.js';
import {
	TerrainPatchTracker, createMapDocument, loadLocalDocument, saveLocalDocument, validateMapDocument,
} from './MapDocument.js';

const _near = new Vector3();
const _direction = new Vector3();
const _right = new Vector3();
const _forward = new Vector3();
const _up = new Vector3( 0, 1, 0 );
const _hit = new Vector3();

const TERRAIN_TOOLS = [
	[ 'raise', '抬高', '将地表向上堆积' ],
	[ 'lower', '降低', '向下挖掘地表' ],
	[ 'smooth', '平滑', '柔化尖锐地形' ],
	[ 'flatten', '压平', '靠近目标高度' ],
	[ 'paint-rock', '岩石', '绘制裸岩区域' ],
	[ 'paint-sand', '沙地', '绘制沙地覆盖' ],
	[ 'paint-path', '道路', '绘制道路与踩踏地' ],
	[ 'paint-seagrass', '海草', '绘制浅海海草' ],
	[ 'paint-rubble', '碎石', '绘制海床碎石' ],
	[ 'paint-meadow', '草地', '强制绘制开阔草地' ],
	[ 'paint-forest', '林地', '绘制森林地表与树木密度' ],
	[ 'paint-snow', '雪地', '绘制积雪覆盖并清除植被' ],
];

function h( tag, className, text ) {

	const element = document.createElement( tag );
	if ( className ) element.className = className;
	if ( text !== undefined ) element.textContent = text;
	return element;

}

function number( value, fallback = 0 ) {

	const parsed = Number( value );
	return Number.isFinite( parsed ) ? parsed : fallback;

}

function fileName( value ) {

	return String( value || 'untitled-island' ).trim().replace( /[^\w\u4e00-\u9fff-]+/g, '-' ).replace( /^-+|-+$/g, '' ) || 'untitled-island';

}

export class EditorApp {

	constructor( app ) {

		this.app = app;
		this.canvas = app.engine.domElement;
		this.terrain = app.terrainData;
		this.gpu = app.terrainGPU;
		this.mode = 'terrain';
		this.entityTool = 'select';
		this.armedAsset = null;
		this.drag = null;
		this.pointer = { x: innerWidth * 0.5, y: innerHeight * 0.5 };
		this.hoverPoint = null;
		this.dirty = false;
		this.loading = false;
		this.preview = false;
		this.view = { target: [ 20, 0, - 150 ], yaw: 0.58, elevation: 0.7, distance: 440 };
		this.tracker = new TerrainPatchTracker( this.terrain );
		this.terrainEditor = new TerrainEditor( {
			terrain: this.terrain, gpu: this.gpu, tracker: this.tracker,
			onStatus: ( message, state ) => this.setStatus( message, state ),
			onChange: () => this.markDirty(),
		} );
		this.entities = new EntityManager( {
			app,
			onChange: () => { this.markDirty(); this.renderEntities(); this.renderInspector(); },
			onSelect: () => { this.renderEntities(); this.renderInspector(); },
		} );

		this._configureGame();
		this._buildUI();
		this._buildBrushCursor();
		this._bind();
		this.applyCamera();
		this.renderAssets();
		this.renderEntities();
		this.renderInspector();
		this.setStatus( '编辑器就绪 · 按住 Shift 可反向雕刻或擦除材质', 'ok' );

	}

	_configureGame() {

		this.app.setFreeCam( true );
		this.app.fly.enabled = false;
		this.app.input.enabled = false;
		this.app.audio?.setMuted?.( true );
		document.body.classList.add( 'map-editor-active' );
		window.__ui = { get isPointerOverUI() { return true; } };

	}

	_buildUI() {

		const root = this.root = h( 'div', 'me-root' );
		root.innerHTML = `
			<header class="me-topbar">
				<div class="me-brand"><span class="me-brand-mark">${ icon( 'mountain' ) }</span><span><b>TIDEWATER</b><small>MAP WORKSHOP</small></span></div>
				<label class="me-map-name"><span>地图名称</span><input value="Untitled island" maxlength="64" aria-label="地图名称"></label>
				<div class="me-top-actions">
					<button type="button" data-action="undo" title="撤销 Ctrl+Z">撤销</button>
					<button type="button" data-action="redo" title="重做 Ctrl+Shift+Z">重做</button>
					<span class="me-divider"></span>
					<button type="button" data-action="save">保存</button>
					<button type="button" data-action="load">载入</button>
					<button type="button" data-action="export">导出</button>
					<button type="button" data-action="import-map">导入</button>
					<button type="button" class="me-primary" data-action="preview">试玩</button>
				</div>
			</header>
			<aside class="me-left me-panel">
				<nav class="me-mode-switch" aria-label="编辑模式">
					<button type="button" class="is-active" data-mode="terrain">地形</button>
					<button type="button" data-mode="entity">实体</button>
				</nav>
				<section class="me-pane is-active" data-pane="terrain">
					<div class="me-section-head"><span>雕刻与覆盖层</span><small>SHIFT 反向</small></div>
					<div class="me-tool-grid"></div>
					<div class="me-controls">
						<label><span>笔刷半径 <output data-out="radius">18 m</output></span><input data-control="radius" type="range" min="2" max="80" step="1" value="18"></label>
						<label><span>笔刷强度 <output data-out="strength">0.65</output></span><input data-control="strength" type="range" min="0.05" max="3" step="0.05" value="0.65"></label>
						<label data-flatten><span>目标高度 <output data-out="target">4 m</output></span><input data-control="target" type="range" min="-30" max="120" step="0.5" value="4"></label>
					</div>
					<div class="me-actions-stack">
						<button type="button" data-action="rebuild-vegetation">根据生物群系重建植被</button>
						<button type="button" data-action="rebuild-shore">重建海岸波场</button>
						<button type="button" data-action="reset-terrain">清除地形修改</button>
					</div>
				</section>
				<section class="me-pane" data-pane="entity">
					<div class="me-section-head"><span>资源库</span><button type="button" class="me-text-button" data-action="import-asset">导入 GLB</button></div>
					<div class="me-asset-list"></div>
					<div class="me-section-head me-entity-head"><span>场景实体</span><small class="me-entity-count">0</small></div>
					<div class="me-entity-list"></div>
				</section>
			</aside>
			<aside class="me-right me-panel">
				<div class="me-inspector-head"><span>属性检查器</span><small>ENTITY</small></div>
				<div class="me-inspector"></div>
			</aside>
			<footer class="me-statusbar">
				<span class="me-state" data-state="ok"><i></i><b>编辑器就绪</b></span>
				<span class="me-hint">左键编辑 · 右键环绕 · 中键平移 · 滚轮缩放</span>
				<span class="me-coordinates">X —　Y —　Z —</span>
			</footer>
			<div class="me-preview-return" hidden><button type="button">返回编辑器 <kbd>Esc</kbd></button></div>
			<input class="me-file-map" type="file" accept=".json,.tidewater-map,application/json" hidden>
			<input class="me-file-asset" type="file" accept=".glb,model/gltf-binary" hidden>
		`;
		document.body.append( root );
		this.nameInput = root.querySelector( '.me-map-name input' );
		this.statusElement = root.querySelector( '.me-state' );
		this.statusText = this.statusElement.querySelector( 'b' );
		this.coordinates = root.querySelector( '.me-coordinates' );
		this.assetList = root.querySelector( '.me-asset-list' );
		this.entityList = root.querySelector( '.me-entity-list' );
		this.entityCount = root.querySelector( '.me-entity-count' );
		this.inspector = root.querySelector( '.me-inspector' );
		this.previewReturn = root.querySelector( '.me-preview-return' );

		const grid = root.querySelector( '.me-tool-grid' );
		for ( const [ id, label, tip ] of TERRAIN_TOOLS ) {

			const button = h( 'button', id === 'raise' ? 'is-active' : '' );
			button.type = 'button';
			button.dataset.tool = id;
			button.title = tip;
			button.innerHTML = `<span>${ label }</span><small>${ id.startsWith( 'paint-' ) ? '材质' : '高度' }</small>`;
			grid.append( button );

		}

	}

	_buildBrushCursor() {

		const mat = standard( {
			name: 'EditorBrushCursor', color: new Color().setHex( 0xb6d8d0 ), emissive: new Color().setHex( 0x304f4b ),
			roughness: 0.4, metalness: 0, opacity: 0.82, transparent: true, depthWrite: false, side: 'double',
		} );
		this.brushCursor = new Mesh( new TorusGeometry( 1, 0.035, 5, 64 ), mat );
		this.brushCursor.name = 'EditorBrushCursor';
		this.brushCursor.rotation.x = Math.PI / 2;
		this.brushCursor.visible = false;
		this.brushCursor.frustumCulled = false;
		this.app.scene.add( this.brushCursor );

	}

	_bind() {

		this.root.addEventListener( 'pointerdown', ( event ) => event.stopPropagation() );
		this.root.addEventListener( 'wheel', ( event ) => event.stopPropagation(), { passive: true } );
		this.root.querySelector( '.me-mode-switch' ).addEventListener( 'click', ( event ) => {

			const button = event.target.closest( '[data-mode]' );
			if ( button ) this.setMode( button.dataset.mode );

		} );
		this.root.querySelector( '.me-tool-grid' ).addEventListener( 'click', ( event ) => {

			const button = event.target.closest( '[data-tool]' );
			if ( ! button ) return;
			this.terrainEditor.tool = button.dataset.tool;
			for ( const node of this.root.querySelectorAll( '[data-tool]' ) ) node.classList.toggle( 'is-active', node === button );
			this.root.querySelector( '[data-flatten]' ).classList.toggle( 'is-visible', button.dataset.tool === 'flatten' );

		} );
		for ( const input of this.root.querySelectorAll( '[data-control]' ) ) input.addEventListener( 'input', () => {

			const value = number( input.value );
			if ( input.dataset.control === 'radius' ) {

				this.terrainEditor.radius = value;
				this.root.querySelector( '[data-out="radius"]' ).textContent = `${ value.toFixed( 0 ) } m`;
				this.brushCursor.scale.setScalar( value );

			} else if ( input.dataset.control === 'strength' ) {

				this.terrainEditor.strength = value;
				this.root.querySelector( '[data-out="strength"]' ).textContent = value.toFixed( 2 );

			} else {

				this.terrainEditor.targetHeight = value;
				this.root.querySelector( '[data-out="target"]' ).textContent = `${ value.toFixed( 1 ) } m`;

			}

		} );
		this.root.addEventListener( 'click', ( event ) => {

			const button = event.target.closest( '[data-action]' );
			if ( button ) this.handleAction( button.dataset.action );

		} );
		this.nameInput.addEventListener( 'input', () => this.markDirty() );
		this.root.querySelector( '.me-file-map' ).addEventListener( 'change', ( event ) => this.importMapFile( event.target.files[ 0 ] ) );
		this.root.querySelector( '.me-file-asset' ).addEventListener( 'change', ( event ) => this.importAssetFile( event.target.files[ 0 ] ) );
		this.previewReturn.querySelector( 'button' ).addEventListener( 'click', () => this.setPreview( false ) );

		this.canvas.addEventListener( 'pointerdown', ( event ) => this.pointerDown( event ) );
		this.canvas.addEventListener( 'pointermove', ( event ) => this.pointerMove( event ) );
		window.addEventListener( 'pointerup', ( event ) => this.pointerUp( event ) );
		this.canvas.addEventListener( 'wheel', ( event ) => {

			if ( this.preview ) return;
			this.view.distance = Math.max( 18, Math.min( 1500, this.view.distance * Math.exp( event.deltaY * 0.0012 ) ) );
			event.preventDefault();

		}, { passive: false } );
		window.addEventListener( 'keydown', ( event ) => this.keyDown( event ) );

	}

	setMode( mode ) {

		this.mode = mode;
		for ( const button of this.root.querySelectorAll( '[data-mode]' ) ) button.classList.toggle( 'is-active', button.dataset.mode === mode );
		for ( const pane of this.root.querySelectorAll( '[data-pane]' ) ) pane.classList.toggle( 'is-active', pane.dataset.pane === mode );
		this.brushCursor.visible = mode === 'terrain' && !! this.hoverPoint;
		if ( mode === 'entity' ) this.setStatus( this.armedAsset ? '在地形上单击以放置实体' : '选择资源进行放置，或从列表选择实体', 'ok' );

	}

	async handleAction( action ) {

		try {

			if ( action === 'undo' ) this.terrainEditor.undo();
			else if ( action === 'redo' ) this.terrainEditor.redo();
			else if ( action === 'save' ) await this.saveLocal();
			else if ( action === 'load' ) await this.loadLocal();
			else if ( action === 'export' ) this.exportMap();
			else if ( action === 'import-map' ) this.root.querySelector( '.me-file-map' ).click();
			else if ( action === 'import-asset' ) this.root.querySelector( '.me-file-asset' ).click();
			else if ( action === 'rebuild-vegetation' ) await this.rebuildVegetation();
			else if ( action === 'rebuild-shore' ) await this.rebuildShore();
			else if ( action === 'reset-terrain' ) await this.resetTerrain();
			else if ( action === 'preview' ) this.setPreview( true );
			else if ( action === 'delete-entity' ) this.entities.removeSelected();

		} catch ( error ) {

			console.error( error );
			this.setStatus( error.message || '操作失败', 'error' );

		}

	}

	pointerDown( event ) {

		if ( this.preview ) return;
		this.pointer.x = event.clientX;
		this.pointer.y = event.clientY;
		this.canvas.setPointerCapture?.( event.pointerId );
		if ( event.button === 2 ) {

			this.drag = { kind: 'orbit', x: event.clientX, y: event.clientY };
			return;

		}
		if ( event.button === 1 ) {

			this.drag = { kind: 'pan', x: event.clientX, y: event.clientY };
			return;

		}
		if ( event.button !== 0 ) return;
		const ray = this.pointerRay( event.clientX, event.clientY );
		if ( this.mode === 'terrain' ) {

			const point = this.terrainHit( ray );
			if ( point ) {

				this.terrainEditor.beginStroke( point.x, point.z, event.shiftKey );
				this.drag = { kind: 'paint' };

			}

		} else if ( this.armedAsset ) {

			const point = this.terrainHit( ray );
			if ( point ) {

				this.entities.add( this.armedAsset, point.x, point.z );
				this.armedAsset = null;
				this.renderAssets();
				this.setStatus( '实体已放置', 'ok' );

			}

		} else {

			const picked = this.entities.pick( ray );
			if ( picked ) this.entities.select( picked );
			else if ( this.entityTool === 'move' && this.entities.selected ) {

				const point = this.terrainHit( ray );
				if ( point ) this.entities.moveSelectedTo( point.x, point.z );

			} else this.entities.select( null );

		}

	}

	pointerMove( event ) {

		if ( this.preview ) return;
		this.pointer.x = event.clientX;
		this.pointer.y = event.clientY;
		if ( this.drag?.kind === 'orbit' ) {

			this.view.yaw -= ( event.clientX - this.drag.x ) * 0.006;
			this.view.elevation = Math.max( 0.12, Math.min( 1.48, this.view.elevation + ( event.clientY - this.drag.y ) * 0.005 ) );
			this.drag.x = event.clientX; this.drag.y = event.clientY;
			return;

		}
		if ( this.drag?.kind === 'pan' ) {

			const scale = this.view.distance * 0.0015;
			this.app.camera.getWorldDirection( _forward );
			_forward.y = 0; _forward.normalize();
			_right.crossVectors( _forward, _up ).normalize();
			const dx = event.clientX - this.drag.x, dy = event.clientY - this.drag.y;
			this.view.target[ 0 ] += ( - _right.x * dx + _forward.x * dy ) * scale;
			this.view.target[ 2 ] += ( - _right.z * dx + _forward.z * dy ) * scale;
			this.view.target[ 1 ] += _forward.y * dy * scale;
			this.drag.x = event.clientX; this.drag.y = event.clientY;
			return;

		}
		const point = this.terrainHit( this.pointerRay( event.clientX, event.clientY ) );
		this.setHoverPoint( point );
		if ( this.drag?.kind === 'paint' && point ) this.terrainEditor.continueStroke( point.x, point.z, event.shiftKey );

	}

	pointerUp( event ) {

		if ( this.drag?.kind === 'paint' ) this.terrainEditor.endStroke();
		this.drag = null;
		this.canvas.releasePointerCapture?.( event.pointerId );

	}

	keyDown( event ) {

		if ( event.target?.matches?.( 'input, select, textarea' ) ) return;
		if ( this.preview ) {

			if ( event.code === 'Escape' ) this.setPreview( false );
			return;

		}
		const mod = event.ctrlKey || event.metaKey;
		if ( mod && event.code === 'KeyZ' ) {

			event.preventDefault();
			if ( event.shiftKey ) this.terrainEditor.redo(); else this.terrainEditor.undo();

		} else if ( mod && event.code === 'KeyY' ) {

			event.preventDefault(); this.terrainEditor.redo();

		} else if ( event.code === 'Delete' || event.code === 'Backspace' ) this.entities.removeSelected();
		else if ( event.code === 'Digit1' ) this.setMode( 'terrain' );
		else if ( event.code === 'Digit2' ) this.setMode( 'entity' );

	}

	pointerRay( clientX, clientY ) {

		const rect = this.canvas.getBoundingClientRect();
		const x = ( clientX - rect.left ) / rect.width * 2 - 1;
		const y = 1 - ( clientY - rect.top ) / rect.height * 2;
		const camera = this.app.camera;
		camera.updateMatrixWorld( true );
		_near.set( x, y, 0.5 ).applyMatrix4( camera.projectionMatrixInverse ).applyMatrix4( camera.matrixWorld );
		_direction.subVectors( _near, camera.position ).normalize();
		return new Ray( camera.position.clone(), _direction.clone() );

	}

	terrainHit( ray ) {

		const half = this.terrain.size * 0.5;
		const box = new Box3( new Vector3( - half, - 100, - half ), new Vector3( half, 340, half ) );
		const range = this._rayBoxRange( ray, box );
		if ( ! range ) return null;
		let previousT = Math.max( 0, range[ 0 ] );
		let previous = this._clearance( ray, previousT );
		const end = Math.min( range[ 1 ], previousT + 3200 );
		const step = Math.max( 1.5, ( end - previousT ) / 900 );
		for ( let t = previousT + step; t <= end + step * 0.5; t += step ) {

			const currentT = Math.min( t, end );
			const current = this._clearance( ray, currentT );
			if ( previous >= 0 && current <= 0 ) {

				let lo = previousT, hi = currentT;
				for ( let i = 0; i < 12; i ++ ) {

					const mid = ( lo + hi ) * 0.5;
					if ( this._clearance( ray, mid ) > 0 ) lo = mid; else hi = mid;

				}
				ray.at( hi, _hit );
				_hit.y = this.terrain.heightAt( _hit.x, _hit.z );
				return _hit.clone();

			}
			previousT = currentT;
			previous = current;
			if ( currentT >= end ) break;

		}
		return null;

	}

	_clearance( ray, distance ) {

		ray.at( distance, _hit );
		return _hit.y - this.terrain.heightAt( _hit.x, _hit.z );

	}

	_rayBoxRange( ray, box ) {

		let near = 0, far = Infinity;
		for ( const axis of [ 'x', 'y', 'z' ] ) {

			const origin = ray.origin[ axis ], direction = ray.direction[ axis ];
			if ( Math.abs( direction ) < 1e-8 ) {

				if ( origin < box.min[ axis ] || origin > box.max[ axis ] ) return null;
				continue;

			}
			let a = ( box.min[ axis ] - origin ) / direction;
			let b = ( box.max[ axis ] - origin ) / direction;
			if ( a > b ) { const temp = a; a = b; b = temp; }
			near = Math.max( near, a ); far = Math.min( far, b );
			if ( near > far ) return null;

		}
		return far >= 0 ? [ near, far ] : null;

	}

	setHoverPoint( point ) {

		this.hoverPoint = point;
		this.brushCursor.visible = this.mode === 'terrain' && !! point;
		if ( point ) {

			this.brushCursor.position.set( point.x, point.y + 0.08, point.z );
			this.brushCursor.scale.setScalar( this.terrainEditor.radius );
			this.coordinates.textContent = `X ${ point.x.toFixed( 1 ) }　Y ${ point.y.toFixed( 1 ) }　Z ${ point.z.toFixed( 1 ) }`;

		} else this.coordinates.textContent = 'X —　Y —　Z —';

	}

	applyCamera() {

		const v = this.view, target = _hit.fromArray( v.target );
		const horizontal = Math.cos( v.elevation ) * v.distance;
		this.app.camera.position.set(
			target.x + Math.sin( v.yaw ) * horizontal,
			target.y + Math.sin( v.elevation ) * v.distance,
			target.z + Math.cos( v.yaw ) * horizontal,
		);
		this.app.camera.lookAt( target );

	}

	update() {

		if ( ! this.preview ) this.applyCamera();

	}

	renderAssets() {

		this.assetList.replaceChildren();
		for ( const asset of this.entities.listAssets() ) {

			const button = h( 'button', this.armedAsset === asset.id ? 'me-asset is-armed' : 'me-asset' );
			button.type = 'button';
			const type = h( 'span', 'me-asset-type', asset.category );
			const name = h( 'b', '', asset.name );
			const size = h( 'small', '', asset.size.map( ( v ) => number( v ).toFixed( 1 ) ).join( ' × ' ) + ' m' );
			button.append( type, name, size );
			button.addEventListener( 'click', () => {

				this.setMode( 'entity' );
				this.armedAsset = this.armedAsset === asset.id ? null : asset.id;
				this.entityTool = 'select';
				this.renderAssets();
				this.setStatus( this.armedAsset ? `单击地形放置“${ asset.name }”` : '已取消放置', 'ok' );

			} );
			this.assetList.append( button );

		}

	}

	renderEntities() {

		this.entityList.replaceChildren();
		this.entityCount.textContent = String( this.entities.entities.length );
		if ( ! this.entities.entities.length ) {

			const empty = h( 'div', 'me-empty' );
			empty.innerHTML = `<span>${ icon( 'grid' ) }</span><b>还没有实体</b><small>从上方资源库选择一种外观，然后在岛屿上单击。</small>`;
			this.entityList.append( empty );
			return;

		}
		for ( const entity of this.entities.entities ) {

			const button = h( 'button', entity === this.entities.selected ? 'me-entity-row is-selected' : 'me-entity-row' );
			button.type = 'button';
			button.append( h( 'b', '', entity.data.name ), h( 'small', '', `${ entity.data.position[ 0 ].toFixed( 0 ) }, ${ entity.data.position[ 2 ].toFixed( 0 ) }` ) );
			button.addEventListener( 'click', () => { this.entities.select( entity ); this.setMode( 'entity' ); } );
			this.entityList.append( button );

		}

	}

	renderInspector() {

		const entity = this.entities.selected;
		this.inspector.replaceChildren();
		if ( ! entity ) {

			const empty = h( 'div', 'me-inspector-empty' );
			empty.innerHTML = `<span>${ icon( 'compass' ) }</span><b>选择一个实体</b><p>从场景列表或直接从视图中选择。实体的位置、外观比例和碰撞体会在这里编辑。</p>`;
			this.inspector.append( empty );
			return;

		}
		const d = entity.data, c = d.collider || { type: 'none', size: [ 1, 1, 1 ], offsetY: 0 };
		this.inspector.innerHTML = `
			<div class="me-object-title"><span>${ entity.asset.category }</span><input data-entity="name" maxlength="64"><small>${ d.id }</small></div>
			<div class="me-property-group"><h3>变换</h3>
				<div class="me-vector" data-vector="position"><label>X<input type="number" step="0.5"></label><label>Y<input type="number" step="0.5"></label><label>Z<input type="number" step="0.5"></label></div>
				<label class="me-field"><span>旋转角度</span><input data-entity="rotation" type="number" step="1"><small>度</small></label>
				<label class="me-field"><span>统一缩放</span><input data-entity="scale" type="number" min="0.05" max="100" step="0.05"></label>
				<label class="me-check"><input data-entity="snap" type="checkbox"><span>贴合地形高度</span></label>
				<button type="button" class="me-wide-button" data-entity-action="move">在视图中移动</button>
			</div>
			<div class="me-property-group"><h3>碰撞体</h3>
				<label class="me-field"><span>类型</span><select data-collider="type"><option value="none">无碰撞</option><option value="box">盒体</option><option value="cylinder">圆柱体</option><option value="mesh">模型网格（精确）</option></select></label>
				<div class="me-collider-fields">
					<div class="me-vector" data-vector="collider"><label>宽<input type="number" min="0.05" step="0.1"></label><label>高<input type="number" min="0.05" step="0.1"></label><label>深<input type="number" min="0.05" step="0.1"></label></div>
					<label class="me-field"><span>垂直偏移</span><input data-collider="offset" type="number" step="0.1"></label>
					<label class="me-check"><input data-collider="solid" type="checkbox"><span>阻挡玩家与射线</span></label>
					<label class="me-check"><input data-collider="walkable" type="checkbox"><span>顶部可以行走</span></label>
				</div>
			</div>
			<button type="button" class="me-danger" data-action="delete-entity">删除实体</button>
		`;
		const name = this.inspector.querySelector( '[data-entity="name"]' );
		name.value = d.name;
		const positionInputs = this.inspector.querySelectorAll( '[data-vector="position"] input' );
		positionInputs.forEach( ( input, index ) => input.value = d.position[ index ].toFixed( 2 ) );
		this.inspector.querySelector( '[data-entity="rotation"]' ).value = ( ( d.rotationY || 0 ) * 180 / Math.PI ).toFixed( 1 );
		this.inspector.querySelector( '[data-entity="scale"]' ).value = d.scale || 1;
		this.inspector.querySelector( '[data-entity="snap"]' ).checked = d.snapToTerrain !== false;
		this.inspector.querySelector( '[data-collider="type"]' ).value = c.type || 'none';
		const colliderInputs = this.inspector.querySelectorAll( '[data-vector="collider"] input' );
		( c.size || [ 1, 1, 1 ] ).forEach( ( value, index ) => colliderInputs[ index ].value = number( value, 1 ).toFixed( 2 ) );
		this.inspector.querySelector( '[data-collider="offset"]' ).value = number( c.offsetY ).toFixed( 2 );
		this.inspector.querySelector( '[data-collider="solid"]' ).checked = c.solid !== false;
		this.inspector.querySelector( '[data-collider="walkable"]' ).checked = !! c.walkable;
		this.inspector.querySelector( '.me-collider-fields' ).hidden = c.type === 'none';

		name.addEventListener( 'change', () => this.entities.updateSelected( { name: name.value.trim() || entity.asset.name } ) );
		positionInputs.forEach( ( input, index ) => input.addEventListener( 'change', () => {

			const position = [ ...d.position ]; position[ index ] = number( input.value, position[ index ] );
			this.entities.updateSelected( { position } );

		} ) );
		this.inspector.querySelector( '[data-entity="rotation"]' ).addEventListener( 'change', ( event ) => this.entities.updateSelected( { rotationY: number( event.target.value ) * Math.PI / 180 } ) );
		this.inspector.querySelector( '[data-entity="scale"]' ).addEventListener( 'change', ( event ) => this.entities.updateSelected( { scale: Math.max( 0.05, number( event.target.value, 1 ) ) } ) );
		this.inspector.querySelector( '[data-entity="snap"]' ).addEventListener( 'change', ( event ) => this.entities.updateSelected( { snapToTerrain: event.target.checked } ) );
		this.inspector.querySelector( '[data-entity-action="move"]' ).addEventListener( 'click', () => {

			this.entityTool = 'move'; this.armedAsset = null; this.setStatus( '在地形上单击，为所选实体设置新位置', 'ok' );

		} );
		const syncCollider = () => {

			const size = [ ...colliderInputs ].map( ( input ) => Math.max( 0.05, number( input.value, 1 ) ) );
			const type = this.inspector.querySelector( '[data-collider="type"]' ).value;
			this.entities.updateSelected( { collider: {
				type, size, radius: size[ 0 ] * 0.5, height: size[ 1 ],
				offsetY: number( this.inspector.querySelector( '[data-collider="offset"]' ).value ),
				solid: this.inspector.querySelector( '[data-collider="solid"]' ).checked,
				walkable: type !== 'cylinder' && this.inspector.querySelector( '[data-collider="walkable"]' ).checked,
			} } );
		};
		for ( const input of this.inspector.querySelectorAll( '[data-collider]' ) ) input.addEventListener( 'change', syncCollider );

	}

	markDirty() {

		if ( this.loading ) return;
		this.dirty = true;
		this.root.classList.add( 'is-dirty' );

	}

	setStatus( message, state = 'ok' ) {

		this.statusText.textContent = message;
		this.statusElement.dataset.state = state;

	}

	buildDocument() {

		return createMapDocument( {
			name: this.nameInput.value.trim(), terrainPatches: this.tracker.serialize(),
			entities: this.entities.serializeEntities(), assets: this.entities.serializeAssets(), view: structuredClone( this.view ),
		} );

	}

	async saveLocal() {

		this.setStatus( '正在保存到浏览器…', 'busy' );
		await saveLocalDocument( this.buildDocument() );
		this.dirty = false; this.root.classList.remove( 'is-dirty' );
		this.setStatus( '已保存到浏览器', 'ok' );

	}

	async loadLocal() {

		this.setStatus( '正在读取浏览器存档…', 'busy' );
		const document = await loadLocalDocument();
		if ( ! document ) throw new Error( '浏览器里还没有地图存档。' );
		await this.loadDocument( validateMapDocument( document ) );

	}

	exportMap() {

		const mapDocument = this.buildDocument();
		const blob = new Blob( [ JSON.stringify( mapDocument ) ], { type: 'application/json' } );
		const url = URL.createObjectURL( blob );
		const anchor = document.createElement( 'a' );
		anchor.href = url; anchor.download = `${ fileName( mapDocument.name ) }.tidewater-map.json`;
		anchor.click();
		setTimeout( () => URL.revokeObjectURL( url ), 1000 );
		this.setStatus( `已导出地图 · ${ ( blob.size / 1024 ).toFixed( 0 ) } KB`, 'ok' );

	}

	async importMapFile( file ) {

		if ( ! file ) return;
		const document = validateMapDocument( JSON.parse( await file.text() ) );
		await this.loadDocument( document );
		this.root.querySelector( '.me-file-map' ).value = '';

	}

	async importAssetFile( file ) {

		if ( ! file ) return;
		this.setStatus( `正在导入 ${ file.name }…`, 'busy' );
		const asset = await this.entities.importAsset( file );
		this.armedAsset = asset.id;
		this.renderAssets();
		this.markDirty();
		this.setStatus( `模型已导入 · 单击地形放置“${ asset.name }”`, 'ok' );
		this.root.querySelector( '.me-file-asset' ).value = '';

	}

	async loadDocument( document ) {

		this.loading = true;
		this.setStatus( '正在载入地图与模型…', 'busy' );
		try {

			this.tracker.restoreBaseline();
			this.entities.clear();
			this.entities.resetImportedAssets();
			await this.entities.loadAssets( document.assets );
			this.tracker.apply( document.terrainPatches );
			this.gpu.updateHeightRegion( { x0: 0, y0: 0, x1: this.terrain.res - 1, y1: this.terrain.res - 1 } );
			this.terrain.buildMinMax();
			await this.terrainEditor.rebuildDerived();
			await this.rebuildVegetation();
			await this.entities.loadEntities( document.entities );
			this.nameInput.value = document.name || 'Untitled island';
			if ( document.view ) this.view = { ...this.view, ...document.view };
			this.terrainEditor.clearHistory();
			this.armedAsset = null;
			this.renderAssets(); this.renderEntities(); this.renderInspector();
			this.dirty = false; this.root.classList.remove( 'is-dirty' );
			this.setStatus( `地图已载入 · ${ document.entities.length } 个实体`, 'ok' );

		} finally { this.loading = false; }

	}

	async resetTerrain() {

		this.setStatus( '正在恢复程序化基础地形…', 'busy' );
		this.tracker.restoreBaseline();
		this.gpu.updateHeightRegion( { x0: 0, y0: 0, x1: this.terrain.res - 1, y1: this.terrain.res - 1 } );
		this.terrain.buildMinMax();
		this.terrainEditor.clearHistory();
		await this.terrainEditor.rebuildDerived();
		await this.rebuildVegetation();
		this.markDirty();
		this.setStatus( '地形修改已清除', 'ok' );

	}

	async rebuildShore() {

		this.setStatus( '正在根据新海岸线计算波浪传播…', 'busy' );
		await new Promise( ( resolve ) => requestAnimationFrame( () => setTimeout( resolve, 0 ) ) );
		const field = computeShoreField( this.terrain, { res: 512, swellDir: [ WORLD.swellDir.x, WORLD.swellDir.y ] } );
		this.app.shoreField = field;
		this.gpu.setShoreField( field );
		this.setStatus( '海岸波场已重建', 'ok' );

	}

	async rebuildVegetation() {

		this.setStatus( '正在根据草地、林地与雪地重新播种植被…', 'busy' );
		await new Promise( ( resolve ) => requestAnimationFrame( () => setTimeout( resolve, 0 ) ) );
		const previous = this.app.vegetation;
		const next = new Vegetation( { scene: this.app.scene, terrain: this.terrain, village: this.app.village } );
		useStaticVelocity( next.group );
		this.app.vegetation = next;
		previous?.dispose?.();
		this.setStatus( `植被已重建 · ${ next.records.trees.length } 棵林木`, 'ok' );

	}

	setPreview( enabled ) {

		this.preview = enabled;
		this.root.classList.toggle( 'is-preview', enabled );
		this.previewReturn.hidden = ! enabled;
		this.brushCursor.visible = false;
		this.app.input.enabled = enabled;
		window.__ui = enabled ? null : { get isPointerOverUI() { return true; } };
		if ( enabled ) {

			this.app.setFreeCam( false );
			this.app.input.requestLock();

		} else {

			document.exitPointerLock?.();
			this.app.setFreeCam( true );
			this.app.fly.enabled = false;
			this.app.input.enabled = false;

		}

	}

}
