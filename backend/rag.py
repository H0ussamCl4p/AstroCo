from __future__ import annotations

import json
import math
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Optional

import numpy as np


@dataclass(frozen=True)
class RagHit:
    score: float
    source: str
    text: str


def _apply_query_text_boosts(
    sims: np.ndarray, *, chunks: list[dict], query_text: Optional[str]
) -> None:
    if not query_text:
        return

    qt = str(query_text).lower()

    # Domain-specific boost maps: (query_keywords, source_file_keywords, text_keywords, specific_phrases)
    boost_rules = [
        # Artemis missions
        {
            "trigger": "artemis",
            "source_boost": ("artemis", 0.10),
            "text_boost": ("artemis", 0.06),
            "phrases": {
                "artemis ii": 0.12, "artemis 2": 0.12,
                "artemis i": 0.12, "artemis 1": 0.12,
                "artemis iii": 0.12, "artemis 3": 0.12,
                "artemis iv": 0.12, "artemis 4": 0.12,
                "artemis v": 0.12, "artemis 5": 0.12,
            },
        },
        # Planets & Solar System
        {
            "trigger_any": ["planet", "mercury", "venus", "mars", "jupiter", "saturn", "uranus", "neptune", "pluto", "solar system"],
            "source_boost": ("solar_system", 0.10),
            "text_boost": None,
            "phrases": {},
        },
        # Moon
        {
            "trigger_any": ["moon", "luna", "lunar", "crater", "south pole"],
            "source_boost": ("solar_system", 0.08),
            "text_boost": ("moon", 0.06),
            "phrases": {"south pole": 0.10, "water ice": 0.08},
        },
        # Stars & stellar
        {
            "trigger_any": ["star", "supernova", "neutron", "pulsar", "red giant", "white dwarf", "main sequence"],
            "source_boost": ("stars_galaxies", 0.10),
            "text_boost": None,
            "phrases": {},
        },
        # Black holes
        {
            "trigger_any": ["black hole", "event horizon", "singularity", "sagittarius"],
            "source_boost": ("stars_galaxies", 0.12),
            "text_boost": ("black hole", 0.08),
            "phrases": {"sagittarius a": 0.10, "hawking radiation": 0.10},
        },
        # Galaxies
        {
            "trigger_any": ["galaxy", "milky way", "andromeda", "nebula", "dark matter", "dark energy"],
            "source_boost": ("stars_galaxies", 0.10),
            "text_boost": None,
            "phrases": {"milky way": 0.08, "andromeda": 0.08},
        },
        # Exoplanets
        {
            "trigger_any": ["exoplanet", "habitable", "trappist", "proxima", "goldilocks", "kepler", "jwst", "james webb"],
            "source_boost": ("stars_galaxies", 0.10),
            "text_boost": ("exoplanet", 0.06),
            "phrases": {"trappist-1": 0.10, "james webb": 0.08, "habitable zone": 0.08},
        },
        # Rockets & Technology
        {
            "trigger_any": ["rocket", "launch", "falcon", "starship", "sls", "spacex", "engine"],
            "source_boost": ("space_technology", 0.10),
            "text_boost": None,
            "phrases": {"falcon 9": 0.08, "starship": 0.08},
        },
        # Space stations
        {
            "trigger_any": ["iss", "space station", "tiangong", "axiom", "orbital"],
            "source_boost": ("space_technology", 0.10),
            "text_boost": ("space station", 0.06),
            "phrases": {},
        },
        # Astronauts & living in space
        {
            "trigger_any": ["astronaut", "spacewalk", "eva", "microgravity", "radiation"],
            "source_boost": ("space_technology", 0.08),
            "text_boost": None,
            "phrases": {},
        },
    ]

    for rule in boost_rules:
        # Check if this rule applies to the query
        triggered = False
        if "trigger" in rule:
            triggered = rule["trigger"] in qt
        elif "trigger_any" in rule:
            triggered = any(t in qt for t in rule["trigger_any"])

        if not triggered:
            continue

        for i, c in enumerate(chunks):
            src = str(c.get("source") or "").lower()
            txt = str(c.get("text") or "").lower()

            # Source file boost
            sb = rule.get("source_boost")
            if sb and sb[0] in src:
                sims[i] += sb[1]

            # Text content boost
            tb = rule.get("text_boost")
            if tb and tb[0] in txt:
                sims[i] += tb[1]

            # Specific phrase boosts
            for phrase, boost in rule.get("phrases", {}).items():
                if phrase in txt:
                    sims[i] += boost


def _safe_read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="ignore")


def iter_kb_files(kb_dir: Path) -> Iterable[Path]:
    if not kb_dir.exists():
        return

    exts = {".txt", ".md"}
    for p in kb_dir.rglob("*"):
        if p.is_file() and p.suffix.lower() in exts:
            yield p


def chunk_text(text: str, *, chunk_chars: int = 900, overlap: int = 160) -> list[str]:
    text = (text or "").strip()
    if not text:
        return []

    chunk_chars = max(200, int(chunk_chars))
    overlap = max(0, min(int(overlap), chunk_chars - 1))

    out: list[str] = []
    start = 0
    n = len(text)

    while start < n:
        end = min(n, start + chunk_chars)

        # Try to end on a boundary for cleaner chunks.
        window = text[start:end]
        cut = max(window.rfind("\n\n"), window.rfind("\n"), window.rfind(". "))
        if cut > 0 and (start + cut) > start + int(chunk_chars * 0.55):
            end = start + cut + 1

        chunk = text[start:end].strip()
        if chunk:
            out.append(chunk)

        if end >= n:
            break

        start = max(0, end - overlap)

    return out


def _ollama_embed(ollama, *, model: str, prompt: str) -> list[float]:
    """Calls Ollama embeddings API with retries.

    NOTE: The Ollama Python client can sometimes block for a long time if the
    local Ollama server stalls or returns intermittent errors. For the RAG index
    build we prefer a bounded timeout + retry behavior.
    """
    import json
    import os
    import urllib.error
    import urllib.request

    host = str(os.environ.get("OLLAMA_HOST") or "http://127.0.0.1:11434").rstrip("/")
    url = f"{host}/api/embeddings"

    timeout_s = float(os.environ.get("ASTROCO_OLLAMA_TIMEOUT_S") or 120)
    max_retries = int(os.environ.get("ASTROCO_OLLAMA_RETRIES") or 5)

    last_err: Exception | None = None
    for attempt in range(1, max_retries + 1):
        try:
            payload = json.dumps({"model": model, "prompt": prompt}).encode("utf-8")
            req = urllib.request.Request(
                url,
                data=payload,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=timeout_s) as resp:
                raw = resp.read().decode("utf-8", errors="replace")
            resp_obj = json.loads(raw)
            resp = resp_obj
            break
        except urllib.error.HTTPError as e:
            last_err = e
        except Exception as e:  # network/timeout/json
            last_err = e

        if attempt < max_retries:
            time.sleep(min(2.5, 0.35 * attempt))
            continue

    else:
        # Should be unreachable due to the break above, but kept for clarity.
        resp = None

    if last_err is not None and resp is None:
        raise RuntimeError(f"Ollama embeddings failed after {max_retries} retries at {url}: {last_err}")

    # Newer ollama Python clients return a pydantic object:
    # EmbeddingsResponse(embedding=[...])
    emb_attr = getattr(resp, "embedding", None)
    if isinstance(emb_attr, list) and emb_attr:
        return emb_attr

    # Some pydantic objects support model_dump().
    model_dump = getattr(resp, "model_dump", None)
    if callable(model_dump):
        dumped = model_dump()
        if isinstance(dumped, dict):
            resp = dumped

    if isinstance(resp, dict):
        if "embedding" in resp and isinstance(resp["embedding"], list):
            return resp["embedding"]

        # Some clients return: {"data": [{"embedding": [...] }], ...}
        data = resp.get("data")
        if isinstance(data, list) and data:
            emb = data[0].get("embedding")
            if isinstance(emb, list):
                return emb

    raise RuntimeError("Unexpected Ollama embeddings response format")


def build_index(
    *,
    kb_dir: Path,
    index_path: Path,
    embed_model: str = "nomic-embed-text",
    chunk_chars: int = 900,
    overlap: int = 160,
    quant_bits: int = 0,
    quant_seed: int = 12345,
    quant_npz_path: Optional[Path] = None,
) -> int:
    import ollama  # local dependency via requirements-realtime.txt

    kb_dir = Path(kb_dir)
    index_path = Path(index_path)

    chunks: list[dict] = []
    emb_list: list[list[float]] = []

    # Build the chunk list first so we can show progress with a known total.
    file_count = 0
    for file_path in iter_kb_files(kb_dir):
        file_count += 1
        raw = _safe_read_text(file_path)
        for i, chunk in enumerate(chunk_text(raw, chunk_chars=chunk_chars, overlap=overlap)):
            chunks.append(
                {
                    "source": str(file_path.as_posix()),
                    "chunk": int(i),
                    "text": chunk,
                }
            )

    total = len(chunks)
    print(f"Building RAG index: {file_count} files, {total} chunks, model={embed_model}", flush=True)

    t0 = time.time()
    for idx, item in enumerate(chunks, start=1):
        emb = _ollama_embed(ollama, model=embed_model, prompt=item["text"])
        emb_list.append([float(x) for x in emb])
        if idx == 1 or idx == total or (idx % 10 == 0):
            dt = time.time() - t0
            rate = idx / max(0.001, dt)
            print(f"  embeddings {idx}/{total} ({rate:.2f} chunks/s)", flush=True)

    payload: dict = {
        "schema": 1,
        "created_unix": int(time.time()),
        "kb_dir": str(kb_dir.as_posix()),
        "embed_model": embed_model,
        "chunk_chars": int(chunk_chars),
        "overlap": int(overlap),
        "chunks": chunks,
    }

    qbits = int(quant_bits or 0)
    if qbits > 0:
        from turboquant import build_quantized_embeddings

        emb = np.asarray(emb_list, dtype=np.float32)
        if emb.ndim != 2:
            raise ValueError("Embeddings shape invalid")

        if quant_npz_path is None:
            quant_npz_path = index_path.with_suffix(".quant.npz")
        quant_npz_path = Path(quant_npz_path)

        codes, params, recon_norms = build_quantized_embeddings(emb, bits=qbits, seed=int(quant_seed))

        np.savez_compressed(
            quant_npz_path,
            schema=np.asarray([1], dtype=np.int32),
            dim=np.asarray([emb.shape[1]], dtype=np.int32),
            bits=np.asarray([params.bits], dtype=np.int32),
            centroids=params.centroids.astype(np.float32, copy=False),
            thresholds=params.thresholds.astype(np.float32, copy=False),
            perm=params.perm.astype(np.int32, copy=False),
            sign=params.sign.astype(np.int8, copy=False),
            codes=codes.astype(np.uint8, copy=False),
            recon_norms=recon_norms.astype(np.float32, copy=False),
        )

        payload["schema"] = 2
        try:
            # Store path relative to the JSON index file directory so loading works
            # even when index_path is inside a subdirectory.
            qpath = quant_npz_path.relative_to(index_path.parent)
        except Exception:
            qpath = Path(os.path.relpath(quant_npz_path, start=index_path.parent))
        payload["quantized"] = {
            "path": str(qpath.as_posix()),
            "bits": int(params.bits),
            "seed": int(quant_seed),
            "transform": "perm_sign",
            "codebook": "gaussian_equal_mass",
        }
    else:
        # Classic (unquantized) index: store embeddings inline.
        for c, e in zip(chunks, emb_list):
            c["embedding"] = e

    index_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return len(chunks)


class RagIndex:
    def __init__(self, chunks: list[dict], embeddings: np.ndarray) -> None:
        self._chunks = chunks
        self._emb = embeddings
        self._emb_norm = np.linalg.norm(self._emb, axis=1) + 1e-9

    @staticmethod
    def load(index_path: Path) -> "RagIndex":
        payload = json.loads(Path(index_path).read_text(encoding="utf-8"))
        chunks = payload.get("chunks") or []
        if not isinstance(chunks, list) or not chunks:
            raise ValueError("RAG index has no chunks")

        qinfo = payload.get("quantized")
        if isinstance(qinfo, dict) and qinfo.get("path"):
            return QuantizedRagIndex.load(index_path=index_path, payload=payload)

        emb_list: list[list[float]] = []
        for c in chunks:
            e = c.get("embedding")
            if not isinstance(e, list) or not e:
                raise ValueError("RAG index chunk missing embedding")
            emb_list.append([float(x) for x in e])

        emb = np.asarray(emb_list, dtype=np.float32)
        if emb.ndim != 2:
            raise ValueError("RAG index embeddings shape invalid")

        return RagIndex(chunks=chunks, embeddings=emb)

    def search(
        self,
        query_embedding: list[float],
        *,
        query_text: Optional[str] = None,
        k: int = 4,
        min_score: float = 0.18,
    ) -> list[RagHit]:
        q = np.asarray(query_embedding, dtype=np.float32).reshape(1, -1)
        if q.shape[1] != self._emb.shape[1]:
            raise ValueError(
                f"Embedding dim mismatch: query={q.shape[1]} index={self._emb.shape[1]}"
            )

        q_norm = float(np.linalg.norm(q) + 1e-9)
        sims = (self._emb @ q.T).reshape(-1) / (self._emb_norm * q_norm)

        _apply_query_text_boosts(sims, chunks=self._chunks, query_text=query_text)

        k = max(1, int(k))
        top_idx = np.argpartition(-sims, min(k, sims.size) - 1)[:k]
        top_idx = top_idx[np.argsort(-sims[top_idx])]

        hits: list[RagHit] = []
        for idx in top_idx.tolist():
            score = float(sims[idx])
            if score < float(min_score):
                continue
            c = self._chunks[idx]
            hits.append(
                RagHit(
                    score=score,
                    source=str(c.get("source") or "(unknown)"),
                    text=str(c.get("text") or "").strip(),
                )
            )
        return hits


class QuantizedRagIndex:
    def __init__(
        self,
        *,
        chunks: list[dict],
        codes: np.ndarray,
        centroids: np.ndarray,
        thresholds: np.ndarray,
        perm: np.ndarray,
        sign: np.ndarray,
        recon_norms: np.ndarray,
    ) -> None:
        self._chunks = chunks
        self._codes = np.asarray(codes, dtype=np.uint8)
        self._centroids = np.asarray(centroids, dtype=np.float32)
        self._thresholds = np.asarray(thresholds, dtype=np.float32)
        self._perm = np.asarray(perm, dtype=np.int32)
        self._sign = np.asarray(sign, dtype=np.int8)
        self._recon_norms = np.asarray(recon_norms, dtype=np.float32).reshape(-1)

        if self._codes.ndim != 2:
            raise ValueError("Quantized codes shape invalid")
        if self._centroids.ndim != 1:
            raise ValueError("Quantized centroids shape invalid")
        if self._thresholds.ndim != 1:
            raise ValueError("Quantized thresholds shape invalid")

        d = self._codes.shape[1]
        if self._perm.shape != (d,):
            raise ValueError("Quantized perm shape invalid")
        if self._sign.shape != (d,):
            raise ValueError("Quantized sign shape invalid")
        if self._recon_norms.shape != (self._codes.shape[0],):
            raise ValueError("Quantized recon_norms shape invalid")

    @staticmethod
    def load(*, index_path: Path, payload: dict) -> "QuantizedRagIndex":
        from turboquant import QuantParams

        chunks = payload.get("chunks") or []
        if not isinstance(chunks, list) or not chunks:
            raise ValueError("RAG index has no chunks")

        qinfo = payload.get("quantized") or {}
        rel = str(qinfo.get("path") or "").strip()
        if not rel:
            raise ValueError("RAG index quantized.path missing")

        npz_path = Path(rel)
        if not npz_path.is_absolute():
            npz_path = Path(index_path).parent / npz_path

        blob = np.load(npz_path, allow_pickle=False)
        codes = blob["codes"]
        centroids = blob["centroids"]
        thresholds = blob["thresholds"]
        perm = blob["perm"]
        sign = blob["sign"]
        recon_norms = blob["recon_norms"]

        return QuantizedRagIndex(
            chunks=chunks,
            codes=codes,
            centroids=centroids,
            thresholds=thresholds,
            perm=perm,
            sign=sign,
            recon_norms=recon_norms,
        )

    def search(
        self,
        query_embedding: list[float],
        *,
        query_text: Optional[str] = None,
        k: int = 4,
        min_score: float = 0.18,
    ) -> list[RagHit]:
        from turboquant import QuantParams, score_query_codes

        # Build a temporary QuantParams for scoring.
        params = QuantParams(
            bits=int(round(math.log2(float(self._centroids.shape[0])))),
            centroids=self._centroids,
            thresholds=self._thresholds,
            perm=self._perm,
            sign=self._sign,
        )

        sims = score_query_codes(
            codes=self._codes,
            params=params,
            recon_norms=self._recon_norms,
            query_embedding=np.asarray(query_embedding, dtype=np.float32),
        )

        _apply_query_text_boosts(sims, chunks=self._chunks, query_text=query_text)

        k = max(1, int(k))
        top_idx = np.argpartition(-sims, min(k, sims.size) - 1)[:k]
        top_idx = top_idx[np.argsort(-sims[top_idx])]

        hits: list[RagHit] = []
        for idx in top_idx.tolist():
            score = float(sims[idx])
            if score < float(min_score):
                continue
            c = self._chunks[idx]
            hits.append(
                RagHit(
                    score=score,
                    source=str(c.get("source") or "(unknown)"),
                    text=str(c.get("text") or "").strip(),
                )
            )
        return hits


def embed_query(*, text: str, embed_model: str = "nomic-embed-text") -> list[float]:
    import ollama

    return _ollama_embed(ollama, model=embed_model, prompt=text)


def format_hits(hits: list[RagHit], *, max_chars: int = 1400) -> str:
    if not hits:
        return ""

    lines: list[str] = []
    used = 0

    for h in hits:
        snippet = " ".join(h.text.split())
        if len(snippet) > 420:
            snippet = snippet[:420].rstrip() + "…"

        line = f"- ({h.score:.3f}) {h.source}: {snippet}"
        if used + len(line) + 1 > max_chars:
            break
        lines.append(line)
        used += len(line) + 1

    return "\n".join(lines).strip()
