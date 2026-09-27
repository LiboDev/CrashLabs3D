"""
Runs one headless Codex agent per image job, in parallel, using Codex's built-in image
generation tool. Each agent gets the shared style brief, the job prompt and real game
screenshots as references, and must save exactly one PNG to the job's output path.

Usage:
  python marketing/run_codex_jobs.py            # all jobs
  python marketing/run_codex_jobs.py icon logo  # only these ids
Logs: marketing/_jobs/<id>.log
"""
import json
import os
import shutil
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CFG = json.load(open(os.path.join(ROOT, "marketing", "jobs.json"), encoding="utf-8"))
CODEX = shutil.which("codex") or "codex"


def build_prompt(job):
    extra = ""
    if job.get("background") == "transparent":
        extra = " Request a transparent background from the image tool so the PNG has an alpha channel."
    return (
        "You are generating marketing art. Use your built-in image generation tool (do not draw with code, "
        "SVG, canvas or Python; do not download images). Generate exactly ONE image, "
        f"orientation/size {job['size']}.{extra}\n\n"
        f"STYLE BRIEF: {CFG['style']}\n\n"
        f"IMAGE: {job['prompt']}\n\n"
        f"When the image is generated, copy the PNG file to this exact path (relative to the current directory): {job['out']} "
        "- overwrite if it exists. Do not create any other files. Reply with only the saved path."
    )


def main(ids):
    jobs = [j for j in CFG["jobs"] if not ids or j["id"] in ids]
    os.makedirs(os.path.join(ROOT, "marketing", "_jobs"), exist_ok=True)
    procs = []
    for job in jobs:
        out = os.path.join(ROOT, job["out"])
        if os.path.exists(out):
            os.remove(out)
        cmd = [CODEX, "exec", "--skip-git-repo-check", "-s", "workspace-write"]
        for r in job.get("refs", []):
            if os.path.exists(os.path.join(ROOT, r)):
                cmd += ["-i", r]
        cmd.append("-")  # prompt from stdin (avoids Windows argument-length/quoting issues)
        log = open(os.path.join(ROOT, "marketing", "_jobs", f"{job['id']}.log"), "w", encoding="utf-8")
        p = subprocess.Popen(cmd, cwd=ROOT, stdin=subprocess.PIPE, stdout=log, stderr=subprocess.STDOUT)
        p.stdin.write(build_prompt(job).encode("utf-8"))
        p.stdin.close()
        procs.append((job, p, log, time.time()))
        print(f"started {job['id']}", flush=True)
        time.sleep(2)  # stagger starts a little
    for job, p, log, t0 in procs:
        code = p.wait(timeout=1500)
        log.close()
        ok = os.path.exists(os.path.join(ROOT, job["out"]))
        print(f"{job['id']:18s} exit={code} saved={ok} {time.time() - t0:.0f}s", flush=True)


if __name__ == "__main__":
    main(sys.argv[1:])
