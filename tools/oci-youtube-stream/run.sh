#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
export DISPLAY=:99 TZ=Asia/Tokyo
work=/home/ubuntu/qzss-stream
mkdir -p "$work"
mkdir -p "$work/segments"
cd "$work"
children=()
cleanup() {
  trap - EXIT TERM INT
  for pid in "${children[@]}"; do kill "$pid" 2>/dev/null || true; done
}
trap cleanup EXIT
trap 'exit 0' TERM INT

Xvfb :99 -screen 0 1280x720x24 -nolisten tcp &
display_pid=$!; children+=("$display_pid")
ready=0
for attempt in {1..30}; do
  kill -0 "$display_pid" 2>/dev/null || exit 1
  if xdotool getdisplaygeometry >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[[ "$ready" == 1 ]] || exit 1

python3 /opt/qzss-stream/browser_guard.py &
chrome_pid=$!; children+=("$chrome_pid")
sleep 20
xdotool key Escape || true

stream_pid=''
if [[ -n "${QZSS_YT_SERVER:-}" && -n "${QZSS_YT_KEY:-}" ]]; then
  [[ "$QZSS_YT_SERVER" == rtmps://* ]] || { echo 'RTMPS URL required'; exit 1; }
  touch "$work/ffmpeg.progress"
  # FFmpeg errors can contain the destination URL and secret key．Keep them
  # out of the journal; retain only the latest attempt in a private file．
  ffmpeg -hide_banner -nostdin -loglevel warning -nostats \
    -progress "$work/ffmpeg.progress" \
    -f x11grab -framerate 15 -video_size 1280x720 -draw_mouse 0 -i :99.0 \
    -re -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=44100 \
    -map 0:v:0 -map 1:a:0 -c:v libx264 -preset ultrafast \
    -tune zerolatency -threads:v 1 -pix_fmt yuv420p -r 15 \
    -g 30 -keyint_min 30 -sc_threshold 0 \
    -b:v 1500k -minrate 1500k -maxrate 1500k -bufsize 3000k \
    -x264-params 'nal-hrd=cbr:force-cfr=1' \
    -c:a aac -b:a 128k -ar 44100 -ac 2 -flags +global_header \
    -f tee -use_fifo 1 \
    -fifo_options 'attempt_recovery=1:recover_any_error=1:recovery_wait_time=5:drop_pkts_on_overflow=1:queue_size=120' \
    "[f=hls:use_fifo=0:hls_time=10:hls_list_size=18:hls_delete_threshold=6:hls_flags=delete_segments+program_date_time+independent_segments:strftime=1:hls_segment_filename=$work/segments/segment-%Y%m%d-%H%M%S.ts]$work/segments/index.m3u8|[f=flv]${QZSS_YT_SERVER%/}/${QZSS_YT_KEY}" \
    > /dev/null 2> "$work/ffmpeg-private.log" &
  stream_pid=$!; children+=("$stream_pid")
else
  echo 'Preview mode: YouTube credentials are not configured．'
fi

while sleep 10; do
  for pid in "${children[@]}"; do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo 'A supervised process stopped; restarting the stack．'
      exit 1
    fi
  done
  if [[ -n "$stream_pid" ]]; then
    modified=$(stat -c %Y "$work/ffmpeg.progress")
    if (( $(date +%s) - modified > 90 )); then
      echo 'FFmpeg progress stalled for over 90 seconds; restarting the stack．'
      exit 1
    fi
  fi
done
