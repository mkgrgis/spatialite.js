<!-- Include these scripts in your page head (CDNs) -->
<script src="https://unpkg.com/@ngageoint/geopackage/dist/geopackage.min.js"></script>
<script>
(async function createGpkgFromOsmBBox(){
  // CONFIG
  const bbox = [-0.15,51.50,-0.10,51.52]; // [minLon,minLat,maxLon,maxLat]
  const overpassUrl = 'https://overpass-api.de/api/interpreter';
  const outFileName = 'osm_extract.gpkg';

  // Ensure geopackage finds sql-wasm.wasm in same origin path or CDN; override if needed:
  if (window.GeoPackage && window.GeoPackage.setSqljsWasmLocateFile) {
    window.GeoPackage.setSqljsWasmLocateFile(name => `https://unpkg.com/sql.js@1.8.0/dist/${name}`);
  }

  // Helper: fetch OSM JSON via Overpass
  const bboxStr = `${bbox[1]},${bbox[0]},${bbox[3]},${bbox[2]}`; // south,west,north,east
  const query = `
    [out:json][timeout:180];
    (
      node(${bboxStr});
      way(${bboxStr});
      relation(${bboxStr});
    );
    out body geom;
  `;
  const resp = await fetch(overpassUrl, { method: 'POST', body: query, headers: {'Content-Type':'text/plain'} });
  if (!resp.ok) throw new Error('Overpass failed: '+resp.status);
  const osm = await resp.json();

  // Build node/way/relation maps
  const nodes = new Map();
  const ways = new Map();
  const relations = new Map();
  osm.elements.forEach(e=>{
    if (e.type==='node') nodes.set(e.id, e);
    else if (e.type==='way') ways.set(e.id, e);
    else if (e.type==='relation') relations.set(e.id, e);
  });

  // Convert OSM element -> GeoJSON Feature
  function nodeFeature(n){
    return { type:'Feature', geometry:{type:'Point', coordinates:[n.lon,n.lat]}, properties:{osm_type:'node',osm_id:n.id,tags:n.tags||{}} };
  }
  function wayFeature(w){
    const coords = (w.geometry && w.geometry.length) ? w.geometry.map(p=>[p.lon,p.lat]) :
      (w.nodes||[]).map(id=>{ const n=nodes.get(id); return n?[n.lon,n.lat]:null; }).filter(Boolean);
    const isClosed = coords.length>=4 && coords[0][0]===coords[coords.length-1][0] && coords[0][1]===coords[coords.length-1][1];
    const geom = isClosed ? {type:'Polygon', coordinates:[coords]} : {type:'LineString', coordinates:coords};
    return { type:'Feature', geometry:geom, properties:{osm_type:'way',osm_id:w.id,tags:w.tags||{}} };
  }
  function relationFeature(r){
    const tags = r.tags||{};
    if (tags.type==='multipolygon'){
      const members = r.members||[];
      const outers=[], inners=[];
      members.forEach(m=>{
        if (m.type==='way'){
          const w = ways.get(m.ref);
          if (!w) return;
          const coords = (w.geometry && w.geometry.length) ? w.geometry.map(p=>[p.lon,p.lat]) :
            (w.nodes||[]).map(id=>{ const n=nodes.get(id); return n?[n.lon,n.lat]:null; }).filter(Boolean);
          if (coords.length>=4){
            if (m.role==='inner') inners.push(coords); else outers.push(coords);
          }
        }
      });
      // naive assembly: single polygon with all inners attached to first outer, or multipolygon
      if (outers.length===0){
        return { type:'Feature', geometry:{type:'GeometryCollection', geometries:[]}, properties:{osm_type:'relation',osm_id:r.id,tags}};
      }
      if (outers.length===1){
        const rings = [outers[0], ...inners];
        return { type:'Feature', geometry:{type:'Polygon', coordinates:rings}, properties:{osm_type:'relation',osm_id:r.id,tags} };
      } else {
        const polygons = outers.map(o => [o]);
        return { type:'Feature', geometry:{type:'MultiPolygon', coordinates:polygons}, properties:{osm_type:'relation',osm_id:r.id,tags} };
      }
    } else {
      // fallback: collect member geometries
      const geoms = [];
      (r.members||[]).forEach(m=>{
        if (m.type==='node'){ const n=nodes.get(m.ref); if(n) geoms.push({type:'Point',coordinates:[n.lon,n.lat]}); }
        else if (m.type==='way'){ const w=ways.get(m.ref); if(w){
          const coords = (w.geometry && w.geometry.length) ? w.geometry.map(p=>[p.lon,p.lat]) :
            (w.nodes||[]).map(id=>{ const n=nodes.get(id); return n?[n.lon,n.lat]:null; }).filter(Boolean);
          const isClosed = coords.length>=4 && coords[0][0]===coords[coords.length-1][0] && coords[0][1]===coords[coords.length-1][1];
          geoms.push(isClosed?{type:'Polygon',coordinates:[coords]}:{type:'LineString',coordinates:coords});
        }}
      });
      return { type:'Feature', geometry:{type:'GeometryCollection', geometries:geoms}, properties:{osm_type:'relation',osm_id:r.id,tags} };
    }
  }

  const features = [];
  for (const n of nodes.values()) features.push(nodeFeature(n));
  for (const w of ways.values()) features.push(wayFeature(w));
  for (const r of relations.values()) features.push(relationFeature(r));

  // Create GeoPackage and write features
  const { GeoPackageManager, GeoPackage } = window.GeoPackage;
  if (!GeoPackageManager) throw new Error('GeoPackage library not loaded');

  // create an empty geopackage in memory
  const gpkgBytes = await GeoPackageManager.create('in-memory.gpkg'); // returns byte array
  const gpkg = await GeoPackageManager.open(gpkgBytes);

  // Create feature table: name it 'osm_features'
  const tableName = 'osm_features';
  // Determine a simple schema: id INTEGER PRIMARY KEY, properties JSON stored as 'properties' TEXT, plus tags fields could be expanded; we'll store tags as JSON in 'tags' column.
  // Use GeoPackageManager/GeoPackage API to create a feature table from GeoJSON features.
  // Build a GeoJSON FeatureCollection for convenience
  const featureCollection = { type:'FeatureCollection', features };
  // Use geopackage-js helper to create feature table from GeoJSON
  await gpkg.createFeatureTableWithGeoJSON(tableName, featureCollection, { srid:4326, geometryColumn: 'geom' });

  // Optional: set contents metadata (gpkg_contents entry is created by library)
  // Export geopackage bytes and trigger download
  const exported = gpkg.getDatabase(); // Uint8Array
  const blob = new Blob([exported], { type:'application/geopackage+sqlite3' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = outFileName; document.body.appendChild(a);
  a.click();
  setTimeout(()=>{ URL.revokeObjectURL(url); a.remove(); }, 2000);

  console.log('GeoPackage created:', outFileName);
})();
</script>
