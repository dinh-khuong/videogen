"""Hiệu ứng âm thanh tổng hợp bằng numpy (không cần file mẫu, không vướng bản quyền).

- whoosh: tiếng "vút" khi chuyển cảnh — nhiễu trắng qua bộ lọc thông thấp có tần số cắt quét lên rồi xuống,
  âm lượng phồng lên ở giữa và lướt từ kênh trái sang phải.
- pop: tiếng "tách" ngắn khi nhãn bước xuất hiện — sóng sin hạ cao độ nhanh, tắt dần.
- Âm thanh meme cho Đạo diễn AI: boom (bùm trầm kiểu "vine boom"), ding (chuông "ting"), scratch (đĩa than rít),
  drumroll (trống dồn), tada (hợp âm "tèn ten"), bonk (gõ "cốp").
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


def _stereo(y: np.ndarray) -> np.ndarray:
    peak = np.max(np.abs(y)) or 1.0
    y = (y / peak).astype(np.float32)
    return np.stack([y, y], axis=1)


@lru_cache(maxsize=1)
def boom(duration: float = 1.3) -> np.ndarray:
    """Tiếng "bùm" trầm: sin quét từ 110 xuống 38 Hz, méo nhẹ cho dày tiếng, có tiếng đập đầu."""
    n = int(duration * RATE)
    t = np.arange(n) / RATE
    freq = 38 + 72 * np.exp(-t / 0.08)
    phase = 2 * np.pi * np.cumsum(freq) / RATE
    body = np.tanh(2.6 * np.sin(phase)) * np.exp(-t / 0.45)
    click = np.random.default_rng(7).standard_normal(n) * np.exp(-t / 0.006) * 0.5
    return _stereo((body + click) * np.clip(t / 0.003, 0, 1))


@lru_cache(maxsize=1)
def ding(duration: float = 1.1) -> np.ndarray:
    """Chuông "ting": vài họa âm không nguyên của chuông, tắt dần theo hàm mũ."""
    t = np.arange(int(duration * RATE)) / RATE
    y = sum(a * np.sin(2 * np.pi * 1320 * r * t) * np.exp(-t / d)
            for r, a, d in ((1.0, 1.0, 0.45), (2.76, 0.45, 0.2), (5.4, 0.25, 0.09), (0.5, 0.3, 0.6)))
    return _stereo(y * np.clip(t / 0.002, 0, 1))


@lru_cache(maxsize=1)
def scratch(duration: float = 0.5) -> np.ndarray:
    """Đĩa than rít: nhiễu lọc thông dải với tần số dao động tới lui như tay kéo đĩa."""
    n = int(duration * RATE)
    t = np.linspace(0.0, 1.0, n)
    noise = np.random.default_rng(3).standard_normal(n)
    cutoff = 500 + 2500 * np.abs(np.sin(np.pi * 2.5 * t))
    y = _one_pole_lowpass(noise, cutoff)
    y -= _one_pole_lowpass(y, cutoff * 0.35)
    return _stereo(y * np.sin(np.pi * t) ** 0.5)


@lru_cache(maxsize=1)
def drumroll(duration: float = 1.6) -> np.ndarray:
    """Trống dồn: chuỗi tiếng gõ nhiễu ngắn, dày dần và to dần, kết bằng một tiếng đập."""
    n = int(duration * RATE)
    y = np.zeros(n)
    rng = np.random.default_rng(5)
    hit_len = int(0.05 * RATE)
    env = np.exp(-np.arange(hit_len) / RATE / 0.012)
    pos, gap = 0, 0.07
    while pos < n - hit_len:
        y[pos:pos + hit_len] += rng.standard_normal(hit_len) * env * (0.35 + 0.65 * pos / n)
        pos += int(gap * RATE)
        gap = max(0.028, gap * 0.94)
    y = _one_pole_lowpass(y, np.full(n, 3200.0))
    tail = boom(0.6)[:, 0] * 0.6
    y[n - len(tail):] += tail[: n]
    return _stereo(y)


@lru_cache(maxsize=1)
def tada(duration: float = 1.2) -> np.ndarray:
    """Hợp âm "tèn ten" (Đô trưởng, tiếng kèn tổng hợp): nốt ngắn rồi hợp âm ngân."""
    t = np.arange(int(duration * RATE)) / RATE

    def brass(freq: float, start: float, length: float) -> np.ndarray:
        local = t - start
        on = (local >= 0) & (local < length)
        env = np.where(on, np.clip(local / 0.02, 0, 1) * np.exp(-np.clip(local, 0, None) / (length * 0.9)), 0)
        wave = sum(np.sin(2 * np.pi * freq * k * t) / k for k in range(1, 6))
        return wave * env

    y = brass(523.25, 0.0, 0.16) + sum(brass(f, 0.18, duration - 0.2) for f in (523.25, 659.25, 783.99, 1046.5))
    return _stereo(y)


@lru_cache(maxsize=1)
def bonk(duration: float = 0.25) -> np.ndarray:
    """Tiếng gõ "cốp" vào đầu: sin trầm hạ cao độ cực nhanh + tiếng gỗ."""
    t = np.arange(int(duration * RATE)) / RATE
    freq = 180 + 900 * np.exp(-t / 0.006)
    y = np.sin(2 * np.pi * np.cumsum(freq) / RATE) * np.exp(-t / 0.05)
    y += 0.4 * np.sin(2 * np.pi * 1250 * t) * np.exp(-t / 0.012)
    return _stereo(y)


# Âm lượng tương đối so với giọng đọc
NAMED_GAIN = {"boom": 0.55, "ding": 0.25, "whoosh": 0.2, "pop": 0.18, "scratch": 0.22, "drumroll": 0.3, "tada": 0.25, "bonk": 0.4}


def named(name: str) -> tuple[np.ndarray, float] | None:
    """(mẫu âm thanh, âm lượng) của hiệu ứng theo tên (xem llm.SFX_NAMES)."""
    makers = {"boom": boom, "ding": ding, "whoosh": lambda: whoosh(0.6), "pop": lambda: pop(0.12), "scratch": scratch,
              "drumroll": drumroll, "tada": tada, "bonk": bonk}
    maker = makers.get(name)
    return (maker(), NAMED_GAIN[name]) if maker else None
