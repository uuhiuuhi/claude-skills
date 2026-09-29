#!/usr/bin/env bash
# [지금감시중] ops/gap-apply.sh — 돌고 있는 러너의 「라운드 경계」에 끼어들어 문서·설정 묶음을 적용·커밋하고 재개한다.
#
# 왜: 러너는 일이 남으면 같은 프로세스가 다음 라운드를 이어 돌아 lock 을 놓지 않는다. lock 이 사라지길 기다리면
#     며칠도 안 온다. 워커가 0 인 유일한 순간 = run-night 이 「라운드 N 완주」 줄을 찍은 직후다.
# 순서: 예약 끔(확인) → 경계(또는 lock 부재) 대기 → 러너 트리 정지(확인) → 엔진 장부 커밋 → 잔여물 전부 stash(확인) →
#       적용 스크립트 실행 → 커밋 → (tools/auto 가 바뀌었으면 런타임 핀 재기록) → 예약을 **원래 상태로** 복구(확인) + 기동.
# 사용: AUTO_RUNNER_DIR=<러너 폴더> bash gap-apply.sh --go <적용스크립트.sh> "<커밋 메시지>" [--wait-min 180] [--add "경로 …"]
#       AUTO_RUNNER_DIR=<러너 폴더> bash gap-apply.sh --go --hold            # 경계에서 세우기만(재개 안 함 · 릴리스 준비용)
# 취소: <상태 폴더>/gap-apply.cancel 파일을 만든다.
# 주의: 적용 스크립트는 **사본에서 먼저 검산**하고, 실패 시 비0 으로 끝나게 쓴다.
#       한 라운드가 --wait-min 보다 길면 「적용 생략」으로 끝난다 — 라운드 길이에 맞춰 넉넉히 주거나 다시 건다.
#       같은 러너에 이 도구를 **동시에 둘 띄우지 않는다**(유지보수 잠금 <상태 폴더>/gap-apply.lock 이 막는다).
# 끝나는 방식(전부 로그에 남는다 · 🔴 줄은 사람이 봐야 하는 것):
#   0 = 적용·커밋·재개 / 변경 0 / 취소 / --hold 성공      1 = 시한 초과 · 적용 실패(되돌림 뒤 재개)      2 = 인자·환경 오류
#   3 = 정지·보존·복구를 **확인하지 못함**(러너를 재개하지 않는다 — 작업 트리 상태를 사람이 본다)
set -u
set -o pipefail
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
  [ -f "$APPLY" ] || { echo "적용 스크립트 없음: $APPLY"; exit 2; }
fi
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
CANCEL="$STATE/gap-apply.cancel"; MLOCK="$STATE/gap-apply.lock"
say() { echo "$(date '+%F %T') [gap-apply] $*" | tee -a "$GAPLOG"; }
psx() { powershell -NoProfile -NonInteractive -Command "$1" | tr -d '\r'; }
task_enabled() { psx "(Get-ScheduledTask -TaskName '$TASK' -ErrorAction Stop).Settings.Enabled"; }   # True / False / (실패 시 빈 값)

# ── 유지보수 잠금: 같은 러너에 둘이 동시에 끼어들지 않는다 ─────────────────────────────────
if ! ( set -o noclobber; echo "$$ $(date '+%F %T')" > "$MLOCK" ) 2>/dev/null; then
  echo "다른 gap-apply 가 이미 대기 중입니다($MLOCK: $(cat "$MLOCK" 2>/dev/null)) — 아무것도 하지 않음"; exit 2
fi

ORIG="$(task_enabled || true)"
case "$ORIG" in True|False) ;; *) rm -f "$MLOCK"; echo "예약작업 '$TASK' 상태를 읽지 못함 — 아무것도 하지 않음"; exit 2 ;; esac

RESUME=1        # 끝날 때 예약을 원래 상태로 되돌릴지(기본 예) — --hold 가 성공했을 때만 0
SAFE=1          # 작업 트리·프로세스 상태를 확인했는지 — 0 이면 러너를 재개하지 않는다
restore_task() {
  rm -f "$MLOCK"
  if [ "$SAFE" -ne 1 ]; then
    say "🔴 상태를 확인하지 못해 러너를 재개하지 않는다 — 예약 '$TASK' 은 꺼진 채다. 러너 폴더의 작업 트리와 남은 프로세스를 사람이 확인한 뒤 Enable/Start-ScheduledTask 할 것"
    return
  fi
  [ "$RESUME" -eq 1 ] || return
  if [ "$ORIG" != "True" ]; then say "예약은 원래 꺼져 있었다 — 끈 채로 둔다"; return; fi
  local i now
  for i in 1 2 3; do
    psx "Enable-ScheduledTask -TaskName '$TASK' | Out-Null; Start-ScheduledTask -TaskName '$TASK'" >/dev/null 2>&1 || true
    now="$(task_enabled || true)"
    [ "$now" = "True" ] && break
    sleep 5
  done
  if [ "$now" != "True" ]; then say "🔴 예약 '$TASK' 을 다시 켜지 못함(3회) — 사람이 Enable-ScheduledTask 할 것"; return; fi
  say "예약 다시 켬(확인: Enabled=True)"
  sleep 20
  if [ -f "$LOCK" ]; then
    say "재개 확인 — lock 생성됨"
  else
    psx "Start-ScheduledTask -TaskName '$TASK'" >/dev/null 2>&1 || true
    sleep 10
    if [ -f "$LOCK" ]; then say "재기동 1회 — lock 있음"; else say "재기동 1회 — lock 없음(할 일이 없거나 기동 실패 · 일지 확인)"; fi
  fi
}
trap restore_task EXIT

rm -f "$CANCEL"
psx "Disable-ScheduledTask -TaskName '$TASK' | Out-Null" >/dev/null 2>&1 || true
[ "$(task_enabled || true)" = "False" ] || { say "예약을 끄지 못함 — 아무것도 하지 않음"; exit 2; }
say "예약 끔(확인) — 라운드 경계 또는 lock 부재 대기(최대 ${WAIT_MIN}분 · 5초 폴링 · 취소 = $CANCEL)"

count_marks() { tr -d '\000' < "$SLOTS" 2>/dev/null | grep -a -c "$ROUND_DONE_MARK" || true; }
# 경계 줄 뒤에 새 배치 머리줄(==== B1 …)이 이미 찍혔으면 늦은 것이다 — 그 경계는 버리고 다음 경계를 기다린다.
started_after_mark() { tr -d '\000' < "$SLOTS" 2>/dev/null | awk -v m="$ROUND_DONE_MARK" 'index($0,m){seen=1;late=0;next} seen && /^==== (AUTO-[0-9]+|B[0-9]+)/{late=1} END{print (late?1:0)}'; }
base=$(count_marks); hit=0
for i in $(seq 1 $((WAIT_MIN * 12))); do
  if [ -f "$CANCEL" ]; then say "취소 — 아무것도 하지 않음"; exit 0; fi
  if [ ! -f "$LOCK" ]; then hit=1; break; fi
  now=$(count_marks)
  if [ "$now" -gt "$base" ]; then
    if [ "$(started_after_mark)" = "0" ]; then hit=2; break; fi
    say "경계를 놓침(다음 라운드가 이미 시작) — 다음 경계를 기다린다"; base=$now
  fi
  [ $((i % 120)) -eq 0 ] && say "대기 $((i / 12))분째"
  sleep 5
done
if [ "$hit" -eq 0 ]; then say "${WAIT_MIN}분 경과 — 적용 생략(라운드가 더 길다 · 다시 걸 것)"; exit 1; fi

cd "$RUNNER" || { say "러너 폴더로 못 들어감: $RUNNER"; exit 2; }
LEDGER="_bmad-output/implementation-artifacts/auto-pipeline-logs"
ledger_commit() {
  # 사람이 미리 스테이징해 둔 것이 장부 커밋에 섞이지 않게 장부 4파일만 경로 지정으로 커밋한다.
  local files=()
  for f in run-summary.log state.json exit-info.json night-last-run.md; do
    if [ -e "$LEDGER/$f" ] || git ls-files --error-unmatch "$LEDGER/$f" >/dev/null 2>&1; then files+=("$LEDGER/$f"); fi
  done
  [ ${#files[@]} -gt 0 ] || { say "엔진 장부 파일 없음"; return; }
  git add -A -- "${files[@]}" 2>>"$GAPLOG"
  if [ -n "$(git diff --cached --name-only -- "${files[@]}")" ]; then
    if git -c core.editor=true commit -q -m "chore(batch): $(date '+%F %H:%M') 경계 정지 시점 엔진 장부 — gap-apply · 정지 순간 라운드는 재개 뒤 새로 편성" -- "${files[@]}" >>"$GAPLOG" 2>&1; then
      say "엔진 장부 커밋 $(git rev-parse --short HEAD)"
    else
      say "엔진 장부 커밋 실패(계속)"
    fi
  else
    say "엔진 장부 변경 없음"
  fi
}
if [ "$hit" -eq 2 ]; then
  say "라운드 경계 도달 — 러너 정지"
  psx "Stop-ScheduledTask -TaskName '$TASK'" >/dev/null 2>&1 || true
  sleep 2
  out="$(powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$(cygpath -w "$OPS_DIR/stop-runner-tree.ps1")" -RunnerDir "$(cygpath -w "$RUNNER")" -LockFile "$(cygpath -w "$LOCK")" | tr -d '\r')"
  echo "$out" >> "$GAPLOG"
  left="$(echo "$out" | sed -n 's/^remaining=//p' | tail -1)"
  if [ "${left:-x}" != "0" ]; then SAFE=0; say "🔴 러너 프로세스가 남아 있음(remaining=${left:-알 수 없음}) — lock 을 지우지 않고 멈춘다"; exit 3; fi
  say "러너 프로세스 0 확인"
  sleep 10; ledger_commit; sleep 5; ledger_commit
  if [ -f "$LOCK" ]; then rm -f "$LOCK"; say "lock 제거"; fi
else
  say "lock 없음(러너 종료) — 바로 진행"
  sleep 8; ledger_commit
fi
if [ "$HOLD" -eq 1 ]; then
  RESUME=0
  say "정지 완료 — 예약은 끈 채로 둔다(재개 = Enable/Start-ScheduledTask '$TASK') · HEAD $(git rev-parse --short HEAD)"
  exit 0
fi

# ── 잔여물 보존: 추적·미추적을 가리지 않고 전부 stash 한다. 보존을 확인하지 못하면 아무것도 적용하지 않는다 ──
STASH=""
if [ -n "$(git status --porcelain)" ]; then
  label="gap-apply 경계 잔여물 $(date '+%F %H:%M:%S')"
  if git stash push -u -m "$label" >>"$GAPLOG" 2>&1 && [ -z "$(git status --porcelain)" ]; then
    STASH="$(git rev-parse --short 'stash@{0}')"
    say "잔여물 보존 — stash $STASH 「$label」(꺼내기: git stash list → git stash pop · 러너가 멈춘 틈에만)"
  else
    SAFE=0; say "🔴 잔여물 보존 실패 — 적용하지 않고 멈춘다"; exit 3
  fi
fi
before=$(git rev-parse HEAD)
# 여기부터 작업 트리는 깨끗하다 = 아래에서 생기는 변경은 전부 적용 스크립트가 만든 것이다.
rollback() {
  git reset -q --hard "$before" >>"$GAPLOG" 2>&1
  git clean -q -fd >>"$GAPLOG" 2>&1          # 무시 목록(.gitignore)의 파일은 건드리지 않는다(-x 없음)
  if [ -n "$(git status --porcelain)" ] || [ "$(git rev-parse HEAD)" != "$before" ]; then SAFE=0; say "🔴 되돌림을 확인하지 못함"; exit 3; fi
  say "되돌림 확인 — HEAD ${before:0:8} · 작업 트리 깨끗함${STASH:+ · 잔여물은 stash $STASH 에 그대로}"
}
bash "$APPLY" 2>&1 | tee -a "$GAPLOG"; rc=${PIPESTATUS[0]}
if [ "$rc" -ne 0 ]; then say "적용 스크립트 실패 exit=$rc — 되돌림"; rollback; exit 1; fi
[ -n "$(git status --porcelain)" ] || { say "변경 0 — 커밋 없음"; exit 0; }
# shellcheck disable=SC2086
git add -A -- $ADD >>"$GAPLOG" 2>&1
outside="$(git status --porcelain | grep -v '^[AMDR]  ' || true)"
if [ -n "$outside" ]; then say "적용 스크립트가 커밋 범위($ADD) 밖을 바꿈 — 되돌림: $(echo "$outside" | head -3 | tr '\n' ' ')"; rollback; exit 1; fi
if git -c core.editor=true commit -q -m "$MSG" >>"$GAPLOG" 2>&1; then
  say "커밋 $(git rev-parse --short HEAD) (이전 ${before:0:8})"
else
  say "커밋 실패 — 되돌림"; rollback; exit 1
fi
# tools/auto(엔진·설정)가 바뀌었으면 런타임 핀을 새 커밋으로 — 안 하면 다음 슬롯이 「핀 불일치」로 선다.
if [ -f "$PIN" ] && git show --name-only --format= HEAD | grep -q "^tools/auto/"; then
  after=$(git rev-parse HEAD)
  cp "$PIN" "$PIN.bak-$(date +%Y%m%d-%H%M)"
  if node "$OPS_DIR/cfg.mjs" --pin "$(cygpath -w "$PIN")" "$after"; then say "핀 재기록 → ${after:0:8}"; else say "🔴 핀 재기록 실패 — 다음 슬롯이 「핀 불일치」로 설 수 있다(백업 $PIN.bak-*)"; fi
fi
say "완료 — 재개"
