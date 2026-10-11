# filmicca

Tools for making a personal offline copy of a film you can watch on
[Filmicca](https://assista.filmicca.com.br) with your own subscription.

Filmicca's streams are protected with Widevine/PlayReady DRM, so they **cannot be downloaded**, and this
project does not decrypt them. Instead it **records what the licensed player shows on screen**, inside a
Docker container with its own virtual screen and sound card.
> Keep recordings for personal use. Do not redistribute them.

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

## Troubleshooting

- **Player error 6012 or a black picture:** Widevine is not working in that browser. The Docker image uses
  Chrome, which bundles it. For `record.ts`, install Widevine and restart the browser so it loads.
- **"no play button" / login fails:** check your email and password in `.env` and that your subscription
  includes the film. A captcha or 2FA on the login page would stop the automatic login.
- **Selectors stopped working:** the login form, play button and cookie banner are matched by selectors
  at the top of each script (`SEL`, `COOKIE_TEXT`). Update them if the site changes.
