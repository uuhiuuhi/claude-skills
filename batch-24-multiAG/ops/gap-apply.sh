#!/usr/bin/env bash
# [지금감시중] ops/gap-apply.sh — 돌고 있는 러너의 「라운드 경계」에 끼어들어 문서·설정 묶음을 적용·커밋하고 재개한다.
#
# 왜: 러너는 일이 남으면 같은 프로세스가 다음 라운드를 이어 돌아 lock 을 놓지 않는다. lock 이 사라지길 기다리면
#     며칠도 안 온다. 워커가 0 인 유일한 순간 = run-night 이 「라운드 N 완주」 줄을 찍은 직후다.
# 순서: 예약 끔 → 경계(또는 lock 부재) 대기 → 러너 트리 정지 → 엔진 장부 커밋 → 잔여물 stash →
#       적용 스크립트 실행 → 커밋 → (tools/auto 가 바뀌었으면 런타임 핀 재기록) → 예약 켬 + 기동(trap).
# 사용: AUTO_RUNNER_DIR=<러너 폴더> bash gap-apply.sh --go <적용스크립트.sh> "<커밋 메시지>" [--wait-min 180] [--add "경로 …"]
#       AUTO_RUNNER_DIR=<러너 폴더> bash gap-apply.sh --go --hold            # 경계에서 세우기만(재개 안 함 · 릴리스 준비용)
# 취소: <상태 폴더>/gap-apply.cancel 파일을 만든다.
# 주의: 적용 스크립트는 **사본에서 먼저 검산**하고, 실패 시 비0 으로 끝나게 쓴다(실패하면 작업 트리를 되돌린다).
#       한 라운드가 --wait-min 보다 길면 「적용 생략」으로 끝난다 — 라운드 길이에 맞춰 넉넉히 주거나 다시 건다.
set -u
[ "${1:-}" = "--go" ] || { echo "인자 --go 없음 — 아무것도 하지 않음(안전장치)"; exit 0; }
shift
HOLD=0; APPLY=""; MSG=""; WAIT_MIN=180; ADD="_bmad-output tools/auto"
while [ $# -gt 0 ]; do
  case "$1" in
    --hold) HOLD=1 ;;
    --wait-min) WAIT_MIN="$2"; shift ;;
    --add) ADD="$ADD $2"; shift ;;
    *) if [ -z "$APPLY" ]; then APPLY="$1"; else MSG="$1"; fi ;;
  esac
  shift
done
if [ "$HOLD" -eq 0 ]; then
  [ -n "$APPLY" ] && [ -n "$MSG" ] || { echo "적용 스크립트와 커밋 메시지가 필요합니다"; exit 2; }
fi
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
CANCEL="$STATE/gap-apply.cancel"
say() { echo "$(date '+%F %T') [gap-apply] $*" | tee -a "$GAPLOG"; }
psx() { powershell -NoProfile -Command "$1" | tr -d '\r'; }
enable_slots() { psx "Enable-ScheduledTask -TaskName '$TASK' | Out-Null; Start-ScheduledTask -TaskName '$TASK'; (Get-ScheduledTask -TaskName '$TASK').Settings.Enabled"; }
resume_check() {
  sleep 20
  if [ -f "$LOCK" ]; then
    say "재개 확인 — lock 생성됨"
  else
    psx "Start-ScheduledTask -TaskName '$TASK'; Start-Sleep 10"
    if [ -f "$LOCK" ]; then say "재기동 1회 — lock 있음"; else say "재기동 1회 — lock 없음(할 일이 없거나 기동 실패 · 일지 확인)"; fi
  fi
}
[ "$HOLD" -eq 1 ] || trap 'say "예약 다시 켬(trap): $(enable_slots)"; resume_check' EXIT
rm -f "$CANCEL"
psx "Disable-ScheduledTask -TaskName '$TASK' | Out-Null"
say "예약 끔 — 라운드 경계 또는 lock 부재 대기(최대 ${WAIT_MIN}분 · 10초 폴링 · 취소 = $CANCEL)"
count_marks() { tr -d '\000' < "$SLOTS" 2>/dev/null | grep -a -c "$ROUND_DONE_MARK"; }
base=$(count_marks); hit=0
for i in $(seq 1 $((WAIT_MIN * 6))); do
  if [ -f "$CANCEL" ]; then say "취소 — 아무것도 하지 않음"; [ "$HOLD" -eq 1 ] && enable_slots >/dev/null; exit 0; fi
  if [ ! -f "$LOCK" ]; then hit=1; break; fi
  if [ "$(count_marks)" -gt "$base" ]; then hit=2; break; fi
  [ $((i % 60)) -eq 0 ] && say "대기 $((i / 6))분째"
  sleep 10
done
if [ "$hit" -eq 0 ]; then
  say "${WAIT_MIN}분 경과 — 적용 생략(라운드가 더 길다 · 다시 걸 것)"
  [ "$HOLD" -eq 1 ] && enable_slots >/dev/null
  exit 1
fi
cd "$RUNNER" || exit 1
LEDGER="_bmad-output/implementation-artifacts/auto-pipeline-logs"
ledger_commit() {
  git add -A -- "$LEDGER/run-summary.log" "$LEDGER/state.json" "$LEDGER/exit-info.json" "$LEDGER/night-last-run.md" 2>>"$GAPLOG"
  if [ -n "$(git diff --cached --name-only)" ]; then
    if git -c core.editor=true commit -q -m "chore(batch): $(date '+%F %H:%M') 경계 정지 시점 엔진 장부 — gap-apply · 정지 순간 라운드는 재개 뒤 새로 편성" >>"$GAPLOG" 2>&1; then
      say "엔진 장부 커밋 $(git rev-parse --short HEAD)"
    else
      say "엔진 장부 커밋 실패(계속)"
    fi
  else
    say "엔진 장부 변경 없음"
  fi
}
if [ "$hit" -eq 2 ]; then
  say "라운드 경계 도달 — 러너 정지(워커 없음)"
  psx "Stop-ScheduledTask -TaskName '$TASK'"
  sleep 2
  powershell -NoProfile -ExecutionPolicy Bypass -File "$(cygpath -w "$OPS_DIR/stop-runner-tree.ps1")" -RunnerDir "$(cygpath -w "$RUNNER")" | tr -d '\r' | tee -a "$GAPLOG"
  sleep 15; ledger_commit; sleep 10; ledger_commit
  if [ -f "$LOCK" ]; then rm -f "$LOCK"; say "lock 제거"; fi
else
  say "lock 없음(러너 종료) — 바로 진행"
  sleep 8; ledger_commit
fi
if [ "$HOLD" -eq 1 ]; then
  say "정지 완료 — 예약은 끈 채로 둔다(재개 = Enable/Start-ScheduledTask '$TASK') · HEAD $(git rev-parse --short HEAD)"
  exit 0
fi
if [ -n "$(git status --porcelain | grep -v '^?? ')" ]; then
  git stash push -u -m "gap-apply 경계 잔여물 $(date '+%F %H:%M')" >>"$GAPLOG" 2>&1 && say "잔여물 stash 보존"
fi
before=$(git rev-parse --short HEAD)
bash "$APPLY" 2>&1 | tee -a "$GAPLOG"; rc=${PIPESTATUS[0]}
if [ "$rc" -ne 0 ]; then
  say "적용 스크립트 실패 exit=$rc — 되돌림"
  git checkout -q -- .
  git clean -q -fd -- _bmad-output tools/auto
  exit 1
fi
[ -n "$(git status --porcelain)" ] || { say "변경 0 — 커밋 없음"; exit 0; }
# shellcheck disable=SC2086
git add -A -- $ADD
if git -c core.editor=true commit -q -m "$MSG" >>"$GAPLOG" 2>&1; then
  say "커밋 $(git rev-parse --short HEAD) (이전 $before)"
else
  say "커밋 실패"; exit 1
fi
# tools/auto(엔진·설정)가 바뀌었으면 런타임 핀을 새 커밋으로 — 안 하면 다음 슬롯이 「핀 불일치」로 선다.
if [ -f "$PIN" ] && git show --name-only --format= HEAD | grep -q "^tools/auto/"; then
  after=$(git rev-parse HEAD)
  cp "$PIN" "$PIN.bak-$(date +%Y%m%d-%H%M)"
  node "$OPS_DIR/cfg.mjs" --pin "$(cygpath -w "$PIN")" "$after"
  say "핀 재기록 → ${after:0:8}"
fi
say "완료 — 재개(trap)"
