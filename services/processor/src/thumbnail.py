from io import BytesIO

from PIL import Image

MAX_DIMENSION = (300, 300)


def make_thumbnail(data: bytes, content_type: str) -> bytes | None:
    if not content_type.startswith("image/"):
        return None
    if content_type == "image/svg+xml":
        return None
    try:
        img = Image.open(BytesIO(data))
        img.thumbnail(MAX_DIMENSION)
        if img.mode not in ("RGB", "RGBA"):
            img = img.convert("RGBA")
        out = BytesIO()
        img.save(out, format="WEBP", quality=80)
        return out.getvalue()
    except Exception:
        return None
