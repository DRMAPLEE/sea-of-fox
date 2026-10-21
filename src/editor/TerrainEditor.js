const clamp = ( value, min, max ) => Math.max( min, Math.min( max, value ) );

const LAYERS = {
	'paint-rock': [ 'rock', 1 ],
	'paint-sand': [ 'sand', 255 ],
	'paint-path': [ 'path', 255 ],
	'paint-seagrass': [ 'seagrass', 255 ],
	'paint-rubble': [ 'rubble', 255 ],
	'paint-meadow': [ 'meadow', 255 ],
	'paint-forest': [ 'forest', 255 ],
	'paint-snow': [ 'snow', 255 ],
};

function emptyBounds() {

	return { x0: Infinity, y0: Infinity, x1: - Infinity, y1: - Infinity };

}

function include( bounds, i, j ) {

	bounds.x0 = Math.min( bounds.x0, i );
	bounds.y0 = Math.min( bounds.y0, j );
	bounds.x1 = Math.max( bounds.x1, i );
	bounds.y1 = Math.max( bounds.y1, j );

}

export class TerrainEditor {

	constructor( { terrain, gpu, tracker, onStatus = () => {}, onChange = () => {} } ) {

		this.terrain = terrain;
		this.gpu = gpu;
		this.tracker = tracker;
		this.onStatus = onStatus;
		this.onChange = onChange;
		this.tool = 'raise';
		this.radius = 18;
		this.strength = 0.65;
		this.targetHeight = 4;
		this.stroke = null;
		this.undoStack = [];
		this.redoStack = [];
		this._bakeTimer = 0;
		this._baking = false;
		this._bakeAgain = false;

	}

	beginStroke( x, z, inverse = false ) {

		if ( this.stroke ) this.endStroke();
		this.stroke = { tool: this.tool, inverse, changes: new Map(), bounds: emptyBounds(), lastX: x, lastZ: z };
		this.dab( x, z, inverse );

	}

	continueStroke( x, z, inverse = false ) {

		const stroke = this.stroke;
		if ( ! stroke ) return;
		const dx = x - stroke.lastX, dz = z - stroke.lastZ;
		const distance = Math.hypot( dx, dz );
		const spacing = Math.max( 0.75, this.radius * 0.22 );
		const steps = Math.max( 1, Math.ceil( distance / spacing ) );
		for ( let i = 1; i <= steps; i ++ ) this.dab( stroke.lastX + dx * i / steps, stroke.lastZ + dz * i / steps, inverse );
		stroke.lastX = x;
		stroke.lastZ = z;

	}

	endStroke() {

		const stroke = this.stroke;
		this.stroke = null;
		if ( ! stroke || ! stroke.changes.size ) return false;
		const changes = [ ...stroke.changes.values() ];
		for ( const change of changes ) change.after = this.terrain[ change.channel ][ change.index ];
		this.undoStack.push( { changes, bounds: stroke.bounds, label: stroke.tool } );
		if ( this.undoStack.length > 80 ) this.undoStack.shift();
		this.redoStack.length = 0;
		this.terrain.buildMinMax();
		this.scheduleDerivedBake();
		this.onChange();
		return true;

	}

	dab( x, z, inverse = false ) {

		const t = this.terrain;
		const radius = Math.max( t.texel, this.radius );
		const i0 = clamp( Math.floor( ( x - radius - t.origin ) / t.texel ), 1, t.res - 2 );
		const i1 = clamp( Math.ceil( ( x + radius - t.origin ) / t.texel ), 1, t.res - 2 );
		const j0 = clamp( Math.floor( ( z - radius - t.origin ) / t.texel ), 1, t.res - 2 );
		const j1 = clamp( Math.ceil( ( z + radius - t.origin ) / t.texel ), 1, t.res - 2 );
		const layer = LAYERS[ this.tool ];
		for ( let j = j0; j <= j1; j ++ ) for ( let i = i0; i <= i1; i ++ ) {

			const px = t.origin + ( i + 0.5 ) * t.texel;
			const pz = t.origin + ( j + 0.5 ) * t.texel;
			const d = Math.hypot( px - x, pz - z );
			if ( d > radius ) continue;
			const u = 1 - d / radius;
			const falloff = u * u * ( 3 - 2 * u );
			const index = j * t.res + i;
			if ( layer ) this._paint( layer[ 0 ], index, layer[ 1 ], falloff, inverse, i, j );
			else this._sculpt( index, falloff, inverse, i, j );

		}
		if ( ! layer ) this.gpu.updateHeightRegion( { x0: i0, y0: j0, x1: i1, y1: j1 } );

	}

	_sculpt( index, falloff, inverse, i, j ) {

		const H = this.terrain.heights;
		this._remember( 'heights', index, H[ index ], i, j );
		const amount = this.strength * falloff;
		if ( this.tool === 'smooth' ) {

			const r = this.terrain.res;
			const average = ( H[ index - 1 ] + H[ index + 1 ] + H[ index - r ] + H[ index + r ] + H[ index ] * 2 ) / 6;
			H[ index ] += ( average - H[ index ] ) * clamp( amount * 0.35, 0, 0.9 );

		} else if ( this.tool === 'flatten' ) {

			H[ index ] += ( this.targetHeight - H[ index ] ) * clamp( amount * 0.18, 0, 0.85 );

		} else {

			let direction = this.tool === 'lower' ? - 1 : 1;
			if ( inverse ) direction *= - 1;
			H[ index ] = clamp( H[ index ] + direction * amount, - 90, 320 );

		}

	}

	_paint( channel, index, target, falloff, inverse, i, j ) {

		const array = this.terrain[ channel ];
		this._remember( channel, index, array[ index ], i, j );
		const max = array instanceof Float32Array ? 1 : 255;
		const goal = inverse ? 0 : target;
		const alpha = clamp( this.strength * 0.22 * falloff, 0, 0.9 );
		const next = array[ index ] + ( goal - array[ index ] ) * alpha;
		array[ index ] = array instanceof Float32Array ? clamp( next, 0, max ) : Math.round( clamp( next, 0, max ) );

	}

	_remember( channel, index, value, i, j ) {

		const stroke = this.stroke;
		if ( ! stroke ) return;
		const key = `${ channel }:${ index }`;
		if ( ! stroke.changes.has( key ) ) stroke.changes.set( key, { channel, index, before: value, after: value } );
		this.tracker.recordOriginal( channel, index, value );
		include( stroke.bounds, i, j );

	}

	undo() {

		this.endStroke();
		const action = this.undoStack.pop();
		if ( ! action ) return false;
		this._applyHistory( action, 'before' );
		this.redoStack.push( action );
		this.onChange();
		return true;

	}

	redo() {

		this.endStroke();
		const action = this.redoStack.pop();
		if ( ! action ) return false;
		this._applyHistory( action, 'after' );
		this.undoStack.push( action );
		this.onChange();
		return true;

	}

	_applyHistory( action, field ) {

		let touchedHeight = false;
		for ( const change of action.changes ) {

			this.terrain[ change.channel ][ change.index ] = change[ field ];
			if ( change.channel === 'heights' ) touchedHeight = true;

		}
		if ( touchedHeight ) this.gpu.updateHeightRegion( action.bounds );
		this.terrain.buildMinMax();
		this.scheduleDerivedBake();

	}

	clearHistory() {

		this.stroke = null;
		this.undoStack.length = 0;
		this.redoStack.length = 0;

	}

	scheduleDerivedBake( delay = 120 ) {

		clearTimeout( this._bakeTimer );
		this._bakeTimer = setTimeout( () => this.rebuildDerived(), delay );

	}

	async rebuildDerived() {

		if ( this._baking ) { this._bakeAgain = true; return; }
		this._baking = true;
		this.onStatus( '正在重建地形光照与材质…', 'busy' );
		await new Promise( ( resolve ) => requestAnimationFrame( () => setTimeout( resolve, 0 ) ) );
		try {

			const timings = this.gpu.rebuildDerived();
			this.onStatus( `地形已同步 · ${ Math.round( ( timings.ao || 0 ) + ( timings.maps || 0 ) ) } ms`, 'ok' );

		} finally {

			this._baking = false;
			if ( this._bakeAgain ) { this._bakeAgain = false; this.scheduleDerivedBake( 40 ); }

		}

	}

}
