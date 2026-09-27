"""
Builds the final store / marketing kit from:
  marketing/raw/*.png            AI key art from the headless Codex agents (run_codex_jobs.py)
  marketing/screenshots/<dev>/   real in-game captures (capture.py)
  marketing/preview/frames-*/    fixed-timestep gameplay frames (capture.py)

Output: marketing/dist/...  plus marketing/dist/manifest.json (every file with its size).
Usage:  python marketing/build_assets.py
"""
import json
import os
import shutil
import subprocess

from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(ROOT, "raw")
SHOTS = os.path.join(ROOT, "screenshots")
DIST = os.path.join(ROOT, "dist")
manifest = []


def out(rel):
    p = os.path.join(DIST, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    return p


def save(img, rel, **kw):
    p = out(rel)
    if rel.endswith(".jpg"):
        img.convert("RGB").save(p, quality=90, optimize=True, progressive=True)
    else:
        img.save(p, optimize=True, **kw)
    manifest.append({"file": rel.replace("\\", "/"), "width": img.width, "height": img.height})


def load(name):
    p = os.path.join(RAW, name)
    return Image.open(p).convert("RGBA") if os.path.exists(p) else None


def cover(img, w, h, focus=(0.5, 0.5)):
    """Scale to fill w x h, then crop around a focus point (fractions of the source)."""
    s = max(w / img.width, h / img.height)
    r = img.resize((max(w, round(img.width * s)), max(h, round(img.height * s))), Image.LANCZOS)
    x = min(max(0, round(r.width * focus[0] - w / 2)), r.width - w)
    y = min(max(0, round(r.height * focus[1] - h / 2)), r.height - h)
    return r.crop((x, y, x + w, y + h))


def fit(img, w, h):
    """Scale to fit inside w x h keeping aspect (for logo placement)."""
    s = min(w / img.width, h / img.height)
    return img.resize((max(1, round(img.width * s)), max(1, round(img.height * s))), Image.LANCZOS)


def trim_alpha(img):
    bbox = img.getchannel("A").point(lambda a: 255 if a > 12 else 0).getbbox()
    return img.crop(bbox) if bbox else img


def logo_image():
    lg = load("logo.png")
    if lg is None:
        return None
    # If the model returned an opaque background, key out the dominant corner colour.
    if lg.getchannel("A").getextrema()[0] == 255:
        bg = lg.getpixel((4, 4))[:3]
        px = lg.load()
        for y in range(lg.height):
            for x in range(lg.width):
                r, g, b, _ = px[x, y]
                d = abs(r - bg[0]) + abs(g - bg[1]) + abs(b - bg[2])
                if d < 60:
                    px[x, y] = (r, g, b, 0 if d < 30 else int((d - 30) / 30 * 255))
    lg = trim_alpha(lg)
    save(lg, "logo/logo-transparent.png")
    for w in (1024, 512, 256):
        save(fit(lg, w, w), f"logo/logo-{w}w.png")
    return lg


def with_logo(img, logo, box):
    """box = (x, y, w, h) fractions of the image; logo is fitted and centred in it with a soft shadow."""
    if logo is None:
        return img
    W, H = img.size
    bw, bh = int(box[2] * W), int(box[3] * H)
    lg = fit(logo, bw, bh)
    x = int(box[0] * W + (bw - lg.width) / 2)
    y = int(box[1] * H + (bh - lg.height) / 2)
    shadow = Image.new("RGBA", img.size, (0, 0, 0, 0))
    a = lg.getchannel("A").point(lambda v: int(v * 0.45))
    blob = Image.new("RGBA", lg.size, (20, 20, 50, 255))
    blob.putalpha(a)
    shadow.alpha_composite(blob, (x, y + max(4, lg.height // 30)))
    shadow = shadow.filter(ImageFilter.GaussianBlur(max(3, lg.height // 40)))
    res = img.copy()
    res.alpha_composite(shadow)
    res.alpha_composite(lg, (x, y))
    return res


# --------------------------------------------------------------------------- icons
def build_icons():
    src = load("icon.png")
    if src is None:
        print("! raw/icon.png missing")
        return
    sq = cover(src, 1024, 1024).convert("RGB").convert("RGBA")  # opaque, no transparency (store rule)
    for s in (1024, 512, 256, 192, 180, 128, 96, 64, 48, 32, 16):
        save(sq.resize((s, s), Image.LANCZOS).convert("RGB"), f"icons/icon-{s}.png")
    # Rounded + circle variants for previews / social avatars (these DO have transparency).
    for s in (512, 256):
        base = sq.resize((s, s), Image.LANCZOS)
        m = Image.new("L", (s, s), 0)
        ImageDraw.Draw(m).rounded_rectangle((0, 0, s - 1, s - 1), radius=int(s * 0.22), fill=255)
        r = base.copy(); r.putalpha(m); save(r, f"icons/icon-rounded-{s}.png")
        m = Image.new("L", (s, s), 0)
        ImageDraw.Draw(m).ellipse((0, 0, s - 1, s - 1), fill=255)
        c = base.copy(); c.putalpha(m); save(c, f"icons/icon-circle-{s}.png")
    # Favicon + web manifest icons for the game build itself.
    ico = out("icons/favicon.ico")
    sq.convert("RGB").save(ico, sizes=[(16, 16), (32, 32), (48, 48), (64, 64)])
    manifest.append({"file": "icons/favicon.ico", "width": 64, "height": 64})


# --------------------------------------------------------------------------- key art
# (name, raw file, w, h, focus, logo box or None)
COVERS = [
    ("banner-16x9-1920x1080", "cover-landscape.png", 1920, 1080, (0.5, 0.5), (0.03, 0.04, 0.42, 0.3)),
    ("banner-16x9-3840x2160", "cover-landscape.png", 3840, 2160, (0.5, 0.5), (0.03, 0.04, 0.42, 0.3)),
    ("banner-16x9-1280x720", "cover-landscape.png", 1280, 720, (0.5, 0.5), (0.03, 0.04, 0.42, 0.3)),
    ("banner-16x9-480x270", "cover-landscape.png", 480, 270, (0.5, 0.5), (0.03, 0.04, 0.45, 0.33)),
    ("banner-16x9-240x135", "cover-landscape.png", 240, 135, (0.5, 0.5), None),
    ("banner-9x16-1080x1920", "cover-portrait.png", 1080, 1920, (0.5, 0.5), (0.08, 0.03, 0.84, 0.17)),
    ("banner-9x16-270x480", "cover-portrait.png", 270, 480, (0.5, 0.5), (0.08, 0.03, 0.84, 0.17)),
    ("banner-9x16-135x240", "cover-portrait.png", 135, 240, (0.5, 0.5), None),
    ("phone-9x19.5-1170x2532", "cover-portrait.png", 1170, 2532, (0.5, 0.5), (0.08, 0.04, 0.84, 0.14)),
    ("tablet-3x4-1536x2048", "cover-portrait.png", 1536, 2048, (0.5, 0.55), (0.1, 0.03, 0.8, 0.17)),
    ("tablet-4x3-2048x1536", "cover-landscape.png", 2048, 1536, (0.5, 0.5), (0.03, 0.03, 0.44, 0.26)),
    ("square-1x1-1080", "cover-square.png", 1080, 1080, (0.5, 0.5), (0.04, 0.03, 0.5, 0.22)),
    ("square-1x1-512", "cover-square.png", 512, 512, (0.5, 0.5), (0.04, 0.03, 0.5, 0.22)),
    ("social-og-1200x630", "cover-landscape.png", 1200, 630, (0.5, 0.5), (0.03, 0.04, 0.42, 0.32)),
    ("social-x-1500x500", "cover-landscape.png", 1500, 500, (0.5, 0.36), (0.02, 0.08, 0.34, 0.5)),
    ("ultrawide-21x9-2560x1080", "cover-landscape.png", 2560, 1080, (0.5, 0.4), (0.03, 0.05, 0.34, 0.34)),
    ("youtube-thumb-1280x720", "cover-landscape.png", 1280, 720, (0.5, 0.5), (0.03, 0.04, 0.42, 0.3)),
]
EXTRA_ART = [
    ("boss-showdown-1920x1080", "boss.png", 1920, 1080),
    ("boss-showdown-1080x1080", "boss.png", 1080, 1080),
    ("vehicle-lineup-1920x1080", "lineup.png", 1920, 1080),
    ("vehicle-lineup-2560x1080", "lineup.png", 2560, 1080),
]


def build_covers(logo):
    for name, raw, w, h, focus, box in COVERS:
        src = load(raw)
        if src is None:
            print(f"! raw/{raw} missing ({name})")
            continue
        base = cover(src, w, h, focus)
        save(base, f"cover-art/clean/{name}.jpg")  # no logo (for platforms that add their own title)
        if box:
            save(with_logo(base, logo, box), f"cover-art/with-logo/{name}.jpg")
    for name, raw, w, h in EXTRA_ART:
        src = load(raw)
        if src is not None:
            save(cover(src, w, h), f"key-art/{name}.jpg")


# --------------------------------------------------------------------------- screenshots
STORE_SHOTS = ["02-first-smash", "04-monster-combo", "05-flamethrower", "06-invincible", "07-mega-bomb", "09-boss-showdown", "10-boss-destroyed", "08-mega-dozer"]


def build_screenshots():
    if not os.path.isdir(SHOTS):
        print("! no screenshots captured")
        return
    for dev in sorted(os.listdir(SHOTS)):
        for f in sorted(os.listdir(os.path.join(SHOTS, dev))):
            img = Image.open(os.path.join(SHOTS, dev, f)).convert("RGB")
            save(img, f"screenshots/{dev}/{f}")
    # Store-ready sets: exact 1920x1080 and 1080x1920 (captured natively at those sizes).
    for dev, tag in (("landscape-16x9", "16x9"), ("portrait-9x16", "9x16")):
        d = os.path.join(SHOTS, dev)
        if not os.path.isdir(d):
            continue
        for i, scene in enumerate(STORE_SHOTS, 1):
            p = os.path.join(d, scene + ".png")
            if os.path.exists(p):
                save(Image.open(p).convert("RGB"), f"store/screenshots-{tag}/{i:02d}-{scene[3:]}.jpg")


def contact_sheet():
    """One overview image of the whole kit for quick review."""
    files = [m for m in manifest if m["file"].endswith((".jpg", ".png")) and "/clean/" not in m["file"]
             and "screenshots/" not in m["file"] and "icons/icon-" not in m["file"]]
    thumbs = []
    for m in files[:40]:
        im = Image.open(os.path.join(DIST, m["file"])).convert("RGB")
        im.thumbnail((360, 360))
        thumbs.append(im)
    icon = os.path.join(DIST, "icons/icon-256.png")
    if os.path.exists(icon):
        thumbs.insert(0, Image.open(icon).convert("RGB").resize((200, 200)))
    cols, pad = 5, 12
    rows = (len(thumbs) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * (360 + pad) + pad, rows * (360 + pad) + pad), (27, 42, 74))
    for i, t in enumerate(thumbs):
        x = pad + (i % cols) * (360 + pad) + (360 - t.width) // 2
        y = pad + (i // cols) * (360 + pad) + (360 - t.height) // 2
        sheet.paste(t, (x, y))
    sheet.save(out("contact-sheet.jpg"), quality=85)


# --------------------------------------------------------------------------- previews
def ffmpeg():
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return shutil.which("ffmpeg")


def build_previews():
    exe = ffmpeg()
    for tag, (w, h) in (("landscape", (1920, 1080)), ("portrait", (1080, 1920))):
        d = os.path.join(ROOT, "preview", f"frames-{tag}")
        if not os.path.isdir(d) or not os.listdir(d):
            print(f"! no preview frames for {tag}")
            continue
        pattern = os.path.join(d, "%04d.png")
        if exe:
            mp4 = out(f"previews/gameplay-{tag}-{w}x{h}.mp4")
            subprocess.run([exe, "-y", "-loglevel", "error", "-framerate", "15", "-i", pattern,
                            "-vf", f"scale={w}:{h}:flags=lanczos,fps=30", "-c:v", "libx264", "-pix_fmt", "yuv420p",
                            "-crf", "20", "-preset", "medium", "-movflags", "+faststart", mp4], check=True)
            manifest.append({"file": f"previews/gameplay-{tag}-{w}x{h}.mp4", "width": w, "height": h})
            webm = out(f"previews/gameplay-{tag}-{w // 2}x{h // 2}.webm")
            subprocess.run([exe, "-y", "-loglevel", "error", "-framerate", "15", "-i", pattern,
                            "-vf", f"scale={w // 2}:{h // 2}:flags=lanczos", "-c:v", "libvpx-vp9", "-b:v", "0",
                            "-crf", "36", "-row-mt", "1", webm], check=True)
            manifest.append({"file": f"previews/gameplay-{tag}-{w // 2}x{h // 2}.webm", "width": w // 2, "height": h // 2})
        # Short looping GIF (first 6 s of action, small, for docs / social).
        frames = sorted(os.listdir(d))
        start = len(frames) // 5
        gif_w = 480 if tag == "landscape" else 270
        gif_h = round(gif_w * h / w)
        imgs = [Image.open(os.path.join(d, f)).convert("RGB").resize((gif_w, gif_h), Image.LANCZOS)
                for f in frames[start:start + 90:2]]
        if imgs:
            pal = [im.quantize(colors=128, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE) for im in imgs]
            p = out(f"previews/gameplay-{tag}-{gif_w}x{gif_h}.gif")
            pal[0].save(p, save_all=True, append_images=pal[1:], duration=int(1000 / 7.5), loop=0, optimize=True)
            manifest.append({"file": f"previews/gameplay-{tag}-{gif_w}x{gif_h}.gif", "width": gif_w, "height": gif_h})


if __name__ == "__main__":
    if os.path.isdir(DIST):
        shutil.rmtree(DIST)
    logo = logo_image()
    build_icons()
    build_covers(logo)
    build_screenshots()
    build_previews()
    contact_sheet()
    with open(out("manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
    print(f"built {len(manifest)} files into marketing/dist")
