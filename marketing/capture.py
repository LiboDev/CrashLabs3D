"""
Captures REAL gameplay screenshots and preview clips from the running dev server.

Usage:  python marketing/capture.py   (dev server must be running on :5173)

Outputs (marketing/):
  screenshots/<device>/NN-<scene>.png   raw in-game captures per device size
  ref/                                   reference frames handed to the image agents
  preview/frames-<device>/               frames for GIF/MP4 previews
"""
import os
import sys
import time
from playwright.sync_api import sync_playwright

URL = "http://localhost:5173/?debug&dpr=3"
G = "window.__game"
ROOT = os.path.dirname(os.path.abspath(__file__))

# CSS viewport -> device scale factor. Pixel sizes are native (no resampling later):
DEVICES = {
    "portrait-9x16": ((360, 640), 3),     # 1080x1920  store screenshot (9:16)
    "landscape-16x9": ((640, 360), 3),    # 1920x1080  store screenshot (16:9)
    "phone-tall": ((390, 844), 3),        # 1170x2532  modern phone (~9:19.5)
    "phone-wide": ((844, 390), 3),        # 2532x1170
    "tablet-portrait": ((768, 1024), 2),  # 1536x2048  (3:4)
    "tablet-landscape": ((1024, 768), 2), # 2048x1536  (4:3)
    "desktop-1440p": ((1280, 720), 2),    # 2560x1440  (16:9)
}

BOT = """() => { const g = window.__game; const pw = g.effPower; let best = null, bd = 1e9;
  const t = [...g.props.filter(p => p.state === 'idle' && p.def.power <= pw), ...g.pickups, ...g.ramps];
  for (const p of t) { const dd = p.d - g.d; if (dd < 2 || dd > 35) continue; if (dd < bd) { bd = dd; best = p; } }
  return best ? best.x - g.x : 0; }"""


def steer(page, w, h, dur):
    """Drive toward smashable targets for `dur` seconds (mouse held)."""
    end = time.time() + dur
    while time.time() < end:
        tx = page.evaluate(BOT)
        page.mouse.move(w / 2 + max(-1, min(1, tx / 3)) * min(w, h) * 0.2, h * 0.7)
        time.sleep(0.08)


def boot(browser, w, h, scale=2):
    page = browser.new_page(viewport={"width": w, "height": h}, device_scale_factor=scale)
    page.goto(URL)
    page.wait_for_function("window.__game !== undefined", timeout=30000)
    time.sleep(1.2)
    return page


def shoot_device(browser, name, w, h, scale):
    out = os.path.join(ROOT, "screenshots", name)
    os.makedirs(out, exist_ok=True)
    shot = lambda page, n, scene: page.screenshot(path=os.path.join(out, f"{n:02d}-{scene}.png"))

    # 1. Title / attract
    page = boot(browser, w, h, scale)
    shot(page, 1, "title")
    # 2. Early smashing (shopping cart)
    page.mouse.move(w / 2, h * 0.7)
    page.mouse.down()
    steer(page, w, h, 3.2)
    shot(page, 2, "first-smash")
    # 3. Upgrade moment
    page.evaluate(f"{G}.debugUpgrade()")
    time.sleep(0.25)
    shot(page, 3, "upgrade")
    steer(page, w, h, 1.5)
    # 4. Mid-tier combo chaos (monster truck)
    for _ in range(3):
        page.evaluate(f"{G}.debugUpgrade()")
        time.sleep(0.8)
    steer(page, w, h, 3.5)
    shot(page, 4, "monster-combo")
    # 5. Flamethrower
    page.evaluate(f"{G}.activatePower('flame', {G}.fx.target.clone())")
    steer(page, w, h, 1.7)
    shot(page, 5, "flamethrower")
    # 6. Invincible rainbow
    steer(page, w, h, 5)
    page.evaluate(f"{G}.activatePower('speed', {G}.fx.target.clone())")
    steer(page, w, h, 1.9)
    shot(page, 6, "invincible")
    # 7. Mega bomb
    steer(page, w, h, 3.5)
    page.evaluate(f"{G}.activatePower('bomb', {G}.fx.target.clone())")
    time.sleep(0.22)
    shot(page, 7, "mega-bomb")
    page.mouse.up()
    page.close()

    # 8-9. Mega Dozer vs boss tank + victory
    page = boot(browser, w, h, scale)
    page.mouse.click(w / 2, h * 0.7)
    for _ in range(6):
        page.evaluate(f"{G}.debugUpgrade()")
        time.sleep(0.8)
    page.mouse.move(w / 2, h * 0.7)
    page.mouse.down()
    steer(page, w, h, 3)
    shot(page, 8, "mega-dozer")
    page.mouse.up()
    page.evaluate(f"{G}.time = 60; {G}.finaleActive = true; {G}.finaleTimer = 0.05")
    page.wait_for_function(f"{G}.boss && {G}.boss.phase === 'charge'", timeout=20000)
    time.sleep(0.9)
    shot(page, 9, "boss-showdown")
    page.wait_for_function(f"{G}.boss && {G}.boss.exploded", timeout=20000)
    time.sleep(0.12)
    shot(page, 10, "boss-destroyed")
    page.wait_for_function(f"{G}.state === 'end'", timeout=20000)
    time.sleep(1.8)
    shot(page, 11, "victory")
    page.close()


def record_preview(browser, name, w, h, scale, seconds=15, fps=15):
    """Fixed-timestep capture (?capture): the game only advances 1/fps per frame we grab,
    so the preview plays back smoothly regardless of how slow rendering is here."""
    out = os.path.join(ROOT, "preview", f"frames-{name}")
    os.makedirs(out, exist_ok=True)
    for f in os.listdir(out):
        os.remove(os.path.join(out, f))
    page = browser.new_page(viewport={"width": w, "height": h}, device_scale_factor=scale)
    page.goto(URL.replace("dpr=3", f"dpr={scale}") + "&capture")
    page.wait_for_function("window.__game !== undefined", timeout=30000)
    time.sleep(1)
    page.mouse.move(w / 2, h * 0.7)
    page.mouse.down()
    step = lambda k=1: page.evaluate(f"() => {{ for (let i = 0; i < {k}; i++) {G}.step({1 / fps}); }}")
    step(int(fps * 1.2))  # pre-roll so the clip opens on action
    total = int(seconds * fps)
    # Scripted beats: early smashing -> upgrade -> upgrade -> flamethrower -> invincible -> bomb.
    events = {int(total * 0.18): "up", int(total * 0.36): "up", int(total * 0.5): "up",
              int(total * 0.58): "flame", int(total * 0.78): "speed", int(total * 0.93): "bomb"}
    t0 = time.time()
    for n in range(total):
        ev = events.get(n)
        if ev == "up":
            page.evaluate(f"{G}.debugUpgrade()")
        elif ev:
            page.evaluate(f"{G}.activatePower('{ev}', {G}.fx.target.clone())")
        tx = page.evaluate(BOT)
        page.mouse.move(w / 2 + max(-1, min(1, tx / 3)) * min(w, h) * 0.2, h * 0.7)
        step()
        page.screenshot(path=os.path.join(out, f"{n:04d}.png"))
    page.mouse.up()
    page.close()
    print(f"  preview {name}: {total} frames in {time.time() - t0:.1f}s")


if __name__ == "__main__":
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
        only = sys.argv[1:]
        for name, ((w, h), scale) in DEVICES.items():
            if only and name not in only:
                continue
            print("capturing", name, flush=True)
            shoot_device(browser, name, w, h, scale)
        if not only or "preview" in only:
            record_preview(browser, "landscape", 1280, 720, 1.5)  # 1920x1080
            record_preview(browser, "portrait", 540, 960, 2)  # 1080x1920
        browser.close()
    print("done")
