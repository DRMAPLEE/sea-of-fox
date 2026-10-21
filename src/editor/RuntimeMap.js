import { EntityManager } from './EntityManager.js';
import { TerrainPatchTracker, loadLocalDocument, validateMapDocument } from './MapDocument.js';

export async function loadRuntimeMapDocument( source ) {

	let value;
	if ( ! source || source === 'local' || source === 'autosave' ) value = await loadLocalDocument();
	else {

		const response = await fetch( source );
		if ( ! response.ok ) throw new Error( `地图下载失败：HTTP ${ response.status }` );
		value = await response.json();

	}
	if ( ! value ) throw new Error( '浏览器里还没有地图存档。' );
	return validateMapDocument( value );

}

export function applyRuntimeTerrain( terrain, document ) {

	const tracker = new TerrainPatchTracker( terrain );
	tracker.apply( document.terrainPatches );
	terrain.buildMinMax();
	return tracker;

}

export async function loadRuntimeEntities( app, document ) {

	const manager = new EntityManager( { app, interactive: false } );
	await manager.loadAssets( document.assets );
	await manager.loadEntities( document.entities );
	return manager;

}
