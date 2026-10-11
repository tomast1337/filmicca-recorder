# filmicca

Tools for making a personal offline copy of a film you can watch on
[Filmicca](https://assista.filmicca.com.br) with your own subscription.

Filmicca's streams are protected with Widevine/PlayReady DRM, so they **cannot be downloaded**, and this
project does not decrypt them. Instead it **records what the licensed player shows on screen**, inside a
Docker container with its own virtual screen and sound card.
> Keep recordings for personal use. Do not redistribute them.

## Quick start

Requirements: [Docker](https://www.docker.com), and a Filmicca account with access to the film.

```bash
cp .env.example .env      # then put your Filmicca email and password in it
./docker-record.sh 'https://assista.filmicca.com.br/watch/<id>'
```

The recording is saved to `downloads/<film title>.mkv`.

Several films at once: they are recorded one after another, a failure does not stop the rest, and a
summary is printed at the end.

```bash
./docker-record.sh '<url-1>' '<url-2>' '<url-3>'
./docker-record.sh --file urls.txt             # one URL per line; blank lines and # comments are ignored
```

```bash
./docker-record.sh '<watch-url>' --test 20     # record only 20 seconds (per film), to check picture and sound
REBUILD=1 ./docker-record.sh '<watch-url>'     # rebuild the image after changing code
```

The first run builds the image (a few minutes). The `watch` URL is the page you get when you open a film
on the site while logged in.

## Standalone executable

`cli.ts` does the same as `docker-record.sh` and can be compiled into one binary that has the Docker files
embedded. Docker is still required on the machine that runs it.

```bash
bun run build                                   # creates dist/filmicca-rec
./dist/filmicca-rec '<watch-url>' [--file urls.txt] [--test 20]
```

Run it from a directory that has the `.env` (or set `FILMICCA_EMAIL` and `FILMICCA_PASSWORD` in the
environment). Recordings go to `./downloads` in that directory. The first run builds the Docker image from
the embedded files.

### Releases

Pushing a tag that matches the `package.json` version builds the executables (Linux x64, macOS x64 and
arm64, Windows x64) and publishes them, with checksums, as a GitHub release (`.github/workflows/release.yml`):

```bash
# bump "version" in package.json, commit, then:
git tag v1.0.0 && git push origin v1.0.0
```

The executables only run the Docker recorder, so each machine needs Docker. Only Linux x64 has been tested.
`.github/workflows/ci.yml` builds the executable on every push and pull request.

## How the Docker recorder works

- **Virtual screen and sound:** Xvfb (1920x1080) and a private PulseAudio sink inside the container, so
  nothing from your computer can end up in the recording and you can keep using the machine.
- **Browser:** Google Chrome (it bundles Widevine) in kiosk mode, driven over the DevTools port.
- **Login:** `FILMICCA_EMAIL` / `FILMICCA_PASSWORD` from `.env`, passed with `--env-file`. A Docker volume
  (`filmicca-profile`) keeps the Chrome profile between runs.
- **Picture:** the video is forced to fill the screen, the cursor is hidden, the cookie banner is removed,
  and Chrome's password-save and Translate bubbles are turned off.
- **Recording:** ffmpeg (`x11grab` + PulseAudio monitor), H.264 1080p30 + AAC 192k, MKV.
- **Real time:** a 77-minute film takes 77 minutes. Expect roughly 25 MB per minute.
- **Errors:** numbered steps (`[1/9]` to `[9/9]`). On failure it prints the failing step, the reason, any
  error text on the page, a hint, and saves `downloads/debug-record.png`.

## Other scripts

- `record.ts`: records in a browser on your own desktop instead of Docker (sway + wf-recorder). Start
  Chromium with `--remote-debugging-port=9222 --user-data-dir=$HOME/.config/chromium-rec` and Widevine
  installed (on Arch: `chromium-widevine`), then `bun record.ts '<watch-url>' [--test 20] [--listen]`.
  It takes over the screen while recording, so the Docker version is usually better.

## Troubleshooting

- **Player error 6012 or a black picture:** Widevine is not working in that browser. The Docker image uses
  Chrome, which bundles it. For `record.ts`, install Widevine and restart the browser so it loads.
- **"no play button" / login fails:** check your email and password in `.env` and that your subscription
  includes the film. A captcha or 2FA on the login page would stop the automatic login.
- **Selectors stopped working:** the login form, play button and cookie banner are matched by selectors
  at the top of each script (`SEL`, `COOKIE_TEXT`). Update them if the site changes.

## Layout

- `docker-record.sh`, `docker/`: Docker screen recorder (recommended)
- `cli.ts`: the same recorder as a CLI that compiles to a standalone executable
- `record.ts`: desktop screen recorder
- `.env`: your credentials (git-ignored); `.env.example` is the template
