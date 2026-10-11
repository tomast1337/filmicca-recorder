// Runs INSIDE the container. Starts a virtual screen (Xvfb) and virtual sound
// card (PulseAudio), launches Google Chrome (bundled Widevine) in kiosk mode,
// logs in, plays the film and records screen + sound with ffmpeg.
// Because the screen and audio are private to the container, nothing on your
// computer (sounds, windows, notifications) can end up in the recording.
//
// Args: <watch-url> [--test seconds]
// Env:  FILMICCA_EMAIL, FILMICCA_PASSWORD
import { chromium } from "playwright-core";
import { spawn, $ } from "bun";
import { join } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "fs";

const args = process.argv.slice(2);
const url = args.find((a) => a.startsWith("http"));
const ti = args.indexOf("--test");
const testSecs = ti >= 0 ? Number(args[ti + 1]) : 0;
if (!url) {
  console.error("usage: record-container.ts <watch-url> [--test seconds]");
  process.exit(1);
}

const ORIGIN = "https://assista.filmicca.com.br";
const LOGIN_PATH = "/log-in";
const SEL = {
  email: 'input[name="identity"]',
  password: 'input[name="accessKey"]',
  submit: "button.e2e-log-in-btn",
  play: 'button[data-cy="play-button"]',
};
const COOKIE_TEXT = /Usamos cookies para garantir/;
const TITLE_STRIP = / - Assistir.*$/i;
const OUT = "/out";
const PROFILE = "/home/rec/profile";
const W = 1920;
const H = 1080;
const PORT = 9222;
const TOTAL = 9;

const procs: ReturnType<typeof spawn>[] = [];
let recorder: ReturnType<typeof spawn> | undefined;
let page: Awaited<ReturnType<Awaited<ReturnType<typeof chromium.connectOverCDP>>["newPage"]>> | undefined;
let cleaned = false;

async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  if (recorder) {
    (recorder.stdin as { write?: (s: string) => unknown } | undefined)?.write?.("q"); // ffmpeg finalizes the file on 'q'
    recorder.kill("SIGINT");
    await Promise.race([recorder.exited, Bun.sleep(15_000)]).catch(() => {});
  }
  for (const p of procs.reverse()) p.kill();
}
process.on("SIGTERM", async () => { await cleanup(); process.exit(143); });
process.on("SIGINT", async () => { await cleanup(); process.exit(130); });

class StepError extends Error {
  constructor(public n: number, public label: string, public reason: string, public hint: string) {
    super(reason);
  }
}
async function step<T>(n: number, label: string, hint: string, fn: () => Promise<T>): Promise<T> {
  console.log(`[${n}/${TOTAL}] ${label}...`);
  try {
    return await fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new StepError(n, label, msg.split("\n")[0] ?? msg, hint);
  }
}

async function waitFor(check: () => Promise<boolean>, ms: number, what: string) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check().catch(() => false)) return;
    await Bun.sleep(300);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function describePage(): Promise<string[]> {
  if (!page || page.isClosed()) return [];
  const lines = [`page url: ${page.url()}`];
  try {
    await page.screenshot({ path: join(OUT, "debug-record.png") });
    lines.push("screenshot: downloads/debug-record.png");
    const text = await page.evaluate(() => document.body?.innerText ?? "");
    const err = text.split("\n").map((l) => l.trim())
      .filter((l) => /erro|error|\b\d{4}\b|n[aã]o foi poss/i.test(l)).slice(0, 5);
    if (err.length) lines.push(`error text on page: ${err.join(" | ")}`);
    lines.push(await page.evaluate(() => {
      const v = document.querySelector("video") as HTMLVideoElement | null;
      return v ? `video: readyState=${v.readyState} duration=${v.duration} error=${v.error?.message ?? "none"}` : "video: no <video> element";
    }));
  } catch {}
  return lines;
}

try {
  await step(1, "Starting virtual screen and sound card", "Container is missing xvfb/pulseaudio: rebuild the image", async () => {
    procs.push(spawn(["Xvfb", ":99", "-screen", "0", `${W}x${H}x24`, "-nolisten", "tcp"], { stdout: "ignore", stderr: "inherit" }));
    await waitFor(async () => existsSync("/tmp/.X11-unix/X99"), 10_000, "Xvfb");
    mkdirSync(process.env.XDG_RUNTIME_DIR!, { recursive: true, mode: 0o700 });
    await $`pulseaudio --daemonize=yes --exit-idle-time=-1 --log-target=stderr`.quiet();
    await waitFor(async () => (await $`pactl info`.quiet().nothrow()).exitCode === 0, 10_000, "PulseAudio");
    await $`pactl load-module module-null-sink sink_name=rec sink_properties=device.description=rec`.quiet();
    await $`pactl set-default-sink rec`.quiet();
  });

  const browser = await step(2, "Starting Google Chrome (with Widevine)", "Chrome failed to start; check the docker logs above", async () => {
    // Turn off the password manager and translate so no popup bubble ends up in the recording.
    // A previous container may have left profile locks behind.
    for (const f of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) rmSync(`${PROFILE}/${f}`, { force: true });
    mkdirSync(`${PROFILE}/Default`, { recursive: true });
    const prefsPath = `${PROFILE}/Default/Preferences`;
    let prefs: Record<string, any> = {};
    try { prefs = JSON.parse(readFileSync(prefsPath, "utf8")); } catch {}
    prefs.credentials_enable_service = false;
    prefs.profile = { ...(prefs.profile ?? {}), password_manager_enabled: false };
    prefs.translate = { ...(prefs.translate ?? {}), enabled: false };
    writeFileSync(prefsPath, JSON.stringify(prefs));
    procs.push(spawn([
      "google-chrome-stable", "--disable-features=PasswordLeakDetection,PasswordManagerOnboarding,Translate,TranslateUI,MediaRouter", "--no-sandbox", "--kiosk", `--window-size=${W},${H}`, "--window-position=0,0",
      `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
      "--no-first-run", "--no-default-browser-check", "--disable-dev-shm-usage",
      "--autoplay-policy=no-user-gesture-required", "--lang=pt-BR", "about:blank",
    ], { stdout: "ignore", stderr: "ignore" }));
    await waitFor(async () => (await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok, 30_000, "Chrome debug port");
    return chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  });
  const ctx = browser.contexts()[0];
  if (!ctx) throw new StepError(2, "Starting Google Chrome", "no browser context", "Rebuild the image and retry");

  const title = await step(3, "Opening the film page", "Check your internet connection and the URL", async () => {
    page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    return (await page.title()).replace(TITLE_STRIP, "").replace(/[\\/:*?"<>|]/g, "_").trim() || "video";
  });
  console.log(`      film: ${title}`);

  await step(4, "Logging in (if needed) and pressing play",
    "Check FILMICCA_EMAIL / FILMICCA_PASSWORD in .env, and that your subscription includes this film",
    async () => {
      const pg = page!;
      const playBtn = pg.locator(SEL.play).first();
      const seesPlay = () => playBtn.waitFor({ state: "visible", timeout: 10_000 }).then(() => true, () => false);
      if (!(await seesPlay())) {
        const email = process.env.FILMICCA_EMAIL;
        const password = process.env.FILMICCA_PASSWORD;
        if (!email || !password) throw new Error("not logged in and FILMICCA_EMAIL / FILMICCA_PASSWORD are not set");
        console.log(`      signing in as ${email}`);
        await pg.goto(`${ORIGIN}${LOGIN_PATH}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
        const pw = pg.locator(SEL.password);
        if (await pw.waitFor({ state: "visible", timeout: 10_000 }).then(() => true, () => false)) {
          await pg.locator(SEL.email).fill(email);
          await pw.fill(password);
          await Promise.all([
            pg.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {}),
            pg.locator(SEL.submit).click(),
          ]);
          await Bun.sleep(2000);
          if (await pw.isVisible().catch(() => false)) throw new Error("login form still showing: wrong email/password, or captcha/2FA");
        }
        await pg.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        if (!(await seesPlay())) throw new Error("logged in, but no play button: no active subscription for this film?");
      }
      await playBtn.click();
    });

  const video = page!.locator("video").first();
  await step(5, "Waiting for the video player to load",
    "Player probably showed an error (6012 = Widevine not working). See the screenshot/error text above", async () => {
      await video.waitFor({ state: "attached", timeout: 30_000 });
      await page!.waitForFunction(() => {
        const v = document.querySelector("video") as HTMLVideoElement | null;
        return !!v && v.readyState >= 2 && Number.isFinite(v.duration) && v.duration > 0;
      }, undefined, { timeout: 60_000 });
    });

  const duration = await step(6, "Preparing the picture (hide cookie banner, fill screen, rewind)",
    "The page layout may have changed; see the screenshot", async () => {
      await page!.evaluate(() => {
        const els = [...document.querySelectorAll("div, section, aside, footer")].filter((e) =>
          COOKIE_TEXT.test(e.textContent ?? ""));
        const banner = els.sort((a, b) => (a.textContent?.length ?? 0) - (b.textContent?.length ?? 0))[0] as HTMLElement | undefined;
        if (!banner) return;
        (banner.querySelector("button, [role=button]") as HTMLElement | null)?.click();
        banner.style.setProperty("display", "none", "important");
      }).catch(() => {});
      await page!.addStyleTag({
        content: `* { cursor: none !important; }
          video { position: fixed !important; inset: 0 !important; width: 100vw !important;
                  height: 100vh !important; z-index: 2147483647 !important;
                  object-fit: contain !important; background: #000 !important; }`,
      });
      const d = await video.evaluate((v: HTMLVideoElement) => { v.pause(); v.currentTime = 0; return v.duration; });
      await Bun.sleep(1500);
      return d;
    });
  console.log(`      duration: ${(duration / 60).toFixed(1)} min${testSecs ? ` (test: recording ${testSecs}s)` : ""}`);

  const file = join(OUT, `${title}${testSecs ? ".test" : ""}.mkv`);
  await step(7, `Starting the recorder -> ${file.replace(OUT, "downloads")}`, "ffmpeg failed to start; see its message above", async () => {
    recorder = spawn([
      "ffmpeg", "-y", "-loglevel", "warning",
      "-f", "x11grab", "-framerate", "30", "-video_size", `${W}x${H}`, "-i", ":99",
      "-f", "pulse", "-i", "rec.monitor",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "192k", file,
    ], { stdin: "pipe", stdout: "inherit", stderr: "inherit" });
    await Bun.sleep(1500);
    if (recorder.exitCode !== null) throw new Error(`ffmpeg exited immediately (code ${recorder.exitCode})`);
    await video.evaluate((v: HTMLVideoElement) => { v.muted = false; v.volume = 1; return v.play(); });
  });

  await step(8, testSecs ? `Recording for ${testSecs}s (test)` : `Recording until the film ends (~${(duration / 60).toFixed(0)} min)`,
    "Playback may have stalled; see the screenshot", async () => {
      if (testSecs) {
        await Bun.sleep(testSecs * 1000);
      } else {
        await page!.waitForFunction(() => {
          const v = document.querySelector("video") as HTMLVideoElement | null;
          return !v || v.ended || v.currentTime >= v.duration - 0.5;
        }, undefined, { timeout: (duration + 120) * 1000, polling: 1000 });
        await Bun.sleep(1000);
      }
    });

  console.log(`[9/${TOTAL}] Finalizing the file...`);
  await cleanup();
  console.log(`\n✓ Saved: ${file.replace(OUT, "downloads")}`);
} catch (e) {
  process.exitCode = 1;
  if (e instanceof StepError) {
    console.error(`\n✗ FAILED at step ${e.n}/${TOTAL}: ${e.label}`);
    console.error(`  reason: ${e.reason}`);
    for (const l of await describePage()) console.error(`  ${l}`);
    console.error(`  what to do: ${e.hint}`);
  } else {
    console.error("\n✗ FAILED:", e instanceof Error ? e.message : String(e));
  }
} finally {
  await cleanup();
}
process.exit(process.exitCode ?? 0);
