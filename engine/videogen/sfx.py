"""Hiệu ứng âm thanh tổng hợp bằng numpy (không cần file mẫu, không vướng bản quyền).

- whoosh: tiếng "vút" khi chuyển cảnh — nhiễu trắng qua bộ lọc thông thấp có tần số cắt quét lên rồi xuống,
  âm lượng phồng lên ở giữa và lướt từ kênh trái sang phải.
- pop: tiếng "tách" ngắn khi nhãn bước xuất hiện — sóng sin hạ cao độ nhanh, tắt dần.
"""
from functools import lru_cache

import numpy as np

RATE = 44100


def _one_pole_lowpass(x: np.ndarray, cutoff_hz: np.ndarray) -> np.ndarray:
    alpha = 1.0 - np.exp(-2.0 * np.pi * cutoff_hz / RATE)
    y = np.empty_like(x)
    acc = 0.0
    for i in range(len(x)):  # vài chục nghìn mẫu: đủ nhanh, kết quả được cache
        acc += alpha[i] * (x[i] - acc)
        y[i] = acc
    return y


@lru_cache(maxsize=8)
def whoosh(duration: float = 0.55, seed: int = 0, direction: int = 1) -> np.ndarray:
    """Mảng float32 (số mẫu, 2 kênh), đỉnh âm lượng 1.0."""
    n = max(16, int(duration * RATE))
    rng = np.random.default_rng(seed)
    noise = rng.standard_normal(n).astype(np.float64)
    t = np.linspace(0.0, 1.0, n)
    swell = np.sin(np.pi * t) ** 2
    cutoff = 220.0 + 2600.0 * np.sin(np.pi * np.clip(t * 1.1, 0, 1)) ** 1.5
    y = _one_pole_lowpass(_one_pole_lowpass(noise, cutoff), cutoff * 1.4)  # hai tầng -> dốc hơn, "mượt" hơn
    y -= np.convolve(y, np.ones(64) / 64, mode="same")  # bỏ bớt tiếng ù tần số thấp
    y *= swell
    peak = np.max(np.abs(y)) or 1.0
    y = (y / peak).astype(np.float32)
    pan = t if direction >= 0 else 1 - t  # lướt trái -> phải (hoặc ngược lại)
    left = y * np.cos(pan * np.pi / 2) * 1.2
    right = y * np.sin(pan * np.pi / 2) * 1.2
    return np.clip(np.stack([left, right], axis=1), -1, 1).astype(np.float32)


@lru_cache(maxsize=4)
def pop(duration: float = 0.09) -> np.ndarray:
    n = int(duration * RATE)
    t = np.arange(n) / RATE
    freq = 380 + 620 * np.exp(-t / 0.018)  # cao độ hạ nhanh
    phase = 2 * np.pi * np.cumsum(freq) / RATE
    env = np.exp(-t / 0.022) * np.clip(t / 0.002, 0, 1)
    y = (np.sin(phase) * env).astype(np.float32)
    return np.stack([y, y], axis=1)
