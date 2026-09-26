import hashlib

EICAR_MARKER = b"EICAR-STANDARD-ANTIVIRUS-TEST-FILE"


def scan(data: bytes) -> str:
    if EICAR_MARKER in data:
        return "infected"
    return "clean"


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()
