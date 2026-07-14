import pmtiles.reader
import json

reader = pmtiles.reader.Reader("optimal_bvmap-v1.pmtiles")
metadata = reader.metadata()

print(json.dumps(metadata, indent=2))