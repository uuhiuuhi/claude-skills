#!/usr/bin/env bash
# [지금작업중] ops/watch-current.sh — 「지금 도는 스토리」 표시기.
# 배치는 Claude 밖(예약작업)에서 돌아 대화 창에는 안 보인다. 이 표시기를 Monitor 로 띄워 제목에 스토리·단계·모델을 적는다.
# 스토리·단계·작동 여부가 **바뀌면 한 줄 찍고 끝난다** → 새 키를 제목에 넣어 다시 띄운다(매분 알림 금지).
# 사용: AUTO_RUNNER_DIR=<러너 폴더> bash watch-current.sh "<시작 키>"   (빈 문자열 = 지금 키만 찍고 끝)
# 시한: 28분(Monitor 30분 상한 안) · 일지가 20분 그대로면 ⚠ 정체 의심.
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
start="${1:-}"; stall=0; prevmt=""
for i in $(seq 1 28); do
  now=$(date +%H:%M)
  if [ -f "$LOCK" ]; then run="작동중"; else run="쉬는중"; fi
  txt=$(tr -d '\000' < "$SLOTS" 2>/dev/null | tail -n 4000)
  total=$(echo "$txt" | grep -a "실행 대상 배치:" | tail -1 | grep -oE "[0-9]+" | tail -1)
  head=$(echo "$txt" | grep -a -E "^==== (AUTO-[0-9]+|B[0-9]+)" | tail -1)
  cur=$(echo "$head" | grep -a -oE '(AUTO-|B)[0-9]+' | head -1 | grep -oE '[0-9]+')
  kind=$(echo "$head" | grep -a -oE '회수|신규' | head -1)
  st=$(echo "$txt" | grep -a -E "^──────── STORY " | tail -1 | grep -a -oE 'STORY [0-9]+-[0-9]+' | grep -oE '[0-9]+-[0-9]+')
  story="$st (${kind:-?})"
  stage=$(echo "$txt" | grep -a "MODEL-ROUTE" | tail -1 | sed 's/.*stage=//;s/ risk=.*//;s/ model=/·/')
  # 살아 있다는 증거 = 배치 일지 + 러너 폴더에서 워커가 방금 고친 파일(구현 단계는 일지가 오래 조용하다)
  wf=$(find "$RUNNER" \( -name node_modules -o -name .git \) -prune -o -type f -newermt "-15 minutes" -printf "%T@\n" 2>/dev/null | sort -n | tail -1)
  lm=$(date -r "$SLOTS" +%s 2>/dev/null || echo 0)
  best=$lm
  if [ -n "$wf" ] && [ "${wf%.*}" -gt "$lm" ]; then best="${wf%.*}"; fi
  mt=$(date -d "@$best" +%H:%M 2>/dev/null)
  rep=$(echo "$txt" | grep -a "^\[${st}-" | grep -a "\[REPAIR\] 수리" | tail -1 | sed 's/.*\[REPAIR\] //;s/ · .*//')
  key="$run|${cur:-?}/${total:-?}|${story:-?}|${stage:-?}|${rep:-}"
  if [ "$key" != "$start" ]; then
    echo "KEY=$key"
    echo "$now | 배치 $run | 슬롯 ${cur:-?}/${total:-?}건 | ${story:-?} | ${stage:-?} ${rep:+· $rep} | 일지 마지막 $mt"
    exit 0
  fi
  if [ "$mt" = "$prevmt" ]; then stall=$((stall + 1)); else stall=0; fi
  prevmt="$mt"
  [ $stall -eq 20 ] && echo "⚠ $now | 일지가 20분째 그대로($mt) — 정체 의심"
  sleep 60
done
echo "KEY=$start"
echo "$(date +%H:%M) | 28분 경과 · 변화 없음 — 다시 띄움"
