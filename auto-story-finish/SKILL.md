---
name: auto-story-finish
description: 스토리 배치를 BMad create→dev→review 순으로 완료한다(헤드리스 claude -p 엔진). 단계별 모델은 사용자가 명시하지 않는 한 지휘 LLM이 성능 우선으로 자동 선택 — 환경별 최상위 후보를 1콜 프로브로 실존 확인 후 create·dev에 적용, 전부 실패 시 CLI 기본 모델 폴백(특정 모델을 찾아 헤매지 않음 — claude·codex 어디서든 동작). 독립 스토리 2개+ 는 워크트리 분리 병렬이 기본(프로젝트에 프로비저닝 수단이 있을 때 — 없으면 순차 폴백), 의존·파일중첩 스토리는 순차. 사용자가 스토리 범위를 "마무리"해 달라고 할 때 사용 — 예) "S-J부터 S-M까지 마무리", "11-2,11-3 끝까지". 터미널 CLI 인증 만료 시 엔진 대기 대신 **대화창 직접 진행으로 자동 폴백**(묻지 않음). qa RED면 중단. 커밋·푸시는 기본 안 하며, 사용자가 켠 `--commit/--branch auto/*/--push` 옵트인 때만 가드 하에 스토리 단위로 수행한다(main 머지는 사람).
---

# auto-story-finish — BMad 스토리 배치 완료 (병렬 우선)

스토리 묶음을 `create → dev → (qa 게이트) → review` 로 완료한다.
엔진 = `~/.claude/skills/auto-story-finish/auto-story-pipeline.mjs` (전역 설치판 — 스킬과 같은 폴더에 동봉, 버전 페어링 보장. 헤드리스 `claude -p` 호출 — 모델 플래그는 선택사항, 미지정 시 CLI 기본 모델). 프로젝트에 자체 `scripts/auto-story-pipeline.mjs`가 있어도 **전역 스킬은 전역 엔진을 쓴다**(구버전 프로젝트 엔진과의 정책 불일치 방지). **이 스킬은 발화 파싱 + 순서 resolve + (병렬 판정) + 모델 선택 + 엔진 구동 + 보고만 한다.**

## 🚨 불변 가드레일 (엔진에 하드코딩 — 무시 불가)
- **워크트리(폴더) 하나 안에서는 순차 처리 = 의존성 순서.** 같은 폴더 동시 2배치 금지(로그·state·파일 교차 오염). 병렬은 §병렬 배치의 **워크트리 분리** 방식으로만.
- **dev 후 qa 게이트 RED → 배치 즉시 중단.** 거짓 PASS 차단. 사람 개입 필요. 게이트 구성 = **프로젝트가 정의**: 기본 `npm run qa`, 다른 조합은 `--qa "<명령>"` 오버라이드. 프로젝트별 게이트 조합·함정(제외할 검사, 선재 부채 등)은 **각 프로젝트 CLAUDE.md 기록을 따른다** — 예: 어떤 프로젝트는 lint 선재 부채로 `npm run qa` 대신 CI 근사 조합을 `--qa`로 지정한다(상세는 해당 프로젝트 문서).
- **단계 성공 판정 = exit code + 사후조건(산출물) 이중 검사.** ① exit 0이어도 스토리 산출물(`{key}*.md`)이 갱신되지 않았으면 **NO-OP STOP(exit 4)** — CLI가 오류를 삼킨 거짓 성공 차단. ② 반대로 exit≠0이어도 산출물이 완성됐으면 "작업 완료 후 비정상 종료"로 간주하고 경고 후 계속(stream-idle 류 거짓 실패 방어 — Epic 13 실사례). 사후조건은 단계 전/후 mtime 스냅샷 비교(시각 비교 아님).
- **인증 오류 + 사용량 한도 자동 감지 + 경계 프로브 + 복구 대기.** ① 각 스토리 시작 전 1콜 프로브(수 초, 기본=CLI 기본 모델·저가 모델이 있는 환경이면 `--probe-model`로 지정 가능, 전량 skip 스토리는 생략)로 토큰 만료·한도 초과를 스토리 "경계"에서 감지 — 분할 배치가 주던 안전 효과를 자동화. ② exit≠0 + 산출물 미완성 + 401/unauthorized/token expired 패턴이면 **AUTH STOP(exit 3)** + "claude 재로그인 → 같은 명령 재실행(=이어하기)" 안내. usage/rate limit 패턴이면 **LIMIT STOP(exit 5)** — 재로그인 불필요, 한도 리셋 후 같은 명령 재실행. ③ `--wait-auth-min N`이면 즉시 종료 대신 최대 N분 동안 폴링(기본 300초 간격, `AUTH_POLL_SEC`) 대기하고, 복구(재로그인 또는 한도 리셋)되면 **멈춘 단계부터 자동 재개**(단계당 재시도 상한 5회). 밤샘 무인 배치 권장 = `--wait-auth-min 480` — 최상위 모델 배치는 한도 소모가 커서 특히 필수. (진짜 토큰 자동갱신은 Claude Code CLI 로그인 시스템의 영역이라 엔진이 하지 않는다.) ④ 배치 **시작 전** 만료 감지 시 §0 폴백 — 엔진 대기 대신 대화창 직접 진행으로 자동 전환.
- **중단 후 같은 명령 재실행 = 이어하기.** 완료 단계는 `auto-pipeline-logs/state.json` 기록으로 자동 skip. **create는 유효한 스토리 파일이 이미 있으면 항상 skip(--force로도 해제 불가)** — dev가 갱신한 스펙·Dev Notes 보호, 재생성은 파일 직접 삭제 후 실행. dev/review 재실행은 `--force`(단계가 새로 실행되면 그 하위 단계 기록은 자동 무효화 — 예: dev 재실행 → 기존 qa·review 기록 리셋). 특정 스토리만 재작업 = `--stories "<해당 키>" --stages dev,review --force`. 동시 배치 2개 병행은 금지(로그·state 교차 오염).
- **nested claude 인스턴스는 git commit·push 절대 안 함.** 이중 방어 = 엔진이 nested `claude -p`에 `--settings`로 pipeline-settings(commit/push/파괴 deny)를 전달 → 파이프라인 인스턴스만 차단, **사람의 대화형 세션은 deny-free**라 영향 없음. **해석 순서(2026-09-02 확정)**: ① `--pipeline-settings <경로>` ② `PIPELINE_SETTINGS_PATH` env ③ 실행 cwd 의 `.claude/pipeline-settings.json` ④ 전역 `~/.claude/pipeline-settings.json`. **넷 다 없으면 SETTINGS STOP(exit 6)** — deny 없이 무인 워커를 띄우지 않는다. ⚠️ **워크트리에서 돌릴 때**(러너 병렬 landing 모드)는 ③이 **커밋된 파일이어야** 워크트리에 딸려 온다 — 미추적으로 두면 워크트리에는 없다. 워크트리 픽스처·러너는 ①/②로 절대경로를 넘기는 편이 안전하다.
- **(2026-08-17 승인) 엔진 자체의 스토리 단위 커밋·푸시 = 옵트인.** 기본(플래그 없음)은 종전대로 커밋·푸시 0. `--commit`(+`--branch auto/<이름>` +`--push`)을 켜면 스토리의 마지막 단계 완료 후 엔진(node, LLM 아님)이 1커밋. **하드 가드**: ① 시작 시 작업 트리 clean 필수(엔진 로그 제외) ② 화이트리스트 pathspec만 스테이징(`src,tests,supabase,tools,public,.github,_bmad-output,package*.json,…` — `--commit-paths`로 조정) ③ 금지 경로(`.env*`·외부 `*.log`·`scratch-*`·`*.local.*`·키 파일) 검출 시 unstage+STOP(exit 6) ④ 스테이징 diff 추가 줄 시크릿 패턴 스캔(`sb_secret_`·JWT·`*_TOKEN=값`·`sk-`·PRIVATE KEY 등) 걸리면 SECRET STOP(exit 6) ⑤ 브랜치는 **`auto/` 접두사만**(main·기타 금지, `--push`는 `--branch` 필수) — **(2026-09-02 하드닝)** `--branch` 를 생략해도 **커밋 자리 자체가 제한**된다: 현재가 **detached HEAD(러너 워크트리 landing 모드) 또는 `auto/*` 브랜치**가 아니면 「무인 커밋은 auto/* 또는 detached worktree 에서만」 STOP(exit 6). 커밋 직전에도 자리를 다시 본다 ⑥ amend·force·태그 0, 푸시 실패는 경고 후 계속 ⑦ **(2026-09-02 하드닝 N1)** `--e2e <명령>`(배치 통합 게이트)이나 `--defer-push` 가 켜져 있으면 **스토리 단위 push 를 보류**하고, 전 스토리 + 배치 e2e 가 GREEN 인 뒤 **한 번만** push 한다. e2e RED = **push 0회**(exit 1 · 커밋은 로컬 `auto/*` 에만 남는다) — 종전에는 스토리마다 즉시 밀어서 「원격에는 이미 RED 조합이 올라간」 상태가 만들어졌다. **정본 main 반영은 항상 사람 머지.** 밤샘 무인 배치 권장 = `--commit --branch auto/<날짜> --push`(아침에 CI 결과와 함께 검토 → 머지/폐기).
- **권한 우회 미지원.** 엔진은 `--permission-mode acceptEdits`(파일 편집만 자동) 고정. bypassPermissions/우회 플래그 없음.
- **단계 타임아웃 기본 120분**(`--stage-timeout-min`) — 행(hang) 무한대기 방지. (실측 예: 한 프로젝트의 최장 단계 dev 53분.)
- **배치 상태 푸시 알림 (2026-08-08 승인)**: WAIT 진입·각종 STOP(인증/한도/실패/no-op)·qa RED·E2E RED·배치 완주 시 ntfy.sh 푸시 1회. 주제 해석 = `--ntfy-topic` > `PIPELINE_NTFY_TOPIC` env > `~/.claude/ntfy-topic.txt` (미설정=무음, `--ntfy-topic off`=강제 무음). 알림 실패는 배치에 영향 없음(fire-and-forget). 수신 = 휴대폰 ntfy 앱에서 해당 주제 구독.
- 단계별 로그 = `_bmad-output/implementation-artifacts/auto-pipeline-logs/`. **run-summary.log는 누적(append)** — 배치 경계는 `====` 구분선.
- **엔진 exit code**: 0=완료 / 1=단계·qa·조건부 게이트·e2e 실패 / 2=인자 오류(**모델 스펙의 셸 메타문자 거부 포함**) / 3=인증 오류(재로그인 필요) / 4=no-op(산출물 무변경·리뷰 적용 실패) / 5=사용량 한도(리셋 후 같은 명령 재실행) / 6=커밋·가드 STOP(금지 경로·시크릿·dirty 시작·브랜치 전환 실패·**커밋 자리 위반**·**워커 git 조작 차단/우회 탐지**·**민감 파일 격리/복원 실패**·**git 차단 shim 생성 실패**·**pipeline-settings.json 부재**·**원격 URL 에 박힌 자격증명**·**qa/게이트/e2e 명령의 셸 연산자** — 사람 확인 후 재실행).

## v3 — 다중 프로바이더 워커 · 품질 루프 (2026-09-02 · 플래그 미지정 = 종전 동작)

- **모델 스펙 문자열로 프로바이더를 고른다** — `--dev-model opus`(claude · 종전) · `--review-model codex`(Codex 기본 모델) ·
  `codex:<model>` · `claude:<별칭>`. 큐·러너 스키마(`models: {dev, review}`) 무변경.
- **Codex**(`providers/codex.mjs`) = `codex exec` 비대화형(실측 0.152.1: `-C` · `-m` · `-s read-only|workspace-write` · `--json` ·
  `-o` · `--output-schema` · `--ephemeral` · `-a` 없음). review = read-only + 구조화 JSON → **엔진이** 스토리 `### Review Findings`
  에 원장 형식(`- [ ] [Review][Patch][sev] …` · `- [x] [Review][Defer] … ⏭️`)으로 기재 + Status/sprint-status/deferred-work/
  DECISIONS-INBOX 전이(bmad-code-review 와 같은 자리). dev/repair = workspace-write(네트워크 `--codex-network on` 옵트인).
  감지는 codex 스펙이 있을 때만(`codex --version` + `login status`) — 미설치·미인증·cwd 불허면 **claude 대체(dev 와 다른 모델)로
  폴백 + 경고**, 배치는 계속. 실행 위치는 배치 워크트리(marker `.auto-batch-worktree`/`.baroos-auto-worktree` 또는 linked
  worktree)만 — 본 트리의 gitignore 실데이터 반출 방지(`AUTO_CODEX_ALLOW_CWD=1` 로 명시 허용).
- **가드**(2026-09-02 하드닝 반영):
  - **자격증명이 밖으로 안 나간다** — Codex 실행 동안 **민감 파일 전부**(`.env*` 뿐 아니라 pem/key/p12/id_rsa/`auth.json`/
    `service-account*.json`/`*secret*`·`*credential*` 자료 파일/`*.local.*`)를 작업 루트 밖으로 격리했다가 복원한다.
    **깊이 제한 없음**(`packages/a/services/api/config/.env.production` 도 잡는다 · `node_modules`·`.git` 등만 제외) ·
    **fail-closed**(탐색 중 `readdir` 실패 1건이라도 · 옮기지 못한 파일 1건이라도 → 실행 중단 · 복원 실패도 exit 6).
    diff 에서만 빼면 벤더가 작업 디렉터리에서 그냥 `cat` 할 수 있어 의미가 없다(2026-09-02 2차 리뷰 N4/N5).
    리뷰 diff 는 ① 만들 때 pathspec 제외 ② unified diff 에서 민감 파일 섹션 제거 ③ 최종 확정 후 값 재마스킹의 **3중**(추적·미추적·
    `baseline..HEAD` 폴백 전부) · 변경 파일 목록·프롬프트에도 민감 경로 없음 · **로그 마스킹은 프로바이더 무관**(qa·claude·codex·
    repair·**배치 e2e** 공용). 마스커는 **구조 인식**이다 — JSON `"api_key":"…"` · `Authorization: Bearer …` · `Cookie:`/`Set-Cookie:` ·
    `x-api-key:` · 공백이 든 인용값 `KEY="a b c"` 까지 값만 가리고 **이름은 남긴다**(무엇이 새려 했는지는 사람이 알아야 한다).
  - **워커의 git 조작은 실행 단계에서 끊긴다** — 워커 spawn env 에 읽기 전용 허용 목록 shim(PATH 선두) + `GIT_ALLOW_PROTOCOL=none`.
    차단되면 exit 86/`[GIT-GUARD] blocked:` → **COMMIT GUARD STOP(exit 6) · 사람 확인 후 재개**. **shim 을 만들지 못하면 워커를
    아예 실행하지 않는다**(exit 6 · 종전에는 경고 후 진행하는 fail-open 이었다 — 2차 리뷰 N2). 마찬가지로 nested deny 설정
    `pipeline-settings.json`(프로젝트 `.claude/` → 전역 `~/.claude/`)이 **없으면 배치를 시작하지 않는다**(exit 6).
    2차 방어 = 실행 전후의 HEAD·브랜치·stash + **모든 remote 의 heads 스냅숏** + **로컬 reflog/ref 지문** 비교 — 절대경로
    `git.exe` 로 shim 을 우회해 `commit → reset` 을 해도 reflog 는 자라므로 그 사실이 잡힌다(변동 시 exit 6).
    3차 방어(2026-09-02 3차 리뷰 H3) = **워커 env 에서 원격 인증 수단을 통째로 제거**한다 — `GIT_CONFIG_*` 로
    `credential.helper=`·`core.askpass=`·`credential.useHttpPath=false`·`http(s).proxy=` 무효화, `GIT_ASKPASS`·`SSH_ASKPASS`·
    `SSH_AUTH_SOCK`·`SSH_AGENT_PID`·`GIT_SSH*`·`GH_TOKEN`/`GITHUB_TOKEN`·`*_TOKEN`/`*_SECRET`/`*_PASSWORD`/`*_KEY`·프록시 변수 삭제,
    `GIT_SSH_COMMAND` 는 `BatchMode=yes -o IdentitiesOnly=yes -o IdentityAgent=none -i NUL` 로 못 박는다. 프로토콜을 되살려도
    **인증할 수단이 없어** push 가 credential 단계에서 죽는다. 제거한 키 **개수**만 로그에 남는다(값은 남기지 않는다).
    예외 = 제공자 자기 인증(`ANTHROPIC_API_KEY`·`OPENAI_API_KEY` 류) — 지우면 워커가 아예 못 돈다(git 원격에는 쓰이지 않는다).
    ⚠️ **프록시 뒤에서 돌리는 환경이라면** 프록시 변수 제거로 워커의 API 호출이 막힐 수 있다(조용히가 아니라
    인증·네트워크 실패로 STOP 한다). 그 환경에서는 `WORKER_AUTH_KEEP`(`providers/git-guard.mjs`)에 필요한 변수를 명시로 추가한다.
    **원격 URL 에 박힌 자격증명**(`https://x:token@host`)은 env 제거로 못 막으므로 **배치 시작 전에 감지해 STOP(exit 6)** 한다
    (`REMOTE CREDENTIAL STOP` · 로그에는 원격 **이름만** 남긴다).
    **잔여 위험(정직 기록)**: 이것은 **OS 샌드박스가 아니다.** 워커가 절대경로 git 을 직접 spawn 하는 경로는 여전히
    **차단이 아니라 「자격증명 제거 + 사후 탐지」로 완화**한 것이고, 이미 나간 push 를 되돌리지는 못한다. 워커가 저장소 안의
    다른 자격증명을 읽어 `-c http.extraHeader=…` 로 조립하는 경로도 남는다. 근본 차단은 워커를 네트워크·git 실행이 불가능한
    OS 샌드박스/job/컨테이너에 넣는 후속 과제다. 운영 규칙도 그대로 — **러너 워크트리에 원격 자격증명을 두지 않는다.**
  - **모델·경로·설정 값의 셸 메타문자 거부**(exit 2 · 프로세스가 뜨기 전) · 실행은 실행파일+argv 분리(셸 문자열 결합 없음).
    **(2026-09-02 3차 리뷰 M5) 엔진에 `shell: true` 는 0건이다** — qa(`--qa`)·조건부 게이트(`npm run <script>`)·배치 e2e(`--e2e`)
    까지 전부 argv 로 실행한다. 자유형 명령의 형식 계약 = **`<실행파일> <인자>…`**(공백 구분 · `"`·`'` 인용 허용).
    셸 연산자(`&&` `||` `&` `;` `|` `>` `<` 백틱 `$` `%`)와 따옴표 불균형은 **실행 전에 거부**하고 `COMMAND FORMAT STOP`(exit 6)
    한다 — 사슬이 필요하면 npm script 안에 두면 된다(그건 npm 의 셸이다). 알림도 curl 셸 문자열이 아니라 러너와 같은 `fetch`
    경로(`notify-push.mjs` 자식 프로세스)를 쓴다.
  - 머신 전역 codex 슬롯 잠금(`--codex-max` 기본 1 · 고정 슬롯 파일 `wx` 원자 선점 · **실행 동안 별도 자식이 `hb` 심박을 60초마다
    원자 갱신**하고 stale 기준은 `max(3시간, stage 타임아웃×1.5)` — 살아 있는 긴 stage 의 슬롯을 뺏어 codex 두 개가 같은
    `auth.json` 을 쓰는 사고를 막는다) · Codex 실패는 Claude 프로브로 「복구됨」 판정하지
    않고 STOP(러너 재시도) · **clean 리뷰는 스토리 파일 + 리뷰 diff 파일을 둘 다 실제로 읽은 증거가 있어야 인정**(스토리 파일은
    열람 대상 목록에서 제외 — dev 가 고친 스토리 문서 한 번 읽기로 두 조건을 채우던 우회를 막는다 · 증거 없으면 exit 4) · 빈 diff 는 claude 리뷰로
    전환 · 이전 라운드 열린 findings 잔존 시 done 금지 · 이월 금지 5범주는 patch 승격 · **Decision 이 있는데 `DECISIONS-INBOX.md` 가
    없으면 기본 형식으로 만들어 등재**하고, 만들 수 없으면 리뷰 적용 실패(exit 4).
- **Claude 인증 프로브는 실제 실행할 프로바이더만 본다** — 남은 단계가 전부 codex 면 스토리 경계 프로브를 생략한다(Claude 로그인이
  만료돼도 codex 전용 배치는 선다). codex 가 불가해 claude 로 폴백될 단계가 있으면 종전대로 프로브한다.
- **한도 사다리 확장**: 같은 프로바이더 차순위(fable→opus→sonnet) → 다른 프로바이더(`--codex-roles` 의 역할 · 가용 ·
  **스토리당 전환 1회** · dev 부분 산출물 폐기 = 처음부터). spend 는 종전대로 사다리·대기 없음.
- **품질 루프** `--auto-repair N`(총 · 기본 0 = 종전 qa RED 즉시 STOP) · `--repair-same-cause N`(기본 3) ·
  `--integrity on|auto|off` — **기본 `on`**(2026-09-02 2차 리뷰 F8: 종전 기본 `auto` 는 `--auto-repair 0` 인 기본 실행에서
  검사를 통째로 껐고, 그 경로에서 워커가 새로 만든 `.only`·skip 이 아무 검사도 받지 않았다. `auto` = 종전 조건부 · `off` = 명시 옵트아웃):
  dev 뒤 테스트 무결성(`.only`·사유 없는 테스트 삭제 = 차단 · skip/ts-ignore/eslint-disable/게이트 설정 변조 = 경고, 수리
  라운드가 새로 만든 것은 차단) → qa → RED 면 원인 분류·서명 → 수리 프롬프트로 dev 워커 재투입 → 재검증. 예산 소진 =
  종전 STOP 문구 + 6절 에스컬레이션(상황·원인·시도·선택지·추천·위험).
  **(2026-09-02)** 무결성 검사는 **미추적 신규 파일 본문까지** 본다(텍스트 · 1MB 상한 · 바이너리 제외) — 새로 만든 테스트의
  `.only`·skip·빈 본문·항상-참 단언이 더 이상 검사를 비껴가지 않는다. 「수리 라운드가 새로 만든 것」 판정은 `rule|file` 이 아니라
  **`rule|file|줄 내용 지문`** 이라 같은 파일에 같은 종류를 하나 더 넣어도 기존 경고에 가려지지 않는다.
- **조건부 게이트는 있으면 실제로 돌린다(#10)** — 보안/성능 트리거(경로·diff 키워드)가 켜지고 `package.json` 에 대응 스크립트
  (`test:security`·`security`·`rls:check`·`audit` / `test:perf`·`perf`·`test:performance`·`bench`)가 있으면 qa GREEN 뒤에 **그 스크립트를
  실행**하고, 실패는 품질 루프의 RED(수리 루프 대상)다. 스크립트가 없으면 종전대로 `required-missing` 으로 정직하게 기록만 한다
  (없는 검사를 통과로 세지 않는다). 매니페스트에 `checks.security/performance` + `conditionalGates.{script,exit,result}`.
- **완료 판정 8조건(`completion`)의 3차 리뷰 강화(2026-09-02)**:
  - **T2(새 테스트)** — 「테스트 1건이라도 붙었나」가 아니라 **정상·실패·경계 3유형**을 diff 의 케이스 이름·본문에서 판별한다.
    3유형 다 있으면 pass · 일부만이면 **`not-verified`**(fail 아님 — 빠진 유형을 사유에 적는다) · 판별할 diff 가 없으면 `not-verified`.
    근거는 매니페스트 `checks.unitKinds{normal,failure,boundary}` 에 구조화해 남긴다(`checks.unit` 은 종전대로 pass/fail 문자열).
    종전에는 happy-path 한 건으로 완료가 `ready` 가 됐다.
  - **T6(교차 검토)** — `workers.dev.provider` 와 `review.provider` 중 **하나라도 없으면 `not-verified`**(둘 다 있고 서로 다를 때만 pass).
    구형·부분 손상 매니페스트가 「다른 쪽인지」 확인 없이 프로젝트를 ready 로 올리던 구멍을 막는다.
  - **clean 리뷰의 열람 증거** — 스토리 파일 + 리뷰 diff에 더해 **변경 구현 파일 최소 1개 열람**이 필수다(종전엔 경고뿐).
    변경 구현 파일이 하나도 없을 때만 종전 판정으로 물러선다.
- **검증 매니페스트** `auto-pipeline-logs/<story>-verification.json`(`--no-manifest` 로 끔) · STOP 부기 `exit-info.json`
  (러너가 레인 전환에 쓴다) · 관찰 로그 `[<story>][CLAUDE|CODEX][DEV|REVIEW|REPAIR]` · `[…][QUALITY][PASS|FAIL]` ·
  `[…][INTEGRITY][BLOCK|WARN]` — 현황판이 읽는 `→ [story] stage (model=…)` · `exit=` 줄은 그대로.
- 테스트: `node --test`(providers · quality-rules · story-writes · engine-guards 소스 앵커 · failure-classify ·
  **engine-e2e = 스텁 claude/codex 심 + 실제 임시 git 저장소로 엔진을 실제 spawn 하는 종단 테스트**).

## 실행 절차

### 0. 실행 모드 결정 — 터미널 인증 만료 시 직접 진행 자동 폴백 (2026-08-08 확정 정책)

배치 시작 전 터미널 CLI 인증을 1콜 프로브로 확인한다(§1 모델 프로브와 겸용).
- **인증 정상** → 기본대로 엔진 배치(§4).
- **인증 만료(401)** → **묻지 않고 대화창 직접 진행으로 자동 전환** — 사용자 부재 중에도 작업이 멈추지 않는 것이 목적. 전환 사실을 첫 보고 1줄로 남기고 진행한다.
  1. 스토리를 의존성 순서로 **순차** 처리: create → dev → qa 게이트(프로젝트 정의 게이트를 Bash로 직접 실행 — §가드레일) → review.
  2. **review = 독립 서브에이전트 필수**(새 컨텍스트, 가능하면 dev와 다른 모델) — dev↔review 격리를 엔진과 동등하게 유지. 러버스탬프 금지.
  3. 스토리 3개+ 배치는 dev도 스토리별 서브에이전트로 위임(지휘 컨텍스트 소모 완화).
  4. 가드레일 동일 적용: qa RED 즉시 중단 / git commit·push 절대 금지 / 임의 기본값 결정은 "⚠️ 무인 기본값 결정" 마커로 스토리 파일에 기록 → §5 보고에서 표면화.
  5. 한계: 직접 진행은 state.json 이어하기가 없다 — 세션 중단 시 다음 세션이 스토리 파일·sprint-status 기준으로 이어간다. 스토리 단위로 진행 상황을 스토리 파일에 반영해 둘 것.
- **엔진 배치가 이미 AUTH WAIT로 멈춘 경우**: 사용자가 자리에 있으면 재로그인 안내 유지. 장시간 무응답이면 **엔진 프로세스 중지를 확인한 뒤** 남은 스토리를 직접 진행으로 이어간다(같은 폴더 동시 2배치 금지 — 엔진이 살아있는 채 직접 진행 병행 절대 금지).

### 1. 발화 파싱
사용자 요청에서 추출:
- **스토리 범위**: "S-J부터 S-M" → `s-j, s-k, s-l, s-m` / "story11"·"Epic 11" → `11-0 … 11-5` / 명시 리스트("11-2,11-3") 그대로.
- **단계(stages)**: 기본 `create,dev,review`. "dev-review만" 같은 지정 반영.
- **모델 지정**: 사용자가 특정 모델을 명시하면(예: "리뷰는 X 모델로") 그대로 `--*-model`에 반영. **미지정(기본) → 성능 우선 자동 선택** (2026-08-08 확정 정책):
  1. **후보 목록(희망값)**: 지휘 LLM이 현재 환경에서 아는 최상위 모델 별칭을 성능순으로 나열한다 — 예: claude 환경 `fable → opus`, codex 환경은 기본 모델이 이미 최상위 코딩 모델이라 후보 없이 생략이 원칙. 후보는 "되면 쓰는 희망값"이며, 없는 모델을 필수로 찾아 헤매지 않는다(새 최상위 모델이 나왔음을 알면 후보 목록 맨 앞에 추가).
  2. **프로브 검증**: 배치 시작 전 후보를 성능순으로 1콜 실존 확인 — `echo ok | claude -p --model <후보>` (수 초). 성공한 최상위 = **create·dev 모델**. 전부 실패 = 플래그 생략(CLI 기본 모델) — 어느 환경에서든 배치가 멈추지 않는다.
  3. **review = dev와 다른 모델**(교차검증 — 같은 모델은 자기 맹점을 공유): 프로브로 검증된 차상위의 *다른* 모델을 지정, 다른 모델이 없으면 생략(기본 모델) — 각 단계가 새 프로세스=새 컨텍스트라 리뷰 독립성은 유지된다.

### 1b. 병렬 판정 — 독립 스토리는 병렬 우선 (2026-07-23 확정 정책)

스토리가 2개 이상이면 **병렬 가능성부터 판정**한다. 판정 기준(전부 충족 시 병렬 그룹 분리):
1. **의존성 무관** — sprint-status·SCP 의 dep 표에서 서로 간선이 없다.
2. **파일 스코프 비중첩** — 스토리 범위 서술(SCP §7·스토리 md File List)이 같은 소스 파일을 건드리지 않는다. **의심되면 같은 그룹(순차)** — 확신 없는 병렬 금지. (`sprint-status.yaml`·`deferred-work.md`·스토리 자신 md 는 항상 겹치므로 판정에서 제외 — 수집 시점에 정합.)
3. **그룹 수 ≤ 2** (같은 머신에서 무거운 qa 게이트(테스트+빌드) 동시 실행 시 자원 경합으로 타임아웃 플레이크 위험 — 실측 예: 한 프로젝트의 vitest RTL 20초. 하드웨어 상향 시 3까지 검토).

**병렬 실행 절차**:
1. 그룹 A = 현 체크아웃. 그룹 B = 새 워크트리 프로비저닝 — **프로젝트에 프로비저닝 스크립트가 있으면 그것을 사용**(파일 실존을 먼저 확인. 예: 프로젝트 동봉 `scripts/setup-pipeline-worktree.mjs` 류), 없으면 `git worktree add` + 의존성 설치 + env/미추적 툴체인 복사를 수동 수행. 프로비저닝이 불확실하거나 실패하면 **병렬을 포기하고 순차로 전환**(안전 우선 — 병렬은 최적화일 뿐).
2. 각 워크트리에서 `git checkout -b feat/<배치>-<그룹> origin/main` 후 **그룹별 엔진 1개씩** background 실행(같은 폴더 1파이프라인 규칙은 그룹 내부에 그대로 적용).
3. **수집(전 그룹 완주 후)**: 그룹별로 스토리별 커밋(각자 브랜치) → PR 은 순차 머지. 두 번째 PR 의 상태 추적 파일(`sprint-status.yaml` 등) 충돌은 **union 3-way 병합 + 기존 개행 형식 보존 + 스토리 키 손실 0 검증**으로 해소(예: 프로젝트에 따라 CRLF 바이트 보존 같은 개행 관례). 리뷰 findings 처리·재리뷰는 그룹별 독립.
4. 병렬 폭 결정·그룹 구성은 배치 계획 echo(§3)에 명시해 1회 보여주고 진행.

**병렬 금지 케이스**: dep 사슬(예: 20-31→20-32)·파일 중첩 의심·마이그레이션 번호 경합(둘 다 신규 마이그를 만들 수 있으면 번호 선점 충돌 — 한 그룹으로) ·리뷰가 "동일 파일 혼재 분리 심사"를 요구할 규모의 대형 스토리 쌍.

### 2. 순서 resolve (의존성)
- `_bmad-output/implementation-artifacts/sprint-status.yaml` 와 `epics.md`를 읽어 **정확한 스토리 식별자(파일명 키)** 와 **의존성 순서**로 정렬.
- **이미 `done` 인 스토리는 건너뛴다**(예: 11-0 done). `in-progress`는 포함.
- 의존성 미충족 발견 시 **경고하고 순서 보정**.
- **배치 분할 정책 (2026-07-13 A/B 재검토, U6/U7로 완화)**: 실측(한 프로젝트 예시) 스토리당 평균 84분 — 프로젝트별 실측으로 갱신. 경계 프로브+`--wait-auth-min`이 켜져 있으면 긴 배치도 토큰 만료 시 스토리/단계 경계에서 대기→자동 재개하므로 분할은 필수가 아니다. 다만 **사람이 자리에 없는 밤샘 배치는 `--wait-auth-min 480` 필수**, 자리에 있는 낮 배치는 2~3스토리 분할 + 직전 재로그인이 여전히 가장 단순하다.

### 3. 계획 echo (1회, 진행 전)
다음을 한 번 보여주고 진행한다(스토리별 승인 없음 — 무인이 목적):
```
배치 계획: [<순서대로 스토리>]  단계: [create,dev,review]  실행 모드: <엔진 배치 | 직접 진행(인증 만료 폴백)>
모델: create=<선택 또는 cli-default> dev=<...> review=<...> (+선택 근거 1줄)  |  qa 게이트: <프로젝트 정의> (RED=중단)  |  커밋/푸시: 안 함
```

### 4. 엔진 구동
Bash로 실행. **장시간 배치면 `run_in_background: true`**, 또는 사용자가 별도 터미널에서 직접 실행하도록 명령을 제시(데스크탑 앱을 닫아도 살아있음).
```bash
node "$HOME/.claude/skills/auto-story-finish/auto-story-pipeline.mjs" \
  --stories "<쉼표구분 순서대로>" \
  --stages "create,dev,review"   [--commit --branch auto/<날짜> --push]   # 옵트인 스토리 단위 커밋·푸시(가드레일 참조)
```
- 실행 위치(cwd) = **대상 프로젝트(워크트리) 루트** — 로그·산출물은 cwd의 `_bmad-output/implementation-artifacts/`에 기록된다. nested deny 설정은 엔진이 프로젝트 `.claude/pipeline-settings.json` → 전역 `~/.claude/pipeline-settings.json` 순으로 자동 해석.
- **모델 플래그는 전부 선택사항** — §1 프로브 검증에서 확정한 모델만 `--create-model/--dev-model/--review-model/--probe-model <별칭>`으로 덧붙인다(프로브 실패 후보는 지정 금지). 미지정 = CLI 기본 모델(어느 환경에서든 동작).
- `--e2e "<명령>"` = **배치 종료(전 스토리 완주) 후 1회** e2e 스모크 — RED면 exit 1(스토리 산출물은 유지, 커밋 전 확인 신호). 프로젝트가 e2e 명령을 보유·GREEN 확인된 경우에만 지정(예: `cd apps/web && npm run e2e:smoke` 형태 — 로컬 빌드+서버 기동 포함, 수 분 소요). **스토리마다 돌리지 않는다**(비용) — 신규 spec 작성도 이 스킬 범위 밖. **`--push` 와 함께 쓰면 스토리 push 가 이 게이트 뒤로 미뤄진다**(N1 · 위 가드레일 ⑦). 러너가 자기 통합 게이트를 따로 돌리는 편성이면 `--defer-push` 만 켜라 — 엔진은 로컬 `auto/*` 에만 커밋하고 push 는 러너 몫이 된다.
- 검증만 먼저 보려면 `--dry-run`. **중단 후 재개 = 같은 명령 그대로 재실행**(state.json 완료 단계 자동 skip). 재실행 강제 = `--force`(create 덮어쓰기 방지는 유지). 스토리 식별자는 sprint-status.yaml **전체 키(=파일명)** 사용 권장 — 짧은 식별자는 엔진 사후조건이 prefix 매칭으로 스토리 파일을 찾으므로 전체 키가 가장 안전하다.
- **AUTH STOP(exit 3)으로 멈추면**: 재실행 반복 금지 → 사용자에게 claude 대화형 재로그인을 요청 → 같은 명령 재실행(이어하기). **LIMIT STOP(exit 5)이면**: 재로그인 불필요 — 한도 리셋 후 같은 명령 재실행(이어하기). 장시간 무인 배치는 애초에 `--wait-auth-min 480`을 붙여 재로그인·한도 리셋만으로 자동 재개되게 한다(최상위 모델 배치는 한도 소모가 커서 특히 권장). **NO-OP STOP(exit 4)이면**: 해당 단계 로그를 열어 CLI가 무엇을 했는지 확인 후 사람 판단.
- **헤드리스 무인 주의**: 엔진은 `acceptEdits`로 파일 편집만 자동 승인한다. 허용 목록에 없는 bash 명령은 **헤드리스에서 프롬프트 없이 자동 거부된다(멈추지 않음)** — dev는 정적 검증(typecheck·vitest·build)만 가능하고 라이브/런타임 검증은 배치 후 사람 몫이다(엔진 GUARD가 미실행 검증의 ✅ PASS 기재를 금지, '미실행(사람 검증 IOU)' 정직 relabel 강제). 무인 실행 전 **사용자가 `.claude/settings.json` 에 필요한 명령 허용 규칙(npm·node·git status 등 읽기/빌드)을 직접 추가**해야 한다(`/fewer-permission-prompts` 스킬 참고). 권한 우회 플래그는 의도적으로 제공하지 않는다 — 허용 범위는 사용자가 명시적으로 정한다.

### 5. 보고
`auto-pipeline-logs/run-summary.log` 와 단계별 로그를 읽어:
- 진행 범위(완료 스토리 / 중단 지점), qa 게이트 통과 여부, review findings 위치 요약. run-summary는 누적이므로 **마지막 `==== BATCH START` 이후 구간**이 이번 배치다.
- **중단됐으면** 어느 스토리·단계에서 왜(exit 3=인증 / exit 4=no-op / exit 5=사용량 한도 / exit 1=실패·qa RED) 멈췄는지 명확히. 사람이 고칠 지점 + 재개 명령(같은 명령 재실행=자동 skip) 안내.
- **무인 기본값 결정 표면화**: 각 스토리 파일·`{story}-create/dev.log`에서 "⚠️ 무인 기본값 결정" 마커를 찾아 임의 결정 목록을 사용자에게 보고.
- **커밋 여부 명시** — 기본 배치는 커밋 안 함(diff + 리뷰 리포트 검토 후 사용자가 수동 커밋). `--commit` 배치는 스토리별 커밋 SHA·브랜치·푸시 성공/실패를 run-summary에서 읽어 보고하고, **main 머지는 사람 승인**임을 명시.

## 주의
- **프로젝트 계층화 (2026-08-08 확정 정책)**: 이 전역 스킬·엔진은 **프로젝트 중립 코어**(모델 선택·인증 폴백·이어하기·qa RED 중단·no-commit)만 담는다. 법정 보수성·보호 경로·게이트 조합·워크트리 격리 세칙 같은 **프로젝트 특화 제약은 각 프로젝트 CLAUDE.md**에 둔다 — 동명 스킬을 프로젝트 `.claude/skills`에 두는 방식은 층위 우선순위(문서 기준 enterprise>personal>project — **전역(개인)이 프로젝트를 가림**) 탓에 비신뢰 경로이므로 쓰지 않는다. 헤드리스 nested 인스턴스는 실행 cwd의 프로젝트 CLAUDE.md를 자동 로드(공식 문서 확인, `--bare`만 예외)하므로 제약 주입은 자동 — 예: 규제 제약이 있는 프로젝트와 없는 프로젝트가 같은 전역 스킬을 공유하면서 서로 다른 제약으로 동작한다. **전역 스킬에 특정 프로젝트 규칙을 역주입하지 말 것.**
- 각 `claude -p`는 **새 프로세스 = 새 컨텍스트** → dev↔review 격리가 자연히 됨. 환경에 다른 모델이 있으면 review에 다른 모델 지정이 권장이지만, 같은 기본 모델이어도 이 격리로 리뷰 독립성은 성립한다.
- 헤드리스에서 create/dev의 대화형 HALT는 **멈추지 않고 임의 기본값으로 통과**된다(GUARD 지시). 결정 내역은 스토리 파일 "⚠️ 무인 기본값 결정" 마커로 남게 했으므로 §5 보고에서 반드시 표면화. 질문이 많을 스토리는 스펙을 미리 채워 임의 결정 여지를 줄이거나 `bmad-quick-dev` 대체를 검토.
- 프로젝트에 워크트리 격리·보호 경로 규칙이 있으면 **그 프로젝트 CLAUDE.md를 따른다**(계층화 — 예: 어떤 프로젝트의 「메인 체크아웃=읽기 전용」 세칙). 엔진은 실행 cwd에서만 동작.
- create-story가 새 스토리 파일을 만들 때 키=파일명 정합 필수(dev-story가 `{key}.md` 탐색 + 엔진 사후조건도 같은 키로 산출물을 찾는다).
- **전역 설치형이라 프로젝트별 이식 불필요.** 새 프로젝트 온보딩 = ① qa 게이트 명령 정의(기본 `npm run qa`) ② 프로젝트 특화 제약을 그 프로젝트 CLAUDE.md에 기록 ③ (병렬을 쓸 경우) 워크트리 프로비저닝 수단 준비 — 이 3가지뿐. nested deny 설정은 전역 `~/.claude/pipeline-settings.json` 폴백이 자동 적용된다.
- **밤샘 무인 배치 감시(선택)**: 배치를 백그라운드/별도 터미널로 띄운 뒤, 다른 세션에서 내장 `/loop`으로 진행 상황만 감시시킬 수 있다 — 예: `/loop 30m _bmad-output/implementation-artifacts/auto-pipeline-logs/run-summary.log 의 마지막 BATCH START 이후 구간을 확인해, AUTH STOP(exit 3)·NO-OP STOP(exit 4)·LIMIT STOP(exit 5)·qa RED로 멈춰 있으면 어느 스토리·단계·사유인지 보고하라. 배치가 정상 진행 중이거나 완료되면 한 줄로만 보고.` ⚠️ `/loop`에는 **감시·보고만** 시킬 것 — 엔진 재시작·재실행·수정 지시는 금지(동시 배치 2개 금지 규칙과 충돌 + 인증 재개는 사람 재로그인이 전제). 멈춤 보고를 받으면 사람이 원인 확인 후 같은 명령 재실행(=이어하기)으로 재개한다.


## 자율 마무리가 부를 때

스토리 범위가 **주어지지 않은** 요청(「알아서 마무리해줘」)은 이 스킬이 직접 받지 않는다.
`night-batch-ops` 의 자율 마무리(`engine/autofinish.mjs`)가 진단·우선순위·BMAD 등재·편성을 먼저 하고,
그 결과 큐를 `run-night --queue` 로 넘기면 이 엔진은 **종전 계약 그대로** 스토리 단위로 돈다
(create→dev→qa→review · 커밋 가드 · 통합 게이트 · 실패 격리).

즉 이 스킬이 바뀌는 것은 없다 — 큐가 어디서 왔는지만 다르다. 자율 마무리가 만든 큐는
`planned: "autofinish"` 이고 `defaults.push` 는 항상 `false` 다(외부 반영은 사람 승인).

자세한 것은 `night-batch-ops/AUTOFINISH.md`.
