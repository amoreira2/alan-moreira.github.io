# Refresh piggybank/rates.json from FRED.
#
# Usage:  python3 update_rates.py path/to/rates.json
#
# Downloads FRED series DFF (daily effective federal funds rate, percent; no API key
# needed), compresses it to change points [date, rate] from 2025-01-01 on, and rewrites
# rates.json only when the data changed, so the daily GitHub Action commits nothing on
# days FRED has nothing new. Run daily by .github/workflows/piggybank-rates.yml (main branch).

import csv
import io
import json
import os
import sys
import urllib.request

path = sys.argv[1]

url = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DFF&cosd=2025-01-01"
raw = urllib.request.urlopen(url, timeout=60).read().decode("utf-8")

points, prev, last_obs = [], None, None
for row in csv.DictReader(io.StringIO(raw)):
    v = row["DFF"].strip()
    if v in ("", "."):          # FRED marks missing values with "."
        continue
    v = float(v)
    last_obs = row["observation_date"]
    if v != prev:
        points.append([row["observation_date"], v])
        prev = v
if not points:
    sys.exit("FRED returned no DFF observations; rates.json left unchanged.")

new = {"series": "DFF", "source": "FRED, Federal Reserve Bank of St. Louis",
       "lastObs": last_obs, "points": points}

old = None
if os.path.exists(path):
    with open(path) as f:
        old = json.load(f)
if old == new:
    print(f"No change: DFF through {last_obs} at {points[-1][1]:.2f}%.")
    sys.exit(0)

with open(path, "w") as f:
    json.dump(new, f, separators=(",", ":"))
    f.write("\n")
print(f"Updated: DFF through {last_obs} at {points[-1][1]:.2f}% ({len(points)} change points); "
      f"previously through {old['lastObs'] if old else 'none'}.")
