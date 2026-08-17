#!/usr/bin/env python3
"""
route-from-track.py — turn a real recorded/exported track into ROUTE.line.

ROUTE.line drives three things: the drawn polyline, the map bounds, and the
precache corridor. Straight chords between hand-placed vertices make the map
lie about where the road goes, and make the corridor buffer cache the wrong
desert. This replaces that line with the geometry from an actual track export.

    python3 tools/route-from-track.py downloads/<file>.gpx

Accepts GPX (trkpt, else rtept, else wpt), KML (<coordinates>) and GeoJSON
(LineString / MultiLineString / Feature / FeatureCollection).

Rewrites route-data.js in place, and rewrites the <trkseg> in the GPX and the
<coordinates> of the LineString in the KML under downloads/ so the files the
app offers for download describe the same road as the map.
"""

import math
import re
import sys
import json
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# The map stops at z15, where a pixel is ~3.7 m at this latitude. Simplifying
# to 12 m keeps every bend that can be seen and still drops the GPS jitter that
# a phone-recorded track is full of.
TOLERANCE_M = 12.0


# ---------------------------------------------------------------- parsing

def _strip_ns(tag):
    return tag.rsplit("}", 1)[-1].lower()


def parse_gpx(text):
    root = ET.fromstring(text)
    for want in ("trkpt", "rtept", "wpt"):
        pts = [
            (float(el.get("lat")), float(el.get("lon")))
            for el in root.iter()
            if _strip_ns(el.tag) == want and el.get("lat") and el.get("lon")
        ]
        if len(pts) >= 2:
            return pts, want
    return [], None


def parse_kml(text):
    root = ET.fromstring(text)
    pts = []
    for el in root.iter():
        if _strip_ns(el.tag) != "coordinates" or not (el.text or "").strip():
            continue
        chunk = [
            (float(p[1]), float(p[0]))
            for tok in el.text.split()
            if len(p := tok.split(",")) >= 2
        ]
        # A KML export mixes Placemark pins (1 coord) with the LineString.
        if len(chunk) > len(pts):
            pts = chunk
    return pts, "coordinates"


def _coords_from_geometry(geom, out):
    kind = (geom or {}).get("type")
    if kind == "LineString":
        out.extend((c[1], c[0]) for c in geom["coordinates"])
    elif kind == "MultiLineString":
        for part in geom["coordinates"]:
            out.extend((c[1], c[0]) for c in part)


def parse_geojson(text):
    doc = json.loads(text)
    out = []
    if doc.get("type") == "FeatureCollection":
        for feat in doc["features"]:
            _coords_from_geometry(feat.get("geometry"), out)
    elif doc.get("type") == "Feature":
        _coords_from_geometry(doc.get("geometry"), out)
    else:
        _coords_from_geometry(doc, out)
    return out, "geojson"


def load_track(path):
    text = path.read_text(encoding="utf-8", errors="replace")
    suffix = path.suffix.lower()
    if suffix == ".gpx":
        return parse_gpx(text)
    if suffix == ".kml":
        return parse_kml(text)
    if suffix in (".json", ".geojson"):
        return parse_geojson(text)
    # Unknown extension: sniff it.
    head = text.lstrip()[:200].lower()
    if head.startswith("{"):
        return parse_geojson(text)
    if "<gpx" in head:
        return parse_gpx(text)
    if "<kml" in head:
        return parse_kml(text)
    raise SystemExit(f"Cannot tell what format {path.name} is.")


# ---------------------------------------------------------------- geometry

def haversine_m(a, b):
    R = 6371008.8
    r = math.pi / 180
    dlat = (b[0] - a[0]) * r
    dlng = (b[1] - a[1]) * r
    q = (math.sin(dlat / 2) ** 2
         + math.cos(a[0] * r) * math.cos(b[0] * r) * math.sin(dlng / 2) ** 2)
    return 2 * R * math.asin(math.sqrt(q))


def path_length_km(pts):
    return sum(haversine_m(pts[i], pts[i + 1]) for i in range(len(pts) - 1)) / 1000


def _perp_m(pt, start, end):
    """Perpendicular distance in metres, in a local flat projection.

    Over the few-km spans that survive to this point in the recursion the
    flat-earth error is far below the tolerance we compare against.
    """
    lat0 = math.radians((start[0] + end[0]) / 2)
    mx = 111320.0 * math.cos(lat0)
    my = 110540.0
    px, py = (pt[1] - start[1]) * mx, (pt[0] - start[0]) * my
    ex, ey = (end[1] - start[1]) * mx, (end[0] - start[0]) * my
    seg2 = ex * ex + ey * ey
    if seg2 == 0:
        return math.hypot(px, py)
    t = max(0.0, min(1.0, (px * ex + py * ey) / seg2))
    return math.hypot(px - t * ex, py - t * ey)


def simplify(pts, tol_m):
    """Douglas-Peucker, iterative so a 50k-point track cannot blow the stack."""
    if len(pts) < 3:
        return list(pts)
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        lo, hi = stack.pop()
        if hi - lo < 2:
            continue
        worst, worst_i = -1.0, -1
        for i in range(lo + 1, hi):
            d = _perp_m(pts[i], pts[lo], pts[hi])
            if d > worst:
                worst, worst_i = d, i
        if worst > tol_m:
            keep[worst_i] = True
            stack.append((lo, worst_i))
            stack.append((worst_i, hi))
    return [p for p, k in zip(pts, keep) if k]


def dedupe(pts):
    out = []
    for p in pts:
        if not out or haversine_m(out[-1], p) > 0.5:
            out.append(p)
    return out


# ---------------------------------------------------------------- emitting

def fmt_line(pts, per_row=5, indent="    "):
    """Match the existing hand-written formatting in route-data.js."""
    cells = [f"[{lat:.5f},{lng:.5f}]" for lat, lng in pts]
    rows = [",".join(cells[i:i + per_row]) for i in range(0, len(cells), per_row)]
    return ",\n".join(indent + r for r in rows)


def rewrite_route_data(pts, source_name):
    path = ROOT / "route-data.js"
    text = path.read_text(encoding="utf-8")
    block = re.compile(r"(\n  line: \[\n)(.*?)(\n  \]\n)", re.S)
    if not block.search(text):
        raise SystemExit("Could not find the `line: [ ... ]` block in route-data.js")
    note = (f"  /* Road geometry from {source_name}: {len(pts)} points, "
            f"{path_length_km(pts):,.0f} km driven distance.\n"
            f"     Regenerate with tools/route-from-track.py — do not hand-edit. */\n")
    text = block.sub(lambda m: m.group(1) + fmt_line(pts) + m.group(3), text, count=1)
    # Replace the old "coarse is fine" comment, which is no longer true.
    text = re.sub(
        r"  /\* Route shape\. Used to draw.*?\*/\n",
        "  /* Route shape. Used to draw the line AND to decide which tiles to cache. */\n" + note,
        text, count=1, flags=re.S)
    path.write_text(text, encoding="utf-8")
    return path


def rewrite_gpx_track(pts):
    path = ROOT / "downloads" / "dubai-salalah-route.gpx"
    if not path.exists():
        return None
    text = path.read_text(encoding="utf-8")
    body = "\n".join(f'      <trkpt lat="{lat:.5f}" lon="{lng:.5f}"/>' for lat, lng in pts)
    new, n = re.subn(r"<trkseg>.*?</trkseg>",
                     f"<trkseg>\n{body}\n    </trkseg>", text, count=1, flags=re.S)
    if not n:
        return None
    path.write_text(new, encoding="utf-8")
    return path


def rewrite_kml_track(pts):
    path = ROOT / "downloads" / "dubai-salalah-route.kml"
    if not path.exists():
        return None
    text = path.read_text(encoding="utf-8")
    body = " ".join(f"{lng:.5f},{lat:.5f},0" for lat, lng in pts)
    # Only the LineString's coordinates; Placemark pins keep their own.
    new, n = re.subn(r"(<LineString>.*?<coordinates>)(.*?)(</coordinates>)",
                     lambda m: m.group(1) + body + m.group(3), text, count=1, flags=re.S)
    if not n:
        return None
    path.write_text(new, encoding="utf-8")
    return path


# ---------------------------------------------------------------- main

def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    src = Path(sys.argv[1])
    if not src.is_absolute():
        src = (Path.cwd() / src).resolve()
    if not src.exists():
        raise SystemExit(f"No such file: {src}")
    tol = float(sys.argv[2]) if len(sys.argv) > 2 else TOLERANCE_M

    raw, kind = load_track(src)
    if len(raw) < 2:
        raise SystemExit(f"{src.name}: found no usable track geometry.")

    pts = dedupe(raw)
    simple = simplify(pts, tol)

    print(f"source      {src.name}  (<{kind}>)")
    print(f"raw points  {len(raw):,}  ->  {len(simple):,} after {tol:g} m simplify")
    print(f"length      {path_length_km(pts):,.1f} km raw / {path_length_km(simple):,.1f} km simplified")

    if len(simple) < 50:
        print("\n!! Only %d points survived. That is chord-shaped, not road-shaped." % len(simple))
        print("   The export probably holds waypoints, not a track. Not writing anything.")
        raise SystemExit(1)

    for p in (rewrite_route_data(simple, src.name),
              rewrite_gpx_track(simple),
              rewrite_kml_track(simple)):
        if p:
            print(f"wrote       {p.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
