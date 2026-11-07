"""ffmpeg đi kèm imageio-ffmpeg (không phụ thuộc ffmpeg cài trên máy)."""


def ffmpeg_exe() -> str:
    import imageio_ffmpeg

    return imageio_ffmpeg.get_ffmpeg_exe()
