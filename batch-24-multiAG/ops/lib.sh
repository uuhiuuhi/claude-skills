#!/usr/bin/env bash
# ops/lib.sh — 운영 도구 공통 설정. 프로젝트 고유값을 스크립트에 박지 않는다.
# 정하는 순서: 환경변수 → 러너 폴더의 tools/auto/auto.config.json → 기본값.
#   AUTO_RUNNER_DIR        러너(무인 배치가 도는 저장소 복사본) 폴더. 없으면 현재 폴더.
#   AUTO_BATCH_STATE_DIR   상태 폴더(runner.lock · slots.log). 없으면 config.stateDir → ~/.claude-auto/<project>
#   AUTO_RUNNER_TASK       윈도우 예약작업 이름. 없으면 config.watchdog.runnerTask → <project>-auto-slots
RUNNER="${AUTO_RUNNER_DIR:-$(pwd)}"
CFG="$RUNNER/tools/auto/auto.config.json"
[ -f "$CFG" ] || { echo "설정 파일 없음: $CFG — AUTO_RUNNER_DIR 를 러너 폴더로 지정하세요" >&2; exit 2; }
_cfg() { node "$(dirname "${BASH_SOURCE[0]}")/cfg.mjs" "$CFG" "$1"; }
PROJECT="$(_cfg project)"; PROJECT="${PROJECT:-$(basename "$RUNNER")}"
STATE="${AUTO_BATCH_STATE_DIR:-$(_cfg stateDir)}"; STATE="${STATE:-$HOME/.claude-auto/$PROJECT}"
STATE="${STATE/#\~/$HOME}"
# 윈도우 경로(C:/…)를 Git Bash 경로(/c/…)로
case "$STATE" in [A-Za-z]:*) STATE="$(cygpath -u "$STATE")";; esac
TASK="${AUTO_RUNNER_TASK:-$(_cfg watchdog.runnerTask)}"; TASK="${TASK:-$PROJECT-auto-slots}"
LOCK="$STATE/runner.lock"; SLOTS="$STATE/slots.log"; GAPLOG="$STATE/gap-apply.log"; PIN="$STATE/runtime-pin.json"
OPS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROUND_DONE_MARK="완주 — 남은 일이 있는지 다시 편성한다"   # run-night 이 라운드 사이에 찍는 줄(워커 0 인 순간)
