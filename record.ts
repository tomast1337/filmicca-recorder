#!/usr/bin/env bun
// Usage: bun record.ts <watch-url> [--out dir] [--test seconds] [--listen] [--port 9222]
//
// Attaches to YOUR running Chromium/Brave/Chrome (logged in, Widevine working), opens
// the film in a new tab, fullscreens the window and records the screen with
// wf-recorder. The browser's audio is moved to a private PipeWire sink while
// recording, so only the film's sound is captured (no room/mic/system noise).
//
// Start the browser first, with the debug port and its own profile (recent
// Chromium ignores the port on the default profile):
//   chromium --remote-debugging-port=9222 --user-data-dir=$HOME/.config/chromium-rec
//
// --listen   also play the film's audio through your speakers while recording
// --test N   record only N seconds (to check the picture is not black)
//
// Needs sway (wf-recorder, swaymsg) and pactl. Nothing here touches DRM: it
// records what the licensed player shows on screen.
import { chromium } from "playwright";
import { spawn, $ } from "bun";
import { mkdirSync } from "fs";
import { join } from "path";

const args = process.argv.slice(2);
const url = args.find((a) => a.startsWith("http"));
const listen = args.includes("--listen");
const flagVal = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const outDir = flagVal("--out") ?? "downloads";
const testSecs = Number(flagVal("--test") ?? 0);
const port = flagVal("--port") ?? "9222";

if (!url) {
  console.error("usage: bun record.ts <watch-url> [--out dir] [--test seconds] [--listen] [--port 9222]");
  process.exit(1);
}

const SINK = "filmicca_rec";
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
mkdirSync(outDir, { recursive: true });

// --- audio helpers ---------------------------------------------------------
const pactl = async (...a: string[]) => (await $`pactl ${a}`.text()).trim();

type SinkInput = { index: number; sink: number; properties: Record<string, string> };

/** PIDs of the debug-port browser and all its children (the audio service is a child process). */
const browserPids = async (): Promise<Set<number>> => {
  const roots = (await $`pgrep -f ${`remote-debugging-port=${port}`}`.nothrow().text())
    .split("\n").map(Number).filter(Boolean);
  const table = (await $`ps -eo pid=,ppid=`.text()).trim().split("\n").map((l) => l.trim().split(/\s+/).map(Number) as [number, number]);
  const pids = new Set<number>(roots);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [pid, ppid] of table) if (pids.has(ppid) && !pids.has(pid)) { pids.add(pid); grew = true; }
  }
  return pids;
};

/** Only streams from the recording browser. Other Chromium/Electron apps (Spotify, Discord...) are left alone. */
const browserStreams = async (): Promise<SinkInput[]> => {
  const pids = await browserPids();
  const all = JSON.parse(await pactl("-f", "json", "list", "sink-inputs")) as SinkInput[];
  return all.filter((s) => pids.has(Number(s.properties["application.process.id"])));
};

const modules: string[] = [];
modules.push(await pactl("load-module", "module-null-sink", `sink_name=${SINK}`, `sink_properties=device.description=${SINK}`));
const recSinkIndex = JSON.parse(await pactl("-f", "json", "list", "sinks")).find(
  (s: { name: string }) => s.name === SINK,
).index as number;
if (listen) {
  modules.push(await pactl("load-module", "module-loopback", `source=${SINK}.monitor`, "latency_msec=60"));
}

/** Move every browser stream to the private sink; remember where each came from. */
const origin = new Map<number, number>();
async function captureAudio() {
  for (const s of await browserStreams()) {
    if (s.sink === recSinkIndex) continue;
    origin.set(s.index, s.sink);
    await pactl("move-sink-input", String(s.index), SINK).catch(() => {});
  }
}

// --- sway helpers ----------------------------------------------------------
type SwayNode = {
  focused?: boolean;
  app_id?: string;
  fullscreen_mode?: number;
  nodes?: SwayNode[];
  floating_nodes?: SwayNode[];
};
const focusedWindow = async (): Promise<SwayNode | undefined> => {
  const walk = (n: SwayNode): SwayNode | undefined => {
    if (n.focused) return n;
    for (const c of [...(n.nodes ?? []), ...(n.floating_nodes ?? [])]) {
      const f = walk(c);
      if (f) return f;
    }
  };
  return walk(JSON.parse(await $`swaymsg -t get_tree -r`.text()));
};

// --- lifecycle --------------------------------------------------------------
let recorder: ReturnType<typeof spawn> | undefined;
let page: Awaited<ReturnType<Awaited<ReturnType<typeof chromium.connectOverCDP>>["newPage"]>> | undefined;
let weFullscreened = false;
let cleaned = false;
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  if (recorder) {
    recorder.kill("SIGINT"); // lets wf-recorder finalize the file
    await recorder.exited.catch(() => {});
  }
  for (const [input, sink] of origin) await pactl("move-sink-input", String(input), String(sink)).catch(() => {});
  if (weFullscreened) await $`swaymsg fullscreen disable`.quiet().catch(() => {});
  await page?.close().catch(() => {});
  for (const m of [...modules].reverse()) await pactl("unload-module", m).catch(() => {});
}
process.on("SIGINT", async () => {
  console.log("\ninterrupted, finalizing...");
  await cleanup();
  process.exit(130);
});

// --- step runner: numbered progress and clear failures ----------------------
const TOTAL = 9;
class StepError extends Error {
  constructor(public n: number, public label: string, public cause_: string, public hint: string) {
    super(cause_);
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

/** Best-effort snapshot of what the page shows, to explain a failure. */
async function describePage(): Promise<string[]> {
  if (!page || page.isClosed()) return [];
  const lines: string[] = [`page url: ${page.url()}`];
  try {
    await page.screenshot({ path: "debug-record.png" });
    lines.push("screenshot: debug-record.png");
    const text = await page.evaluate(() => document.body?.innerText ?? "");
    const err = text.split("\n").map((l) => l.trim()).filter((l) => /erro|error|\b\d{4}\b|n[aã]o foi poss/i.test(l)).slice(0, 5);
    if (err.length) lines.push(`error text on page: ${err.join(" | ")}`);
    const v = await page.evaluate(() => {
      const el = document.querySelector("video") as HTMLVideoElement | null;
      return el ? `video: readyState=${el.readyState} duration=${el.duration} error=${el.error?.message ?? "none"}` : "video: no <video> element on page";
    });
    lines.push(v);
  } catch {}
  return lines;
}

const DEBUG_CMD = `chromium --remote-debugging-port=${port} --user-data-dir=$HOME/.config/chromium-rec`;

try {
  const browser = await step(1, `Connecting to browser on port ${port}`,
    `Start it first: ${DEBUG_CMD}  (quit other Chromium windows first; check: curl localhost:${port}/json/version)`,
    () => chromium.connectOverCDP(`http://localhost:${port}`));
  const ctx = browser.contexts()[0];
  if (!ctx) throw new StepError(1, "Connecting to browser", "no browser context found", "Open at least one window in the browser");

  const title = await step(2, "Opening the film page", "Check your internet and that the URL is a Site /watch/ link", async () => {
    page = await ctx.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.bringToFront();
    return (await page.title()).replace(TITLE_STRIP, "").replace(/[\\/:*?"<>|]/g, "_").trim() || "video";
  });
  console.log(`      film: ${title}`);

  await step(3, "Starting playback (login if needed, then play button)",
    "Set FILMICCA_EMAIL and FILMICCA_PASSWORD in .env, or log in manually in that browser window. Also check you have an active subscription",
    async () => {
      const pg = page!;
      const playBtn = pg.locator(SEL.play).first();
      const seesPlay = () => playBtn.waitFor({ state: "visible", timeout: 10_000 }).then(() => true, () => false);
      if (!(await seesPlay())) {
        // Not logged in (the watch page is public but has no play button): sign in.
        const email = process.env.FILMICCA_EMAIL;
        const password = process.env.FILMICCA_PASSWORD;
        if (!email || !password) throw new Error("not logged in and FILMICCA_EMAIL / FILMICCA_PASSWORD are not set in .env");
        console.log(`      not logged in, signing in as ${email}`);
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
          if (await pw.isVisible().catch(() => false)) throw new Error("login form still showing: wrong email/password, or a captcha/2FA is required");
        }
        await pg.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        if (!(await seesPlay())) throw new Error("logged in, but no play button: no active subscription for this film?");
      }
      await playBtn.click();
    });

  const video = page!.locator("video").first();
  await step(4, "Waiting for the video player to load",
    "Player may have shown an error (e.g. 6012 = Widevine/DRM not working in this browser). See the screenshot/error text below. Check chrome://components for Widevine",
    async () => {
      await video.waitFor({ state: "attached", timeout: 30_000 });
      await page!.waitForFunction(
        () => {
          const v = document.querySelector("video") as HTMLVideoElement | null;
          return !!v && v.readyState >= 2 && Number.isFinite(v.duration) && v.duration > 0;
        },
        undefined,
        { timeout: 60_000 },
      );
    });

  await step(5, "Making the video fill the window", "The page layout may have changed; check debug-record.png", async () => {
    // Dismiss the cookie banner (click its close button, then hide it for good).
    await page!.evaluate(() => {
      const els = [...document.querySelectorAll("div, section, aside, footer")].filter((e) =>
        COOKIE_TEXT.test(e.textContent ?? ""),
      );
      const banner = els.sort((a, b) => (a.textContent?.length ?? 0) - (b.textContent?.length ?? 0))[0] as HTMLElement | undefined;
      if (!banner) return;
      (banner.querySelector("button, [role=button]") as HTMLElement | null)?.click();
      banner.style.setProperty("display", "none", "important");
    }).catch(() => {});
    await page!.addStyleTag({
      content: `
        * { cursor: none !important; }
        video { position: fixed !important; inset: 0 !important; width: 100vw !important;
                height: 100vh !important; z-index: 2147483647 !important;
                object-fit: contain !important; background: #000 !important; }`,
    });
    const win = await focusedWindow();
    if (!win || !/brave|chrom/i.test(win.app_id ?? "")) {
      throw new Error(`focused window is "${win?.app_id ?? "none"}", not the browser`);
    }
    if (!win.fullscreen_mode) {
      await $`swaymsg fullscreen enable`.quiet();
      weFullscreened = true;
    }
  }).catch((e) => {
    if (e instanceof StepError) e.hint = "Click the browser window to focus it, then rerun (sway must see it as the focused window)";
    throw e;
  });

  // Play briefly so the browser opens its audio stream, move it to the private
  // sink, then rewind to 0 and record from the start.
  const duration = await step(6, "Routing the film's audio to the private sink",
    "Is `pactl` working? Check: pactl info", async () => {
      await video.evaluate((v: HTMLVideoElement) => { v.muted = false; v.volume = 1; return v.play(); });
      for (let i = 0; i < 20 && !origin.size; i++) {
        await captureAudio();
        if (!origin.size) await Bun.sleep(250);
      }
      if (!origin.size) {
        console.warn("      warning: no browser audio stream found; the recording may be silent");
      } else {
        console.log(`      moved ${origin.size} audio stream(s)`);
      }
      const d = await video.evaluate((v: HTMLVideoElement) => {
        v.pause();
        v.currentTime = 0;
        return v.duration;
      });
      await Bun.sleep(1500);
      return d;
    });
  console.log(`      duration: ${(duration / 60).toFixed(1)} min${testSecs ? ` (test: recording ${testSecs}s)` : ""}`);

  const file = join(outDir, `${title}${testSecs ? ".test" : ""}.mkv`);
  await step(7, `Starting the screen recorder -> ${file}`,
    "Needs wf-recorder and a sway session (check: swaymsg -t get_outputs)", async () => {
      const outputs = JSON.parse(await $`swaymsg -t get_outputs -r`.text()) as { name: string; focused: boolean }[];
      const output = (outputs.find((o) => o.focused) ?? outputs[0])?.name;
      if (!output) throw new Error("no sway output found");
      console.log(`      screen: ${output}`);
      recorder = spawn(["wf-recorder", "-o", output, `--audio=${SINK}.monitor`, "-f", file, "-y"], {
        stdout: "inherit",
        stderr: "inherit",
      });
      await Bun.sleep(1000);
      if (recorder.exitCode !== null) throw new Error(`wf-recorder exited immediately (code ${recorder.exitCode})`);
      await video.evaluate((v: HTMLVideoElement) => v.play());
      // Catch a reopened audio stream (the browser may recreate it after the pause).
      for (let i = 0; i < 8; i++) {
        await captureAudio();
        await Bun.sleep(500);
      }
    });

  await step(8, testSecs ? `Recording for ${testSecs}s (test)` : `Recording until the film ends (~${(duration / 60).toFixed(0)} min, do not touch the computer)`,
    "Playback may have stalled or the tab was closed; check debug-record.png", async () => {
      if (testSecs) {
        await Bun.sleep(testSecs * 1000);
      } else {
        await page!.waitForFunction(
          () => {
            const v = document.querySelector("video") as HTMLVideoElement | null;
            return !v || v.ended || v.currentTime >= v.duration - 0.5;
          },
          undefined,
          { timeout: (duration + 120) * 1000, polling: 1000 },
        );
        await Bun.sleep(1000);
      }
    });

  console.log(`[9/${TOTAL}] Finalizing the file and restoring audio/fullscreen...`);
  await cleanup();
  console.log(`\n✓ Saved: ${file}`);
} catch (e) {
  process.exitCode = 1;
  if (e instanceof StepError) {
    console.error(`\n✗ FAILED at step ${e.n}/${TOTAL}: ${e.label}`);
    console.error(`  reason: ${e.cause_}`);
    for (const l of await describePage()) console.error(`  ${l}`);
    console.error(`  what to do: ${e.hint}`);
  } else {
    console.error("\n✗ FAILED:", e instanceof Error ? e.message : String(e));
  }
} finally {
  await cleanup();
}
process.exit(process.exitCode ?? 0);
