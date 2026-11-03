#!/usr/bin/env bash
set -euo pipefail
export DISPLAY=${DISPLAY:-:99}
export RUYI_LOGIN_DISPLAY=vnc
export RUYI_UPLOAD_DIR=${RUYI_UPLOAD_DIR:-/data/upload}
timeout=${RUYI_SHUTDOWN_TIMEOUT_SECONDS:-30}
if [[ ! $timeout =~ ^[1-9][0-9]*$ ]]; then
  echo '退出等待时间必须为正整数秒' >&2
  exit 2
fi
pids=()
app_pid=''
cleaning=0
stop_signal=TERM
alive() { kill -0 -- "-$1" 2>/dev/null; }
signal_group() { kill -s "$1" -- "-$2" 2>/dev/null || true; }
cleanup() {
  [[ $cleaning -eq 0 ]] || return 0
  cleaning=1
  trap '' TERM INT
  # npm 会先退出；等待整个进程组，给 Node 内嵌 Worker 留出停止时间。
  if [[ -n $app_pid ]]; then
    signal_group "$stop_signal" "$app_pid"
    deadline=$((SECONDS + timeout))
    while alive "$app_pid" && [[ $SECONDS -lt $deadline ]]; do sleep 0.1; done
  fi
  for pid in ${pids[@]+"${pids[@]}"}; do signal_group TERM "$pid"; done
  deadline=$((SECONDS + 3))
  while [[ $SECONDS -lt $deadline ]]; do
    remaining=0
    for pid in ${pids[@]+"${pids[@]}"}; do alive "$pid" && remaining=1; done
    [[ $remaining -eq 1 ]] || break
    sleep 0.1
  done
  for pid in ${pids[@]+"${pids[@]}"}; do signal_group KILL "$pid"; done
  for pid in ${pids[@]+"${pids[@]}"}; do wait "$pid" 2>/dev/null || true; done
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'stop_signal=INT; exit 130' INT

mkdir -p "$RUYI_UPLOAD_DIR"
setsid Xvfb "$DISPLAY" -screen 0 1440x1000x24 -nolisten tcp &
pids+=("$!")
ready=0
for attempt in {1..50}; do
  kill -0 "${pids[0]}" 2>/dev/null || break
  if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then ready=1; break; fi
  sleep 0.1
done
if [[ $ready -ne 1 ]]; then
  echo '虚拟桌面启动失败' >&2
  exit 1
fi
setsid openbox &
pids+=("$!")
setsid x11vnc -display "$DISPLAY" -localhost -rfbport 5900 -forever -shared -nopw &
pids+=("$!")
setsid npm start &
app_pid=$!
pids+=("$app_pid")

# 任一必需服务退出都使容器失败，避免桌面失效时应用仍继续接受扫码请求。
while true; do
  for pid in ${pids[@]+"${pids[@]}"}; do
    if ! kill -0 "$pid" 2>/dev/null; then
      status=0
      wait "$pid" || status=$?
      [[ $status -ne 0 ]] || status=1
      echo '必需服务已退出，正在停止容器' >&2
      exit "$status"
    fi
  done
  sleep 0.1
done
