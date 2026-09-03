# night-batch-ops — 24시간 무인 배치 러너

> **무정지(non-stop) 단일판이다.** 시계가 **30분마다 한 번씩 두드리기만** 하고, 겹침·미머지·
> 충돌·중단 판정은 전부 러너가 스스로 한다. 목표는 하나다 — **아침 브리핑부터 다음 아침까지
> 러너가 서 있는 시간을 없애되, 완성도 게이트는 한 칸도 낮추지 않는다.**
>
> **2026-09-02 통합**: 종전의 「4시간 슬롯판 + 30분 무정지판」 두 갈래를 **이 하나로 합쳤다.**
> 4시간 슬롯판은 시계가 밤에만 열려 있어 낮 산출물을 이어받지 못했고, 무정지판이 그 문제를
> 러너 쪽(lock·연속 루프·승계·하향 동기)에서 풀었기 때문에 남겨 둘 이유가 없어졌다.
> 예약 작업도 **1개뿐**이다 — 두 개로 나눠 두면 겹침·휴면 판정이 두 곳으로 갈린다.

BMad 프로젝트에 무인 배치 체계를 설치·운영한다. `auto-story-finish` 전역 스킬(엔진)을 전제로,
그 위에 ① 예약 실행(30분 간격 1개 작업) ② 큐 자동 편성(규칙 10종, LLM 호출 0) ③ 연속 실행 루프
(작업 종료가 다음 배치를 연다) ④ 무정지 판정부(승계·동기·lock·차단기) ⑤ 텔레그램/ntfy 알림·원격
명령을 얹는다.

**계층 원칙**: 이 폴더의 엔진 6파일은 프로젝트 중립이다. 프로젝트 고유값(에픽 순서·하루 상한·
모델·상태 폴더)은 전부 대상 프로젝트의 `tools/auto/auto.config.json` 이 소유한다 — 같은 엔진을
여러 프로젝트가 받아 쓰고, 설정만 다르게 갖는다.

## 구성

| 파일 | 역할 |
|---|---|
| `engine/run-night.mjs` | 러너 — 큐 실행·워크트리 새로고침·stash 보존·**lock v2**·**선형 승계**·**하향 동기**·연속 루프·병렬 실행(워크트리 분리 + cherry-pick landing)·알림 |
| `engine/plan-queue.mjs` | 편성기 — sprint-status·스토리 파일을 규칙만으로 판정해 큐 생성(**규칙 9 v2**·**체인 게이트**·**/extend 가산**) |
| `engine/runner-rules.mjs` | 순수 판정 규칙(테스트 가능 분리) — 차단기·병렬 조건·File List 겹침·무정지 판정부·**지출 한도 알림** |
| `engine/story-ledger.mjs` | **원장(Markdown) 해석 단일 소스** — 열린 findings·미완 Task·사람 게이트·목업 게이트. 표기 흔들림(굵게·👤 인용·부정문) 흡수는 여기 한 곳만 고친다 |
| `engine/telegram-rules.mjs` | 원격 명령 판정부(순수) — 파서·발신자 검증·확인 코드·ff 판정·`/extend` 인자 파서 |
| `engine/telegram-commands.mjs` | 원격 명령 폴러 — `/status` `/merge` `/resume` `/extend N` (10분 예약 · 코드 되묻기) |
| `engine/plan-dag.mjs` | 계획 DAG + **계획 검증기** — 선행·사이클·중복·배치 상한·모델 스펙 형식. 규칙 계획과 LLM 계획을 **같은 잣대**로 문다 |
| `engine/conflicts.mjs` | 확장 충돌 판정 — File List 가 겹치지 않아도 병렬이 깨지는 5범주(마이그레이션 번호 경합·생성물 스키마·API 계약·공유 설정·테스트 환경) |
| `engine/assign.mjs` | 워커 배정 — 난이도·위험도·역할·슬롯 상한·과거 성적(`assign-history.json`). 고위험 dev 는 Codex 배제 · review 는 dev 와 다른 눈 · 연속 2회 실패 회피 |
| `engine/orchestrate.mjs` | Fable 오케스트레이터(**선택 · 기본 꺼짐**) — 프롬프트·응답 파싱·검증·결정적 폴백. 실제 호출은 주입된 실행기가 한다 |
| `engine/metrics.mjs` | 계측 — 엔진 로그·Codex 토큰 → 전체 시간·p50/p95·유휴·병렬 효율·재시도·모델 호출량 + **품질 게이트 판정** |
| `engine/bench.mjs` | 하네스 벤치(스텁 실측) — 같은 스토리 세트를 기준선/새 하네스로 각각 돌려 비교표 생성 |
| `install.mjs` | 설치기 — 파일 복사·설정 템플릿·예약(작업 XML)·클론(옵트인) · Codex CLI 유무·인증 상태 기록 |
| `engine/*.test.mjs` | `node --test` 테스트 — 종전 vitest 79종 이식(기준선) + 워커 풀·프로바이더·통합 게이트 + **종단(e2e) 6 시나리오**(스텁 claude/codex · 실제 git) |

## 다중 프로바이더 하네스 (2026-09-02 · Claude + Codex 병렬 개발 + 자율 품질 검증)

> 목표: 「Claude Code 중심 무인 배치」를 **Claude·Codex 를 독립 워커로 쓰는 병렬 개발 + 자체 검증 하네스**로 확장하되,
> 설정 키가 없으면 **종전과 바이트 단위로 같은 동작**(Claude 전용 · 2폭 · 하드캡 3 · qa RED 즉시 STOP)을 유지한다.
> 설계·적대 검토 40건·실측은 `references/multi-provider-design.md`.

```
Orchestrator(run-night)
  ├ plan-queue: 스토리 판정 + 모델·프로바이더 배정(providers.codex.enabled 면 review="codex")
  ├ 병렬 가능성: File List 서로소 + parallelHazards(package.json/lock 은 한쪽만 만져도 순차)
  ├ 워커 풀: 프로바이더별 상한(codex 기본 1 · claude 3) · 총 상한(workers.max · 절대 6) · 순서 보존
  │    └ 스토리별 워크트리(<clone>-wtN) → 엔진 1개씩 (dev → 무결성 검사 → qa → [자동 수리] → review)
  │         └ 엔진이 프로바이더를 고른다: 모델 스펙 "opus"=claude · "codex" · "codex:<model>"
  ├ landing: cherry-pick 직렬(종전) → **통합 게이트**(합쳐진 트리에서 qa 1회 · RED 면 landing 되돌림 + STOP)
  │    └ **순차 경로도 같은 규칙**(2026-09-02 N1): 통합 게이트가 켜져 있으면 엔진에 `--push --defer-push`
  │       를 넘겨 스토리별 push 를 보류시키고, 게이트 GREEN 을 본 뒤 **러너가 1회** push 한다(RED = push 0 · 되돌림)
  └ 사람 호출: 예산 소진·5범주·결정 필요만 — 6절 에스컬레이션(상황·원인·시도·선택지·추천·위험)
```

**프로바이더 계약**(엔진 `providers/{claude,codex}.mjs`): 프롬프트 stdin · 작업 루트 지정 · 모델 지정 · exit/stdout/stderr 수집 ·
타임아웃 · 인증/한도/지출 분류(auth > spend > limit > other — 종전 규율) · 폴백. Codex 는 `codex exec`(비대화형)만 쓴다 —
`codex review` 는 커스텀 프롬프트를 못 받는다(실측).

**Codex 가 없을 때**: 엔진이 codex 스펙을 만나면 `codex --version` + `codex login status` 로 감지하고, 미설치·미인증·
cwd 불허(본 트리)면 **claude 대체 모델(dev 와 다른 것)로 폴백 + 경고**한다. 러너는 `[PROVIDERS] claude=YES(…) codex=NO(사유)`
한 줄을 남기고 계속 돈다. Codex 때문에 배치가 서는 경로는 없다.

**Codex 역할**: 기본 `roles: ["review"]` — 구현(Claude) ↔ 리뷰(Codex) 교차검증. review 는 **read-only 샌드박스 + 구조화 JSON**
(`--output-schema`)으로 받고 **엔진(node)이** 스토리 파일 `### Review Findings`(Tasks 절 안)에 원장 형식으로 기재 · 상태 전이
(findings → in-progress · 0건 → done, 단 이전 라운드 열린 findings 잔존 시 done 금지) · sprint-status · deferred-work ·
DECISIONS-INBOX 까지 bmad-code-review 와 같은 자리에 쓴다. `roles` 에 `dev` 를 넣고 `split: true` 면 병렬 짝의 홀수 번째를
Codex dev(workspace-write · 네트워크 기본 닫힘)로 나눈다 — 이때 리뷰는 Claude(교차).

**안전선(전부 코드가 집행)**: ① Codex 는 배치 워크트리(marker 또는 linked worktree)에서만 — 본 트리의 gitignore 실데이터 반출 금지
② 실행 동안 `.env*` 를 작업 루트 밖으로 격리 후 복원 · 리뷰 diff 에서 env/키/시크릿 파일 제외 + 시크릿 마스킹 · 로그 마스킹
③ dev/repair 워커가 HEAD·브랜치·stash 를 움직이면 COMMIT GUARD STOP(exit 6) — 커밋은 엔진만 한다 ④ 머신 전역 codex 슬롯 잠금
(같은 auth.json 동시 사용 금지) ⑤ 한도 = 대기가 아니라 레인 전환(스토리당 1회 · 부분 산출물 폐기) · Codex 실패를 Claude 프로브로
「복구됨」이라 오판하지 않는다 ⑥ 이월 금지 5범주는 리뷰어가 defer/optional 로 내도 patch 로 승격.

**품질 루프**(`quality.autoRepair`): dev 뒤 **테스트 무결성 검사**(`.only`·사유 없는 테스트 삭제 = 차단 / skip·ts-ignore·eslint-disable·
게이트 설정 변조·항상-참 단언·단언 약화 = 경고, **수리 라운드가 새로 만든 것은 차단**) → `npm run qa` → RED 면 원인 분류
(typecheck/lint/test/build + 안정 서명) → 같은 원인 3회 · 총 5회 안에서 수리 프롬프트로 재시도 → 소진 시 종전 STOP + 6절 에스컬레이션.
실제로 있는 스크립트만 쓴다 — coverage/e2e/보안/성능 스크립트가 없으면 매니페스트에 `n/a(사유)`·`required-missing` 으로 정직 기록.

**검증 매니페스트** `auto-pipeline-logs/<story>-verification.json`: provider/model/role · commit · checks(qa·typecheck·lint·build·unit·
integration·coverage·security·performance·e2e) · 트리거 · 무결성 · 수리 이력 · 리뷰 결과 · 에스컬레이션.
배치(병렬·순차 모두)는 여기에 `integration: { result: pass|fail|rollback, qaExit, landingBase, at, batchId? }` 를 **병합**하고
(매니페스트가 없으면 만들지 않고 경고), 배치 한 건을 `auto-pipeline-logs/batch-<id>-manifest.json`(`mode`=parallel|sequential ·
스토리 목록·landing 순서·통합 결과·push 여부·실패 증거 경로)으로 남긴다.
**RED/rollback 은 추적 매니페스트를 고치지 않는다**(되돌림이 그 파일도 되돌렸고, 손대면 다음 라운드 cherry-pick 이 거부된다) —
대신 되돌리기 **전에** 읽어 둔 사본에 `rollback` 을 새겨 ⓐ `<상태폴더>/archive/<시각>-evidence/<story>/verification.json`
ⓑ 미추적 sidecar `auto-pipeline-logs/<story>-verification.rollback-<batchId>.json` 두 곳에 남긴다(batchId 가 이전 라운드 파일을 덮지 않게 한다).

**실패 증거** `<상태폴더>/archive/<시각>-evidence/<story>/`: 엔진 로그(**복사할 때 다시 마스킹**) + `code.diff`(추적 파일 미커밋 변경 ·
민감 pathspec 제외 · 저장 직전 시크릿 재마스킹) + `untracked/`(미추적 산출물 · 민감 경로 제외 · 개별 5MB 상한) + `summary.json` +
`RESTORE.md`(복구 절차). 워크트리를 지우기 **전에** 남긴다 — 실패한 dev/repair 의 「절반쯤 한 일」이 `worktree remove --force` 와 함께 사라지지 않게.

**마스킹 경계**(정책 2 · 2026-09-02 N3): 러너가 **파일에 쓰거나 밖으로 내보내는 모든 텍스트** — 통합 게이트 로그 · 증거 폴더로
복사되는 엔진 로그 · 텔레그램/ntfy 알림 본문 · `night-last-run.md` 요약 — 은 엔진 `providers/codex.mjs` 의 `redactSecrets` 하나를
거친다(판정기 중복 금지 · 구판 엔진이면 최소 폴백).

**설정 예**(`tools/auto/auto.config.json` · 전부 선택):
```jsonc
"workers":  { "max": 3, "batchSize": 2 },
"providers": {
  "claude": { "enabled": true,  "max": 3 },
  "codex":  { "enabled": true,  "max": 1, "roles": ["review"], "reviewKinds": ["new", "closeout"],
              "split": false, "network": false, "fallback": true }
},
"quality": { "autoRepair": true, "sameRootCauseMaxRetries": 3, "totalRepairAttempts": 5, "integrity": "auto" },
"integrationGate": { "enabled": true },   // RED = 무조건 landing 되돌림·STOP·push 금지(설정 우회 없음 — pushOnFail 은 폐지)
"exhaustedModels": ["codex"]   // 이번 주 Codex 한도가 다 찼을 때 — 편성기가 짝 단위로 claude 로 돌린다
```

**운영자가 보는 로그**(현황판이 읽는 종전 줄 `→ [story] stage (model=…)` · `exit=` 는 그대로):
```
[PROVIDERS] claude=YES(2.1.250) codex=YES(codex-cli 0.152.1)
· 워커 풀 — 총 2 · claude 3 · codex 1 · 배정: 2-1=claude 2-2=claude
[2-1-a][CLAUDE][DEV] spawn wt=…\proj-wt0 · 동시 1/2 · review=codex
[2-1-a][CODEX][REVIEW] start model=codex:default cwd=… target=워킹트리 vs HEAD(729fb74)
[2-1-a][CODEX][REVIEW] .env 격리 1건(실행 동안만 · 종료 후 복원)
[2-1-a][CODEX][REVIEW] usage in=126706 out=3154 cmds=12 files=0
[2-1-a][CODEX][REVIEW] 기재 완료 — decision 0 · patch 2(high 1) · defer 0 · optional 0 → status=in-progress · sprint-status …
[2-1-a][QUALITY][FAIL] kind=lint sig=lint:src/x.ts:no-unused-vars   /  [2-1-a][REPAIR] 수리 1/5 · 같은 원인 1/3
[INTEGRATION][RUN] landing 2건 뒤 통합 게이트: npm run qa   →   [INTEGRATION][PASS] | [INTEGRATION][FAIL] … landing 되돌림
- [INTEGRATION] rollback 기재 2건 — 증거 <상태폴더>/archive/…-evidence · sidecar auto-pipeline-logs/<story>-verification.rollback-<batchId>.json
↘ [2-1-a] review: codex:default 한도 — opus 로 자동 전환(프로바이더 전환 · 스토리당 1회 · 대기 없음)
🆘 사람 판단 필요 — [2-1-a] qa  1) 상황 … 6) 위험도
```

**설치 요구**: Node 20+ · git · `auto-story-finish` 최신판(`providers/` 계층 포함) · **`pipeline-settings.json`** — nested 워커의
commit/push deny 설정이 없으면 엔진이 배치를 **시작조차 하지 않는다**(fail-closed · exit 6). 러너는 시작 전에
`PIPELINE_SETTINGS_PATH` → 프로젝트 `.claude/` → 전역 `~/.claude/` 순으로 실측하고, 없으면 exit 3 으로 멈춘다(밤새 exit 6 만 쌓이지
않게). 찾은 경로는 **절대경로로 엔진에 `--pipeline-settings` 로 넘긴다** — 워크트리에 `.claude/` 가 없어도 모든 워커가 같은 설정을
본다(사본을 흩뿌리지 않는다). · (선택) `npm i -g @openai/codex` + `codex login`
(ChatGPT 구독 · API 키 없음). 실측(2026-09-02): 리뷰 1건 ≈ 100k+ 입력 토큰 — Plus 한도에서 하루 몇 건인지는 첫 주 실측 대상.

### 배선 4곳 (2026-09-02 하네스 · 러너가 순수 모듈을 부르는 자리)

| 무엇 | 어디 | 기본값 |
|---|---|---|
| **확장 충돌 판정** | `run-night.parallelHazards(lists, { judges: [conflicts.parallelHazardsCompat] })` | 항상 켬 — 걸리면 **순차 폴백** + 요약에 `[PARALLEL][HAZARD] …` |
| **워커 배정** | `assign.assignWorkers(...)` (종전 홀짝 `assignProviders` 대체 · 하위 호환용으로 함수는 남음) | 설정 없으면 배치 `models` 그대로. 요약에 `[ASSIGN] <story> dev=… review=… — <근거>` |
| **Fable 계획** | `orchestrate.requestPlan(...)` — `--auto-plan` 의 규칙 큐를 감싼다 | `orchestrator.enabled: false` = **종전 동작**. 켜도 검증 실패·거부·타임아웃은 전부 규칙 큐로 폴백 |
| **계측** | `metrics.summarizeTimeline(...)` — 라운드 끝에 1회 | 항상 켬 — `auto-pipeline-logs/metrics-<batchId>.json` + 상태 폴더 `metrics-history.jsonl` + 요약 맨 뒤 `## 계측` 표 1개 |

**배정 기록(`assign-history.json`)**: 상태 폴더에 있고 **러너가 유일한 작성자**다(라운드 끝 1회 · tmp→rename).
같은 스토리·역할에서 한 프로바이더가 **연속 2회 실패**하면 다음 편성에서 그 프로바이더를 피한다(성공 1회면 풀린다).

**⚠️ 종전과 달라지는 한 가지**: `providers.codex.max` 는 이제 **배치당 Codex 몫**으로도 쓰인다(assign 의 슬롯 예산).
`max: 1` + 2폭이면 배치의 **첫 스토리만** Codex 리뷰를 받고 나머지는 Claude 교차로 간다(종전 홀짝 분할은 둘 다 Codex 였다).
스토리마다 Codex 리뷰를 원하면 `max` 를 배치 폭만큼 올린다 — 다만 같은 `auth.json` 동시 사용은 실측 없이 올리지 말 것.

**Fable 계획 켜기**: `auto.config.json` 에 `"orchestrator": { "enabled": true, "model": "fable", "timeoutMin": 5 }`.
후보 집합은 **규칙 편성기가 고른 스토리 그대로**이고(추가 불가), 지휘는 묶고 나누는 순서만 바꾼다.
검증(`plan-dag.validatePlan`)을 통과할 때만 채택하고, 시작 로그에 `[ORCHESTRATOR] source=fable|deterministic-fallback(사유)` 가 남는다.
시험용 주입: `AUTO_PLAN_RUNNER_STUB=<계획을 stdout 으로 내는 .mjs>` (실제 `claude -p` 를 부르지 않는다).

**벤치**: `node night-batch-ops/engine/bench.mjs --stub` → `references/hardening-2026-09-02/bench-stub.md`.
스텁이라 **절대 시간은 의미가 없다** — 뜻이 있는 것은 재시도·모델 호출 수·병렬 효율·유휴 비율·품질 게이트 통과 여부다.
비교는 **양쪽 다 품질 게이트(qa GREEN · 리뷰 high 0 · 통합 pass · 워커 STOP 0)를 통과한 실행끼리만** 한다.

**이번 판에서 하지 않은 것**: 스토리 내부 역할 병렬(구현‖테스트 작성 — 같은 스토리 md·테스트 파일을 두 워커가 만진다) ·
API 키/크레딧 경로 · 벤더 3사 · Codex 세션 타임아웃 시 고아 프로세스 정리(spawnSync 한계 — 스테이지 타임아웃으로만 제동).

## 2026-09-02 통합에 들어간 것 (실사고 회수분)

| 무엇 | 왜 |
|---|---|
| **원장 해석 단일 소스**(`story-ledger.mjs`) | 편성기·가드·현황판·브리핑이 각자 문장을 해석하다 오판이 반복됐다 — 굵게 적힌 열린 findings 16건이 0으로 읽혀 열린 결함 8건인 스토리가 마감 재검수로 편성됐고, 미완 Task 줄의 확정 **근거 인용**이 사람 게이트로 읽혀 하루에 3회 편성 제외됐다. 해석 규칙은 이제 한 파일만 고친다 |
| **규칙 7 단위 = 하루 고유 스토리**(재편성 무과금) | 편성 이벤트를 세니 dev↔review 왕복이 상한을 거듭 먹었다(실측: 편성 50 = 고유 29). 낮에 상한이 차서 밤 슬롯이 빈손으로 돌았다 |
| **규칙 9 v2 스트릭 리셋 순서 수정** | `progressed` 검사가 「그날 편성 0」 조기 반환 **뒤에** 있어, 편성 밖에서 들어온 진전 기재(사람의 재편성 승인 · 다른 세션의 커밋)가 스트릭을 영원히 리셋하지 못했다 — 승인해도 5스토리가 계속 봉쇄됐다. 누적 갈래는 그대로라 폭주 백스톱은 무손실 |
| **하향 동기: 문서 전용 충돌도 자동 해소** | 종전 `defer` + 반복 백스톱이 결합해 **19시간 38분 미동기**를 만들었다 — 문서 2파일 충돌 2회에 하루치 동기가 꺼지고, 새 날 브랜치가 정본이 아니라 전날 tip 을 승계했다. 이제 스토리 md 는 `ours`, 공유 장부는 `union` 으로 풀고 백스톱은 **코드 충돌(halt)만** 센다 |
| **지출 한도 차단 알림** | 계정 지출 한도로 막힌 9시간 동안 30분마다 같은 알림이 20회 나갔고 원인을 「결정 대기」라고 **엉뚱하게** 말했다. 이제 원인을 이름으로 말하고(사람만 풀 수 있다는 사실 포함) 첫 회 + 4라운드마다만 말한다 |
| **소진 모델 회피**(`exhaustedModels`) | 주간 한도가 빈 모델을 배정하면 엔진 프로브가 헛돈다. **짝 단위**로 대체해 교차검증(dev ≠ review)을 지킨다. 프로젝트 사정이라 config 소유이고 기본은 빈 목록 |

## 설치 (Claude 가 "이 프로젝트에 무인 배치 적용해줘" 를 받으면)

1. **대상 프로젝트 루트**에서 `node <이 폴더>/install.mjs` — 파일 설치 + 안내 출력.
2. `auto.config.json` 의 **`epicOrder` 를 사용자와 정한다**(파일럿/목표 경로 순 — 사람 결정).
3. 실행 전용 클론(`--clone <경로>`) + `npm install` — 대화 세션의 발밑을 배치가 절대 바꾸지 않게
   하는 격리다. **하향 동기는 이 클론에서만 돈다**(marker `.auto-batch-worktree` 가 있을 때만).
4. 예약 등록은 **사용자 승인 후** `--register-tasks` (또는 출력된 PowerShell 을 직접).
   **예약 작업은 1개뿐** — `<프로젝트>-nonstop` · **00:05 시작 · 30분 간격 · 무기한 반복**.
   Interactive only — PC 가 로그온 상태로 켜져 있어야 깨어난다.
5. 알림: 상태 폴더 → 공용 `~/.claude-auto/` 순으로 `telegram-token.txt`(BotFather 토큰)와
   `telegram-chat.json`(`{"chat_id": ...}`)을 찾는다 — 여러 프로젝트가 같은 봇을 공유하고 머리말
   `[프로젝트명]` 으로 구분된다. 없으면 `~/.claude/ntfy-topic.txt`(공개 주제), 둘 다 없으면 무음.
6. **`tools/auto` 를 먼저 커밋**한다 — 방금 설치된 파일이 untracked 인 채로 리허설을 돌리면
   러너의 dirty 가드(작업 트리가 clean 이 아니면 커밋 배치를 시작하지 않는다)에 걸려 exit 4 로 죽는다.
7. 리허설: `node tools/auto/plan-queue.mjs --dry` → `node tools/auto/run-night.mjs --auto-plan --dry-run`.
7. 프로젝트 CLAUDE.md 에 아래 「무정지 설계」·「안전선」 요약과 낮/밤 리듬을 기록한다.

### 예약 등록의 실측 함정 (설치기가 이미 피해 놓은 것)

- PowerShell `New-ScheduledTaskTrigger -RepetitionDuration ([TimeSpan]::MaxValue)` 는 **실패한다**
  ("value which is incorrectly formatted or out of range"). 그래서 설치기는 **작업 XML 직접 등록**을
  쓰고 `<Repetition>` 에서 `<Duration>` 을 **생략**한다(생략 = 무기한).
- XML 선언(`<?xml … encoding=…?>`)을 **일부러 넣지 않는다** — 넣으면 문자열 등록 경로나 GUI 가져오기
  경로 중 하나가 반드시 깨진다.
- `ExecutionTimeLimit PT0S`(시간 제한 없음) · `MultipleInstancesPolicy IgnoreNew`(앞 라운드가 돌면
  새 인스턴스 안 만듦 — 러너 lock 과 이중 방어) · 배터리 조건 false(전원이 빠져도 서지 않는다).
- XML 은 상태 폴더에 **항상 파일로 남는다** — 등록이 실패해도 사람이 같은 파일로 재현할 수 있어야 한다.

## auto.config.json

```json
{
  "project": "이름(예약 작업·상태 폴더·알림 머리말에 쓰임)",
  "epicOrder": [1, 2, 3],
  "parallelAllow": { "<스토리키>": 2 },
  "dailyCap": 30,
  "parallel": 2,
  "models": {
    "new": { "dev": "fable", "review": "opus" },
    "recovery": { "dev": "opus", "review": "fable" },
    "closeout": { "review": "opus" }
  },
  "mockupGate": {
    "marker": "새 화면",
    "ruleId": null,
    "mockupsDir": "mockups",
    "verdictsPath": "tools/dev-status/mockup-verdicts.json"
  },
  "orchestrator": { "enabled": false, "model": "fable", "timeoutMin": 5 }
}
```

- `epicOrder` **필수** — 비어 있으면 자동 편성이 이유를 말하고 선다(사람이 정하는 값이라서).
- `dailyCap` = 하루 편성 상한 — **페이스가 아니라 폭주 방지 백스톱**이다. 몫을 다 했다고 남은
  슬롯이 쉬면 안 된다. 실질 제동은 STOP 차단기·결정 대기 제외·한도 대기·리뷰 게이트.
  그날만 늘리려면 원격 `/extend N`(아래).
- `parallel` = 병렬 폭(기본 2 · 하드캡 3) — File List 서로소 2스토리 배치(규칙 ⑤ 짝)를 워크트리
  분리로 동시 실행한다. 대상 = **dev 를 포함하는 배치**. 신규 스토리 짝은 **스펙에 예상 File List
  절이 있어야** 병렬 후보가 된다(비어 있으면 순차 폴백). 커밋 가드는 엔진 그대로, 반영은 러너의
  cherry-pick 직렬 landing(충돌 = 그 스토리만 실패 + `archive/parallel-*` 태그 보존 — 유실 0).
- `models` — 배치 종류별 3키(`new`/`recovery`/`closeout` — 중요도 배정). 평평한 `{dev,review}`
  1개만 두면 전 종류 공통(하위 호환). null = CLI 기본 모델. **dev ≠ review 가 교차검증**이며,
  엔진이 배치 안에서 같은 모델로 붙는 조합을 강제로 회피한다(사다리 강등 시에도 유지).
- `mockupGate` = **목업 게이트가 쓰는 값 전부의 집**(편성 규칙 ⑥). 코드에는 어떤 프로젝트의 내부
  규칙 ID 도 남아 있지 않다 — 필요하면 여기서 주입한다.
  - `marker` — 에픽 문서의 그 스토리 절에서 「새 화면」을 가리키는 문자열(기본 `"새 화면"`).
    **비어 있으면 게이트 미구성**으로 보고 통과시키되, 편성 결과의 `_편성` 근거에
    「목업 게이트 미구성」을 남긴다(조용히 없는 척하지 않는다).
  - `ruleId` — 같이 있어야 새 화면으로 볼 **추가 문자열**(기본 `null` = 추가 조건 없음).
    프로젝트가 「새 화면 + 내부 규칙 번호」 표기를 쓸 때만 채운다.
  - `mockupsDir` — 목업 파일 폴더(기본 `mockups`). 스토리 키로 `story-<에픽>-<번호>-` 접두사를 찾는다.
  - `verdictsPath` — 승인 판정 JSON 경로(기본 `tools/dev-status/mockup-verdicts.json`).
    파일이 없으면 판정 0건이므로 새 화면 스토리는 「목업 부재」로 보류된다.
- `orchestrator` = **Fable 계획(선택 · 기본 꺼짐)**. `enabled: false` 면 편성은 규칙 그대로다.
  켜면 규칙 큐를 지휘 모델에게 재편성시키되 **후보는 규칙이 고른 스토리뿐**이고, 검증기를
  통과할 때만 채택한다(실패·거부·타임아웃 = 규칙 큐 폴백 · 사유는 `[ORCHESTRATOR] source=…`).
  `timeoutMin` 을 넘기면 그 라운드는 규칙 큐로 간다 — **LLM 때문에 밤이 서지 않는다**.
- **상태 폴더는 3단계 우선순위**다 — ① 환경변수 `AUTO_BATCH_STATE_DIR` ② `auto.config.json` 의
  `stateDir` ③ 기본 `~/.claude-auto/<project>`. 러너·편성기·원격 폴러·설치기가 **같은 순서**를 쓴다
  (한 곳만 다르면 lock 과 원장이 갈라져 이중 기동이 난다). `project` 는 **`auto.config.json` 의
  `project` → 폴더 이름** 2단계다(설치기 포함 네 곳이 같은 식을 쓴다 — 설치기는 config 를 만들 때
  이 값을 항상 써 넣으므로, 이후로는 config 가 단일 출처가 된다).

## 무정지 설계 — 「밤이 서 있는 시간」을 없앤 8가지

### 1. 시계는 두드리기만 한다 (30분 슬롯 · 연속 루프)

30분마다 러너가 기동을 시도한다. 실제로 할 일이 있으면 **큐가 마를 때까지 연속 루프**로 돌고
(작업 종료가 다음 배치를 연다), 없으면 조용히 물러난다. 라운드가 30분을 넘겨도 상관없다 —
겹침은 lock 과 예약 작업의 `IgnoreNew` 가 이중으로 막는다. 자정을 넘기면 시작 시점 날짜로 고정된
채 루프를 끝내고 다음 슬롯에 넘긴다(브랜치 이름과 원장 날짜가 어긋나지 않게).

**공회전 가드** — 루프가 다음 라운드를 여는 조건은 「STOP 없음 + 편성 0 아님」만으로는 부족하다.
엔진이 전 단계를 skip 하고 **자기 로그 2파일만 커밋**한 채 exit 0 을 내면 러너는 그걸 완주로 세고
같은 라운드를 밤새 재생산한다(커밋 오염 + 알림 폭주). 그래서 러너는 그 라운드 커밋이 만진 파일
목록을 모아 **로그 폴더 밖 파일이 하나라도 있을 때만** 「실작업 있음」으로 보고, 아니면 —
커밋 0·빈 커밋·판정 재료 미전달 포함 — **루프를 끝낸다.** 모르면 멈추는 쪽이 싸다: 잘못 멈춰도
다음 정시 슬롯이 새 프로세스로 이어받는다. 편성기의 무진전 상한(규칙 9 v2)이 1차 방어선이고
이건 러너 쪽 심층 방어다.

### 2. lock v2 — 죽은 lock 이 밤을 잠그지 못한다

- **모든 모드가 lock 을 잡는다**(수동 실행 포함) — 「수동은 lock 밖」이 과거 이중 기동 사고의 한 축이었다.
- 획득은 원자 생성(`wx`), 내용은 `{pid, token, at, hb}`. **해제는 자기 토큰일 때만** — 탈취당한 구
  프로세스가 종료하면서 새 lock 을 지우는 사고(ABA)를 막는다.
- **심박(hb)** 은 라운드 시작·배치 경계마다 갱신한다(자기 토큰일 때만). 갱신은 **원자 교체**다 —
  임시 파일에 쓰고 `rename` 으로 갈아끼운다. 덕분에 다른 프로세스가 갱신 도중에 읽어 **찢긴 JSON**
  을 보는 갈래가 사라진다(제자리 덮어쓰기였을 때만 있던 위험이다).
- 판정 갈래: 없으면 **acquire** · pid 생존이면 **skip-alive** · pid 사망(ESRCH)이면 **takeover** ·
  **JSON 손상**이면 심박을 읽을 수 없으므로(경과 = ∞) **즉시 takeover**(원자 교체 이후 남는 손상
  원인은 수동 편집·디스크 오류뿐이고, 그런 lock 은 기다릴 근거가 없다) · **권한 오류(EPERM 등)로
  pid 만 판정 못 하면** 심박 **6시간** 초과일 때만 takeover, 아니면 **skip-unknown**.
- 6시간인 이유: 최장 스토리 라운드(스테이지 150분 × 3단계 + qa)보다 길다 — 살아 있는 러너를
  stale 로 오판하지 않는다.
- `skip-unknown` 은 **무음 금지** — 하루 1회 알린다(죽은 lock 이 「생존」으로 굳어 밤새 조용히
  건너뛰는 일이 없게). 수동 모드에서 물러날 때는 exit 1(사람이 눈치채야 한다).

### 3. 선형 승계 — 미머지 `auto/*` 가 남아도 밤은 계속된다

구방식은 미머지 `auto/*` 가 있으면 슬롯을 통째로 휴면시켰다(실측: 하룻밤 9.5시간 유휴).
무정지판은 **최신 미머지 `auto/<날짜>` 의 tip 위에서 오늘 브랜치를 시작한다.**

- 대상은 `auto/YYYY-MM-DD` 패턴 브랜치(로컬 + 원격 둘 다 스캔). 같은 날짜면 원격 이름 우선
  (푸시된 것이 공유된 사실이다).
- **main 은 무접촉** — 사람 머지 원칙은 그대로다. 체인이 선형이므로 **아침에 최신 브랜치 1개만
  머지하면 체인 전체가 들어온다.**
- 날짜형 이름이 하나도 없으면(비정형 브랜치) 승계 기준을 정할 수 없으므로 **종전대로 휴면**하고
  사람을 부른다. 알림은 밤당 1회.

### 4. 하향 동기 — 낮의 확정이 밤에 보인다

라운드 시작마다 `fetch` 후 `origin/main` 을 작업 브랜치로 **가져온다**(main 에 쓰지 않는다).
낮에 확정한 결정·큐·목업 승인이 그날 밤 배치에 반영되는 통로다. 충돌은 **3분기**로만 처분한다.

| 처분 | 조건 | 행동 |
|---|---|---|
| **resolve** | 충돌이 전부 로그·공유 장부 클래스 | 계획대로 자동 해소(`checkout --ours` / 마커 정리) 후 커밋 |
| **defer** | 잔여 충돌이 전부 `_bmad-output/` 하위 `.md`(문서) | merge 중단 · **동기 없이 라운드 계속**(아침 사람 머지가 정식 3-way 로 합친다) |
| **halt** | 코드 파일이 하나라도 섞임 | merge 중단 · **이 라운드 휴면**(자동으로 뭉개지 않는다) |

- 같은 **충돌 지문**(파일 목록을 정규화·정렬한 문자열)이 2회 나오면 그날은 동기 재시도를 멈춘다
  (`d2halt`) — 같은 충돌을 슬롯마다 재생산하지 않게. 알림은 밤당 1회.
- 자동 해소가 도중에 실패하면 **defer 로 강등**한다 — 밤을 막지 않는다.
- 한글 경로 때문에 문서 충돌이 코드 충돌로 오분류되던 결함이 있어, 충돌 목록은 항상
  `core.quotePath=false` 로 읽는다.

### 5. 체인 게이트 — 사람 검토 없는 축조에 상한을 둔다

러너가 라운드마다 상태 폴더에 `chain-info.json`(`{ageDays, branches, at}`)을 남기고, 편성기가
읽는다. **미머지 체인이 2일 이상이면 「신규 착수」만 보류**한다.

- 회수·마감 재검수는 계속 돈다 — **이미 시작된 일의 마무리는 검토를 더 쌓는 게 아니라 검토를
  준비하는 일**이기 때문이다.
- 사람이 머지하면 다음 라운드의 실측에서 나이가 0 으로 돌아가고 신규가 자동 재개된다.
- 체인 실측이 실패하면 나이 0 으로 본다(밤을 세우지 않는 방향).

### 6. STOP 차단기 v2 — 원인 서명 단위

구방식은 창(낮/밤) 단위 단순 카운터라 **서로 무관한 STOP 2건**에도 밤 전체가 잠겼다(최장 11시간
휴면). v2 는 **「원인 서명」 = exit 코드 + 멈춘 배치 라벨** 단위로 센다.

- 같은 서명 **2회**면 차단 · 창 누적 **4회**면 차단(폭주 백스톱) · **다른 원인은 계속 간다.**
- 성공 라운드는 서명 스트릭을 지운다(창 누적은 유지 — 백스톱 보존).
- **exit 5(사용량 한도)는 세지 않는다** — 고장이 아니라 날씨다.
- 창은 달력일이 아니라 낮/밤(06~18 / 18~익일 06) — 낮 사고가 밤 몫을 잠그지 않는다.
- 원격 `/resume` 이 이 창의 차단기를 **통째로**(스트릭·누적 모두) 리셋한다.

### 7. 규칙 9 v2 — 「무진전 편성의 연속 횟수」

반복 편성 상한의 대상이 「평생 편성 N회」에서 **「진전 없이 연속으로 편성된 횟수」**로 바뀌었다.
「평생 N회」는 24시간 무정지에서 폭주 상한이 아니라 그 스토리의 사형 선고였다 — 정상적으로
전진하는 스토리(신규 → 회수 → 마감 재검수)도 몇 라운드면 소진돼 무인 done 경로가 봉쇄됐다.

- 러너가 라운드마다 `state.days[날짜].progressed` 에 **그 라운드 커밋이 실제로 만진 스토리 md 키**를
  누적한다(로그 폴더 안 경로는 제외 — 로그만 커밋된 헛돎은 진전이 아니다).
- 편성기는 날짜 오름차순으로 원장을 훑어 — 편성됐는데 그날 진전이 없으면 스트릭 +편성수,
  진전이 있으면 **0 리셋**.
- 상한은 **마감 재검수 1회 · 그 외 2회**. 스토리 파일이 아직 없는 신규 갈래도 같은 검사를 지난다
  (사람 게이트에 막힌 신규가 매 라운드 재편성 + 전 단계 skip 으로 도는 폭주가 정확히 이 갈래였다).
- **판정 순서가 계약이다**: 편성기는 **kind(new/recovery/closeout)를 먼저 정하고 그 다음 상한을
  검사한다.** 구판 순서에서는 규칙 9 가 마감 재검수를 선점해 정상 파이프라인의 무인 done 경로를
  영구 봉쇄했다.
- 무진전 반복(같은 스토리를 계속 다시 집는 폭주)은 종전과 똑같이 잡힌다 — **폭주 백스톱은 무손실**이다.
- 원장은 편성기가 읽기만 하고 러너가 쓴다(단일 작성자 원칙).

### 8. exit 5 환불 · `/extend` — 한도가 하루를 공짜로 먹지 않는다

- **exit 5 환불**: 한도로 멈춘 배치의 스토리 중 **라운드 커밋이 그 스토리 md 를 한 번도 만지지
  않은 키**는 실작업 0 이므로 하루 상한 원장에서 환불한다(규칙 9 v2 스트릭도 먹지 않는다).
  다른 exit 코드는 종전대로 보수적으로 남긴다(멈춘 배치는 일부 실행됐을 수 있다).
- **`/extend N`**(1~30): 그날 하루 상한만 N 만큼 올린다(누적). **유일하게 인자를 받는 명령**이며
  4자리 코드 되묻기를 그대로 지난다. 인자 없는 `/extend` 는 무시(형식 미달), 범위 밖 숫자도 무시.
- `/extend` 는 **원장을 만지지 않는다** — 폴러가 상태 폴더에 `cap-extend-<날짜>.json` 을 쓰고
  편성기가 **읽기 전용으로 가산**한다(`상한 = 기본 + 보너스`). 두 프로세스가 같은 파일을 쓰지
  않게 하는 단일 작성자 원칙이다. 당일 한정 — 자정이 지나면 기본 상한으로 돌아간다.

## 완성도를 지키는 안전선 (무정지가 절대 넘지 않는 선)

무정지의 목적은 **쉬지 않는 것**이지 **빨리 끝내는 것**이 아니다. 속도는 아래 어느 것도 완화하는
근거가 될 수 없다.

1. **코드 충돌은 절대 자동 해소하지 않는다.** 하향 동기에서 코드 파일이 하나라도 충돌하면 그
   라운드는 휴면하고 사람을 부른다. 자동 해소 대상은 로그·공유 장부 클래스뿐이고, 문서 충돌은
   해소하지 않고 **미룬다**(아침 사람 머지의 정식 3-way 가 합친다).
2. **미머지가 2일이면 신규 착수를 멈춘다.** 승계로 계속 돌 수는 있어도, 사람이 한 번도 보지 않은
   결과물 위에 새 일을 무한히 쌓지는 않는다. 회수·마감 재검수(시작된 일의 마무리)만 계속된다.
3. **qa 게이트·적대 리뷰·커밋 가드는 불변.** `npm run qa` 실패는 그대로 STOP 이고, 리뷰 단계도
   무인 라운드 상한도 그대로다. 무정지 개편은 **언제 도느냐**만 바꿨고 **무엇을 통과해야 하느냐**는
   건드리지 않았다.
4. **main 머지는 사람이 한다.** 러너는 `auto/<날짜>` 브랜치까지만 커밋·푸시하고, main 방향은
   `origin/main` 을 **가져오기만** 한다. 원격 `/merge` 도 **원격 fast-forward 전용**이며 갈라짐은
   강제하지 않고 사람에게 넘긴다. 배포·외부 발송 명령은 파서에 아예 없다.
5. **결정은 사람 몫이다.** 열린 Decision 이 있는 스토리는 편성에서 제외되고, 무진전 상한을 소진한
   스토리도 사람 판단으로 넘어간다(아침 브리핑에 뜬다).
6. **자동 판정이 불확실하면 물러난다.** lock 판정 불능·비정형 브랜치·체인 실측 실패·**실작업
   판정 불명**(공회전 가드)은 전부 「조용히 밀어붙이기」가 아니라 「알리고 물러나기」 또는
   「루프 종료」로 처리한다. 무정지는 **쉬지 않는 것**이지 **모르면서 계속 도는 것**이 아니다.

## 운영 계약 (러너·편성기에 하드코딩 — 프로젝트가 알아야 할 것)

- **브랜치는 항상 `auto/<날짜>`** · 커밋·푸시는 큐 `defaults` 옵트인 · **main 머지는 사람 승인**.
- **한도 대기**: 슬롯 모드 30분(짧게 기다렸다 exit 5 — 이어하기는 상태 파일 + 다음 슬롯),
  수동 실행 480분. 차단기는 exit 5 를 세지 않는다.
- **리셋 전 미커밋 보존**: 워크트리 새로고침(`checkout -f`/`clean`)은 앞 배치가 STOP 으로 커밋하지
  못한 변경을 `git stash push -u`(slot-preserve) 로 먼저 보관하고 알린다 — 산출물·물증 유실 0.
- **원격 명령**(옵트인 — 폴러 예약 등록 시): `/status`(읽기) · `/merge`(미머지 `auto/*` → main
  **원격 ff 전용**) · `/resume`(창 차단기 리셋 + 죽은 lock 제거 + 러너 기동 요청) · `/extend N`.
  발신자 chat_id 단일 잠금 · 실행형은 4자리 코드 되묻기(TTL 30분) · 전 명령 원장 · 운영 DB·삭제·
  배포·시크릿 명령은 파서에 존재하지 않는다. 회신은 fetch 선행 + exit 검증(스테일 성공 보고 차단).
  `--dry-run` 은 완전 무부작용(offset·pending·state·lock·발신 0). 예약 예:
  `schtasks /Create /F /IT /TN "<프로젝트>-telegram-commands" /SC MINUTE /MO 10 /TR "cmd /c cd /d <클론> && node tools\auto\telegram-commands.mjs --once >> <상태폴더>\telegram-poll.log 2>&1"`
- **알림 2채널 · 채널마다 다른 분량**: 텔레그램(비공개)이 구성돼 있으면 정본, 없으면 공개 ntfy
  폴백, 둘 다 없으면 무음.
  - 텔레그램 전송은 Node 20 빌트인 `fetch()` 로 한다 — 외부 CLI 도 셸 문자열 보간도 쓰지 않는다.
    토큰이 명령줄에 실리면 같은 PC 의 **프로세스 목록에 그대로 노출**되고, 알림 본문에 있는 따옴표
    하나가 셸 명령을 바꿔 놓을 수 있다. 전송 실패는 무음(배치에 영향 없음).
  - **공개 ntfy 로 나갈 때는 축약 본문만** — 제목·건수·exit 코드 수준까지다. 브랜치 이름·파일
    경로·배치 라벨은 싣지 않고 「상세는 상태 폴더 로그를 확인한다」로 대체한다(알림마다 축약문을
    따로 줄 수 있고, 안 주면 이 기본 문장이 나간다). **상세 본문은 텔레그램에만 간다** — 공개
    주제는 이름만 알면 누구나 읽는다.
- **설정 JSON 은 BOM 금지** — PowerShell 로 저장하면 UTF-8 BOM 이 붙는다. 코드가 내성을 갖지만
  (chat.json 등), 새 파일은 BOM 없는 UTF-8 로 저장한다(실사고: 알림이 무음 증발).
- **편성 규칙 10종**: ① epicOrder 는 **우선순위이지 댐이 아니다** — 뒤 에픽의 회수·마감 재검수는 앞
  에픽에 후보가 남아도 통과하고, **신규 착수만** 에픽 도달을 기다린다 ② 열린 Decision = 제외(인박스
  미등재 의심 경고) ③ 재투입 금지 지시 ④ Patch 만 있고 Task 0 = 사람이 라운드를 열어야 함
  ⑤ File List 서로소 **같은 종류·같은 에픽** 2건 묶음(공유 장부 파일은 겹침 판정 제외) ⑥ 새 화면
  목업 게이트(**판정 재료는 전부 `cfg.mockupGate`** — `marker` 가 비면 미구성으로 보고 통과시키되
  근거를 남긴다) ⑦ 하루 상한(+`/extend` 보너스) ⑧ 회수분 0 제외 ⑨ **무진전 연속 편성 소진 = 사람
  판단으로**(v2 — 진전 시 자동 리셋) ⑩ **마감 재검수(closeout)** — 상태 review 에 열린 findings 0
  인 스토리는 review 단계만 강제 재실행해 done 으로 마감하거나 새 findings 를 캔다.
  여기에 **체인 게이트**(신규 착수만 보류)가 신규 갈래에 하나 더 얹힌다.
- **수동 큐 우선**: `night-queue.json` 의 `planned` 가 `'auto'` 가 아니면 다음 라운드가 1회 우선
  소비한다(전역 소비 표식 — 자정이 지나도 재실행되지 않는다).
- **exit code**: 0 완주 · 1 실패/qa RED(수동 모드의 lock 회피 포함) · **2 전제 미충족**(엔진 미설치 ·
  저장소 루트가 아님(`package.json` 없음) · 큐 JSON 을 읽지 못함 — 러너는 자기 인자를 검증하지 않는다) ·
  3 편성기 실패·워크트리 새로고침 실패, 그리고 엔진의 인증 STOP 전파 · 4 no-op/dirty · 5 한도.
- **상태 폴더**(저장소 밖 · 기본 `~/.claude-auto/<프로젝트>`): `auto-plan-state.json`(원장·창 차단기·
  진전) · `runner.lock` · `chain-info.json` · `cap-extend-<날짜>.json` · `slots.log` · 텔레그램 원장·
  offset·pending · 작업 XML.

## 종전 4시간 슬롯판에서 올라올 때 (2026-09-02 통합으로 폴더는 사라졌다)

옛 판은 예약이 **2개**(18:00 데일리 + 4시간 슬롯 5회)였고, 미머지 `auto/*` 가 있으면 슬롯이
**휴면**했으며, `origin/main` 은 다음 날 새로 시작할 때만 반영됐다. 그 세 가지가 각각
낮 산출물 단절·무기한 정지·정본 미반영을 만들었고, 지금 판이 러너 쪽에서 전부 해결했다.

| 항목 | 옛 4시간 슬롯판 | 지금 |
|---|---|---|
| 예약 작업 | 2개 — 18:00 데일리 + 4시간 슬롯 5회 | **1개** — 00:05 시작 · 30분 · 무기한 |
| 미머지 `auto/*` | 슬롯 **휴면**(사람 머지가 열쇠) | **선형 승계**로 계속(비정형 이름만 휴면) |
| `origin/main` 반영 | 다음 날 새로 시작할 때만 | **라운드마다 하향 동기**(문서 충돌은 자동 해소) |
| lock | 슬롯 모드만 · pid 생존만 판정 | **모든 모드** · 원자 생성 + 심박 6h + 토큰 해제 |
| STOP 차단기 | 창 단위 단순 2회(전면 차단) | **원인 서명 2회** · 창 누적 4회 |
| 반복 편성 상한 | 편성 2회(누적 — 리셋 없음) | **무진전 연속** 2회(마감 재검수 1회) · 진전 시 리셋 |
| 하루 상한 | 편성 이벤트 기준 · 연장 없음 | **고유 스토리 기준**(재편성 무과금) · `/extend N` |
| main 머지 · qa · 적대 리뷰 · 커밋 가드 | 사람 / 불변 | **동일**(무정지가 완화하지 않는다) |

**올라오는 법**: 대상 프로젝트 루트에서 `node <이 폴더>/install.mjs --force` 로 `tools/auto/`
엔진을 덮어쓰고, 옛 예약 2개를 `Disable-ScheduledTask` 한 뒤 `--register-tasks` 로 1개를 건다.
`auto.config.json` 스키마와 큐 형식은 그대로라 설정을 새로 만들 필요가 없다.

## 운영 진단 순서 (30분 심박이 안 보일 때 — 위에서부터)

1. **`slots.log` 의 마지막 기록 시각.** 30분 안에 아무 줄도 없으면 러너가 아니라 **시계가 안
   두드린 것**이다 — 2~3번으로 간다. 줄은 있는데 「물러난다」류면 4번 이후.
2. **PC 로그온·절전.** 예약은 Interactive only다 — 로그아웃·잠자기·최대 절전이면 돌지 않는다.
   전원 옵션의 절전 설정부터 본다(가장 흔한 원인).
3. **예약 작업 상태.** `Get-ScheduledTask -TaskName "<프로젝트>-nonstop"` 의 State(Disabled 아닌지) ·
   `Get-ScheduledTaskInfo` 의 LastRunTime/LastTaskResult/NextRunTime.
4. **lock.** 상태 폴더의 `runner.lock` 에서 pid·hb 확인. 「lock 판정 불능」 알림은 **권한 오류로
   pid 를 못 읽은 경우**이며, 이때만 심박 6시간이 지나야 자동 교체된다 — 급하면 파일을 지우고
   (다른 러너가 없는 것을 확인한 뒤) `/resume`. 파일이 깨져서 못 읽는 경우는 **다음 슬롯이 즉시
   교체**하므로 기다릴 필요가 없다.
5. **차단기.** `auto-plan-state.json` 의 `windows[<날짜>-day|night]` 에서 `sigs`·`total` 확인.
   같은 서명 2회 또는 누적 4회면 차단 상태 — 원인을 보고 `/resume`.
6. **편성 0.** `node tools/auto/plan-queue.mjs --dry` 로 `_편성.excluded` 의 이유를 읽는다
   (결정 대기 · 무진전 연속 소진 · 체인 게이트 · 상한 · 목업 미승인 중 하나다).
7. **하향 동기.** 로그에 「코드 충돌 — 이 라운드 휴면」이나 「하향 동기 중단 상태」가 보이면
   사람이 정식으로 머지해야 풀린다.
8. **한도.** exit 5 가 반복되면 고장이 아니라 사용량 문제다 — 차단기는 세지 않으므로 다음 슬롯이
   계속 시도한다.

## 하루 리듬 (권장 — 프로젝트 CLAUDE.md 에 기록)

「실행→판정→확정→장전」 폐루프: **밤·새벽**(결정이 필요 없는 물량 전량 소진 — 성과는 낮의
준비량에 비례) → **아침**(밤 결과 판정 + 결정 재고를 15~20분 분량으로 압축 · 슬롯 심박/한도 대기
의무 확인) → **오전**(결정 소진 + main 머지 — 머지가 체인 게이트를 풀고 승계 사슬을 비운다) →
**오후**(다음 물량 최대 가동환경: 스펙·목업 승인·게이트 해소·큐 장전). 무정지판에서는 낮에도
러너가 계속 돌므로, 낮 작업은 **커밋·머지·푸시까지 끝내는 것**이 그대로 밤의 준비량이 된다.

## 전제

- Node 20+(빌트인만 사용 · 외부 npm 의존성 0) · git 원격(origin) · `auto-story-finish` 전역 스킬 ·
  `npm run qa` 게이트 정의
- BMad v6 산출물(`sprint-status.yaml`·`epics.md`·스토리 md) — 없으면 수동 큐만 가능
- 결정 단일 창구 `_bmad-output/implementation-artifacts/DECISIONS-INBOX.md`
- 실행 전용 클론 + marker `.auto-batch-worktree` — 없으면 워크트리 새로고침·하향 동기를 하지 않는다
  (대화 세션의 작업 트리를 배치가 건드리지 않게 하는 안전장치)
- (선택) Codex CLI(`@openai/codex`) + `codex login` — 없으면 Claude 전용으로 그대로 돈다. 켜는 것은 `auto.config.json`
  `providers.codex.enabled` 이고, Codex 는 marker 클론·linked worktree 에서만 실행된다(본 트리 금지)

## 테스트

```bash
node --test $(git ls-files -co --exclude-standard | grep '\.test\.mjs$')   # 전량 (LLM 호출 0 · 실 알림 0 · 실제 git·실제 프로세스 사용)
node night-batch-ops/engine/bench.mjs --stub                              # 하네스 벤치(스텁 실측) → references/hardening-2026-09-02/bench-stub.md
```


## 자율 마무리 — 범위를 사람이 정하지 않을 때

「지금 상태를 파악하고 배포 가능한 수준까지 자율적으로 마무리해줘」 같은 요청이면
큐를 손으로 짜지 말고 **자율 마무리 진입점**을 쓴다.

    node <skill>/engine/autofinish.mjs --root <프로젝트> --max-rounds 3 --bmad-writes on

하는 일: 프로젝트를 읽어 진단 → 남은 일을 7단계 우선순위로 세움 → 사람이 정할 8범주만 결정 인박스에
올림 → BMAD 스토리에 등재 → 지휘 모델 계획(검증 통과 시에만 채택 · 아니면 규칙 계획) →
`run-night --queue` 로 실행 → 다시 진단해 계속/중단/사람 호출을 판정 → 비개발자용 보고서.

**하지 않는 일**: 푸시 · main 머지 · 배포 · 외부 발송 · main 직접 작업 · `_bmad-output/` 밖 쓰기.
커밋은 종전 러너 계약대로 워크트리·`auto/<날짜>` 브랜치에서만 일어난다.

먼저 볼 것: `--diagnose-only --no-gates` 는 **대상 저장소에 한 바이트도 쓰지 않고** 판정만 낸다.

옵션·산출물 경로·안전 경계·문제 해결은 `AUTOFINISH.md` 에 있다.
