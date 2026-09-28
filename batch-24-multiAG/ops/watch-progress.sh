#!/usr/bin/env bash
# [지금확인중] ops/watch-progress.sh — 배치 진행 표시기 + 정체 감지(읽기만 한다).
#  - 작동 여부·배치 번호·스토리·단계가 바뀔 때만 한 줄 찍는다.
#  - 일지가 20분 그대로면 ⚠, 40분이면 🔴 사람 확인 요청.
#  - 기본 90분 뒤 스스로 끝난다(끝없는 감시를 남기지 않는다).
# 사용: AUTO_RUNNER_DIR=<러너 폴더> bash watch-progress.sh [분=90]
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
MIN="${1:-90}"; prev=""; prevmt=""; stall=0; w20=0; w40=0
for i in $(seq 1 "$MIN"); do
  now=$(date +%H:%M)
  if [ -f "$LOCK" ]; then run="배치 작동중"; else run="배치 쉬는중"; fi
  txt=$(tr -d '\000' < "$SLOTS" 2>/dev/null | tail -n 4000)
  total=$(echo "$txt" | grep -a "실행 대상 배치:" | tail -1 | grep -oE "[0-9]+" | tail -1)
  head=$(echo "$txt" | grep -a -E "^==== (AUTO-[0-9]+|B[0-9]+)" | tail -1 | sed 's/^==== //;s/ ====$//')
  route=$(echo "$txt" | grep -a "MODEL-ROUTE" | tail -1 | sed 's/.*stage=/단계 /;s/ risk=.*//')
  mt=$(date -r "$SLOTS" +%H:%M 2>/dev/null)
  if [ "$mt" = "$prevmt" ]; then stall=$((stall + 1)); else stall=0; w20=0; w40=0; fi
  prevmt="$mt"
  key="$run | 전체 ${total:-?}건 | ${head:-?} | ${route:-?}"
  if [ "$key" != "$prev" ]; then echo "$now | $key | 일지 마지막 $mt"; prev="$key"; fi
  if [ $stall -ge 40 ] && [ $w40 -eq 0 ]; then
    echo "🔴 $now | 일지가 ${stall}분째 그대로($mt) — 멈춘 것으로 본다. 사람 확인 필요"; w40=1
  elif [ $stall -ge 20 ] && [ $w20 -eq 0 ]; then
    echo "⚠ $now | 일지가 ${stall}분째 그대로($mt) — 정체 의심. 40분까지 더 본다"; w20=1
  fi
  sleep 60
done
echo "=== 표시기 ${MIN}분 종료 — 더 볼 일이 남았으면 다시 켤 것 ==="
