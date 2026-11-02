"""Nhập ảnh từ một dataset (Hugging Face Hub hoặc thư mục/parquet trên máy) vào Assets.

    python -m videogen import-dataset not-lain/meme-dataset            # vào web app đang chạy (localhost:3000)
    python -m videogen import-dataset not-lain/meme-dataset --limit 50 --tag meme
    python -m videogen import-dataset not-lain/meme-dataset --out memes/   # chỉ lưu ra thư mục (dùng với --library-dir)

Tự tìm cột ảnh và các cột nhãn (ClassLabel, chữ ngắn như name/label/caption, danh sách tag). Nhãn của dataset được ghi
vào mô tả asset kèm hashtag; sau khi tải lên, web app tự phân tích từng asset (đọc chữ + AI tóm tắt + hashtag, mô hình
thị giác nếu có cấu hình) và AI dùng chính các nhãn đó làm thông tin đầu vào để phân loại.
"""
import io
import re
import sys
import time
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path

import requests
from PIL import Image

from .llm import normalize_hashtags

LABEL_HINTS = ("label", "labels", "name", "title", "caption", "text", "category", "class", "tags", "tag", "description",
               "template", "meme", "emotion", "sentiment")
MAX_LABEL_CHARS = 300
MAX_DESCRIPTION_CHARS = 1500
MAX_SIDE = 2400


class DatasetError(RuntimeError):
    pass


@dataclass
class Row:
    index: int
    image: Image.Image
    labels: dict[str, str] = field(default_factory=dict)  # tên cột -> giá trị nhãn (đã thành chữ)
    tags: list[str] = field(default_factory=list)


def _load(source: str, split: str, config: str | None, streaming: bool):
    try:
        import datasets
    except ImportError as e:
        raise DatasetError("Chưa cài thư viện datasets: pip install 'datasets>=2.18'") from e
    path = Path(source).expanduser()
    if path.exists():
        # Thư mục ảnh (imagefolder: thư mục con = nhãn) hoặc file/thư mục parquet trên máy
        files = [path] if path.is_file() else sorted(path.rglob("*.parquet"))
        if files and all(f.suffix == ".parquet" for f in files):
            return datasets.load_dataset("parquet", data_files=[str(f) for f in files], split=split, streaming=streaming)
        return datasets.load_dataset("imagefolder", data_dir=str(path), split=split, streaming=streaming)
    return datasets.load_dataset(source, config, split=split, streaming=streaming)


def _image_columns(features) -> list[str]:
    import datasets

    return [name for name, f in (features or {}).items() if isinstance(f, datasets.Image)]


def _as_image(value) -> Image.Image | None:
    if isinstance(value, Image.Image):
        return value
    if isinstance(value, dict):
        if value.get("bytes"):
            return Image.open(io.BytesIO(value["bytes"]))
        if value.get("path") and Path(value["path"]).exists():
            return Image.open(value["path"])
    return None


def _label_value(name: str, value, features) -> tuple[str | None, list[str]]:
    """(nhãn dạng chữ, danh sách tag) của một ô; None nếu cột không giống nhãn."""
    import datasets

    feature = (features or {}).get(name)
    if isinstance(feature, datasets.ClassLabel) and isinstance(value, int) and value >= 0:
        text = feature.int2str(value)
        return text, [text]
    # Danh sách nhãn (Sequence ở datasets cũ, List ở datasets >= 4)
    if isinstance(getattr(feature, "feature", None), datasets.ClassLabel) and isinstance(value, list):
        names = [feature.feature.int2str(v) for v in value or [] if isinstance(v, int) and v >= 0]
        return ", ".join(names) or None, names
    if isinstance(value, str):
        text = " ".join(value.split())
        if not text or len(text) > MAX_LABEL_CHARS or re.match(r"^(https?://|/|[a-zA-Z]:\\)", text):
            return None, []
        # Chữ ngắn (vài từ) dùng làm tag; câu dài chỉ làm mô tả
        return text, [text] if len(text.split()) <= 4 else []
    if isinstance(value, list) and value and all(isinstance(v, str) for v in value):
        items = [" ".join(v.split()) for v in value if v.strip()][:20]
        return ", ".join(items)[:MAX_LABEL_CHARS] or None, items
    if isinstance(value, bool) or not isinstance(value, (int, float)) or name.lower() not in LABEL_HINTS:
        return None, []
    return str(value), []


def iter_rows(ds, image_col: str | None, label_cols: list[str] | None, limit: int | None) -> Iterator[Row]:
    features = getattr(ds, "features", None)
    image_cols = [image_col] if image_col else _image_columns(features)
    for i, item in enumerate(ds):
        if limit is not None and i >= limit:
            return
        if not image_cols:
            image_cols = [k for k, v in item.items() if _as_image(v) is not None][:1]
            if not image_cols:
                raise DatasetError(f"Không tìm thấy cột ảnh trong dataset (các cột: {', '.join(item)}). Dùng --image-col.")
        image = _as_image(item.get(image_cols[0]))
        if image is None:
            continue
        row = Row(i, image)
        names = label_cols or [k for k in item if k not in image_cols]
        for name in names:
            text, tags = _label_value(name, item.get(name), features)
            if text:
                row.labels[name] = text
                row.tags.extend(tags)
        yield row


def encode(image: Image.Image) -> tuple[bytes, str]:
    """Ảnh -> (bytes, đuôi file). Giữ PNG cho ảnh trong suốt, còn lại JPEG; thu nhỏ ảnh quá lớn."""
    if getattr(image, "is_animated", False):
        image.seek(0)
    if max(image.size) > MAX_SIDE:
        image = image.copy()
        image.thumbnail((MAX_SIDE, MAX_SIDE), Image.LANCZOS)
    buf = io.BytesIO()
    if image.mode in ("RGBA", "LA") or (image.mode == "P" and "transparency" in image.info):
        image.convert("RGBA").save(buf, "PNG", optimize=True)
        return buf.getvalue(), ".png"
    image.convert("RGB").save(buf, "JPEG", quality=92)
    return buf.getvalue(), ".jpg"


def dataset_tag(source: str) -> str:
    """Tag nhóm mọi ảnh của dataset, vd not-lain/meme-dataset -> memedataset."""
    name = Path(source).name if Path(source).exists() else source.split("/")[-1]
    return (normalize_hashtags([name]) or ["dataset"])[0]


def describe(row: Row, source: str, split: str, tags: list[str]) -> tuple[str, str]:
    """(tiêu đề, mô tả có hashtag) cho asset."""
    main = next((v for k, v in row.labels.items() if k.lower() in ("name", "title", "label", "caption", "text")), None)
    main = main or next(iter(row.labels.values()), None)
    title = (main or f"{source.split('/')[-1]} #{row.index}")[:120]
    lines = [f"{k}: {v}" for k, v in row.labels.items()]
    lines.append(f"Nguồn: dataset {source} (split {split}, dòng {row.index})")
    hashtags = normalize_hashtags(tags + row.tags)[:15]
    text = "\n".join(lines)[: MAX_DESCRIPTION_CHARS - 200]
    return title, f"{text}\n{' '.join('#' + t for t in hashtags)}".strip()


def _safe_name(text: str, limit: int) -> str:
    return re.sub(r"[^\w-]+", "_", text).strip("_")[:limit]


def _upload(server: str, data: bytes, ext: str, title: str, description: str) -> bool:
    """Tải lên web app; trả về True nếu là asset mới (False nếu đã có ảnh trùng nội dung)."""
    for attempt in range(4):
        try:
            resp = requests.post(
                f"{server.rstrip('/')}/api/assets",
                params={"filename": f"{_safe_name(title, 60) or 'image'}{ext}", "title": title,
                        "description": description},
                data=data, headers={"Content-Type": "application/octet-stream"}, timeout=120,
            )
        except requests.ConnectionError as e:
            if attempt == 3:
                raise DatasetError(f"Không kết nối được web app tại {server}. Hãy chạy `npm run dev` trong web/ "
                                   "(hoặc đặt --server).") from e
            time.sleep(2 * (attempt + 1))
            continue
        if resp.status_code >= 500 and attempt < 3:
            time.sleep(2 * (attempt + 1))
            continue
        if resp.status_code >= 400:
            try:
                message = resp.json().get("error")
            except ValueError:
                message = resp.text[:200]
            raise DatasetError(f"Web app từ chối ảnh: {message}")
        return not resp.json().get("existed")
    return False


def run_import(
    source: str, split: str = "train", config: str | None = None, limit: int | None = None,
    server: str | None = "http://localhost:3000", out_dir: Path | None = None, tags: list[str] | None = None,
    image_col: str | None = None, label_cols: list[str] | None = None, streaming: bool = True,
) -> dict:
    tags = normalize_hashtags((tags or []) + [dataset_tag(source)])
    print(f"Đang mở dataset {source} (split {split}{', streaming' if streaming else ''}) ...", flush=True)
    ds = _load(source, split, config, streaming)
    if out_dir:
        out_dir.mkdir(parents=True, exist_ok=True)
    stats = {"added": 0, "existed": 0, "skipped": 0}
    for row in iter_rows(ds, image_col, label_cols, limit):
        try:
            data, ext = encode(row.image)
        except (OSError, ValueError) as e:
            stats["skipped"] += 1
            print(f"  ⚠️  Bỏ qua dòng {row.index}: ảnh lỗi ({e})", flush=True)
            continue
        title, description = describe(row, source, split, tags)
        if out_dir:
            # Mô tả trong <tên>.txt cạnh ảnh: dùng được với --library-dir
            stem = f"{row.index:05d}_{_safe_name(title, 50)}".rstrip("_")
            (out_dir / f"{stem}{ext}").write_bytes(data)
            (out_dir / f"{stem}.txt").write_text(description, encoding="utf-8")
            stats["added"] += 1
        else:
            new = _upload(server or "http://localhost:3000", data, ext, title, description)
            stats["added" if new else "existed"] += 1
        done = sum(stats.values())
        if done % 10 == 0:
            print(f"  {done} ảnh: {stats['added']} mới, {stats['existed']} đã có, {stats['skipped']} lỗi", flush=True)
    target = str(out_dir) if out_dir else f"Assets ({server})"
    print(f"✅ Xong: {stats['added']} ảnh mới, {stats['existed']} đã có sẵn, {stats['skipped']} lỗi → {target}", flush=True)
    if not out_dir and stats["added"]:
        print(f"   Web app đang tự phân tích ảnh (đọc chữ + AI tóm tắt, phân loại). Lọc theo tag #{tags[-1]} ở trang Assets.",
              flush=True)
    return stats


def main(argv: list[str]) -> int:
    import argparse

    parser = argparse.ArgumentParser(
        prog="videogen import-dataset",
        description="Nhập ảnh từ dataset Hugging Face (hoặc thư mục/parquet) vào Assets, kèm nhãn để AI phân loại.",
    )
    parser.add_argument("source", help="Tên dataset trên Hugging Face (vd not-lain/meme-dataset) hoặc đường dẫn trên máy")
    parser.add_argument("--split", default="train")
    parser.add_argument("--config", help="Tên config/subset của dataset (nếu có)")
    parser.add_argument("--limit", type=int, help="Số ảnh tối đa (mặc định: tất cả)")
    parser.add_argument("--server", default="http://localhost:3000", help="Địa chỉ web app (mặc định http://localhost:3000)")
    parser.add_argument("--out", type=Path, help="Chỉ lưu ảnh + mô tả .txt vào thư mục này, không tải lên web app")
    parser.add_argument("--tag", action="append", default=[], help="Hashtag thêm cho mọi ảnh (lặp lại được)")
    parser.add_argument("--image-col", help="Tên cột ảnh (mặc định: tự tìm)")
    parser.add_argument("--label-col", action="append", help="Cột dùng làm nhãn (lặp lại được; mặc định: tự tìm)")
    parser.add_argument("--no-streaming", action="store_true", help="Tải toàn bộ dataset trước (dùng khi streaming lỗi)")
    args = parser.parse_args(argv)
    try:
        run_import(
            args.source, args.split, args.config, args.limit, args.server, args.out, args.tag,
            args.image_col, args.label_col, streaming=not args.no_streaming,
        )
    except DatasetError as e:
        print(f"❌ {e}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("\nĐã dừng (ảnh đã nhập vẫn được giữ).", file=sys.stderr)
        return 130
    return 0
