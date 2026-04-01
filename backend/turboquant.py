from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Optional

import numpy as np


# ---- Normal distribution helpers (no SciPy dependency) ----

def _norm_pdf(x: np.ndarray) -> np.ndarray:
    return np.exp(-0.5 * x * x) / math.sqrt(2.0 * math.pi)


def _norm_cdf(x: np.ndarray) -> np.ndarray:
    # Φ(x) = 0.5 * (1 + erf(x / sqrt(2)))
    x = np.asarray(x, dtype=np.float64)
    y = (x / math.sqrt(2.0)).reshape(-1)
    erf_y = np.array([math.erf(float(v)) for v in y], dtype=np.float64)
    return (0.5 * (1.0 + erf_y)).reshape(x.shape)


def _norm_ppf(p: np.ndarray) -> np.ndarray:
    """Inverse CDF for standard normal using Acklam's approximation.

    Vectorized version.
    """

    # Coefficients from Peter J. Acklam's approximation.
    a = np.array(
        [
            -3.969683028665376e01,
            2.209460984245205e02,
            -2.759285104469687e02,
            1.383577518672690e02,
            -3.066479806614716e01,
            2.506628277459239e00,
        ],
        dtype=np.float64,
    )
    b = np.array(
        [
            -5.447609879822406e01,
            1.615858368580409e02,
            -1.556989798598866e02,
            6.680131188771972e01,
            -1.328068155288572e01,
        ],
        dtype=np.float64,
    )
    c = np.array(
        [
            -7.784894002430293e-03,
            -3.223964580411365e-01,
            -2.400758277161838e00,
            -2.549732539343734e00,
            4.374664141464968e00,
            2.938163982698783e00,
        ],
        dtype=np.float64,
    )
    d = np.array(
        [
            7.784695709041462e-03,
            3.224671290700398e-01,
            2.445134137142996e00,
            3.754408661907416e00,
        ],
        dtype=np.float64,
    )

    plow = 0.02425
    phigh = 1.0 - plow

    p = np.asarray(p, dtype=np.float64)
    if np.any(p <= 0.0) or np.any(p >= 1.0):
        raise ValueError("p must be in (0, 1)")

    x = np.empty_like(p, dtype=np.float64)

    low = p < plow
    high = p > phigh
    mid = ~(low | high)

    if np.any(low):
        q = np.sqrt(-2.0 * np.log(p[low]))
        num = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
        den = ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1.0)
        x[low] = num / den

    if np.any(mid):
        q = p[mid] - 0.5
        r = q * q
        num = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
        den = (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1.0)
        x[mid] = num / den

    if np.any(high):
        q = np.sqrt(-2.0 * np.log(1.0 - p[high]))
        num = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
        den = ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1.0)
        x[high] = -(num / den)

    return x


# ---- TurboQuant-lite primitives ----


@dataclass(frozen=True)
class QuantParams:
    bits: int
    centroids: np.ndarray  # (K,)
    thresholds: np.ndarray  # (K-1,) ascending, bin upper edges
    perm: np.ndarray  # (d,) int32
    sign: np.ndarray  # (d,) int8 values in {-1, +1}


def make_perm_sign(d: int, *, seed: int) -> tuple[np.ndarray, np.ndarray]:
    """Cheap orthogonal 'rotation': permutation + sign flips.

    This is a strict orthogonal transform (so it preserves dot products),
    but is much cheaper to store/compute than a dense random rotation matrix.
    """

    d = int(d)
    rng = np.random.default_rng(int(seed))
    perm = rng.permutation(d).astype(np.int32, copy=False)
    sign = rng.choice(np.array([-1, 1], dtype=np.int8), size=d, replace=True)
    return perm, sign


def apply_perm_sign(x: np.ndarray, perm: np.ndarray, sign: np.ndarray) -> np.ndarray:
    """Applies y = sign * x[perm] (works for (d,) or (n,d))."""

    if x.ndim == 1:
        return (x[perm] * sign).astype(np.float32, copy=False)
    if x.ndim == 2:
        return (x[:, perm] * sign).astype(np.float32, copy=False)
    raise ValueError("x must be 1D or 2D")


def gaussian_equal_mass_codebook(*, bits: int, sigma: float) -> tuple[np.ndarray, np.ndarray]:
    """Non-uniform scalar quantizer for N(0, sigma^2) using equal-mass bins.

    Returns (centroids, thresholds).

    - thresholds: length K-1, upper edge for each bin.
    - centroids: length K, conditional mean within each bin.

    This is not the full Lloyd-Max fixed-point solve, but is a strong,
    data-oblivious approximation that works well in practice.
    """

    bits = int(bits)
    if bits <= 0 or bits > 8:
        raise ValueError("bits must be in [1, 8]")

    sigma = float(sigma)
    if not (sigma > 0.0):
        raise ValueError("sigma must be > 0")

    k = 1 << bits

    # Quantile boundaries in Z ~ N(0,1): p = i/k for i=1..k-1
    ps = np.arange(1, k, dtype=np.float64) / float(k)
    z_edges = _norm_ppf(ps)  # (k-1,)

    # thresholds in X = sigma * Z
    thresholds = (sigma * z_edges).astype(np.float32)

    # Compute centroids per bin as conditional mean.
    # Bin i is [edge_{i-1}, edge_i] with edge_-1=-inf, edge_{k-1}=+inf
    edges = np.concatenate(
        [
            np.array([-np.inf], dtype=np.float64),
            z_edges,
            np.array([np.inf], dtype=np.float64),
        ]
    )

    # For standard normal, mu(a,b) = (phi(a) - phi(b)) / (Phi(b) - Phi(a)).
    a = edges[:-1]
    b = edges[1:]

    phi_a = _norm_pdf(a)
    phi_b = _norm_pdf(b)
    Phi_a = _norm_cdf(a)
    Phi_b = _norm_cdf(b)

    denom = (Phi_b - Phi_a)
    # Equal-mass bins => denom ~ 1/k, but keep numeric stability.
    denom = np.maximum(denom, 1e-12)

    mu = (phi_a - phi_b) / denom
    centroids = (sigma * mu).astype(np.float32)

    if centroids.shape != (k,):
        raise AssertionError("centroids shape mismatch")

    return centroids, thresholds


def quantize(x: np.ndarray, thresholds: np.ndarray) -> np.ndarray:
    """Quantize x using thresholds (upper edges). Returns uint8 indices."""

    thresholds = np.asarray(thresholds, dtype=np.float32)
    if thresholds.ndim != 1:
        raise ValueError("thresholds must be 1D")

    # np.searchsorted works for vectorized quantization.
    idx = np.searchsorted(thresholds, x, side="right").astype(np.uint8, copy=False)
    return idx


def l2_normalize_rows(x: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    x = np.asarray(x, dtype=np.float32)
    if x.ndim != 2:
        raise ValueError("x must be 2D")

    norms = np.linalg.norm(x, axis=1) + 1e-9
    return (x / norms[:, None]).astype(np.float32, copy=False), norms.astype(np.float32)


def build_quantized_embeddings(
    embeddings: np.ndarray,
    *,
    bits: int,
    seed: int,
    sigma: Optional[float] = None,
) -> tuple[np.ndarray, QuantParams, np.ndarray]:
    """Quantize embeddings for cosine/IP scoring.

    Returns:
    - codes: uint8 (n,d)
    - params: QuantParams
    - recon_norms: float32 (n,) L2 norms of reconstructed vectors (in rotated space)

    Note: embeddings are row-wise L2 normalized internally.
    """

    emb = np.asarray(embeddings, dtype=np.float32)
    if emb.ndim != 2:
        raise ValueError("embeddings must be 2D")

    n, d = emb.shape
    if n <= 0 or d <= 0:
        raise ValueError("embeddings shape invalid")

    emb_n, _orig_norms = l2_normalize_rows(emb)

    perm, sign = make_perm_sign(d, seed=seed)
    emb_rot = apply_perm_sign(emb_n, perm, sign)

    # For unit vectors, per-coordinate variance is ~1/d.
    if sigma is None:
        sigma = 1.0 / math.sqrt(float(d))

    centroids, thresholds = gaussian_equal_mass_codebook(bits=bits, sigma=float(sigma))
    codes = quantize(emb_rot, thresholds)

    # Reconstructed vectors in rotated space; needed only to precompute norms.
    recon = centroids[codes]
    recon_norms = np.linalg.norm(recon, axis=1).astype(np.float32)

    params = QuantParams(
        bits=int(bits),
        centroids=centroids.astype(np.float32, copy=False),
        thresholds=thresholds.astype(np.float32, copy=False),
        perm=perm,
        sign=sign,
    )

    return codes, params, recon_norms


def score_query_codes(
    *,
    codes: np.ndarray,
    params: QuantParams,
    recon_norms: np.ndarray,
    query_embedding: np.ndarray,
) -> np.ndarray:
    """Approx cosine similarity between query and quantized database vectors."""

    codes = np.asarray(codes)
    if codes.ndim != 2:
        raise ValueError("codes must be 2D")

    recon_norms = np.asarray(recon_norms, dtype=np.float32).reshape(-1)
    if recon_norms.shape[0] != codes.shape[0]:
        raise ValueError("recon_norms length mismatch")

    q = np.asarray(query_embedding, dtype=np.float32).reshape(-1)
    if q.shape[0] != codes.shape[1]:
        raise ValueError("query dim mismatch")

    q_norm = float(np.linalg.norm(q) + 1e-9)
    q = (q / q_norm).astype(np.float32, copy=False)

    q_rot = apply_perm_sign(q, params.perm, params.sign)  # (d,)

    centroids = params.centroids.astype(np.float32, copy=False)
    d = q_rot.shape[0]
    k = centroids.shape[0]

    # LUT[j, t] = q_rot[j] * centroid[t]
    lut = q_rot.reshape(d, 1) * centroids.reshape(1, k)

    # Gather LUT rows by codes.
    # codes: (n,d) => codes.T is (d,n)
    gathered = lut[np.arange(d)[:, None], codes.T.astype(np.int64, copy=False)]
    dots = gathered.sum(axis=0).astype(np.float32, copy=False)

    # Approx cosine: dot / ||recon|| (query is unit)
    sims = dots / (recon_norms + 1e-9)
    return sims
