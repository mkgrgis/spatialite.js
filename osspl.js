(async function downloadOsmRectToSqlite() {
  // --- CONFIG ---
  // Set bounding box [minLon, minLat, maxLon, maxLat]
  const bbox = [-0.15, 51.50, -0.10, 51.52]; // example: small area in London
  const overpassUrl = 'https://overpass-api.de/api/interpreter';
  const sqliteFileName = 'data.sqlite';
  const tagsFileName = 'tags.json';

  // --- LOAD DEPENDENCIES ---
  // sql.js (SQLite compiled to WASM)
  const SQL_JS_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/sql-wasm.js';
  // wkx for WKB from GeoJSON (uses UMD build)
  const WKX_CDN = 'https://cdn.jsdelivr.net/npm/wkx@0.5.0/dist/wkx.umd.min.js';

  await loadScript(SQL_JS_CDN);
  await loadScript(WKX_CDN);

  const initSqlJs = window.initSqlJs;
  if (!initSqlJs) throw new Error('initSqlJs not available');

  const SQL = await initSqlJs({ locateFile: file => file }); // uses default path to wasm in same CDN; should work

  // --- FETCH OSM VIA OVERPASS ---
  // Overpass query: fetch nodes, ways, relations in bbox (convert to JSON)
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
  const resp = await fetch(overpassUrl, {
    method: 'POST',
    body: query,
    headers: { 'Content-Type': 'text/plain' },
  });
  if (!resp.ok) throw new Error('Overpass request failed: ' + resp.statusText);
  const osmJson = await resp.json();

  // --- BUILD MAPS FOR OSM ELEMENTS ---
  const nodes = new Map(); // id -> {lat, lon, tags}
  const ways = new Map();  // id -> {nodes: [...nodeIds], tags}
  const relations = new Map(); // id -> {members: [...], tags}

  osmJson.elements.forEach(el => {
    if (el.type === 'node') nodes.set(el.id, { lat: el.lat, lon: el.lon, tags: el.tags || {} });
    else if (el.type === 'way') ways.set(el.id, { nodes: el.nodes || [], tags: el.tags || {} , geometry: el.geometry});
    else if (el.type === 'relation') relations.set(el.id, { members: el.members || [], tags: el.tags || {} , geometry: el.geometry});
  });

  // --- CONVERT OSM ELEMENTS TO GeoJSON FEATURES ---
  const features = [];
  function nodeToFeature(id, node) {
    return {
      type: 'Feature',
      id: `node/${id}`,
      geometry: { type: 'Point', coordinates: [node.lon, node.lat] },
      properties: { osm_type: 'node', osm_id: id, tags: node.tags || {} },
    };
  }
  function wayToFeature(id, way) {
    // If Overpass returned geometry use it; otherwise build from node map
    const coords = (way.geometry && way.geometry.length) ? way.geometry.map(p => [p.lon, p.lat])
      : way.nodes.map(nid => {
        const n = nodes.get(nid);
        return n ? [n.lon, n.lat] : null;
      }).filter(c => c !== null);
    // Determine if polygon (closed)
    const isClosed = coords.length >= 4 && coords[0][0] === coords[coords.length-1][0] && coords[0][1] === coords[coords.length-1][1];
    const geom = isClosed ? { type: 'Polygon', coordinates: [coords] } : { type: 'LineString', coordinates: coords };
    return {
      type: 'Feature',
      id: `way/${id}`,
      geometry: geom,
      properties: { osm_type: 'way', osm_id: id, tags: way.tags || {} },
    };
  }
  function relationToFeature(id, rel) {
    // Relations can be complex. We'll attempt simple multipolygon assembly if type=multipolygon, else keep as GeometryCollection of members' geometries.
    const tags = rel.tags || {};
    if (tags.type === 'multipolygon') {
      // collect member ways with role 'outer'/'inner'
      const outerRings = [];
      const innerRings = [];
      const members = rel.members || [];
      members.forEach(m => {
        if (m.type === 'way') {
          const w = ways.get(m.ref);
          if (!w) return;
          const coords = (w.geometry && w.geometry.length) ? w.geometry.map(p => [p.lon, p.lat])
            : w.nodes.map(nid => {
              const n = nodes.get(nid);
              return n ? [n.lon, n.lat] : null;
            }).filter(c => c !== null);
          if (coords.length >= 4) {
            if (m.role === 'inner') innerRings.push(coords);
            else outerRings.push(coords);
          }
        }
      });
      // naive pairing: take each outer and attach inner rings as available
      const polygons = outerRings.map(outer => {
        const rings = [outer];
        // attach all inner rings (not spatially tested)
        innerRings.forEach(inner => rings.push(inner));
        return rings;
      });
      const geom = polygons.length === 1 ? { type: 'Polygon', coordinates: polygons[0] } : { type: 'MultiPolygon', coordinates: polygons.map(p => [p]) };
      return { type: 'Feature', id: `relation/${id}`, geometry: geom, properties: { osm_type: 'relation', osm_id: id, tags } };
    } else {
      // fallback: collect member geometries into GeometryCollection
      const geoms = [];
      (rel.members || []).forEach(m => {
        if (m.type === 'node') {
          const n = nodes.get(m.ref); if (!n) return;
          geoms.push({ type: 'Point', coordinates: [n.lon, n.lat] });
        } else if (m.type === 'way') {
          const w = ways.get(m.ref); if (!w) return;
          const coords = (w.geometry && w.geometry.length) ? w.geometry.map(p => [p.lon, p.lat])
            : w.nodes.map(nid => { const n = nodes.get(nid); return n ? [n.lon, n.lat] : null; }).filter(c => c !== null);
          const isClosed = coords.length >= 4 && coords[0][0] === coords[coords.length-1][0] && coords[0][1] === coords[coords.length-1][1];
          geoms.push(isClosed ? { type: 'Polygon', coordinates: [coords] } : { type: 'LineString', coordinates: coords });
        }
      });
      const geom = { type: 'GeometryCollection', geometries: geoms };
      return { type: 'Feature', id: `relation/${id}`, geometry: geom, properties: { osm_type: 'relation', osm_id: id, tags } };
    }
  }

  // Convert all nodes, ways, relations to features
  for (const [id, node] of nodes) features.push(nodeToFeature(id, node));
  for (const [id, way] of ways) features.push(wayToFeature(id, way));
  for (const [id, rel] of relations) features.push(relationToFeature(id, rel));

  // --- Convert GeoJSON geometries to WKB using wkx ---
  const wkx = window.wkx;
  if (!wkx) throw new Error('wkx library not loaded');

  function geojsonToWkb(geom) {
    if (!geom) return new Uint8Array();
    // wkx expects WKB from GeoJSON-like objects mapped to its types
    try {
      const geomObj = wkx.Geometry.parseGeoJSON(geom);
      const wkb = geomObj.toWkb(); // Buffer (Node) or Uint8Array in browser
      return wkb;
    } catch (e) {
      // fallback: empty
      return new Uint8Array();
    }
  }

  // --- CREATE SQLITE DB and TABLE ---
  const db = new SQL.Database();
  // schema: features(id TEXT PRIMARY KEY, osm_type TEXT, osm_id INTEGER, geom_wkb BLOB, tags TEXT)
  db.run(`CREATE TABLE features (
    id TEXT PRIMARY KEY,
    osm_type TEXT,
    osm_id INTEGER,
    geom_wkb BLOB,
    tags TEXT
  );`);

  const insertStmt = db.prepare('INSERT INTO features (id, osm_type, osm_id, geom_wkb, tags) VALUES (?, ?, ?, ?, ?);');

  const tagsExport = [];

  // Insert features
  for (const feat of features) {
    const id = feat.id;
    const osmType = feat.properties && feat.properties.osm_type;
    const osmId = feat.properties && feat.properties.osm_id;
    const tags = feat.properties && feat.properties.tags ? feat.properties.tags : {};
    const wkb = geojsonToWkb(feat.geometry);
    // sql.js requires typed array for blobs
    insertStmt.run([id, osmType, osmId, wkb, JSON.stringify(tags)]);
    tagsExport.push({ id, type: osmType, osm_id: osmId, tags });
  }
  insertStmt.free();

  // --- EXPORT SQLITE FILE ---
  const binaryArray = db.export(); // Uint8Array
  const blob = new Blob([binaryArray], { type: 'application/x-sqlite3' });
  triggerDownload(blob, sqliteFileName);

  // --- EXPORT TAGS JSON ---
  const tagsBlob = new Blob([JSON.stringify(tagsExport, null, 2)], { type: 'application/json' });
  triggerDownload(tagsBlob, tagsFileName);

  console.log('Done: downloaded', sqliteFileName, 'and', tagsFileName);

  // --- Helper funcs ---
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) return resolve();
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => resolve();
      s.onerror = (e) => reject(new Error('Failed to load ' + src));
      document.head.appendChild(s);
    });
  }
  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 2000);
  }
})();
