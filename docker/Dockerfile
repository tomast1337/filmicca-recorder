FROM debian:bookworm-slim

ARG UID=1000
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates wget gnupg xvfb pulseaudio pulseaudio-utils ffmpeg procps \
      fonts-liberation fonts-noto-color-emoji \
 && wget -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
 && apt-get install -y --no-install-recommends /tmp/chrome.deb \
 && rm -rf /tmp/chrome.deb /var/lib/apt/lists/*

COPY --from=oven/bun:1 /usr/local/bin/bun /usr/local/bin/bun

RUN mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix \
 && useradd -m -u ${UID} rec && mkdir -p /out /app /home/rec/profile \
 && chown -R rec /out /app /home/rec

WORKDIR /app
COPY docker/package.json ./
RUN bun install
COPY docker/record-container.ts ./

USER rec
ENV HOME=/home/rec XDG_RUNTIME_DIR=/tmp/runtime-rec DISPLAY=:99
ENTRYPOINT ["bun", "/app/record-container.ts"]
