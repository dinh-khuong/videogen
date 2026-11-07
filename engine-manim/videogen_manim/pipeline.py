"""Điều phối engine Manim: kịch bản, ảnh/clip và giọng đọc chuẩn bị y như engine cũ (videogen.pipeline.prepare), âm thanh
trộn bằng cùng code (videogen_core.audio.mix), chỉ phần hình được dựng bằng ManimGL (render.VideoScene)."""
import random
from pathlib import Path

from videogen.effects import ALL_MOTIONS, MOTIONS, WHOOSH_TRANSITIONS, color_filter, pick_transitions
from videogen.pipeline import (
    TITLE_CARD_SECONDS, Options, Prepared, RunResult, StepImage, _style_for, motion_for, prepare, slugify,
)
from videogen.style import step_label, tagline
from videogen.video_builder import SILENT_SCENE, Segment, _seed
from videogen_core.audio.mix import AUDIO_RATE, SceneAudio, build_track, decode_audio, write_wav
from videogen_core.audio.tts import load_words

from .render import Look, ScenePlan, Timeline, VideoScene

FPS = 30


def _plan_scenes(prepared: Prepared, opts: Options) -> tuple[list[ScenePlan], list[SceneAudio]]:
    """Kế hoạch dựng hình và âm thanh của từng cảnh, cùng bố cục cảnh với engine cũ (mở đầu, các bước, lời kết; hoặc mỗi
    bước một cảnh với Đạo diễn AI)."""
    script, style, lang = prepared.script, opts.style, prepared.lang
    pacing = style.timing
    head = pacing.head
    intro_imgs, outro_imgs = prepared.bookend_images()
    plans: list[ScenePlan] = []
    audios: list[SceneAudio] = []

    def add(images: list[StepImage], key: str, narration: str, step=None, index: int = -1, pop: bool = False,
            not_before: float = 0.0, **extra) -> None:
        path = prepared.audio.get(key)
        speech = decode_audio(path) if path else None
        speech_len = len(speech) / AUDIO_RATE if speech is not None else 0.0
        duration = head + speech_len + pacing.tail if speech is not None else SILENT_SCENE
        plan = ScenePlan(
            segments=[Segment(img.path, img.media, _style_for(img, opts)) for img in images], motions=[],
            duration=duration, head=head, speech=speech_len, narration=narration,
            words=load_words(path) if path else None, **extra,
        )
        sounds = []
        if step:
            overlay = prepared.overlays[index] if 0 <= index < len(prepared.overlays) else None
            taken = None
            if overlay and step.overlay:
                taken = step.overlay["position"]
                plan.overlay = (overlay.path, overlay.media, taken, max(0.25, not_before))
            events = prepared.line_events(step, index, path, head, not_before, taken)
            plan.visuals = events.visuals
            plan.camera = [(head + t, kind) for t, kind in events.camera]
            sounds = [(head + t, ref) for t, ref in events.sounds]
            plan.motions = [motion_for(step, index)]
        # Tiếng "tách" khi nhãn/lớp chữ xuất hiện (như engine cũ: chỉ khi cảnh có lớp hình phủ)
        shows_layer = plan.title or plan.badge or plan.meme or plan.cta_start is not None or \
            (plan.overlay and plan.overlay[1] != "video")
        plans.append(plan)
        audios.append(SceneAudio(speech, [0.2] if pop and shows_layer else [], sounds))

    if prepared.director:
        for i, step in enumerate(script.steps):
            # Tiêu đề lớn chiếm giữa khung vài giây đầu: chữ meme, sticker, chữ nhấn mạnh hiện sau đó
            clear_at = TITLE_CARD_SECONDS if step.title_card else 0.0
            extra: dict = {}
            if step.title_card:
                extra.update(title=(script.title, ""), title_end=TITLE_CARD_SECONDS)
            elif step.heading:
                extra["badge"] = ("", step.heading)
            if step.meme:
                extra["meme"] = (step.meme.get("top", ""), step.meme.get("bottom", ""), max(0.1, clear_at))
            if i == len(script.steps) - 1 and style.cta:
                extra["cta_start"] = 1.0
            add(prepared.steps[i], f"step_{i + 1:02d}", step.narration, step, i, bool(step.heading), clear_at, **extra)
    else:
        add(intro_imgs, "intro", script.intro, title=(script.title, tagline(lang, opts.video_type, len(script.steps))))
        for i, step in enumerate(script.steps):
            add(prepared.steps[i], f"step_{i + 1:02d}", step.narration, step, i, True,
                badge=(step_label(lang, opts.video_type, i + 1), step.heading))
        if script.outro or style.cta:
            add(outro_imgs, "outro", script.outro, pop=True, badge=(lang.done, ""),
                cta_start=0.35 if style.cta else None)
    for audio, sound in zip(audios, prepared.enter_sounds(opts)):
        audio.enter_sound = sound
    return plans, audios


def _choose_motions(plans: list[ScenePlan], min_segment: float, rng: random.Random) -> None:
    """Chuyển động từng đoạn ảnh, rút từ cùng chuỗi ngẫu nhiên và theo đúng thứ tự như engine cũ (video_builder._build_scene)
    để sau đó chọn ra cùng các kiểu chuyển cảnh — nhờ vậy tiếng "vút" rơi đúng chỗ như bản dựng bằng engine cũ."""
    for plan in plans:
        chosen = plan.motions[0] if plan.motions and plan.motions[0] in ALL_MOTIONS else None
        plan.segments = plan.segments[: max(1, int(plan.duration // min_segment))]
        motions: list[str | None] = []
        last = None
        for seg in plan.segments:
            if seg.media == "video":
                motions.append(None)
                continue
            if chosen and last is None:
                last = chosen
            else:
                last = rng.choice([m for m in MOTIONS if m != last])
            motions.append(last)
        plan.motions = motions


def run(
    topic: str | None,
    out_path: str | None,
    script_path: str | None,
    opts: Options,
    script_data: dict | None = None,
) -> RunResult:
    """Chạy toàn bộ pipeline với phần dựng hình bằng ManimGL (cùng tham số và kết quả với videogen.pipeline.run)."""
    prepared = prepare(topic, script_path, opts, script_data)
    result = prepared.result
    if opts.script_only:
        return result
    reporter, style, work_dir = opts.reporter, opts.style, prepared.work_dir
    pacing = style.timing
    plans, audios = _plan_scenes(prepared, opts)
    rng = random.Random(_seed(plans))  # cùng hạt với engine cũ
    _choose_motions(plans, pacing.min_segment, rng)

    # Timeline như engine cũ: cảnh sau bắt đầu chồng lên `transition` giây cuối của cảnh trước
    durations = [p.duration for p in plans]
    transition = min([pacing.transition] + [d / 3 for d in durations])
    starts = [0.0]
    for d in durations[:-1]:
        starts.append(starts[-1] + d - transition)
    total = starts[-1] + durations[-1]
    kinds = pick_transitions(style.transition, len(plans) - 1, rng)
    timeline = Timeline(starts, durations, transition, kinds, total)

    print(f"[4/4] Dựng video {prepared.layout} ({len(plans)} cảnh) bằng ManimGL ...", flush=True)
    reporter.stage("render", f"Đang dựng video {prepared.layout} (ManimGL)")
    if prepared.bg_video:
        print(f"      Video nền: {prepared.bg_video}", flush=True)
    final_out = Path(out_path) if out_path else work_dir / f"{slugify(prepared.script.title)}.mp4"
    thumbnail = final_out.with_suffix(".jpg")
    track = build_track(audios, starts, pacing.head, total, transition, kinds, WHOOSH_TRANSITIONS, opts.music,
                        opts.music_volume, style.sfx, style.transition_sound)
    audio_path = write_wav(track, work_dir / f"{final_out.stem}.manim-audio.wav")
    look = Look(
        size=prepared.size, frame_size=prepared.frame_size, fonts=prepared.fonts, accent=style.accent,
        subtitles=style.subtitles_for(prepared.size), zoom=pacing.zoom, clip_push=pacing.clip_push,
        segment_blend=pacing.segment_blend, grade=color_filter(style.color_filter), logo=style.logo,
        progress_bar=style.progress_bar, bg_video=prepared.bg_video, cta=style.cta,
    )
    scene = VideoScene(plans, timeline, look, final_out, audio_path, work_dir, fps=FPS, thumbnail=thumbnail,
                       progress=lambda f: reporter.stage("render", f"Đang render {f:.0%}", f))
    try:
        scene.run()
    finally:
        audio_path.unlink(missing_ok=True)
    result.duration = total
    result.video, result.thumbnail, result.size = final_out, thumbnail, prepared.frame_size
    reporter.stage("render", "Hoàn tất", 1.0)
    print(f"✅ Hoàn tất! Video: {final_out.resolve()}", flush=True)
    return result
