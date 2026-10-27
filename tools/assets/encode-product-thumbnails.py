"""Deterministic resize/encode of verified Apple originals. No generated artwork.

Packaged images must decode on phones, not only in DevTools. WeChat documents
the <image webp> switch for network resources only, and v3.3.1 packaged WebP
rendered in DevTools but failed in phone previews. Opaque originals therefore
ship as baseline JPEG and transparent originals as 256-colour PNG with alpha.
"""
from pathlib import Path
from PIL import Image, ImageChops, ImageOps, ImageStat
import hashlib
import io
import json
import sys

plan = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
root = Path(plan['root'])
asset_dir = root / 'miniprogram/images/products'
asset_dir.mkdir(parents=True, exist_ok=True)
digest = lambda data: hashlib.sha256(data).hexdigest()
mapping = {'assets': [], 'byPart': {}}
JPEG_QUALITY, PNG_COLORS, ALPHA_CLEAR, ALPHA_SOLID = 85, 256, 16, 224
manifest = {'schemaVersion': 2, 'catalogSha256': plan['catalogSha256'],
            'encoder': {'pillow': Image.__version__, 'opaque': {'format': 'JPEG', 'quality': JPEG_QUALITY, 'progressive': False, 'subsampling': '4:2:0'},
                        'transparent': {'format': 'PNG', 'colors': PNG_COLORS, 'quantize': 'FASTOCTREE', 'dither': 'FLOYDSTEINBERG', 'alphaSnap': [ALPHA_CLEAR, ALPHA_SOLID]}},
            'cardMaxEdge': 216, 'posterMaxEdge': 720, 'cardMaxBytes': 12288, 'posterMaxBytes': 65536, 'assets': []}


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


written = set()
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
    for variant, edge, budget in [('card', 216, 12288)] + ([('poster', 720, 65536)] if entry['poster'] else []):
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
        (asset_dir / filename).write_bytes(encoded)
        written.add(filename)
        asset[variant] = '/images/products/' + filename
        record['renditions'].append({'variant': variant, 'path': asset[variant], 'width': resized.width, 'height': resized.height,
                                     'bytes': len(encoded), 'sha256': digest(encoded), 'format': image_format, 'hasTransparency': transparent})
    for part in entry['parts']:
        assert part not in mapping['byPart'], 'duplicate_sku'
        mapping['byPart'][part] = len(mapping['assets'])
    mapping['assets'].append(asset)
    manifest['assets'].append(record)
# Drop superseded generated renditions (for example earlier .webp files) so
# they are neither packaged nor counted; never touch non-generated names.
for stale in asset_dir.iterdir():
    generated = len(stale.stem) > 21 and stale.stem[20] == '-' and stale.stem[21:] in ('card', 'poster') and stale.suffix in ('.webp', '.png', '.jpg')
    if stale.is_file() and generated and stale.name not in written:
        stale.unlink()
mapping_data = ('// Generated by tools/assets/build-product-thumbnails.mjs; exact original URL/SKU mapping.\nmodule.exports = '
                + json.dumps(mapping, ensure_ascii=False, separators=(',', ':')) + ';\n').encode('utf-8')
(root / plan['destinations']['mapping']).write_bytes(mapping_data)
manifest['mappingSha256'] = digest(mapping_data)
manifest['totalBytes'] = sum(r['bytes'] for a in manifest['assets'] for r in a['renditions'])
assert manifest['totalBytes'] <= 750000, 'thumbnail_package_budget'
manifest_path = root / plan['destinations']['manifest']
manifest_path.parent.mkdir(parents=True, exist_ok=True)
manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
package_bytes = sum(p.stat().st_size for p in (root / 'miniprogram').rglob('*') if p.is_file())
assert package_bytes < 2 * 1024 * 1024, f'main_package_budget:{package_bytes}'
print(json.dumps({'assets': len(manifest['assets']), 'skus': len(mapping['byPart']), 'thumbnailBytes': manifest['totalBytes'], 'mainPackageRawBytes': package_bytes}))
