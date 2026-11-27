# GTFS snapshot foundation

Official source: https://gtfs.mot.gov.il/gtfsfiles/israel-public-transportation.zip

Run the importer on a separate worker or a local machine, not inside the web request process. Python 3.10+; install shapely and psycopg[binary]. Supply DATABASE_URL securely, never commit it.

Selection: stops inside any of the five 1 km coverage polygons; select trips visiting these stops, retain their full stop sequences (including outside stops), routes, agencies, service calendars and relevant shapes. Membership is many-to-many. Routes which only cross a polygon without stopping are not included in this first phase. Preserve GTFS time strings including hours >=24 and blank times; no invented times. Future interpolation must distinguish estimates from published times.

Database tables are isolated in schema elia_gtfs. Each import is transactional; prior active snapshot remains available on failure. Do not schedule nightly imports until real-feed runtime and database footprint have been measured.

Phase 1 command (local archive, no download in application):
python tools/gtfs_snapshot.py /path/to/israel-public-transportation.zip

The web service exposes authenticated GET /api/gtfs/status. No automatic updater or route-detection interface is enabled yet.
