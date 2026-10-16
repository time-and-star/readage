"""Japanese Kokoro v1 G2P using the unmodified official Misaki Cutlet adapter.

Only phonemization runs in Python. ONNX inference remains in the shared Node model.
"""
import json
import sys
from pathlib import Path

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, str(Path(sys.argv[1]).resolve()))

from fugashi import Tagger
from misaki.cutlet import Cutlet
import unidic_lite

g2p = Cutlet()
dictionary = Path(unidic_lite.DICDIR)
g2p.tagger = Tagger(f'-d "{dictionary}" -r "{dictionary / "mecabrc"}"')

for line in sys.stdin:
    if len(line) > 16_000:
        break
    request = json.loads(line)
    try:
        text = request.get("text")
        if not isinstance(text, str) or not text.strip() or len(text) > 2000:
            raise ValueError("Invalid speech text")
        phonemes, _ = g2p(text)
        response = {"id": request["id"], "phonemes": phonemes}
    except Exception:
        response = {"id": request.get("id"), "error": "Japanese pronunciation failed"}
    print(json.dumps(response, ensure_ascii=False), flush=True)
