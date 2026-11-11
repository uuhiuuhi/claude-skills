#!/usr/bin/env bash
# 깃러너 — 배포 요청서 1건씩: 최신 main 과 합치기 → 합친 판 검사 → main 푸시 → 운영 DB 덧셈 적용 → 화면 배포 → 실측 → RELEASE-LOG
# (👤 2026-11-11 「깃러너 = 배포·main 전담 · 요청 오면 바로 main 먼저 → 배포 · 운영 DB 덧셈도 예약 작업이 직접」)
# 실행 = 예약 작업 BaroOS-gitrunner(1분마다 · 요청 없으면 바로 끝) 또는 손으로 `bash gitrunner.sh`.
# 요청서 양식 = 같은 폴더 REQUEST-FORM.md · 넣는 곳 = queue/ · 결과 = done/<id>.result.json(성공) · held/<id>.result.json(멈춤 = 깃러너 창 몫)
# 멈추는 경우(아무것도 올리지 않음): 합치기 충돌 · 검사 RED · 덧셈 아닌 DB 변경 · Edge Function 변경 · 유일 색인 · 운영 DB 로그인 실패.
# 연습: GR_DRY=1(푸시·DB·배포 끔 — 합치기·검사·판정까지만)
set -uo pipefail
export PATH="/c/nvm4w/nodejs:$PATH"
B=/c/Users/user/.baroos-auto; G=$B/gitrunner; M=/c/Projects/jng-os; W=/c/Projects/jng-os-gitrunner
PROD=eubtqkueostvgmvschfa; DEV=dahsgpporxvdstqayqla; SITE=https://baro.jngsystem.co.kr
SB="/c/Users/user/AppData/Local/npm-cache/_npx/b96a6bd565c470ce/node_modules/@supabase/cli-windows-x64/bin/supabase.exe"
LIB="$G/gitrunner-lib.mjs"; DRY=${GR_DRY:-0}
mkdir -p "$G/queue" "$G/running" "$G/done" "$G/held" "$G/logs"
LOG="$G/logs/gitrunner-$(date +%Y%m%d).log"
say() { echo "$(date '+%F %T') [깃러너] $*" | tee -a "$LOG"; }

# ── 잠금(동시에 하나만) — mkdir 은 원자적. 주인 pid 가 죽었으면 넘겨받는다
LK="$G/lock"
if ! mkdir "$LK" 2>/dev/null; then
  op=$(cat "$LK/pid" 2>/dev/null); if [ -n "$op" ] && ! kill -0 "$op" 2>/dev/null && ! powershell -NoProfile -Command "if (Get-Process -Id $op -ErrorAction SilentlyContinue) {exit 0} else {exit 1}"; then
    say "죽은 잠금(pid $op) 넘겨받음"; rm -rf "$LK"; mkdir "$LK" || exit 0
  else exit 0; fi
fi
echo $$ > "$LK/pid"; trap 'rm -rf "$LK"' EXIT

REQ=$(ls "$G/queue"/*.json 2>/dev/null | sort | head -1); [ -n "$REQ" ] || exit 0
# ── 배포 안 하는 시간(👤 2026-11-11): 평일·주말 구분 없이 08:50~12:00 · 13:00~18:10 — 사람이 요청한 건("humanRequested": true)만 처리
HM=$((10#$(date +%H%M)))
if { [ $HM -ge 850 ] && [ $HM -lt 1200 ]; } || { [ $HM -ge 1300 ] && [ $HM -lt 1810 ]; }; then
  REQ=""; for q in $(ls "$G/queue"/*.json 2>/dev/null | sort); do
    [ "$(node "$LIB" get "$q" humanRequested 2>/dev/null)" = true ] && { REQ=$q; break; }
  done
  # 미리 검사(👤 2026-11-11 「미리 검사 넣어줘」): 배포는 안 하고 합치기·판정·검사만 — 지금 main 기준 미리 검사가 안 된 요청 1건
  if [ -z "$REQ" ]; then
    git -C "$W" fetch -q origin 2>>"$LOG"; OMNOW=$(git -C "$W" rev-parse origin/main)
    for q in $(ls "$G/queue"/*.json 2>/dev/null | sort); do
      pc="$G/precheck/$(basename "$q" .json).ok"
      [ -f "$pc" ] && [ "$(cut -d' ' -f1,2 "$pc")" = "$OMNOW $(node "$LIB" get "$q" commit 2>/dev/null)" ] && continue
      REQ=$q; PRE=1; break
    done
  fi
  [ -n "$REQ" ] || exit 0   # 대기열에 그대로 둔다 — 시간이 끝나면 다음 1분 실행이 집어 간다
fi
PRE=${PRE:-0}; mkdir -p "$G/precheck"
ID=$(basename "$REQ" .json); RUN="$G/running/$ID.json"
if [ "$PRE" = 1 ]; then cp "$REQ" "$RUN"; else mv "$REQ" "$RUN"; fi
REL="$B/archive/release-$(date +%Y-%m-%d)-gitrunner-$ID"; mkdir -p "$REL"; cp "$RUN" "$REL/request.json"
get() { node "$LIB" get "$RUN" "$1"; }
finish() {  # $1 = done|held · $2 = 한 줄 · 나머지 = 키=값
  local st=$1 line=$2; shift 2; local dir=$G/$st; [ "$st" = done ] || dir=$G/held
  [ "$PRE" = 1 ] && { rm -f "$REQ" "$G/precheck/$ID.ok"; line="미리 검사 멈춤 — $line"; }   # 미리 검사에서 걸리면 대기열에서 빼서 멈춤 칸으로(요청 창이 고칠 시간)
  node "$LIB" result "$RUN" "$RUN.result.json" "$st" "$line" "release=$REL" "$@"
  mv "$RUN" "$dir/$ID.json"; mv "$RUN.result.json" "$dir/$ID.result.json"
  printf '%s · %s · %s · %s\n' "$(date '+%F %T')" "$ID" "$st" "$line" >> "$G/STATUS.log"
  say "$( [ "$st" = done ] && echo ✅ || echo ⏸ ) $ID — $line"; exit 0
}
hold() { finish held "$@"; }
say "요청 $ID 시작 ($(get requester))"
V=$(node "$LIB" validate "$RUN") || hold "요청서 칸 문제 — $(echo $V)"
C=$(get commit); BR=$(get branch)

cd "$W" || hold "작업 폴더 $W 없음"
git fetch -q origin 2>>"$LOG" || hold "origin 가져오기 실패"
git cat-file -e "$C^{commit}" 2>/dev/null || git fetch -q origin "$BR" 2>>"$LOG"
git cat-file -e "$C^{commit}" 2>/dev/null || hold "요청 커밋 ${C:0:9} 을 찾지 못함(본선 저장소에도 origin/$BR 에도 없음)"

tries=0
while :; do
  tries=$((tries+1)); [ $tries -le 3 ] || hold "main 이 계속 움직여 3번 다 푸시 거절됨"
  git reset -q --hard; git clean -q -fd -e node_modules -e .env.production -e .env.local -e public/manual
  OM=$(git rev-parse origin/main); git checkout -q --detach "$OM" || hold "main 판으로 옮기기 실패"
  # ── ① 최신 main 과 합치기
  if git merge-base --is-ancestor "$C" "$OM"; then MODE=already
  elif git merge-base --is-ancestor "$OM" "$C"; then MODE=ff; git merge -q --ff-only "$C" || hold "앞으로 감기 실패"
  else
    MODE=merge
    if ! git -c core.editor=true merge -q --no-edit -m "merge: $BR → main (깃러너 · $ID)" "$C" >>"$LOG" 2>&1; then
      U=$(git diff --name-only --diff-filter=U | tr '\n' ' ')
      SS=_bmad-output/implementation-artifacts/sprint-status.yaml
      # 상태표 하나만 충돌이면 키 단위로 합친다(요청마다 자기 스토리 줄만 더하므로) — 그 밖 충돌은 멈춤
      if [ "$U" = "$SS " ] && PYTHONIOENCODING=utf-8 python "$B/resolve-sprint-status-keys.py" "$SS" >>"$LOG" 2>&1 \
         && ! grep -qE '^(<<<<<<<|>>>>>>>|=======)' "$SS" && git add "$SS" && git -c core.editor=true commit -q --no-edit >>"$LOG" 2>&1; then
        say "상태표 충돌 키 단위로 합침"
      else
        git merge --abort 2>/dev/null
        hold "최신 main 과 합치기 충돌 — $U" "conflicts=$U"
      fi
    fi
  fi
  H=$(git rev-parse HEAD); say "합치기 $MODE · main ${OM:0:9} → ${H:0:9}"
  CH=$(git diff --name-only "$OM" "$H")
  [ -n "$CH" ] || [ "$MODE" = already ] || hold "바뀐 파일 0"
  # ── ② 판정: Edge Function · DB
  EF=$(echo "$CH" | grep '^supabase/functions/' | cut -d/ -f3 | sort -u | grep -v '^_shared$' | tr '\n' ' ')
  echo "$CH" | grep -q '^supabase/functions/_shared/' && EF="$EF(공용 _shared 바뀜)"
  [ -z "${EF// /}" ] || hold "Edge Function 변경 — 자동 배포 밖(👤 승인 · 깃러너 창이 처리): $EF" "ef=$EF"
  NEWM=$(git diff --name-only --diff-filter=A "$OM" "$H" -- supabase/migrations/ | grep '\.sql$')
  MODM=$(git diff --name-only --diff-filter=MDR "$OM" "$H" -- supabase/migrations/)
  [ -z "$MODM" ] || hold "이미 있던 마이그레이션 파일이 바뀜/지워짐 — $(echo $MODM)"
  if [ -n "$NEWM" ]; then
    AC=$(node tools/ops/additive-check.mjs --since "$OM" 2>&1); rc=$?
    echo "$AC" > "$REL/additive-check.txt"
    [ $rc -eq 0 ] || hold "덧셈 아닌 DB 변경 — 👤 승인 필요(판정 $REL/additive-check.txt)" "additive=$rc"
    UQ=$(node "$LIB" replaced $NEWM | grep '^unique ' | cut -d' ' -f2 | tr '\n' ' ')
    [ -z "$UQ" ] || hold "유일 색인 — 기존 자료 중복 0 실측이 먼저(ⓘ · 깃러너 창 몫): $UQ"
  fi
  # ── ③ 합친 판 검사(요청 창이 이미 전체 검사를 했으므로 여기선 합친 결과가 깨지지 않았는지만)
  TREE=$(git rev-parse "$H^{tree}"); PC="$G/precheck/$ID.ok"
  if [ "$PRE" != 1 ] && [ -f "$PC" ] && [ "$(cat "$PC")" = "$OM $C $TREE" ]; then
    say "미리 검사 재사용 — main ${OM:0:9} 이후 안 바뀜 · 합친 결과 같음"
  elif [ "$MODE" != already ]; then
    if [ -n "$(git diff --name-only "$OM" "$H" -- package-lock.json)" ]; then npm ci --no-audit --no-fund >>"$LOG" 2>&1 || hold "npm ci 실패"; fi
    timeout 1200 npm run -s typecheck > "$REL/typecheck.log" 2>&1 || hold "타입 검사 RED($REL/typecheck.log)"
    LINT=$(echo "$CH" | grep -E '\.(ts|tsx|js|mjs)$' | while read -r f; do [ -f "$f" ] && echo "$f"; done)
    if [ -n "$LINT" ]; then timeout 900 npx eslint $LINT > "$REL/eslint.log" 2>&1 || hold "eslint RED($REL/eslint.log)"; fi
    # 정적 시험(DB 접속 없음): 원장·마이그레이션 성질 가드 + 바뀐 시험 중 tests/db 실DB 시험이 아닌 것
    T=$( { echo tests/db/story-ledger-guard.test.ts; echo tests/db/migration-guard.test.ts; echo tests/db/migration-properties-guard.test.ts
           echo "$CH" | grep -E '^tests/.*\.test\.tsx?$' | grep -v -E '^tests/db/' ; echo "$CH" | grep -E '^tests/db/.*-guard\.test\.ts$'; } | sort -u | while read -r t; do [ -f "$t" ] && echo "$t"; done )
    [ -f .env.local ] || cp "$M/.env.local" .env.local 2>/dev/null
    timeout 1500 npx vitest run --fileParallelism=false $T --reporter=dot > "$REL/vitest.log" 2>&1 || hold "시험 RED($REL/vitest.log)"
    say "검사 GREEN — 타입·eslint·시험 $(echo "$T" | wc -l)파일"
  fi
  if [ "$PRE" = 1 ]; then
    echo "$OM $C $TREE" > "$PC"; rm -f "$RUN"
    printf '%s · %s · 미리 검사 GREEN · main %s · 합치기 %s · 배포는 시간 되면\n' "$(date '+%F %T')" "$ID" "${OM:0:9}" "$MODE" >> "$G/STATUS.log"
    say "미리 검사 GREEN $ID — 배포 가능 시간에 main 이 그대로면 검사 없이 바로 반영"; exit 0
  fi
  [ "$DRY" = 1 ] && finish held "연습(GR_DRY=1) — 합치기 $MODE ${H:0:9} · 새 DB $(echo $NEWM | wc -w) · 여기서 멈춤"
  # ── ④ main 푸시(먼저) — 거절되면 main 이 움직인 것 → 처음부터 다시
  if [ "$MODE" != already ]; then
    if git push -q origin "$H:refs/heads/main" >>"$LOG" 2>&1; then break; fi
    say "main 푸시 거절(움직임) — 다시 합침($tries)"; git fetch -q origin; continue
  fi
  break
done
RM=$(git ls-remote origin refs/heads/main | cut -f1); [ "$RM" = "$H" ] || [ "$MODE" = already ] || hold "main 푸시 실측 불일치(${RM:0:9} ≠ ${H:0:9})"
say "main = ${H:0:9}(실측)"

# ── ⑤ 운영 DB 덧셈 적용(새 마이그레이션 중 운영 장부에 없는 것만)
APPLIED=""
if [ -n "$NEWM" ]; then
  VERS=$(for f in $NEWM; do basename "$f" | cut -d_ -f1; done)
  IN=$(echo "$VERS" | sed "s/.*/'&'/" | paste -sd,)
  QO=$(timeout 180 env -u SUPABASE_ACCESS_TOKEN "$SB" db query --linked --project-ref $PROD "select version from supabase_migrations.schema_migrations where version in ($IN)" 2>&1)
  echo "$QO" | grep -q '"rows"\|\[\]' || hold "운영 DB 장부 읽기 실패(로그인 만료?) — main 은 올라감 · 화면 배포 전 멈춤: $(echo "$QO" | tail -1 | cut -c1-120)"
  HAVE=$(echo "$QO" | grep -oE '"version": *"[0-9]{14}"' | grep -oE '[0-9]{14}' | sort -u)
  TODO=$(for f in $NEWM; do v=$(basename "$f" | cut -d_ -f1); echo "$HAVE" | grep -qx "$v" || echo "$f"; done)
  if [ -n "$TODO" ]; then
    # ⓙ 교체하는 함수·뷰의 지금 정의를 떠 둔다(되돌릴 재료)
    node "$LIB" replaced $TODO | grep -E '^(function|view) ' | sort -u | while read -r kind name; do
      sch=${name%%.*}; obj=${name#*.}
      if [ "$kind" = function ]; then sql="select pg_get_functiondef(p.oid) as def from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='$sch' and p.proname='$obj'"
      else sql="select pg_get_viewdef('$sch.$obj'::regclass, true) as def where to_regclass('$sch.$obj') is not null"; fi
      timeout 120 env -u SUPABASE_ACCESS_TOKEN "$SB" db query --linked --project-ref $PROD "$sql" > "$REL/before-$kind-$name.json" 2>&1
    done
    node "$LIB" build-apply "$REL/apply-prod.sql" "$ID" $TODO > "$REL/apply-versions.txt" || hold "적용 묶음 만들기 실패 — main 은 올라감"
    {
      echo "# 운영 DB 반영 ⓖ~ⓙ — $ID"; echo "- 파일: $(echo $TODO)"; echo "- 덧셈 판정: tools/ops/additive-check.mjs exit 0(additive-check.txt)"
      echo "- ⓖ $(get db.compat)"; echo "- ⓗ $(get db.access)"; echo "- ⓘ 유일 색인 없음(있으면 자동 적용 안 함) · $(get db.index)"; echo "- ⓙ 교체 전 정의 = before-*.json"
    } > "$REL/CHECKS.md"
    AO=$(timeout 600 env -u SUPABASE_ACCESS_TOKEN "$SB" db query --linked --project-ref $PROD -f "$REL/apply-prod.sql" 2>&1); arc=$?
    echo "$AO" > "$REL/apply-prod.out"
    QO=$(timeout 180 env -u SUPABASE_ACCESS_TOKEN "$SB" db query --linked --project-ref $PROD "select version from supabase_migrations.schema_migrations where version in ($IN)" 2>&1)
    NOW=$(echo "$QO" | grep -oE '"version": *"[0-9]{14}"' | grep -oE '[0-9]{14}' | sort -u | grep -c .)
    [ "$NOW" -eq "$(echo "$VERS" | grep -c .)" ] || hold "운영 DB 적용 실패(exit $arc · 장부 $NOW/$(echo "$VERS" | grep -c .)) — main 은 올라감 · 화면 배포 안 함 · $REL/apply-prod.out"
    APPLIED=$(cat "$REL/apply-versions.txt"); say "운영 DB 적용 $APPLIED (장부 실측 $NOW)"
  else say "새 마이그레이션은 운영에 이미 다 있음"; fi
fi

# ── ⑥ 화면 배포(main 판 그대로)
cp "$M/.env.production" .env.production || hold "운영 공개값 파일 복사 실패 — main·DB 는 반영됨"
rm -rf public/manual; cp -r "$M/public/manual" public/manual 2>/dev/null || hold "설명서(public/manual) 복사 실패"
node tools/deploy/preflight.mjs production > "$REL/preflight.log" 2>&1 || hold "preflight RED — 배포 안 함($REL/preflight.log)"
rm -rf dist; timeout 900 npx vite build > "$REL/build.log" 2>&1 || hold "vite build 실패 — 배포 안 함"
NDEV=$(grep -l $DEV dist/assets/*.js | wc -l); NPROD=$(grep -l $PROD dist/assets/*.js | wc -l)
[ "$NDEV" -eq 0 ] && [ "$NPROD" -ge 1 ] || hold "번들 호스트 실측 실패(개발 $NDEV · 운영 $NPROD) — 배포 안 함"
[ "$(stat -c %s dist/manual/index.html 2>/dev/null || echo 0)" -gt 100000 ] || hold "빌드에 설명서 없음 — 배포 안 함"
PREV=$(env -u CF_API_TOKEN -u CLOUDFLARE_API_TOKEN npx wrangler deployments list --env production 2>/dev/null | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | tail -1)
env -u CF_API_TOKEN -u CLOUDFLARE_API_TOKEN npx wrangler deploy --env production > "$REL/deploy.log" 2>&1 || hold "wrangler 배포 실패 — $(tail -2 "$REL/deploy.log" | tr -d '[:cntrl:]' | cut -c1-160)"
VER=$(grep -oE 'Current Version ID: [0-9a-f-]+' "$REL/deploy.log" | awk '{print $4}')
BUNDLE=$(basename "$(ls dist/assets/index-*.js | head -1)")
# ── ⑦ 실측(번들 해시 · 조각 200 · 설명서 크기·장 표식) — RED 면 직전 판으로 되돌림
ok=0; for i in 1 2 3 4 5 6; do sleep 10; LIVE=$(curl -s "$SITE/" | grep -oE 'index-[A-Za-z0-9_-]+[.]js' | head -1); [ "$LIVE" = "$BUNDLE" ] && { ok=1; break; }; done
CHUNK=$(ls dist/assets/*.js | grep -v index- | head -1 | xargs basename); CODE=$(curl -s -o /dev/null -w '%{http_code}' "$SITE/assets/$CHUNK")
curl -sL -o "$REL/manual-live.html" "$SITE/manual/"; MSZ=$(stat -c %s "$REL/manual-live.html" 2>/dev/null || echo 0); MID=$(grep -c 'id="attendance"' "$REL/manual-live.html" 2>/dev/null); MID=${MID:-0}; [ "$MID" -ge 1 ] && MID=1 || MID=0
if [ $ok -ne 1 ] || [ "$CODE" != 200 ] || [ "$MSZ" -lt 100000 ] || [ $MID -ne 1 ]; then
  RB="되돌림 안 함(직전 판 모름)"; [ -n "$PREV" ] && env -u CF_API_TOKEN -u CLOUDFLARE_API_TOKEN npx wrangler rollback "$PREV" --env production -y -m "gitrunner $ID 실측 RED" >> "$REL/deploy.log" 2>&1 && RB="직전 ${PREV:0:8} 로 되돌림"
  hold "배포 실측 RED(번들 $LIVE/$BUNDLE · 조각 $CODE · 설명서 ${MSZ}B·표식 $MID) — $RB · main·DB 는 반영됨" "version=$VER"
fi
say "배포 ${VER:0:8} · 번들 $BUNDLE · 조각 200 · 설명서 ${MSZ}B"

# ── ⑧ RELEASE-LOG + 운영 판 태그 → main 푸시(실패해도 배포는 끝난 것 — 결과에 적는다)
TAG="prod/$(date +%Y%m%d-%H%M)-${VER:0:8}"
{
  echo ""
  echo "## $(date '+%Y-%m-%d %H:%M') KST · $BR(${C:0:9}) → main(${H:0:9} · $MODE · 깃러너 자동) · 운영 DB $( [ -n "$APPLIED" ] && echo "$(echo $APPLIED | wc -w)파일" || echo 0) · 배포 \`$VER\`"
  echo "- **무엇**: $(get summary)"
  echo "- **검사**: 요청 창 — $(get checks) · 깃러너 — 합친 판 typecheck·eslint·정적 시험 GREEN · 덧셈 판정 $( [ -n "$NEWM" ] && echo 'exit 0' || echo '대상 없음')"
  [ -n "$APPLIED" ] && echo "- **운영 DB**: $APPLIED · ⓖ~ⓙ = \`$REL/CHECKS.md\`"
  echo "- **실측**: 번들 \`$BUNDLE\` 운영 ref $NPROD·개발 ref 0 · 서빙 일치 · 조각 200 · /manual/ ${MSZ}B(장 표식 있음) · 태그 \`$TAG\`"
  echo "- **되돌리기**: 화면 = \`wrangler rollback ${PREV} --env production\` · $(get rollback)"
  echo "- **실제 화면에서 확인할 항목(👤)**: $(get screens | tr '\n' ' ')"
  echo "- 요청: $(get requester) · 실행자: 깃러너 예약 작업(BaroOS-gitrunner · $ID)"
} >> _bmad-output/implementation-artifacts/RELEASE-LOG.md
git add _bmad-output/implementation-artifacts/RELEASE-LOG.md
git -c core.editor=true commit -q -m "docs(release-log): $(date '+%m-%d %H:%M') $ID 운영 반영 ${VER:0:8} (깃러너)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
LH=$(git rev-parse HEAD); git tag "$TAG" "$H"
PUSHED=no; for i in 1 2 3; do
  if git push -q origin "$LH:refs/heads/main" >>"$LOG" 2>&1; then PUSHED=yes; break; fi
  git fetch -q origin; git rebase -q origin/main >>"$LOG" 2>&1 || { git rebase --abort; break; }; LH=$(git rev-parse HEAD)
done
git push -q origin "refs/tags/$TAG" >>"$LOG" 2>&1
[ -f "$B/downsync-conflict.json" ] && DS="러너 하향 동기 충돌 해소 요청 있음($B/downsync-conflict.json)" || DS=""
finish done "main ${H:0:9} · 배포 ${VER:0:8} · DB $(echo $APPLIED | wc -w) · 기록 푸시 $PUSHED${DS:+ · $DS}" "version=$VER" "main=$H" "tag=$TAG" "bundle=$BUNDLE" "logPushed=$PUSHED"
