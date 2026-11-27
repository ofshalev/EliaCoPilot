#!/usr/bin/env python3
"""Build one project-filtered GTFS snapshot from a local national archive."""
import argparse
import csv
import hashlib
import io
import json
import os
import sqlite3
import tempfile
import zipfile
from pathlib import Path

from shapely.geometry import Point, shape
from shapely.ops import unary_union
from shapely.prepared import prep

ROOT = Path(__file__).resolve().parents[1]
PROJECTS = {"P":"purple_line", "B":"brown_line", "G":"green_line",
            "M1":"rishon_metro", "M3":"holon_metro"}
# Explicit fields keep the database compact. All GTFS times remain text.
FIELDS = {
    "agency": ("agency_id","agency_name","agency_url","agency_timezone"),
    "stops": ("stop_id","stop_code","stop_name","stop_lat","stop_lon","location_type","parent_station"),
    "routes": ("route_id","agency_id","route_short_name","route_long_name","route_type","route_desc"),
    "trips": ("trip_id","route_id","service_id","shape_id","direction_id","trip_headsign"),
    "stop_times": ("trip_id","stop_sequence","stop_id","arrival_time","departure_time","pickup_type","drop_off_type","shape_dist_traveled","timepoint"),
    "calendar": ("service_id","monday","tuesday","wednesday","thursday","friday","saturday","sunday","start_date","end_date"),
    "calendar_dates": ("service_id","date","exception_type"),
    "shapes": ("shape_id","shape_pt_sequence","shape_pt_lat","shape_pt_lon","shape_dist_traveled"),
    "project_stops": ("project","stop_id"),
}
PRIMARY = {
    "agency":("agency_id",), "stops":("stop_id",), "routes":("route_id",),
    "trips":("trip_id",), "stop_times":("trip_id","stop_sequence"),
    "calendar":("service_id",), "calendar_dates":("service_id","date"),
    "shapes":("shape_id","shape_pt_sequence"), "project_stops":("project","stop_id"),
}
REQUIRED = {"agency","stops","routes","trips","stop_times"}
NUMERIC = {"stop_sequence","shape_pt_sequence","route_type","direction_id",
           "pickup_type","drop_off_type","location_type","timepoint","exception_type"}
FLOATS = {"stop_lat","stop_lon","shape_pt_lat","shape_pt_lon","shape_dist_traveled"}

def rows(archive, table):
    filename = table + ".txt"
    if filename not in archive.namelist():
        if table in REQUIRED:
            raise ValueError(f"Missing {filename}")
        return
    with archive.open(filename) as raw, io.TextIOWrapper(raw, encoding="utf-8-sig", newline="") as stream:
        reader = csv.DictReader(stream)
        if not set(PRIMARY[table]).issubset(reader.fieldnames or []):
            raise ValueError(f"Missing key fields in {filename}")
        for row in reader:
            yield row

def project_polygons():
    out = {}
    for code, basename in PROJECTS.items():
        obj = json.loads((ROOT/"data"/"geography"/(basename+"_buffer_1km.geojson")).read_text(encoding="utf-8"))
        geom = unary_union([shape(f["geometry"]) for f in obj["features"]])
        if geom.is_empty or not geom.is_valid:
            raise ValueError(f"Invalid project polygon: {code}")
        out[code] = (geom.bounds, prep(geom))
    return out

def member_ids(archive):
    polygons = project_polygons()
    result = []
    for r in rows(archive,"stops"):
        try:
            x,y = float(r["stop_lon"]),float(r["stop_lat"])
        except (KeyError, ValueError, TypeError):
            continue
        for code,(bounds,polygon) in polygons.items():
            a,b,c,d = bounds
            if a <= x <= c and b <= y <= d and polygon.covers(Point(x,y)):
                result.append((code,r["stop_id"]))
    if not result:
        raise ValueError("No stops inside any project polygon")
    return result

def extract(archive, db):
    membership = member_ids(archive)
    area_stops = {s for _,s in membership}
    selected = set()
    # First pass: collect trip identifiers touching any project stop.
    for r in rows(archive,"stop_times"):
        if r["stop_id"] in area_stops:
            selected.add(r["trip_id"])
    if not selected:
        raise ValueError("No trips visit the selected stops")
    # The national feed can have millions of rows. Keep selected rows in a
    # disk-backed SQLite staging database, not an in-memory dataframe.
    for name, fields in FIELDS.items():
        cols = ",".join(f'"{f}" TEXT' for f in fields)
        keys = ",".join(f'"{f}"' for f in PRIMARY[name])
        db.execute(f'CREATE TABLE "{name}" ({cols}, PRIMARY KEY ({keys}))')
    def put(name, iterable):
        fields = FIELDS[name]
        placeholders = ",".join("?" for _ in fields)
        db.executemany(f'INSERT INTO "{name}" VALUES ({placeholders})', iterable)
    def values(name,r):
        return tuple(r.get(f,"") or "" for f in FIELDS[name])
    put("project_stops", membership)
    route_ids,service_ids,shape_ids = set(),set(),set()
    def trips():
        for r in rows(archive,"trips"):
            if r["trip_id"] in selected:
                route_ids.add(r["route_id"])
                service_ids.add(r["service_id"])
                if r.get("shape_id"):
                    shape_ids.add(r["shape_id"])
                yield values("trips",r)
    put("trips",trips())
    if db.execute("SELECT count(*) FROM trips").fetchone()[0] != len(selected):
        raise ValueError("Selected stop_times reference missing trips")
    all_stops = set(area_stops)
    def stop_times():
        for r in rows(archive,"stop_times"):
            if r["trip_id"] in selected:
                all_stops.add(r["stop_id"])
                yield values("stop_times",r)
    put("stop_times",stop_times())
    # Preserve full sequences, not just stops inside the area.
    put("stops",(values("stops",r) for r in rows(archive,"stops") if r["stop_id"] in all_stops))
    agency_ids = set()
    def routes():
        for r in rows(archive,"routes"):
            if r["route_id"] in route_ids:
                agency_ids.add(r.get("agency_id",""))
                yield values("routes",r)
    put("routes",routes())
    put("agency",(values("agency",r) for r in rows(archive,"agency") if r.get("agency_id","") in agency_ids or not r.get("agency_id")))
    for name in ("calendar","calendar_dates"):
        put(name,(values(name,r) for r in rows(archive,name) if r["service_id"] in service_ids))
    put("shapes",(values("shapes",r) for r in rows(archive,"shapes") if r["shape_id"] in shape_ids))
    counts = {name:db.execute(f'SELECT count(*) FROM "{name}"').fetchone()[0] for name in FIELDS}
    if counts["stops"] != len(all_stops) or counts["routes"] != len(route_ids):
        raise ValueError("Missing referenced stops or routes")
    if counts["calendar"]+counts["calendar_dates"] == 0:
        raise ValueError("No service calendar records")
    # Check every trip has a calendar record (calendar_dates-only service is valid).
    missing = db.execute("SELECT count(*) FROM trips t WHERE NOT EXISTS (SELECT 1 FROM calendar c WHERE c.service_id=t.service_id) AND NOT EXISTS (SELECT 1 FROM calendar_dates c WHERE c.service_id=t.service_id)").fetchone()[0]
    if missing:
        raise ValueError(f"{missing} trips have no service calendar")
    project_counts = {code:db.execute("SELECT count(*) FROM project_stops WHERE project=?",(code,)).fetchone()[0] for code in PROJECTS}
    if not all(project_counts.values()):
        raise ValueError("At least one project has no stops; inspect polygons and feed")
    db.commit()
    return counts,project_counts

def publish(db, counts, project_counts, digest, source):
    import psycopg
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise ValueError("DATABASE_URL required to publish; use --dry-run for local validation")
    with psycopg.connect(url) as conn, conn.cursor() as cur:
        # One transaction, no changes to application tables or existing active
        # snapshot on failure. Prevent concurrent publishers.
        cur.execute("SELECT pg_advisory_xact_lock(77102601)")
        cur.execute("CREATE SCHEMA IF NOT EXISTS elia_gtfs")
        cur.execute("CREATE TABLE IF NOT EXISTS elia_gtfs.snapshot (singleton boolean PRIMARY KEY CHECK(singleton), imported_at timestamptz NOT NULL, source text NOT NULL, sha256 text NOT NULL, counts jsonb NOT NULL, project_counts jsonb NOT NULL)")
        for name, fields in FIELDS.items():
            cols = ",".join(f'"{f}" '+("integer" if f in NUMERIC else "double precision" if f in FLOATS else "text") for f in fields)
            keys = ",".join(f'"{f}"' for f in PRIMARY[name])
            cur.execute(f'CREATE TABLE IF NOT EXISTS elia_gtfs."{name}" ({cols}, PRIMARY KEY ({keys}))')
        cur.execute("TRUNCATE "+",".join(f'elia_gtfs."{name}"' for name in FIELDS))
        for name, fields in FIELDS.items():
            with cur.copy(f'COPY elia_gtfs."{name}" FROM STDIN') as copy:
                for row in db.execute(f'SELECT * FROM "{name}"'):
                    copy.write_row(tuple(None if v=="" and f in NUMERIC|FLOATS else v for f,v in zip(fields,row)))
        for table, col in (("stop_times","stop_id"),("trips","route_id"),("trips","service_id"),("project_stops","stop_id")):
            cur.execute(f'CREATE INDEX IF NOT EXISTS "idx_{table}_{col}" ON elia_gtfs."{table}" ("{col}")')
        cur.execute("INSERT INTO elia_gtfs.snapshot VALUES (true,now(),%s,%s,%s::jsonb,%s::jsonb) ON CONFLICT(singleton) DO UPDATE SET imported_at=excluded.imported_at,source=excluded.source,sha256=excluded.sha256,counts=excluded.counts,project_counts=excluded.project_counts",(source,digest,json.dumps(counts),json.dumps(project_counts)))

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--dry-run",action="store_true",help="Extract and count without touching Postgres")
    args = parser.parse_args()
    with args.archive.open("rb") as stream:
        hasher = hashlib.sha256()
        for chunk in iter(lambda: stream.read(1024*1024), b""):
            hasher.update(chunk)
        digest = hasher.hexdigest()
    with tempfile.TemporaryDirectory(prefix="elia-gtfs-") as directory, zipfile.ZipFile(args.archive) as archive:
        db = sqlite3.connect(str(Path(directory)/"snapshot.sqlite"))
        try:
            counts,project_counts=extract(archive,db)
            print(json.dumps({"sha256":digest,"counts":counts,"project_counts":project_counts},ensure_ascii=False),flush=True)
            if not args.dry_run:
                publish(db,counts,project_counts,digest,args.archive.name)
                print("Snapshot committed.",flush=True)
        finally:
            db.close()

if __name__=="__main__":
    main()
