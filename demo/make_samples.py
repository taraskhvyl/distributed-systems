#!/usr/bin/env python3
import struct
import zlib
from pathlib import Path


def make_gradient_png(path: Path, width: int = 800, height: int = 600) -> None:
    rows = bytearray()
    for y in range(height):
        rows.append(0)
        for x in range(width):
            r = int(255 * x / width)
            g = int(255 * y / height)
            b = int(128 + 64 * (x / width) * (y / height))
            rows.extend((r, g, b))

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    png_bytes = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(bytes(rows), 9))
        + chunk(b"IEND", b"")
    )
    path.write_bytes(png_bytes)
    print(f"wrote {path} ({len(png_bytes)} bytes)")


def make_infected_sample(path: Path) -> None:
    eicar = b"X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"
    body = b"mediashare demo file that trips the demo scanner\n\n" + eicar + b"\n"
    path.write_bytes(body)
    print(f"wrote {path} ({len(body)} bytes)")


if __name__ == "__main__":
    out = Path(__file__).parent / "samples"
    out.mkdir(exist_ok=True)
    make_gradient_png(out / "sample.png")
    make_infected_sample(out / "infected.txt")
