from __future__ import annotations

import argparse
from pathlib import Path

from rag import build_index

# Project root (parent of backend/)
PROJECT_ROOT = Path(__file__).resolve().parent.parent


def main() -> None:
    parser = argparse.ArgumentParser(description="Build a local RAG embeddings index using Ollama embeddings")
    parser.add_argument("--kb", default=str(PROJECT_ROOT / "kb"), help="Folder containing .md/.txt knowledge base files")
    parser.add_argument("--out", default=str(PROJECT_ROOT / "data" / "rag_index.json"), help="Output index JSON path")
    parser.add_argument("--model", default="nomic-embed-text", help="Ollama embedding model name")
    parser.add_argument("--chunk", type=int, default=900, help="Chunk size in characters")
    parser.add_argument("--overlap", type=int, default=160, help="Overlap in characters")
    parser.add_argument(
        "--quant-bits",
        type=int,
        default=0,
        help="Optional: quantize embeddings to N bits/coordinate and store codes in a .npz (0 = disabled)",
    )
    parser.add_argument(
        "--quant-seed",
        type=int,
        default=12345,
        help="Quantization seed (controls the deterministic perm+sign rotation)",
    )
    parser.add_argument(
        "--quant-npz",
        default="",
        help="Optional: path for the quantized .npz payload (default: <out>.quant.npz)",
    )

    args = parser.parse_args()

    kb_dir = Path(args.kb)
    out_path = Path(args.out)

    quant_npz = Path(args.quant_npz) if str(args.quant_npz).strip() else None

    count = build_index(
        kb_dir=kb_dir,
        index_path=out_path,
        embed_model=args.model,
        chunk_chars=args.chunk,
        overlap=args.overlap,
        quant_bits=int(args.quant_bits),
        quant_seed=int(args.quant_seed),
        quant_npz_path=quant_npz,
    )

    print(f"Built RAG index: {out_path} ({count} chunks)")


if __name__ == "__main__":
    main()
