"""Read-only decode QA of the downloaded official image assets (no edits)."""
from pathlib import Path
from PIL import Image
import hashlib
import json

root = Path(__file__).resolve().parents[2]
catalog = json.loads((root / 'catalog/products.json').read_text(encoding='utf-8'))
report_file = root / 'evidence/catalog' / catalog['imagesGeneratedAt'][:10] / 'images.verification.json'
report = json.loads(report_file.read_text(encoding='utf-8'))
errors = []
for entry in report['entries']:
    entry.pop('decoded', None)
    entry.pop('decodeError', None)
    try:
        path = root / report.get('assetDirectory', f"evidence/catalog/{catalog['imagesGeneratedAt'][:10]}/image-files") / entry['assetFile']
        assert hashlib.sha256(path.read_bytes()).hexdigest() == entry['record']['sha256']
        with Image.open(path) as image:
            image.verify()
        with Image.open(path) as image:
            image.load()
            assert image.width > 0 and image.height > 0
            entry['decoded'] = {'format': image.format, 'width': image.width, 'height': image.height, 'mode': image.mode}
    except Exception as exc:
        entry['decodeError'] = str(exc)
        errors.append(entry['imageKey'])
report['decodeVerified'] = not errors and len(report['entries']) == report['uniqueImages']
report_file.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps({'decoded': sum('decoded' in e for e in report['entries']), 'errors': errors, 'totalBytes': report['totalBytes']}, ensure_ascii=False))
raise SystemExit(1 if errors else 0)
