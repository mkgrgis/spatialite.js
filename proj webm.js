<!-- Include dependencies -->
<script src="https://unpkg.com/proj4@2.8.0/dist/proj4.js"></script>
<script src="https://unpkg.com/@ngageoint/geopackage/dist/geopackage.min.js"></script>

<script>
(async function osmToGpkg3857WithTiles(){
  // CONFIG
  const bbox4326 = [-0.15, 51.50, -0.10, 51.52]; // [minLon,minLat,maxLon,maxLat] in EPSG:4326
  const overpassUrl = 'https://overpass-api.de/api/interpreter';
  const outFile = 'osm_3857_tiles.gpkg';
  const featureTableName = 'osm_features_3857';
  const tileTableName = 'osm_tiles';
  const tileZoomMin = 10; // adjust
  const tileZoomMax = 12; // adjust; keep small for browser
  // set proj4 defs (EPSG:3857 already built-in in proj4 as 'EPSG:3857')
  const fromProj = 'EPSG:4326';
  const toProj = 'EPSG:3857';

  // Ensure GeoPackage finds sql-wasm.wasm via CDN
  const { setSqljsWasmLocateFile, GeoPackageManager } = window.GeoPackage;
  if (setSqljsWasmLocateFile) setSqljsWasmLocateFile(f => `https://unpkg.com/sql.js@1.8.0/dist/${f}`);

  // 1) Fetch OSM via Overpass
  const bboxStr = `${bbox4326[1]},${bbox4326[0]},${bbox4326[3]},${bbox4326[2]}`;
  const query = `[out:json][timeout:180];(node(${bboxStr});way(${bboxStr});relation(${bboxStr}););out body geom;`;
  const resp = await fetch(overpassUrl, { method:'POST', body:query, headers:{'Content-Type':'text/plain'} });
  if (!resp.ok) throw new Error('Overpass error '+resp.status);
  const osm = await resp.json();

  // 2) Build element maps
  const nodes = new Map(), ways = new Map(), relations = new Map();
  osm.elements.forEach(e => {
    if (e.type==='node') nodes.set(e.id, e);
    else if (e.type==='way') ways.set(e.id, e);
    else if (e.type==='relation') relations.set(e.id, e);
  });

  // 3) Convert to GeoJSON features in 4326, then reproject to 3857
  function nodeFeature(n){ return { type:'Feature', geometry:{type:'Point', coordinates:[n.lon,n.lat]}, properties:{osm_type:'node',osm_id:n.id,tags:n.tags||{}} }; }
  function wayFeature(w){
    const coords = (w.geometry && w.geometry.length) ? w.geometry.map(p=>[p.lon,p.lat]) :
      (w.nodes||[]).map(id => { const n = nodes.get(id); return n ? [n.lon,n.lat] : null; }).filter(Boolean);
    const isClosed = coords.length>=4 && coords[0][0]===coords[coords.length-1][0] && coords[0][1]===coords[coords.length-1][1];
    const geom = isClosed ? { type:'Polygon', coordinates:[coords] } : { type:'LineString', coordinates:coords };
    return { type:'Feature', geometry:geom, properties:{osm_type:'way',osm_id:w.id,tags:w.tags||{}} };
  }
  function relationFeature(r){
    const tags = r.tags||{};
    if (tags.type==='multipolygon'){
      const members = r.members||[]; const outers=[], inners=[];
      members.forEach(m => {
        if (m.type==='way'){
          const w = ways.get(m.ref); if(!w) return;
          const coords = (w.geometry && w.geometry.length) ? w.geometry.map(p=>[p.lon,p.lat]) :
            (w.nodes||[]).map(id=>{ const n=nodes.get(id); return n?[n.lon,n.lat]:null; }).filter(Boolean);
          if (coords.length>=4) (m.role==='inner'?inners:outers).push(coords);
        }
      });
      if (outers.length===1) return { type:'Feature', geometry:{type:'Polygon', coordinates:[outers[0], ...inners]}, properties:{osm_type:'relation',osm_id:r.id,tags} };
      if (outers.length>1) return { type:'Feature', geometry:{type:'MultiPolygon', coordinates:outers.map(o=>[o])}, properties:{osm_type:'relation',osm_id:r.id,tags} };
    }
    // fallback: geometry collection
    const geoms=[];
    (r.members||[]).forEach(m=>{
      if (m.type==='node'){ const n=nodes.get(m.ref); if(n) geoms.push({type:'Point',coordinates:[n.lon,n.lat]}); }
      else if (m.type==='way'){ const w=ways.get(m.ref); if(w){
        const coords = (w.geometry && w.geometry.length) ? w.geometry.map(p=>[p.lon,p.lat]) :
          (w.nodes||[]).map(id=>{ const n=nodes.get(id); return n?[n.lon,n.lat]:null; }).filter(Boolean);
        const isClosed = coords.length>=4 && coords[0][0]===coords[coords.length-1][0] && coords[0][1]===coords[coords.length-1][1];
        geoms.push(isClosed?{type:'Polygon',coordinates:[coords]}:{type:'LineString',coordinates:coords});
      }}
    });
    return { type:'Feature', geometry:{type:'GeometryCollection',geometries:geoms}, properties:{osm_type:'relation',osm_id:r.id,tags: r.tags||{}} };
  }

  const features4326 = [];
  for (const n of nodes.values()) features4326.push(nodeFeature(n));
  for (const w of ways.values()) features4326.push(wayFeature(w));
  for (const r of relations.values()) features4326.push(relationFeature(r));

  // Reproject coordinates to 3857
  function reprojectGeometry(geom){
    if (!geom) return geom;
    const proj = window.proj4;
    if (!proj) throw new Error('proj4 not loaded');
    function projCoord([lon,lat]){ return proj(fromProj, toProj, [lon, lat]); }
    if (geom.type==='Point') return { type:'Point', coordinates: projCoord(geom.coordinates) };
    if (geom.type==='LineString') return { type:'LineString', coordinates: geom.coordinates.map(projCoord) };
    if (geom.type==='Polygon') return { type:'Polygon', coordinates: geom.coordinates.map(r => r.map(projCoord)) };
    if (geom.type==='MultiPolygon') return { type:'MultiPolygon', coordinates: geom.coordinates.map(poly => poly.map(r => r.map(projCoord))) };
    if (geom.type==='GeometryCollection') return { type:'GeometryCollection', geometries: geom.geometries.map(g=>reprojectGeometry(g)) };
    return geom;
  }
  const features3857 = features4326.map(f => ({ type:'Feature', geometry: reprojectGeometry(f.geometry), properties: f.properties }));

  // 4) Create GeoPackage (in-memory) and add feature table using EPSG:3857
  const gpkgBytes = await GeoPackageManager.create('in-memory.gpkg');
  const gpkg = await GeoPackageManager.open(gpkgBytes);

  // Create feature table from GeoJSON FeatureCollection (note: createFeatureTableWithGeoJSON expects features in same CRS as desired SRID)
  const featureCollection3857 = { type:'FeatureCollection', features: features3857 };
  await gpkg.createFeatureTableWithGeoJSON(featureTableName, featureCollection3857, { srid:3857, geometryColumn: 'geom' });

  // 5) Create tile table and tiles covering bbox in EPSG:3857
  // Convert bbox4326 to bbox3857 for tile bounds
  const proj = window.proj4;
  const min = proj(fromProj, toProj, [bbox4326[0], bbox4326[1]]);
  const max = proj(fromProj, toProj, [bbox4326[2], bbox4326[3]]);
  const bbox3857 = [min[0], min[1], max[0], max[1]]; // [minX,minY,maxX,maxY]

  // Use library FeatureTiles to draw tiles; set up tile table
  const { TileBoundingBoxUtils, TileDao, GeoPackageTile, TileMatrix, TileMatrixSet, TileMatrixDao } = window.GeoPackage;

  // Create tile table with WebMercator bounds (will be populated per zoom)
  // Use GeoPackage API: createTileTableWithTableName
  // Provide tile matrix set and initial matrix entries for zooms
  // Calculate tile matrix set for EPSG:3857 using standard web mercator tile calculations
  function resolutionForZoom(z){ return 156543.03392804062 / Math.pow(2, z); } // meters per pixel at equator for 256px tiles
  // Create tile table
  await gpkg.createTileTable(tileTableName, { srs_id:3857, tile_table: tileTableName });

  // For each zoom, compute tile x/y ranges covering bbox3857 and render tiles
  // Helpers to convert between meters and XYZ tile coords
  function metersToTileXY(mx, my, z){
    const tileSize = 256;
    const initialResolution = 2 * Math.PI * 6378137 / tileSize;
    const originShift = 2 * Math.PI * 6378137 / 2.0;
    const res = initialResolution / Math.pow(2, z);
    const px = (mx + originShift) / res;
    const py = (originShift - my) / res;
    const tx = Math.floor(px / tileSize);
    const ty = Math.floor(py / tileSize);
    return [tx, ty];
  }
  function tileBoundsMeters(tx, ty, z){
    const tileSize = 256;
    const initialResolution = 2 * Math.PI * 6378137 / tileSize;
    const originShift = 2 * Math.PI * 6378137 / 2.0;
    const res = initialResolution / Math.pow(2, z);
    const minx = tx * tileSize * res - originShift;
    const maxx = (tx+1) * tileSize * res - originShift;
    const miny = originShift - (ty+1) * tileSize * res;
    const maxy = originShift - ty * tileSize * res;
    return [minx, miny, maxx, maxy];
  }

  // Prepare FeatureTiles renderer
  const featureDao = gpkg.getFeatureDao(featureTableName);
  const FeatureTiles = window.GeoPackage.FeatureTiles;
  const featureTiles = new FeatureTiles(gpkg, featureDao);

  // Create tileDao
  const tileDao = await gpkg.createTileDao(tileTableName, 3857);

  for (let z = tileZoomMin; z <= tileZoomMax; z++){
    // compute tile x/y covering bbox3857
    const [txMin, tyMax] = metersToTileXY(bbox3857[0], bbox3857[1], z); // minx,miny => txMin, tyMax?
    const [txMax, tyMin] = metersToTileXY(bbox3857[2], bbox3857[3], z);
    const tx0 = Math.min(txMin, txMax), tx1 = Math.max(txMin, txMax);
    const ty0 = Math.min(tyMin, tyMax), ty1 = Math.max(tyMin, tyMax);
    for (let tx = tx0; tx <= tx1; tx++){
      for (let ty = ty0; ty <= ty1; ty++){
        try {
          // Draw tile image for this x,y,z using FeatureTiles; it returns a GeoPackageImage
          const img = await featureTiles.drawTile(tx, ty, z, { width:256, height:256, background: 'rgba(255,255,255,0)' });
          // Get PNG data URL from canvas
          const canvas = img.getImage();
          // Convert canvas to blob (png)
          const dataUrl = canvas.toDataURL('image/png');
          // Convert base64 to Uint8Array
          const base64 = dataUrl.split(',')[1];
          const binary = atob(base64);
          const len = binary.length; const bytes = new Uint8Array(len);
          for (let i=0;i<len;i++) bytes[i]=binary.charCodeAt(i);
          // Insert tile into tileDao
          await tileDao.createTile(tx, ty, z, bytes);
          // dispose canvas if needed
          if (window.GeoPackage.Canvas && window.GeoPackage.Canvas.disposeImage) window.GeoPackage.Canvas.disposeImage(img);
        } catch (e){
          // ignore tiles with no features or rendering errors
          console.warn('tile render error', z, tx, ty, e && e.message);
        }
      }
    }
  }

  // 6) Export and download geopackage
  const exported = gpkg.getDatabase(); // Uint8Array
  const blob = new Blob([exported], { type:'application/geopackage+sqlite3' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = outFile; document.body.appendChild(a); a.click();
  setTimeout(()=>{ URL.revokeObjectURL(url); a.remove(); }, 2000);

  console.log('Done:', outFile);
})();
</script>
