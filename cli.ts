#!/usr/bin/env bun
// Host CLI: records Filmicca films inside Docker. Same behaviour as docker-record.sh, but it can be
// compiled into one executable (`bun run build`), with the Docker files embedded in it.
//
// Usage: filmicca-rec <watch-url> [<watch-url> ...] [--file urls.txt] [--test seconds]
// Needs Docker, and FILMICCA_EMAIL / FILMICCA_PASSWORD in the environment or in a .env file in the
// current directory. Recordings go to ./downloads.
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error Bun embeds extensionless files as a path string
import dockerfilePath from "./docker/Dockerfile" with { type: "file" };
import packageJsonPath from "./docker/package.json" with { type: "file" };
// @ts-expect-error Bun embeds this file as a path string, not as a module
import recorderPath from "./docker/record-container.ts" with { type: "file" };

const IMAGE = "filmicca-rec";
const VOLUME = "filmicca-profile";

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function usage(): never {
  fail("usage: filmicca-rec <watch-url> [<watch-url> ...] [--file urls.txt] [--test seconds]");
}

async function parseArgs(argv: string[]) {
  const urls: string[] = [];
  let testSecs: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--file") {
      const file = argv[++i];
      if (!file || !existsSync(file)) fail("--file needs an existing file");
      for (const raw of (await Bun.file(file).text()).split("\n")) {
        const line = raw.replace(/#.*/, "").trim();
        if (line) urls.push(line);
      }
    } else if (a === "--test") {
      const n = argv[++i];
      if (!n || !/^\d+$/.test(n)) fail("--test needs a number of seconds");
      testSecs = n;
    } else if (a.startsWith("http")) {
      urls.push(a);
    } else {
      console.error(`unknown argument: ${a}`);
      usage();
    }
  }
  if (urls.length === 0) usage();
  const unique = [...new Set(urls)];
  for (const u of urls) if (unique.indexOf(u) !== urls.indexOf(u)) console.log(`skipping duplicate: ${u}`);
  return { urls: unique, testSecs };
}

async function run(cmd: string[], quiet = false) {
  const proc = Bun.spawn(cmd, {
    stdin: "inherit",
    stdout: quiet ? "pipe" : "inherit",
    stderr: quiet ? "pipe" : "inherit",
  });
  const code = await proc.exited;
  const out = quiet ? await new Response(proc.stdout as unknown as ReadableStream).text() : "";
  return { code, out };
}

async function buildImage() {
  // The Dockerfile expects docker/<file> inside the build context, so rebuild that layout in a temp dir.
  const ctx = mkdtempSync(join(tmpdir(), "filmicca-rec-"));
  try {
    mkdirSync(join(ctx, "docker"));
    await Bun.write(join(ctx, "docker/Dockerfile"), Bun.file(dockerfilePath));
    await Bun.write(join(ctx, "docker/package.json"), Bun.file(packageJsonPath as unknown as string));
    await Bun.write(join(ctx, "docker/record-container.ts"), Bun.file(recorderPath));
    console.log("building image (first time only, a few minutes)...");
    const uid = String(process.getuid?.() ?? 1000);
    const { code } = await run([
      "docker", "build", "-f", join(ctx, "docker/Dockerfile"),
      "--build-arg", `UID=${uid}`, "-t", IMAGE, ctx,
    ]);
    if (code !== 0) fail("docker build failed");
  } finally {
    rmSync(ctx, { recursive: true, force: true });
  }
}

const { urls, testSecs } = await parseArgs(Bun.argv.slice(2));

if (!process.env.FILMICCA_EMAIL || !process.env.FILMICCA_PASSWORD) {
  fail("missing FILMICCA_EMAIL / FILMICCA_PASSWORD (set them or put them in .env in this directory)");
}
const docker = await run(["docker", "version", "--format", "{{.Server.Version}}"], true).catch(() => null);
if (!docker || docker.code !== 0) fail("docker is not available (is it installed and running?)");

const hasImage = (await run(["docker", "images", "-q", IMAGE], true)).out.trim() !== "";
if (!hasImage || process.env.REBUILD === "1") await buildImage();

const downloads = join(process.cwd(), "downloads");
mkdirSync(downloads, { recursive: true });

let interrupted = false;
process.on("SIGINT", () => {
  console.log("\ninterrupted");
  interrupted = true;
});

const ok: string[] = [];
const failed: string[] = [];
const line = "=".repeat(62);

for (const [i, url] of urls.entries()) {
  if (interrupted) break;
  console.log(`\n${line}\n Film ${i + 1} of ${urls.length}: ${url}\n${line}`);
  // Named volume keeps the Chrome profile (login, Widevine) between runs. Credentials are passed by
  // name only, so they never show up in the process list.
  const { code } = await run([
    "docker", "run", "--rm", "--shm-size=2g",
    "-e", "FILMICCA_EMAIL", "-e", "FILMICCA_PASSWORD",
    "-v", `${VOLUME}:/home/rec/profile`,
    "-v", `${downloads}:/out`,
    IMAGE, url, ...(testSecs ? ["--test", testSecs] : []),
  ]);
  if (code === 0) ok.push(url);
  else {
    failed.push(url);
    console.log(`!! failed: ${url} (continuing with the next one)`);
  }
}

console.log(`\n${line}`);
console.log(` Summary: ${ok.length} ok, ${failed.length} failed, ${urls.length - ok.length - failed.length} not run`);
for (const u of ok) console.log(`  ✓ ${u}`);
for (const u of failed) console.log(`  ✗ ${u}`);
console.log(line);
process.exit(failed.length === 0 && !interrupted ? 0 : 1);
