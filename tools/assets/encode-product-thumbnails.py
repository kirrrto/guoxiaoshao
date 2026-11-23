"""Deterministic resize/encode of verified Apple originals. No generated artwork.

Packaged images must decode on phones, not only in DevTools. WeChat documents
the <image webp> switch for network resources only, and v3.3.1 packaged WebP
rendered in DevTools but failed in phone previews. Opaque originals therefore
ship as baseline JPEG and transparent originals as 256-colour PNG with alpha.
"""
from pathlib import Path
from datetime import datetime, timezone
from PIL import Image, ImageChops, ImageOps, ImageStat
import hashlib
import io
import json
import sys

plan = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
root = Path(plan['root'])
policy = json.loads((root / 'config/product-image-policy.json').read_text(encoding='utf-8'))
assert plan['policy'] == policy, 'thumbnail_policy_changed'
assert plan['entries'], 'empty_thumbnail_sample'
asset_dir = root / 'miniprogram/images/products'
asset_dir.mkdir(parents=True, exist_ok=True)
digest = lambda data: hashlib.sha256(data).hexdigest()
mapping = {'assets': [], 'byPart': {}}
JPEG_QUALITY, PNG_COLORS = policy['jpegQuality'], policy['pngColors']
ALPHA_CLEAR, ALPHA_SOLID = policy['alphaClear'], policy['alphaSolid']
manifest = {'schemaVersion': 2, 'catalogSha256': plan['catalogSha256'],
            'encoder': {'pillow': Image.__version__, 'opaque': {'format': 'JPEG', 'quality': JPEG_QUALITY, 'progressive': False, 'subsampling': '4:2:0'},
                        'transparent': {'format': 'PNG', 'colors': PNG_COLORS, 'quantize': 'FASTOCTREE', 'dither': 'FLOYDSTEINBERG', 'alphaSnap': [ALPHA_CLEAR, ALPHA_SOLID]}},
            **{key: policy[key] for key in ('cardMaxEdge', 'posterMaxEdge', 'cardMaxBytes', 'posterMaxBytes')}, 'assets': []}


def encode_jpeg(image):
    buffer = io.BytesIO()
    image.convert('RGB').save(buffer, format='JPEG', quality=JPEG_QUALITY, optimize=True, progressive=False, subsampling='4:2:0')
    return buffer.getvalue(), 'JPEG', 'jpg'


def encode_png(image, budget=12288):
    for colors in (PNG_COLORS, 192, 160, 128):
        quantized = image.quantize(colors=colors, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.FLOYDSTEINBERG)
        palette = quantized.getpalette('RGBA')
        # Octree quantization can leave solid product pixels slightly see-through;
        # snap palette alpha so solid stays solid and clear margins stay clear.
        for index in range(3, len(palette), 4):
            palette[index] = 0 if palette[index] <= ALPHA_CLEAR else 255 if palette[index] >= ALPHA_SOLID else palette[index]
        quantized.putpalette(palette, 'RGBA')
        buffer = io.BytesIO()
        quantized.save(buffer, format='PNG', optimize=True)
        data = buffer.getvalue()
        if len(data) <= budget:
            return data, 'PNG', 'png'
    return data, 'PNG', 'png'


manifest_path = root / plan['destinations']['manifest']
previous = json.loads(manifest_path.read_text(encoding='utf-8')) if manifest_path.exists() else {}
compatible = all(previous.get(key) == manifest[key] for key in ('schemaVersion', 'encoder', 'cardMaxEdge', 'posterMaxEdge'))
previous_assets = {item['source']: item for item in previous.get('assets', [])} if compatible else {}
outputs = {}
reused = 0


def verified_rendition(prior, variant, key, source, edge, budget):
    if not prior or any(prior.get(field) != source[field] for field in ('sourceSha256', 'sourceWidth', 'sourceHeight')):
        return None
    for item in prior['renditions']:
        if item['variant'] != variant:
            continue
        ext = 'png' if item['hasTransparency'] else 'jpg'
        if item['path'] != f'/images/products/{key}-{variant}.{ext}':
            continue
        file = asset_dir / Path(item['path']).name
        if not file.is_file():
            continue
        data = file.read_bytes()
        if len(data) != item['bytes'] or len(data) > budget or digest(data) != item['sha256']:
            continue
        with Image.open(io.BytesIO(data)) as image:
            image.load()
            if (image.size == (item['width'], item['height']) and max(image.size) <= edge
                    and image.format == item['format'] == ('PNG' if item['hasTransparency'] else 'JPEG')):
                return item, data
    return None


for entry in plan['entries']:
    raw = Path(entry['sourcePath']).read_bytes()
    assert digest(raw) == entry['sourceSha256'], 'original_hash_mismatch'
    with Image.open(io.BytesIO(raw)) as original:
        original.load()
        assert original.size == (entry['sourceWidth'], entry['sourceHeight']), 'original_size_changed'
        image = ImageOps.exif_transpose(original).convert('RGBA')
    key = digest(entry['source'].encode())[:20]
    asset = {'source': entry['source']}
    record = {k: entry[k] for k in ['source', 'sourceSha256', 'sourceWidth', 'sourceHeight', 'parts']}
    record['renditions'] = []
    reused_asset = True
    for variant, edge, budget in [('card', policy['cardMaxEdge'], policy['cardMaxBytes'])] + ([('poster', policy['posterMaxEdge'], policy['posterMaxBytes'])] if entry['poster'] else []):
        cached = verified_rendition(previous_assets.get(entry['source']), variant, key, entry, edge, budget)
        if cached:
            item, data = cached
            record['renditions'].append(item)
            asset[variant] = item['path']
            outputs[asset_dir / Path(item['path']).name] = data
            continue
        reused_asset = False
        resized = image.copy()
        resized.thumbnail((edge, edge), Image.Resampling.LANCZOS, reducing_gap=3.0)
        transparent = resized.getchannel('A').getextrema()[0] < 255
        encoded, image_format, extension = encode_png(resized, budget) if transparent else encode_jpeg(resized)
        assert len(encoded) <= budget, f'thumbnail_byte_budget:{key}:{variant}:{len(encoded)}'
        with Image.open(io.BytesIO(encoded)) as verified:
            verified.load()
            assert verified.format == image_format and verified.size == resized.size
            if transparent:
                source_alpha = resized.getchannel('A')
                decoded_alpha = verified.convert('RGBA').getchannel('A')
                clear = source_alpha.point(lambda value: 255 if value == 0 else 0)
                solid = source_alpha.point(lambda value: 255 if value == 255 else 0)
                assert ImageChops.multiply(decoded_alpha, clear).getextrema()[1] == 0, 'alpha_clear_changed'
                assert ImageChops.multiply(ImageChops.invert(decoded_alpha), solid).getextrema()[1] == 0, 'alpha_solid_changed'
                assert ImageStat.Stat(ImageChops.difference(source_alpha, decoded_alpha)).mean[0] <= 2, 'alpha_changed'
        filename = f'{key}-{variant}.{extension}'
        outputs[asset_dir / filename] = encoded
        asset[variant] = '/images/products/' + filename
        record['renditions'].append({'variant': variant, 'path': asset[variant], 'width': resized.width, 'height': resized.height,
                                     'bytes': len(encoded), 'sha256': digest(encoded), 'format': image_format, 'hasTransparency': transparent})
    for part in entry['parts']:
        assert part not in mapping['byPart'], 'duplicate_sku'
        mapping['byPart'][part] = len(mapping['assets'])
    mapping['assets'].append(asset)
    manifest['assets'].append(record)
    reused += int(reused_asset)
# Drop superseded generated renditions (for example earlier .webp files) so
# they are neither packaged nor counted; never touch non-generated names.
stale_files = set()
for stale in asset_dir.iterdir():
    generated = len(stale.stem) > 21 and stale.stem[20] == '-' and stale.stem[21:] in ('card', 'poster') and stale.suffix in ('.webp', '.png', '.jpg')
    if stale.is_file() and generated and stale not in outputs:
        stale_files.add(stale)
mapping_data = ('// Generated by tools/assets/build-product-thumbnails.mjs; exact original URL/SKU mapping.\nmodule.exports = '
                + json.dumps(mapping, ensure_ascii=False, separators=(',', ':')) + ';\n').encode('utf-8')
outputs[root / plan['destinations']['mapping']] = mapping_data
manifest['mappingSha256'] = digest(mapping_data)
manifest['totalBytes'] = sum(r['bytes'] for a in manifest['assets'] for r in a['renditions'])
assert manifest['totalBytes'] <= policy['thumbnailMaxBytes'], 'thumbnail_package_budget'
# Validate the projected package before replacing working renditions or removing old ones.
sizes = {p: p.stat().st_size for p in (root / 'miniprogram').rglob('*') if p.is_file() and p not in stale_files}
sizes.update({p: len(data) for p, data in outputs.items()})
package_bytes = sum(sizes.values())
assert package_bytes <= policy['mainPackageMaxBytes'], f'main_package_budget:{package_bytes}'
image_bytes = sum(size for p, size in sizes.items() if p.suffix.lower() in ('.png', '.jpg', '.jpeg', '.gif', '.svg'))
assert image_bytes <= policy['imageMaxBytes'], f'image_package_budget:{image_bytes}'
for file, data in outputs.items():
    if not file.exists() or file.read_bytes() != data:
        file.write_bytes(data)
for stale in stale_files:
    stale.unlink()
manifest['incrementalBuild'] = {'reusedVerifiedAssets': reused, 'newlyEncodedAssets': len(manifest['assets']) - reused,
                                'sourceHashesRechecked': True}
manifest['catalogImagesGeneratedAt'] = plan['catalogImagesGeneratedAt']
manifest['generatedAt'] = datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
manifest_path.parent.mkdir(parents=True, exist_ok=True)
manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
print(json.dumps({'assets': len(manifest['assets']), 'skus': len(mapping['byPart']), 'thumbnailBytes': manifest['totalBytes'], 'mainPackageRawBytes': package_bytes, **manifest['incrementalBuild']}))
