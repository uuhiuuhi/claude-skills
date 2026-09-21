---
name: dev-status
description: BMad v6 프로젝트의 읽기 전용 개발 현황판. "개발 현황판 열어줘", "스토리 진척 보여줘", "어젯밤 배치 어떻게 됐어", "배포해도 되나" 같은 요청에 사용한다. epics.md(목록 SoT)·sprint-status.yaml(상태 SoT)·스토리 md·auto-pipeline-logs 와 무인 배치 하네스 산출물(배치·검증 매니페스트·계측·예정 큐·자율 진단·결정 인박스)을 규칙만으로 판정해 **현황판 신선도 검토(이 화면이 지금을 반영하는가)**, 배포 가능 판정, 결정 인박스, 지난밤 배치(프로바이더/모델·병렬·통합 게이트), 오늘 예정 큐, 3일 계측, 자율 마무리 진단, 에픽·스토리 진행률, 단계 배지 4칸, File List 겹침 판정, 불일치 경고, 다음 할 일 추천을 로컬 HTML 한 장으로 보여준다. 외부 의존성 0, LLM 호출 0, Node 20 이상. 커밋·게시 등 쓰기 작업은 하지 않는다.
---

# dev-status — BMad 개발 현황판 (최소판)

프로젝트를 바꾸지 않는 **읽기 전용** 현황판. 로컬 서버(127.0.0.1)를 띄워 브라우저로 보여 주며, 새로고침(F5)할 때마다 원천 파일에서 다시 만든다. 생성물은 `{프로젝트루트}/_bmad-output/dev-status/index.html` 한 장뿐이다.

## 실행법

프로젝트 루트(또는 그 하위 폴더)에서:

- Bash: `node "$HOME/.claude/skills/dev-status/serve.mjs"`
- PowerShell: `node "$env:USERPROFILE\.claude\skills\dev-status\serve.mjs"`
- cmd: `node "%USERPROFILE%\.claude\skills\dev-status\serve.mjs"`

설정 폴더를 옮긴 사용자는 `CLAUDE_CONFIG_DIR` 환경변수가 있으면 홈 대신 그 값을 쓴다 — 예: `node "$CLAUDE_CONFIG_DIR/skills/dev-status/serve.mjs"`.

- `--root <경로>`: 프로젝트 루트 지정. 없으면 현재 폴더에서 시작해 `_bmad/` 또는 `.git/` 를 만날 때까지 상위로 최대 6단 탐색한다(모노레포의 패키지 폴더 대응).
- 포트: `DEV_STATUS_PORT`(기본 5180). 점유돼 있으면 5181…5189 로 자동 증가하고, **확정된 주소를 stdout 첫 줄에 출력**한다. 범용 포트 변수는 읽지 않는다.
- `NO_OPEN=1` 이면 브라우저 자동 열기를 생략한다.
- 화면 파일만 만들기: `node …/build.mjs --root <경로>` · 데이터(JSON)만 보기: `node …/scan.mjs --root <경로>`
- `--out <폴더>`: 화면을 정본 폴더(`_bmad-output/dev-status/`) 대신 다른 곳에 쓴다(스모크·미리보기용). 스토리 문서 상대 링크는 **정본 폴더 기준**이라 다른 폴더에 쓰면 그 링크만 어긋난다.
- `package.json` 이 없는 프로젝트에서는 npm 스크립트가 없으므로 **위 전역 스킬 직접 호출이 유일한 실행법**이다.

## 원천 계약 (무엇을 읽는가)

- 산출물 경로: `_bmad/bmm/config.yaml` 의 `planning_artifacts`·`implementation_artifacts`(`{project-root}` 치환). 없으면 `_bmad/config.toml` 의 `[modules.bmm]` 아래 같은 두 키. **둘 다 실패하면 확인한 경로 진단**(CLI 실행이면 exit 2 · import 경로면 `scan().error`) — 기본 이름 폴백·글롭 탐색은 하지 않는다.
- `{planning_artifacts}/epics.md` — 에픽·스토리 목록 SoT
- `{implementation_artifacts}/sprint-status.yaml` — 상태 SoT(`development_status:` 블록). `story_location`·`last_updated` 는 주석줄로 와도 읽는다. **`last_updated:` 가 여러 줄이면 날짜가 가장 최근인 것**을 고른다(2026-09-21 — 같은 키가 머리에 수십 줄 쌓이고 맨 위가 최신이 아니다). 이 값은 참고일 뿐이고 헤더의 「상태 파일 날짜」는 **파일 시각·커밋 시각**을 쓴다(신선도 F2).
- `{implementation_artifacts}/RELEASE-LOG.md` — **있으면** 읽는다. 절 머리 `## YYYY-MM-DD [HH:MM] · …` 에서 가장 최근 릴리스 시각을 뽑아 「마지막 릴리스 이후만 센다」의 기준선으로 쓴다. 없으면 **아무것도 접지 않는다**(종전대로 전건을 센다).
- `{프로젝트루트}/tools/dev-status/sources.json` — **있으면** 읽는 프로젝트 소유 설정(이 스킬 폴더에는 두지 않는다 — 계층화 정책). 읽는 키는 넷뿐이고 전부 **있을 때만** 동작한다: `opsLineEpics`(운영선 에픽 번호 → 운영선/개발선 가르기) · `devLineBranches`(개발선으로 확인된 주제 갈래 이름) · `integrationGateSince`(통합 게이트 도입일) · `qualityGatesSince`(검사 종류별 도입일 맵). 없으면 전부 종전 동작이다.
- 스토리 `.md` 파일 — File List(겹침 판정)·수용기준
- `auto-pipeline-logs/state.json`(단계 배지)·`run-summary.log`(배치 가동 판정 **+ 스토리별 리뷰 실행 횟수**) — 없으면 단계 배지·배치바·리뷰 반복 판정만 빠지고 나머지는 정상.
  - `run-summary.log` 의 스테이지 시작 줄 `[ISO] → [슬러그] <stage>` 중 `stage` 가 정확히 `review` 이고 **바로 뒤 `[ISO]    exit=0` 줄로 완료가 확인된 것만** 슬러그별로 센다. 시작 줄만 세면 `--dry-run` 예행연습(엔진이 시작 줄을 찍고 즉시 반환한다)과 인증 만료로 죽은 실행까지 리뷰 1회로 잡힌다. 이 줄 서식은 무인 배치 엔진(auto-story-finish)이 찍는 것이라 프로젝트 문서 서식과 무관하다.
- **엔진 경로 리터럴 1순위**: 무인 배치 엔진(auto-story-finish)은 config 를 읽지 않고 `_bmad-output/implementation-artifacts` 를 하드코딩한다. 이 스킬은 그 리터럴을 1순위, config 값을 2순위로 찾고, 두 경로가 다르면 화면 상단에 배너를 띄운다.

구조 패턴(`PATTERNS` 5종 — 문서가 한국어여도 이 키워드는 영어로 남는다):

1. `^#{2,3} Epic (\d+): ` — 에픽 절. **제목 단계로 자르지 않는다**(2026-09-21) — 실제 문서는 본문 절 `## Epic N:` 과 「## Epic List」 요약 절 안의 `### Epic N:` 이 섞이고, 같은 에픽 번호가 두 절에 나뉘어 각각 다른 스토리를 든다. 같은 번호의 절은 **스토리를 합집합으로 합치고**(제목·설명은 스토리가 더 많은 절이 맡는다), 몇 개가 합쳐졌는지는 `duplicateEpics` 로 남긴다. 자리(진행 순서)는 그 번호가 **처음 나온** 자리다.
2. `^#{3,4} Story (\d+)\.(\d+): ` — 스토리 절. `### Story` 와 `#### Story` 를 **둘 다** 읽는다(한 칸 깊은 것은 `deep: true`). 단계만 보던 종전 규칙은 원 프로젝트에서 스토리 30건을 「상태 파일에는 있으나 에픽 문서에 없습니다」로 오탐하고 에픽을 11개로 셌다.
3. `^\*\*Given\*\*` — 수용기준(AC) 개수
4. `So that` — 스토리 목표 문장
5. `Deferred from:` — 이연 기록 절(이 스킬 화면에는 쓰이지 않지만 BMad v6 원천 계약의 일부)

원천 파일은 있는데 위 패턴이 0건이면(에픽 0·스토리 0·상태 항목 0·AC 총합 0) stderr 경고 + 화면 상단 배너로 알린다 — 서식이 바뀌어도 "정상처럼 보이는 빈 화면"이 되지 않는다.

요구 환경: Node 20+. 외부 패키지 0(node 빌트인만), LLM 호출 0(전부 규칙 판정).

## 새 배치 하네스 블록 (2026-09-03 · 목업 승인분)

무인 배치(`night-batch-ops` 러너 + `auto-story-finish` 엔진)를 쓰는 프로젝트라면 그 산출물을 읽어 블록 6개를 **추가**한다. **기존 블록(다음 할 일·불일치·진행률·스토리 표)은 그대로다** — 새 블록은 끼워 넣기지 대체가 아니다. 하네스를 안 쓰는 프로젝트에서는 전부 「없음」으로 뜨고 화면의 나머지는 종전과 같다.

| 블록 | 무엇 | 원천 |
|---|---|---|
| ① 헤더 히어로 | 배포 가능 판정 배지 + 이유 1줄 · 슬롯 심박 · 오늘의 숫자 5칸 | 아래 전부 |
| ② 오늘 정하실 것 | 결정 대기 · 사람 게이트(3일 이상은 맨 위·주황) · 사후 확인 접기 | `DECISIONS-INBOX.md` |
| ④ 지난밤 배치 | 스토리별 **프로바이더/모델** · 병렬 폭 · 통합 게이트 · 되돌림 설명 · 재시도 · 증거 폴더 | `batch-<id>-manifest.json` + `<story>-verification.json` + `metrics-<id>.json` + `archive/*-evidence/` |
| ⑤ 오늘 밤 예정 | 편성 방식 · 자기 검증 경고 · 빠진 스토리 · 배치 순서 · 병렬 짝 · 배정 이유 · 사용 LLM | `auto-queue-*.json`(없으면 `tools/auto/night-queue.json`) + `assign-history.json` |
| ⑥ 얼마나 잘 돌았나 | 지표 6종 + 모델 호출량을 **지난 1/2/3일**(18:00 접기)로 · 추세 · 「제외 N」 | `metrics-history.jsonl` + 위 매니페스트 2종 |
| ⑦ 자율 마무리 진단 | 5분류 · 우선순위 7단계 · 배포 차단 목록 · 확인 못 한 것 | `<state>/autofinish/<runId>/{diagnosis,backlog,readiness,report}.json` |

**⑦ 의 파일 이름·모양은 엔진이 정한다**(2026-09-21). 엔진은 라운드마다 `round-N-<종류>.json` 을, 마지막 라운드 뒤에 `final-<종류>.json` 을 쓴다. 현황판은 `<종류>.json` → `final-<종류>.json` → **가장 나중 라운드** `round-N-<종류>.json` 순으로 하나만 골라 읽고, 하나도 없으면 「아직 없습니다」로 적는다(추측하지 않는다). `readiness.json` 은 최상위가 `{project, tasks}` 이고 판정은 `project` 안에 있어서, 최상위에 `schema` 가 없는 모양이면 `project` 를 꺼내 읽는다 — 종전 파서는 이걸 「알 수 없는 형식」으로 버려서 **진단을 돌려도 화면에 안 들어왔다**. 실행 폴더도 한 겹 더 깊은 옛 배치(`…/autofinish/autofinish/<runId>/`)까지 보고, 고르는 순서는 **runId(`YYYY-MM-DD-HHmmss`) 최신 우선**이다(폴더 시각만 보면 옛것을 나중에 복사한 것이 이긴다).

스토리 표에는 **워커 · 라운드 · 마지막 리뷰어** 3칸을 덧붙인다 — 값이 하나라도 있을 때만 그린다(빈 칸 3개는 화면만 좁힌다).

## 현황판 신선도 검토 (2026-09-21 · 화면 맨 위 블록)

「이 화면이 **지금**을 반영하는가」를 화면 스스로 검토해 맨 위에 7줄로 적는다. 왜 생겼나 — 화면이 현재를 반영하지 못한 채 조용히 낡아 있었다(원 프로젝트 실측: 읽는 폴더가 최신 main 이 아닌데 표시가 없었고, 헤더의 「상태 파일 날짜」가 손으로 적은 주석을 읽어 사흘 전이었다).

판정은 `freshness.mjs`(순수 함수 · fs 접근 0)가 하고, 재료는 `scan.mjs` 가 `data.freshness` 로 모으며, 그림은 `build.mjs` 의 `renderFreshness` 가 그린다.

| 항목 | 무엇을 보나 | 재료 |
|---|---|---|
| F1 | 읽는 폴더가 최신인가 — **이미 받아 둔** `origin/main` 과의 앞뒤·미커밋 변경 수 | `git rev-parse`·`rev-list`·`status --porcelain` (읽기 전용 · **fetch 하지 않는다**) |
| F2 | 상태 파일이 언제 바뀌었나 — 근거는 주석이 아니라 **파일 시각·커밋 시각** 중 최근 | `sprint-status.yaml` 의 mtime + `git log -1` |
| F3 | 에픽 문서 ↔ 상태 파일 정합 — 한쪽에만 있는 스토리 · `#### Story` 건수 · 중복 에픽 절 | `parseEpics`/`parseSprint` 집계 |
| F4 | 무인 러너가 살아 있나 — 심박·잠금 파일·마지막 기록 | 상태 폴더 `slots.log` |
| F5 | 지난밤 배치 재료가 있나 — 「0건」이 진짜 0 인지 재료가 없는 것인지 | `batch-<id>-manifest.json` |
| F7 | 결정 인박스가 언제 바뀌었나 | `DECISIONS-INBOX.md` mtime + 커밋 시각 |
| F8 | 이 화면을 만든 시각 — 10분 넘으면 새로고침 안내 | `generatedAt` |

- 상태는 넷뿐이다: `ok`(✅) · `warn`(⚠️) · `stale`(🔶) · `unknown`(❔). 종합 판정은 stale 하나라도 있으면 🔴, warn 만 있으면 🟡, 전부 ok 면 🟢, **unknown 이 남으면 ⚪ 판정 불가**다 — 확인 못 한 것을 🟢 로 올려치지 않는다.
- 각 줄은 **무엇을 · 왜 · 다음에 뭘 하면 되는지** 순서다(`detail` + `action`).
- **F6 번호는 비어 있다.** 원본 프로젝트의 F6 은 DB 마이그레이션 실프로브 산출물이 원천이라 이 스킬에 없다(아래 「이 스킬에 없는 기능」). 번호를 당기지 않고 비워 둔 것은 빠진 자리를 감추면 「F6 은 통과했나」로 오해되기 때문이다.
- **git 이 없어도 죽지 않는다.** git 이 없거나 저장소가 아니면 F1 은 `unknown` 이고 F2·F7 은 파일 시각만 쓴다. 「외부 패키지 0」은 그대로다 — `git` 은 읽기 명령만, 설치·로그인·네트워크 없이 쓴다.

### 상태 폴더 해석 (원장이 갈라지지 않게)

`AUTO_BATCH_STATE_DIR` → `tools/auto/auto.config.json` 의 `stateDir` → `~/.claude-auto/<project>` → `~/.baroos-auto`(jng-os 호환 폴백 · 실존할 때만). **러너·편성기와 같은 순서**다(`run-night.mjs` · `plan-queue.mjs`). 화면 footer 에 실제로 고른 폴더와 그 사유를 적는다.

### 판정 규칙 — 확인 못 한 것을 통과로 적지 않는다

`verdict.mjs` 하나가 판정하고, 규칙은 셋뿐이다.

- **RED**: 통합 게이트 `fail`·`rollback` / 배치 `worst ≥ 7` / 진단 우선순위 ①②③ 잔여 > 0 / readiness `not-ready`.
- **AMBER**: 계측 품질 게이트 미통과 / 큐 자기 검증 실패 / 검증 매니페스트 `checks` 에 fail·required-missing / 결정 대기·사람 게이트 > 0 / 미머지 `auto/*` 체인 ≥ 1일 / 진단 ④⑤ 잔여 > 0 / readiness `not-verified`.
- **GREEN — 전부 「적극 조건」이다**(2026-09-02 교차리뷰 H2). 막는 것이 없다는 것만으로는 GREEN 이 못 된다. 다음이 **실제로 있어야** 한다: 지난밤 배치 ≥ 1 이고 전부 통합 `pass` · 계측 ≥ 1건이고 전부 `qualityGate.passed === true` · 검증 기록이 존재하고(지난밤 배치가 돌린 스토리는 전부) 검사 실패 0 · `diagnosis` 존재 · `readiness.verdict === 'ready'`. 하나라도 없으면 GREEN 이 아니다.
- **판정 불가(회색)**: 재료가 하나도 없을 때, 그리고 위 적극 조건 중 무엇이 빠졌을 때. **GREEN 이 아니다.**
- **상한 AMBER**: 막는 것이 없어도 **`diagnosis` 가 없으면 GREEN 으로 올리지 않는다.** `backlog`·`readiness` 유무와 **무관한 단독 조건**이다 — 예전에는 셋 다 없을 때만 상한이 걸려서 backlog 하나만 있어도 상한을 뚫었다. 진단을 안 돌린 것을 「이상 없음」으로 그리면 화면이 사람을 속인다.
- RED 와 GREEN 이 동시에 성립하면 RED 다.
- 이유 문장은 **센 것만** 적는다 — 계측 0건인데 「품질 게이트 통과」라고 쓰지 않는다.

**무엇을 세는가 — 「지금 막는 것」만 센다 (2026-09-21).** 판정이 끝난 과거 기록이 영원히 「현재 불일치」로 남으면 사람이 매번 같은 것을 다시 본다. 그래서 아래 넷은 **건수에서 빼되 감추지 않고** 히어로 아래 참고 줄(`verdict.notes`)·불일치 위 참고 줄(`data.driftNotes`)로 적는다. **넷 다 근거가 있을 때만 접고, 근거를 모르면 접지 않는다.**

| 접는 것 | 근거 | 근거가 없으면 |
|---|---|---|
| 마지막 릴리스 **이전**에 끝난 배치·되돌림 | `RELEASE-LOG.md` 절 머리에서 뽑은 가장 최근 릴리스 시각(`lastRelease`) | 전건을 센다 |
| 개발선(별도 갈래에서만 도는) 배치의 리뷰 대기·STOP | `sources.json` 의 `opsLineEpics` | 전건을 센다 |
| 통합 게이트 **도입 전**에 만들어진 검증 기록의 빈 통합 칸 | `sources.json` 의 `integrationGateSince` | 전건을 센다 |
| 그 검사가 **생기기 전** 기록의 「스크립트 없음」 | `sources.json` 의 `qualityGatesSince` | 전건을 센다 |
| 자율 진단 잔여(`tierRemaining`) 중 **개발선 에픽 몫** | 항목의 `epic`·`story` + `opsLineEpics` | 전건을 운영선으로 센다 |
| 자율 마무리 판정 `not-ready` 가 **전부 개발선 몫**일 때 | 항목 목록이 있고 · 운영선 잔여 0 · 개발선 잔여 > 0 | 그대로 RED |

진단 잔여는 **항목마다** 갈래를 가른다(`lineOfFinding`). 근거는 항목의 `epic` 숫자, 없으면 `story` 슬러그의 에픽이고, **에픽을 모르는 항목은 운영선으로 센다**(프로젝트 전역 항목이 여기 온다). 항목 목록 없이 집계값(`byTier`·`counts.findings`)만 있으면 가릴 근거가 없으므로 **전건을 운영선으로** 센다.

**「확인 못 함(not-verified)」은 절대 접지 않는다.** 그건 「검사를 안 돌렸다」는 뜻이고, 접으면 화면이 안 돌린 검사를 통과로 그린다. 접는 것은 `not-ready`(미달이 실제로 세어진 것) 뿐이고, 그때도 원본 판정·미달 수를 참고 줄에 그대로 남긴다.

미머지 갈래도 같다 — 상태 폴더 `chain-info.json` 의 갈래 이름이 있으면 `auto/YYYY-MM-DD`(개발선 날짜 체인)와 `auto/<날짜>-<주제>`(운영선 수리 갈래)를 갈라 **뒤엣것만** 센다. 다만 주제 갈래는 이름만으로 갈래를 가릴 수 없으므로(수리 규약을 안 지킨 이름이 섞인다) `devLineBranches` 에 **확인된 것만** 적어 접고, 적지 않은 것은 종전대로 센다. 이름을 모르거나 git 이 없으면 **미머지로 본다**(나쁜 쪽이 이긴다).

### 손상 내성

JSON 하나가 깨져도 **그 블록만** 「읽지 못했습니다(파일 · 사유)」가 되고 나머지는 그대로 그려진다. 예상 밖 `schema` 는 「알 수 없는 형식」 + 원문 경로만 적고 **추측해서 그리지 않는다**. `metrics-history.jsonl` 은 깨진 줄만 버리고 몇 줄을 버렸는지 화면에 적는다.

파일 읽기도 같다(2026-09-02 교차리뷰 M4). `scan.mjs` 의 모든 읽기는 `readSafe(path)` → `{value, error}` 다 — 「존재 확인 → 읽기」 사이에 파일이 지워지거나(ENOENT) 잠기거나(EBUSY·EPERM) 같은 이름의 폴더로 바뀌어도(EISDIR) **던지지 않고** 그 블록만 빈 값이 되며 사유가 `READ_ERRORS` 에 쌓인다.

- `scan()` 은 **던지지 않는다.** 원천을 못 찾거나 조립 중 예외가 나면 `{ error: { code, message, checked[], readErrors[] }, epics: [], … }` 를 돌려준다.
- **`process.exit` 는 CLI 진입일 때만**이다(`import.meta.url === pathToFileURL(process.argv[1]).href`). 라이브러리로 import 한 상위 도구(build.mjs·테스트·아침 브리핑)를 죽이지 않는다.
- `build()` 는 `data.error` 를 보면 **예외 없이** 「원천을 읽지 못했습니다(파일 · 사유)」 화면 한 장을 만들고 `{ error: <code> }` 를 돌려준다. CLI 는 그 뒤 exit 2 로 알린다. 그 화면에는 진척·배포 판정을 **그리지 않는다**.

### 모듈 (프로젝트 이식판이 그대로 복사해 쓰는 5개)

| 파일 | export | 성격 |
|---|---|---|
| `batch-sources.mjs` | `collectBatchSources` · `parse*` 9종(`parseReadiness` 는 엔진의 `{project,tasks}` 모양도 읽는다) · `resolveStateDir` · `nightKey`/`lastNightManifests` · `slotHeartbeat` · `assignByStory` · `findAutofinishDir`/`findAutofinishFile` | 파서(읽기 전용) |
| `verdict.mjs` | `deployVerdict` · `batchWarnings` · `tierRemaining` · `lastRelease` · `epicOfStory`/`storySlugs`/`releaseLineOf`/`lineOfFinding`/`splitBatchMaterial` · `splitCheckFails` · `splitChain` | 순수 함수 |
| `freshness.mjs` | `freshnessChecks`(7항목) · `freshnessVerdict` · `ms`/`ago`/`stamp` | 순수 함수(fs 접근 0) |
| `daily-metrics.mjs` | `dailyMetrics` · `nightKeys` · `trendOf` · `formatValue`/`formatDuration` | 순수 함수 |
| `render-batch.mjs` | `renderHero`/`renderInbox`/`renderNight`/`renderQueue`/`renderMetrics`/`renderDiagnosis`/`renderVerdictTick`/`renderError` · `storyExtras` · `BATCH_CSS` · `esc` | 순수 문자열 |

CSS 클래스는 전부 `b-` 접두다 — 목업의 `.chip`·`.it`·`.row`·`.sec` 는 기존 화면의 필터 칩·항목 카드와 이름이 겹쳐서 그대로 쓰면 기존 UI 가 깨진다. 색 토큰(`--orange`·`--green`·`--lblue`)은 목업 그대로이며 **빨강을 새로 만들지 않는다**(RED = 주황 채움).

### 플러그인 계약 (프로젝트 고유 블록)

`build({ plugins })` 의 계약은 하나뿐이다.

```js
{ name: '이름', sections(data) { return ['<section>…</section>'] } }
```

반환한 HTML 을 **스토리 표 아래·footer 위**에 순서대로 끼운다. 플러그인이 던지면 그 플러그인 자리만 경고 박스가 되고 나머지 화면은 그대로다. jng-os 의 목업 갤러리·앱 미리보기·파일럿 게이트·deferred RC1 이 이 자리에 온다.

## 리뷰 반복 게이트 (review-gated)

**이 게이트는 `auto-story-finish` 로그가 있는 프로젝트에서만 동작한다.** 엔진을 쓰지 않는 BMad 프로젝트에서는 `review` 상태에 늘 자동 리뷰가 추천되므로(종전 동작), 몇 라운드를 돌았는지는 사람이 판단해야 한다. BMad 자체 산출물인 `state.json` 으로 범위를 넓히는 길은 막혀 있다 — `slug::review` 가 `slug::dev` 보다 새롭다는 조합은 실측(내부 프로젝트)에서 dev·review 기록이 둘 다 있는 슬러그 30건 **전부**(그중 19건이 `done`)에 성립했다. 정상 라운드의 지문이지 비수렴 신호가 아니다.

상태가 `review` 인데 엔진이 그 스토리에 **리뷰를 6회 이상 완료**했으면 자동 리뷰 추천을 끊는다.

- 근거: BMad v6 정본 `bmad-code-review` 는 라운드가 끝나면 상태를 `done` 또는 `in-progress` 로 옮긴다. "리뷰를 여러 번 끝냈는데 상태가 아직 `review`" 는 자동 루프가 수렴하지 않는다는 신호이고, 여기서 또 자동 리뷰를 추천하면 무한 반복이 된다.
- 동작: 카드의 `[지시문 복사]` **버튼 자체를 그리지 않고**(비활성이 아니라 미렌더), 묶음 실행(`--stages review --force`) 후보에서도 뺀다. 배지는 `리뷰 반복 · 사람 판단`, 판정 근거(누적 몇 회인지)를 카드에 상시 표시하고, 섹션 머리에 `리뷰 반복 N건은 버튼 없이 표시됩니다` 를 덧붙인다.
- 남는 것: 카드·스토리 문서 링크·단계 배지는 그대로다. 사람이 직접 `bmad-code-review` 를 부르는 길은 막지 않는다.
- 상태 SoT 는 건드리지 않는다 — `status` 는 `review` 그대로 두고 화면 분류 키(`key`)만 가른다.
- 정렬은 `실행 가능한 진행 중` 뒤다(rank 1.5) — 누를 수 없는 카드가 목록 머리를 덮지 않게 한다.
- 임계값 6은 `scan.mjs` 의 코드 상수(`REVIEW_GATE_RUNS`)다. 설정 파일·환경변수로 빼지 않는다. **3이 아닌 이유**: 실측(2026-08-21 · 내부 프로젝트 슬러그 38종)에서 정상 완료(`done`)한 스토리 27건의 완료 리뷰 횟수 분포가 `6,5,5,4,4,4,4,3×15,2×4,1` 로 **최빈값·중앙값이 정확히 3**이었다. 3으로 두면 그 22건이 correct-course 등으로 `review` 로 되돌아오는 순간 첫 라운드부터 잠긴다. 6이면 같은 표본에서 오탐이 1건으로 줄고 실제 비수렴 전례(2-10 8회·2-16 6회·3-5 6회)는 그대로 잡힌다.
- 슬러그 조회는 **엔진과 같은 prefix 규칙**이다 — 로그의 식별자가 상태 파일 키와 같거나 그 앞부분(`<식별자>-…`)이면 합산한다. 엔진이 `--stories "1-1"` 같은 짧은 식별자를 받아 그대로 로그에 찍기 때문이다.
- **게이팅하지 않는 경우 3가지**(전부 종전 동작으로 폴백): `run-summary.log` 가 없거나 매치 0건 / 산출물 경로가 엔진 리터럴 경로와 어긋나 로그를 리터럴 쪽에서 읽은 경우(남의 로그로 버튼을 지우지 않는다) / 상태가 `review` 가 아닌 경우.
- 로그에 리뷰 실행 줄은 있는데 **어떤 식별자도 상태 파일 키와 맞지 않으면** stderr 경고 + 화면 상단 배너로 알린다 — "리뷰 이력 없음"과 "식별자가 안 맞음"이 구분되지 않는 조용한 무동작을 막는다.

## 이 스킬에 없는 기능과 이유

파일럿 게이트 카드·보류(사람 대기) 항목·목업 갤러리 탭·앱 실행기는 특정 프로젝트 전용 원천(게이트 원장 문서, 판정 JSON, 고정 포트 dev 서버 설정)에 붙어 있는 기능이라 이 전역 스킬에는 없다 — **대신 위 플러그인 계약이 그 자리를 연다.**

마이그레이션 실프로브(외부 DB CLI 를 실제로 호출해 적용 상태를 실측하는 기능)도 없다 — 외부 CLI 설치·로그인·네트워크를 전제하므로 "외부 의존성 0(node 빌트인만)"과 충돌하고, 마이그레이션·DB 는 BMad v6 산출물 계약에 없는 개념이라 중립 코어가 아니다. 원본 프로젝트에는 있다. **신선도 F6 이 비어 있는 이유가 이것이다.**

**러너 클론 대조**(무인 러너가 도는 **다른 폴더**의 배치 산출물을 읽어 이 폴더 것과 합치는 기능)도 없다 — 러너를 어디서 어떻게 돌리는지는 프로젝트 배치 방식이고, 남의 폴더 경로를 추측해 뒤지지 않는다는 원칙과도 맞물린다. 그래서 신선도 F5 는 **이 폴더의 기록만** 보고, 대조하지 않았다는 사실을 화면에 적는다. 필요하면 플러그인이 그 자리를 연다(`verdict.releaseLineOf` 는 `fromRunnerClone: true` 표식을 읽을 준비가 돼 있다).

## 계층화 정책

이 스킬은 BMad 프로젝트 중립 코어만 담는다. 게이트 원장·보류 항목·앱 실행기·커밋 정책 같은 프로젝트 특화 제약은 각 프로젝트에 둔다. **전역 스킬에 특정 프로젝트 규칙을 역주입하지 말 것.**

## 경고 3종 (켜기 전에 읽을 것)

1. **정적 서버가 프로젝트 루트 전체를 서빙한다.** 127.0.0.1 바인딩과 경로 탈출 방지는 있지만, 루트 안에 비공개 파일이 있는 프로젝트라면 켜기 전에 사람이 판단할 것.
2. **`_bmad-output/dev-status/` 를 `.gitignore` 에 넣을 것.** 무인 배치의 커밋 화이트리스트가 `_bmad-output` 통째라서, 안 넣으면 현황판 생성물이 스토리 커밋에 딸려 들어간다.
3. **auto-story-finish 와 같이 쓰려면 산출물 기본 경로(`_bmad-output/implementation-artifacts`)를 유지할 것.** 엔진이 이 경로를 하드코딩하므로, 경로를 바꾸면 단계 배지와 배치 중 쓰기 차단이 동작하지 않는다(화면 배너로도 경고된다).

## 알려진 한계

- **신선도 F1 은 `origin/main` 을 정본 갈래로 가정한다.** 다른 이름(`master`·`trunk`)을 쓰는 저장소에서는 `behind` 가 `null` 이 되어 `unknown` 으로 뜬다 — 틀린 초록을 그리지는 않지만 맞는 초록도 못 그린다. 미머지 갈래 판정(`splitChain` 배선)의 `merge-base … main` 도 같다.
- **신선도는 `git fetch` 를 하지 않는다.** 이미 받아 둔 원격 기록과만 견주므로, 오래 fetch 하지 않은 폴더에서는 「최신입니다」가 **그 시점 기준**이다. 새로고침 경로에 네트워크·인증을 넣지 않기 위한 의도적 선택이고, 견줄 기록이 아예 없으면 `unknown` + 「한 번 `git fetch origin` 을 돌리세요」로 적는다.
- **`scan.mjs` 의 JSON 출력은 1 MB 를 넘을 수 있다**(산출물이 쌓인 저장소에서 실측 1.11 MB). 다른 도구가 `child_process.spawnSync`/`execSync` 로 이 출력을 받아 쓴다면 **`maxBuffer` 를 반드시 올려야 한다** — 기본값 1 MB 를 넘으면 자식이 SIGTERM 으로 죽고 `status` 가 `null` 이 되는데, 그 모습이 「원천을 못 읽어 실패」와 구분되지 않아 원인을 엉뚱한 데서 찾게 된다(이 스킬의 `scan.test.mjs` 가 실제로 그렇게 한 번 걸렸다). 파이프·리다이렉트로 받으면 해당 없다.
- **접는 규칙 넷은 설정이 있어야 켜진다.** `sources.json` 이 없는 프로젝트에서는 개발선 가르기·게이트 도입 전 접기가 **전부 꺼진 채 종전대로 전건을 센다**. 안전한 쪽(과하게 세는 쪽)으로 기운 것이지 버그가 아니다.
- 제목 어긋남 경고의 임계값이 한글 4음절(정규화 후 공통 접두 4자) 기준이라, 스토리 슬러그가 영문인 프로젝트에서는 경고가 뜨지 않는다.
- **리뷰 반복 게이트에는 해제 조건이 없다.** `run-summary.log` 는 누적 로그라 카운터가 줄지 않는다. `in-progress` 인 동안 **적용되지 않을 뿐**이고(게이트는 `status === 'review'` 일 때만 본다), 그 스토리가 `review` 로 돌아오면 다시 게이팅된다 — 풀리는 것이 아니다. 원본에는 자동 해제 조건이 있지만(원장 문서의 종결 선언을 읽는다) 이 스킬에는 그와 동등한 근거가 되는 원천이 없다. 사라지는 것은 버튼뿐이고 사람이 직접 리뷰를 부르는 길은 막지 않는다.
- **원본과 판정이 다르다(같은 저장소에서 4건 어긋남).** 원본은 프로젝트 원장 문서의 종결 선언 유무로 가르고, 이 스킬은 완료된 리뷰 실행 횟수로 가른다 — 묻는 질문 자체가 다르니 결과도 다르다. 실측(2026-08-21 · 같은 내부 프로젝트, `review` 4건): 원본은 3.1·3.2·3.4 를 게이팅하고 3.5 는 게이팅하지 않으며, 이 스킬은 3.5 만 게이팅한다(3.5=완료 리뷰 6회, 나머지 3건=5회. 그 3건의 리뷰 시작 줄은 6회지만 1회가 `--dry-run` 예행연습이라 세지 않는다).
- **자기 자신이 게이트를 밀어올린다.** 묶음 버튼의 지시문이 `--stages review --force` 라서 클릭 1회 = 묶음 전원 카운터 +1 이다. 임계값까지 남은 클릭 수는 화면에 표시되지 않고, 임계값에 닿는 순간 그 묶음의 버튼이 한꺼번에 사라진다(섹션 머리의 `리뷰 반복 N건` 요약이 그 자리를 설명한다).

## 재생성 절차 (사본 갱신)

이 폴더는 원 개발 프로젝트 저장소의 `tools/dev-status/` 원본에서 파생된 **읽기 전용 스냅샷**이다. 개발은 원본에서만 하고, 동기화 스크립트·심링크·subtree 는 만들지 않는다(읽기 전용 도구라 갈라져도 실해가 작다).

**파일마다 정본이 다르다.** 원본 파일 머리에 `// SOURCE: claude-skills/dev-status/<파일> — 이식판이 정본` 주석이 있으면 **이 스킬 쪽이 정본**이고(현재 `batch-sources.mjs`·`daily-metrics.mjs`·`render-batch.mjs`·`verdict.mjs` + 각 테스트), 그 파일은 원본에서 **거의 그대로 복사**하면 된다. 그 주석이 없는 파일(`scan.mjs`·`build.mjs`·`serve.mjs`)만 아래 2·3단계의 삭제·전역화가 필요하다. 갱신하려면:

0. **원본이 지금도 움직이는지 먼저 본다.** `git -C <원본저장소> log --oneline -3` 으로 기준 커밋을 적어 두고, 작업이 끝나면 한 번 더 봐서 그사이 바뀐 것이 있으면 보고에 적는다(2026-09-21 재생성 중 원본에 새 커밋이 두 번 들어왔다).
1. 원본 파일을 이 폴더로 다시 복사한다. (같은 폴더의 PLAN.md·README.md·mockups/·JSON 산출물은 그 프로젝트 기록물이므로 가져오지 않는다. `sources.json` 도 **가져오지 않는다** — 그 파일은 프로젝트가 소유하고, 이 스킬은 프로젝트 루트의 `tools/dev-status/sources.json` 을 있으면 읽을 뿐이다.)
2. **프로젝트 전용 기능을 통째로 삭제한다**: 파일럿 게이트(parsePilotGate)·보류 항목(parseDeferred)·목업(parseMockups)과 그 UI(게이트 카드·보류 섹션·목업 탭), 앱 실행기(serve 의 앱 포트·spawn 계열 전부), 프로젝트 브랜드 문자열(예: 예약작업 이름), 지시문 속 커밋·푸시 정책 플래그, **마이그레이션 실프로브(probe-migrations.mjs·parseMigrationProbe·migration-probe.json·신선도 F6)**, **러너 클론 읽기**(resolveRunnerClone·readCloneLogs·mergeByKey·`sources.json` 러너 경로·신선도 F5 의 러너 대조 절반), 프로젝트 원장을 직접 파싱하는 함수(`parseOpsEpics` 가 `RELEASE-LINES.md` 의 한국어 문장을 읽는 것 — **설정 키로 갈아끼운다**).
3. **전역화 수정을 다시 적용한다**: 경로 탐지(--root → 상위 6단 → BMad config, 실패 시 exit 2 진단), 엔진 리터럴 1순위 + 경로 불일치 배너, 매치 0건 경고, 배치 가동 판정(종료 태그 확장 + state.json mtime 30분 무변화 = 중단), 전용 포트 변수(DEV_STATUS_PORT, 5180→5189 자동 증가, 주소 stdout 첫 줄), 헤더에 루트 절대경로 표시, MIME 표 확장(미등록 확장자는 404), 브라우저 열기 3분기(win32/darwin/그 외), 출력 경로 상수(OUT_DIR) 한 곳 공유, **리뷰 반복 게이트의 근거 교체**.
   - **리뷰 반복 게이트 변형본**(원본 RC5 의 전역판): 원본은 `review-gated` 판정을 `deferred-work.md` 원장(종결 선언 문구·미해소 심각도 집계)에서 얻는다. 이 스킬에는 그 파서가 없으므로 **판정 근거만 `run-summary.log` 의 완료된 리뷰 실행 횟수(`REVIEW_GATE_RUNS = 6`)로 갈아끼우고, 원본의 `review-gated` 관련 코드는 전부 남긴다** — ① `scan.mjs` `SKILL` 맵의 `'review-gated'` 항목, ② `scan.mjs` `rank` 의 `'review-gated'`(단, 이 스킬은 게이팅 대상이 다수가 될 수 있어 0 대신 1.5 로 내렸다), ③ `scan.mjs` BULK 필터의 `n.key !== 'review-gated'`, ④ `build.mjs` `actHTML` 의 조기 반환(스킬 문자열이 비면 버튼 미렌더 — RC5 의 실제 안전장치는 배지가 아니라 이것이다), ⑤ `build.mjs` 배지 조회를 `STLABEL[n.key] || STLABEL[n.status]` 로, ⑥ `build.mjs` 의 `gatedN` 섹션 머리 요약, ⑦ `build.mjs` CSS 2줄(`.it .gatewhy`·`.noact`). 원본의 `n.sev`(원장 심각도 N건 경고)와 `gate-notes.json` 접기만 원천이 없어 가져오지 않고, 배지 문구·`gateWhy` 꼬리말은 새 근거에 맞게 바꾼다.
   - 새 근거를 쓸 때 함께 지킬 것: 리뷰 **시작** 줄이 아니라 `exit=0` 으로 완료가 확인된 줄만 셀 것(`--dry-run`·인증 만료 실행이 리뷰 1회가 되지 않게), 슬러그 조회는 엔진과 같은 prefix 규칙일 것, 산출물 경로가 엔진 리터럴 경로와 어긋날 때는 게이팅하지 않을 것.
   - 원본의 한국어 관례 문구(`### 사람 대기` 절, `검증 전용`·`마지막 라운드` 같은 문장)를 탐지 패턴으로 옮기지 말 것 — 특정 프로젝트 규칙의 역주입이다. UI 표시 문구가 한국어인 것은 무관하다(스킬 전체가 한국어다).
   - **프로젝트 원장 → 설정 키 갈아끼우기**(2026-09-21 추가): 원본이 프로젝트 문서에서 읽어 내는 기준선은 스냅샷에서 **`tools/dev-status/sources.json` 의 키**로 바꾸고, 키가 없으면 **종전 동작(전건을 센다)** 으로 떨어뜨린다. 현재 셋 — `opsLineEpics`(원본은 `RELEASE-LINES.md` §0 을 정규식으로 읽는다 · 스냅샷은 설정만) · `integrationGateSince` · `qualityGatesSince`. `RELEASE-LOG.md`(마지막 릴리스 시각)는 **문서 이름·절 서식이 중립적이라 그대로 가져온다** — 없으면 아무것도 접지 않는다.
   - **신선도 블록**(2026-09-21 추가): `freshness.mjs`·`freshness.test.mjs` 를 복사하되 **F6(마이그레이션 실측)은 통째로 빼고**, **F5 는 러너 클론 대조 절반을 빼고** 이 폴더 기록만 보게 고친다(번호는 당기지 않는다 — 위 「현황판 신선도 검토」 참조). 재료는 `scan.mjs` 의 `gitInfo`·`fileAge`·`unmergedChainBranches` 가 모으고, 화면은 `build.mjs` 의 `renderFreshness` + CSS `b-fr*`·`.rulenote` 가 그린다. 히어로 아래 참고 줄은 `render-batch.mjs` 의 `verdict.notes` + `.b-hnote` 다.
   - **자율 진단 산출물 읽기 규격**(2026-09-21 추가): 파일 이름(`final-*`/`round-N-*`)·`readiness` 의 `{project,tasks}` 모양·이중 폴더 내성은 **엔진이 쓰는 모양**이라 중립 코어다 — `batch-sources.mjs` 를 그대로 복사하면 된다(이 파일은 이식판이 정본이다).
   - **진단 잔여의 갈래 가르기**(2026-09-21 추가): `lineOfFinding`·`tierRemaining(…, opsEpics)`·`readyFolded` 도 `opsEpics` 가 비면 전건을 운영선으로 세므로 그대로 가져온다. 다만 사람에게 보이는 문구에서 **프로젝트 고유 에픽 번호**(「Epic 5~9·13 몫」 같은 것)는 중립 표현으로 바꾼다.
   - **제목 단계 인식**(2026-09-21 추가): `PATTERNS.epic` 은 `#{2,3}`, `PATTERNS.story` 는 `#{3,4}` 이고, 같은 에픽 번호의 절은 스토리를 합집합으로 합친다. 이건 특정 프로젝트 문서의 사고가 아니라 **문서가 손으로 커지면 어디서나 생기는 모양**이라 중립 코어로 가져온다.
4. **검증**(전부 통과해야 한다):
   - `node dev-status/build.mjs --root <원본저장소> --out <임시폴더>` 가 화면을 만들고, 「에픽 문서에 없습니다」 오탐 0 · 신선도 블록(`class="b-fresh"`) 존재 · 신선도 줄 수가 항목 수와 같을 것.
   - `node dev-status/scan.mjs --root <원본저장소>` 가 exit 0 · JSON 정상.
   - `node --test dev-status/*.test.mjs` 전건 GREEN.
   - `grep -h "^import .* from '" dev-status/*.mjs | grep -v "'\./"` 가 `node:` 뿐일 것(외부 패키지 0).
5. 설치본(`~/.claude/skills/dev-status/`)에 같은 파일을 복사한다. 설치본에만 있는 파일은 지우지 않는다.
