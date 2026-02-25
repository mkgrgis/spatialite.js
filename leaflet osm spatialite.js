import SPL from './dist/index.js';

const spl = await SPL();
var osm = {};

/*
// Convert GeoJSON geometry to WKT format
const geojsonToWKT = (geometry) => {
	const {
		type,
		coordinates
	} = geometry;

	switch (type) {
		case "Point":
			return `POINT(${coordinates[0]} ${coordinates[1]})`;

		case "LineString":
			return `LINESTRING(${coordinates.map(c => `${c[0]} ${c[1]}`).join(", ")})`;

		case "Polygon":
			return `POLYGON((${coordinates[0].map(c => `${c[0]} ${c[1]}`).join(", ")}))`;

		case "MultiPoint":
			return `MULTIPOINT(${coordinates.map(c => `${c[0]} ${c[1]}`).join(", ")})`;

		case "MultiLineString":
			return `MULTILINESTRING(${coordinates.map(line =>
		`(${line.map(c => `${c[0]} ${c[1]}`).join(", ")})`
	  ).join(", ")})`;

		case "MultiPolygon":
			return `MULTIPOLYGON(${coordinates.map(polygon =>
		`((${polygon[0].map(c => `${c[0]} ${c[1]}`).join(", ")}))`
	  ).join(", ")})`;

		default:
			throw new Error(`Unsupported geometry type: ${type}`);
	}
};*/


// Convert OSM element -> GeoJSON Feature
function nodeFeature(n) {
	return {
		type: 'Feature',
		geometry: {
			type: 'Point',
			coordinates: [n.lon, n.lat]
		},
		properties: {
			osm_type: 'node',
			osm_id: n.id,
			tags: n.tags || {}
		}
	};
}

function wayFeature(w, nodes) {
	const coords = (w.geometry && w.geometry.length) ? w.geometry.map(p => [p.lon, p.lat]) :
		(w.nodes || []).map(id => {
			const n = nodes.get(id);
			return n ? [n.lon, n.lat] : null;
		}).filter(Boolean);
	const isClosed = coords.length >= 4 && coords[0][0] === coords[coords.length - 1][0] && coords[0][1] === coords[coords.length - 1][1];
	const geom = isClosed ? {
		type: 'Polygon',
		coordinates: [coords]
	} : {
		type: 'LineString',
		coordinates: coords
	};
	return {
		type: 'Feature',
		geometry: geom,
		properties: {
			osm_type: 'way',
			osm_id: w.id,
			tags: w.tags || {}
		}
	};
}

function relationFeature(r, nodes, ways) {
	const tags = r.tags || {};
	if (tags.type === 'multipolygon') {
		const members = r.members || [];
		const outers = [],
			inners = [];
		members.forEach(m => {
			if (m.type === 'way') {
				const w = ways.get(m.ref);
				if (!w) return;
				const coords = (w.geometry && w.geometry.length) ? w.geometry.map(p => [p.lon, p.lat]) :
					(w.nodes || []).map(id => {
						const n = nodes.get(id);
						return n ? [n.lon, n.lat] : null;
					}).filter(Boolean);
				if (coords.length >= 4) {
					if (m.role === 'inner') inners.push(coords);
					else outers.push(coords);
				}
			}
		});
		// naive assembly: single polygon with all inners attached to first outer, or multipolygon
		if (outers.length === 0) {
			return {
				type: 'Feature',
				geometry: {
					type: 'GeometryCollection',
					geometries: []
				},
				properties: {
					osm_type: 'relation',
					osm_id: r.id,
					tags
				}
			};
		}
		if (outers.length === 1) {
			const rings = [outers[0], ...inners];
			return {
				type: 'Feature',
				geometry: {
					type: 'Polygon',
					coordinates: rings
				},
				properties: {
					osm_type: 'relation',
					osm_id: r.id,
					tags
				}
			};
		} else {
			const polygons = outers.map(o => [o]);
			return {
				type: 'Feature',
				geometry: {
					type: 'MultiPolygon',
					coordinates: polygons
				},
				properties: {
					osm_type: 'relation',
					osm_id: r.id,
					tags
				}
			};
		}
	} else {
		// fallback: collect member geometries
		const geoms = [];
		(r.members || []).forEach(m => {
			if (m.type === 'node') {
				const n = nodes.get(m.ref);
				if (n) geoms.push({
					type: 'Point',
					coordinates: [n.lon, n.lat]
				});
			} else if (m.type === 'way') {
				const w = ways.get(m.ref);
				if (w) {
					const coords = (w.geometry && w.geometry.length) ? w.geometry.map(p => [p.lon, p.lat]) :
						(w.nodes || []).map(id => {
							const n = nodes.get(id);
							return n ? [n.lon, n.lat] : null;
						}).filter(Boolean);
					const isClosed = coords.length >= 4 && coords[0][0] === coords[coords.length - 1][0] && coords[0][1] === coords[coords.length - 1][1];
					geoms.push(isClosed ? {
						type: 'Polygon',
						coordinates: [coords]
					} : {
						type: 'LineString',
						coordinates: coords
					});
				}
			}
		});
		return {
			type: 'Feature',
			geometry: {
				type: 'GeometryCollection',
				geometries: geoms
			},
			properties: {
				osm_type: 'relation',
				osm_id: r.id,
				tags
			}
		};
	}
}

getOsmData("https://www.openstreetmap.org/api/0.6/map.json?bbox=37.643548250198364,55.6185638959107,37.658751010894775,55.621895967699245");

async function getOsmData(url) {
	var nodes = new Map();
	var ways = new Map();
	var relations = new Map();

	let x = await fetch(url);
	osm = await x.json();

	osm.elements.forEach(e => {
		if (e.type === 'node') nodes.set(e.id, e);
		else if (e.type === 'way') ways.set(e.id, e);
		else if (e.type === 'relation') relations.set(e.id, e);
	});

	const features = [];
	for (const n of nodes.values()) features.push(nodeFeature(n));
	for (const w of ways.values()) features.push(wayFeature(w, nodes));
	for (const r of relations.values()) features.push(relationFeature(r, nodes, ways));

	await spl
		.fs.mount('proj', [
			// Mounts proj.db required for transformation of EPSG 27700 to 3857.
			// Instead of downloading the entire db spl/sqlite will only fetch required db pages.
			{
				name: 'proj.db',
				data: new URL(
					'dist/proj/proj.db',
					window.location.href,
				).toString(),
			},
		]);

	// Create an in-memory database
	const db = spl.db();
	const tn = "Объекты АП";
	await insertGeoJSONFeatures(db, tn, features);

	// db_save(db);

	/*/ Query results
	const q = `SELECT id, name, properties FROM "${tn}"`;
	const result = await db.exec(q).get.objs;
	console.log(result);*/
	// obj_1_group are already GeoJSON objects. No need for AsGeoJSON().
	const obj_1_group = await db.exec(`select geom geo1, id, t from "${tn}" where t->'tags' = '{}'`).get.objs;

	// obj_2_group are already GeoJSON objects. No need for AsGeoJSON().
	const obj_2_group = await db.exec(`select geom geo1, id, t from "${tn}" where t->'tags' != '{}'`).get.objs;


	document.querySelector('#progress').remove();

	const map = L.map('map').setView([0, 0], 2);

	// OSM tile layer
	L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
		attribution: '© OpenStreetMap contributors'
	}).addTo(map);

	// Create a GeoJSON layer and add it to the map
	const geojsonLayer_1 = L.geoJSON(
		// Build a GeoJSON FeatureCollection from your geometries array (assumes geometries are valid GeoJSON geometries)
		{
			type: 'FeatureCollection',
			features: obj_1_group.map(cortage => ({
				type: 'Feature',
				properties: {
					id: cortage.id
				},
				geometry: cortage.geo1
			}))
		}, {
			onEachFeature: function(feature, layer) {
				// Only attempt to display the properties if this feature has them
				if (feature.properties) {
					layer.bindPopup(`<strong>${feature.properties.id}</strong><br>${feature.properties.id}`);
				}
			}
		}).addTo(map);

	// Create a GeoJSON layer and add it to the map
	const geojsonLayer_2 = L.geoJSON(
		// Build a GeoJSON FeatureCollection from your geometries array (assumes geometries are valid GeoJSON geometries)
		{
			type: 'FeatureCollection',
			features: obj_2_group.map(cortage => ({
				type: 'Feature',
				properties: {
					id: cortage.id,
					t: JSON.stringify(cortage.t.tags)
				},
				geometry: cortage.geo1
			}))
		}, {
			onEachFeature: function(feature, layer) {
				// Only attempt to display the properties if this feature has them
				if (feature.properties) {
					layer.bindPopup(`<strong>${feature.properties.id}, ${feature.properties.t}</strong>`);
				}
			},
			style: {
				color: "#ff7800",
				weight: 3,
				opacity: 0.65,
				fillColor: "#ffff00",
				fillOpacity: 0.5
			}
		}).addTo(map);

	// Fit the map view to the GeoJSON layer bounds (if there are features)
	const bounds = geojsonLayer_1.getBounds();
	if (bounds.isValid()) {
		map.fitBounds(bounds);
	}

}

async function db_save (db){
  // Save the database to an ArrayBuffer
	const dbBuffer = await db.save();

	// Create a Blob from the ArrayBuffer
	const blob = new Blob([dbBuffer], {
		type: 'application/octet-stream'
	});

	// Create a download link
	const urldb = URL.createObjectURL(blob);
	const link = document.createElement('a');
	link.href = urldb;
	link.download = '1.db';

	// Trigger the download
	link.click();

	// Clean up
	URL.revokeObjectURL(urldb);
}

// Insert GeoJSON FeatureCollection into SpatiaLite table
const insertGeoJSONFeatures = async (db, tableName, features) => {
	try {

		// Create spatial table if it doesn't exist
		await db.exec(`
	  CREATE TABLE "${tableName}" (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		name TEXT,
		t TEXT,
		geom GEOMETRY
	  );

	  SELECT InitSpatialMetaData(1);
	  SELECT AddGeometryColumn('${tableName}', 'geom', 4326, 'GEOMETRY', 'XY');
	`);

		// Insert each feature as a separate row
		features.forEach((feature, index) => {
			if (feature.properties.osm_type == 'node' && Object.keys(feature.properties.tags).length === 0)
				return;

			// Prepare properties as JSON string
			const propertiesJson = JSON.stringify(feature.properties || {});


			var ia = [
				feature.properties.tags.name ?? `Гео_№_${index}`,
				propertiesJson,
				JSON.stringify(feature.geometry)
			];
			// Insert row
			db.exec(
				`INSERT INTO "${tableName}" (name, t, geom)
		 VALUES (?, ?, GeomFromGeoJSON(?))`, ia);
		});

		console.log(`✓ Inserted ${features.length} features into ${tableName}`);
		return true;
	} catch (error) {
		console.error("Insertion error:", error);
		return false;
	}
};
