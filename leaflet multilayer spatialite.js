import SPL from './dist/index.js';

const spl = await SPL();

const db = await spl
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
    ])
    .fs.mount('data', [
        {
            name: 'ITA',
            data: new URL(
                'data/italia.db',
                window.location.href,
            ).toString(),
        },
    ])
    .db()
    .load('file:data/ITA?immutable=1').read(`
        -- select enablegpkgmode();
        -- select initspatialmetadata(1);
        select PROJ_SetDatabasePath('/proj/proj.db'); -- set proj.db path
    `);

// obj_1_group are already GeoJSON objects. No need for AsGeoJSON().
const obj_1_group = await db.exec('select transform(geometry, 4326) geo1, PK_UID id, ST_SRID(geometry) SRID from Railways where PK_UID <=50').get.objs;

// obj_2_group are already GeoJSON objects. No need for AsGeoJSON().
const obj_2_group = await db.exec('select transform(geometry, 4326) geo1, PK_UID id from Railways where PK_UID >50').get.objs;


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
            properties: {id: cortage.id, srid: cortage.SRID},
            geometry: cortage.geo1
        }))
    },
    {
        onEachFeature: function(feature, layer) {
            // Only attempt to display the properties if this feature has them
            if (feature.properties) {
                layer.bindPopup(`<strong>${feature.properties.id}</strong><br>${feature.properties.srid}`);
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
            properties: {id: cortage.id},
            geometry: cortage.geo1
        }))
    },
    {
        onEachFeature: function(feature, layer)
        {
            // Only attempt to display the properties if this feature has them
            if (feature.properties) {
                layer.bindPopup(`<strong>${feature.properties.id}</strong>`);
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
