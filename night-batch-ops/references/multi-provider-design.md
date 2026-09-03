# 다중 프로바이더 하네스 — 설계 (2026-09-02)

> 대상: `auto-story-finish`(엔진) + `night-batch-ops`(러너·편성기). 목표는 「Claude Code 중심 무인 배치」를
> 「Claude + Codex 다중 워커 병렬 개발 + 자율 품질 검증 하네스」로 **하위 호환을 지키며** 확장하는 것.
> 이 문서는 구현 전 분석·설계이며, 구현 후 실측으로 갱신한다(§8 실측 결과는 이미 반영).

## 1. 기존 구조 (실측 · 2026-09-02)

### 1-1. 실행 흐름

```
[Windows 예약 30분] → run-night.mjs --auto-plan
  ├ lock v2(심박·탈취) → 워크트리 새로고침(marker 있을 때만) → 선형 승계 → 차단기 v2
  └ 라운드 루프: writeChainInfo → doDownSync(origin/main 흡수) → selectQueue(수동 큐 > plan-queue)
       └ runQueue: 배치 순서대로
            ├ parallelPlan ≥ 2 → runBatchParallel: 스토리별 워크트리(<clone>-wtN · node_modules junction · .env 복사)
            │     → 엔진 N개 spawn(--commit, detached HEAD) → cherry-pick 직렬 landing → push 1회 → 정리
            └ 그 외 → 엔진 1개 spawn(순차 · --commit --branch auto/<날짜> --push)
  엔진(auto-story-pipeline.mjs): 스토리마다 프로브 → create/dev/review 단계
       └ runClaude(stage): `claude -p --model X --permission-mode acceptEdits --settings pipeline-settings.json`
            stdin 프롬프트(`/bmad-*` 슬래시 스킬 + GUARD) → exit code + 산출물 mtime 이중 판정
       └ dev 뒤 qa 게이트(`npm run qa`) RED = 즉시 STOP(exit 1) · 스토리 끝 commitStory(가드 6종)
```

### 1-2. 모델 선택
- 편성기 `modelsFor(kind)`: 신규 dev=fable/review=opus · 회수 dev=opus/review=fable · 마감 review=opus. `cfg.models` 가 있으면 우선. `exhaustedModels` 는 짝 단위 회피.
- 엔진: `MODEL_LADDER`(fable→opus→sonnet · `AUTO_MODEL_LADDER` env) — limit 시 차순위 자동 전환, review 는 dev 와 다른 모델 강제(`enforceCrossModel`). spend(월 지출 한도)는 사다리·대기 모두 타지 않는다.

### 1-3. 실패 분류 (엔진)
`classifyFailure(out)`: auth(401·token expired) > spend(spend limit) > limit(usage/rate/429) > other. 프로브·단계 공통. `failure-classify.test.mjs` 가 소스 문자열 앵커로 규율을 문다(`const AUTH_RE =` · `kind !== "spend" && waitForRecovery` · `if (r === "limit") {` · `if (p === "limit") {`) — **이 앵커는 보존한다**.

### 1-4. 병렬 · landing
- 판정 `parallelPlan`: dev 포함 배치 · 2스토리+ · `parallel` 옵트인 · **하드캡 3**(`PARALLEL_MAX`). 근거(64d6ac8 · OPS-4): ① 동시 세션이 **사용량 한도를 배로 태운다** ② 같은 머신에서 무거운 qa(테스트+빌드) 동시 실행 시 **자원 경합·타임아웃 플레이크**(auto-story-finish SKILL §1b). 기본 권장 2.
- 편성기 규칙 5: 같은 에픽·같은 종류·File List 서로소 **2개까지** 한 배치.
- landing 충돌 자동 해소 클래스 = 엔진 자기 로그(union) · state.json(ours) · 공유 장부(union). 그 외 = archive 태그 보존 폴백.

### 1-5. 원장·설정·테스트
- 원장 해석 단일 소스 `story-ledger.mjs`(openFindings·readStorySignals·parseSprint). 리뷰 findings 형식 `- [ ] [Review][Patch] …` / `- [x] … ⏭️|✅|❌|~~` (story-ledger-guard 래칫).
- 설정 `tools/auto/auto.config.json`(project·epicOrder·parallelAllow·dailyCap·exhaustedModels·parallel·stateDir·models·mockupGate). 러너·편성기·폴러가 같은 3단계 규약으로 상태 폴더를 정한다.
- 테스트: 저장소는 `auto-story-finish/failure-classify.test.mjs`(node 단독) 하나. 엔진 순수 규칙 테스트(vitest 79종)는 원 프로젝트(`tests/auto/*.test.ts`)에만 있다 → **이번에 `node:test` 로 이식해 저장소 안에 기준선을 둔다**.

### 1-6. Codex CLI 실측 (0.152.1 · ChatGPT 로그인)
| 항목 | 실측 |
|---|---|
| 비대화형 | `codex exec [OPTIONS] [PROMPT]` · `-` 로 stdin 프롬프트 · `-C <dir>` 작업 루트 · `-m <model>` · `-s read-only\|workspace-write\|danger-full-access` · `--json`(JSONL 이벤트) · `-o <file>`(마지막 메시지) · `--output-schema <json>`(구조화 응답 강제 · 검증됨) · `--ephemeral` · `--skip-git-repo-check` · `-c key=value`(config 덮어쓰기) |
| 승인 | `exec` 에는 `-a/--ask-for-approval` **없음**(`unexpected argument`) — 비대화형은 묻지 않고 샌드박스 밖 명령은 실패로 모델에 돌아간다 |
| JSONL | `thread.started` · `turn.started` · `item.started/completed`(`agent_message`·`command_execution`·`file_change`) · `turn.completed{usage}` · 실패는 `turn.failed` / `error` |
| 오류 문구(바이너리 실측) | 인증: `Not logged in` · `please re-run codex login` · `ChatGPT login is required` / 한도: `You've hit your usage limit` · `You've reached your usage limit` · `rate limit exceeded` · `Quota exceeded` · `out of credits` · `stream disconnected` |
| 샌드박스 | workspace-write 로 `-C` 폴더 안 파일 생성 **성공**(Windows) · read-only 는 파일 쓰기 불가 · workspace-write 기본 네트워크 차단(`-c sandbox_workspace_write.network_access=true` 로 해제) |
| 인증 | `codex login status` = `Logged in using ChatGPT` · `~/.codex/auth.json` 자동 갱신(8일·401 시 refresh) · **같은 auth.json 동시 다중 사용 불가**(OpenAI 문서 · 08-29 설계 §4 🔒) → codex 동시 실행 상한 기본 1 |
| 모델 | `~/.codex/config.toml` `model = "gpt-5.6-sol"` 기본 · `-m` 으로 지정 |
| 비용 감 | 리뷰 1건 ≈ 78k 토큰(09-02 시범) · Plus 한도(5h 창 + 주간) 미측정 |

### 1-7. 이미 확정된 제약 (👤 · 08-29 설계서 + 09-02 결정)
- **Codex 는 배치 워크트리에서만** — 본 트리엔 gitignore 된 고객 실데이터(`docs/` `tools/migrate/local|out` `tools/eval/out`)가 있어 외부 벤더 반출 금지. marker 또는 linked worktree(`.git` 이 파일) 만 허용.
- 구독 OAuth 전용 · API 키·크레딧 구매 경로 없음 · 한도 = 대기가 아니라 **레인 전환 신호**(전환 1회 상한 · 부분 산출물 이어받기 금지).
- 게이트(`npm run qa`)·커밋 가드·`auto/*` 한정·main 머지 사람 승인·무인 결정 규칙 — 벤더 무관 불변.
- Codex 의 1차 용도 = **리뷰 교차검증**(09-02 👤). dev 위임은 옵션(설정으로 켠다).

## 2. 변경안

### 2-1. 계층
```
러너(run-night)  ── 큐·워크트리·landing·통합 게이트 ──▶ 엔진 N개 spawn(스토리별 --*-model <spec>)
엔진(pipeline)   ── 단계 루프·품질 루프·커밋 가드 ──▶ providers/index.mjs(감지·해석·사다리)
                                                     ├ providers/claude.mjs (claude -p …)
                                                     └ providers/codex.mjs  (codex exec …)
순수 규칙         quality-rules.mjs(게이트 탐지·실패 분류·수리 예산·테스트 무결성·트리거·매니페스트·에스컬레이션)
                  runner-rules.mjs(+워커 풀·병렬 위험·통합 게이트 판정)
```

### 2-2. 프로바이더 추상화 (엔진)
- **모델 스펙 문자열**로 프로바이더를 고른다 — 큐·러너 스키마 무변경: `"opus"`=claude/opus · `"codex"`=codex/기본 모델 · `"codex:gpt-5.6-sol"` · `"claude:fable"`. `parseModelSpec()` 순수.
- 어댑터 계약(둘 다 동일): `build(args) → {cmd, argv, input, cwd}` / `run() → {code, stdout, stderr, timedOut, events?, lastMessage?}` / `classify(text) → auth|spend|limit|other` / 타임아웃 · 로그 파일.
- `runClaude(stage, story)` 는 이름·앵커를 보존한 채 내부에서 `runWorker(spec, role, story)` 로 분기한다.
- **능력 감지**(`detectProviders`): claude=`claude --version`, codex=`codex --version` + `codex login status`. 감지는 **codex 스펙이 요청됐을 때만** 실행(Claude-only 배치는 새 프로세스 0). 결과를 `[PROVIDERS] claude=YES codex=YES|NO(사유)` 로 기록. codex 불가 → 그 단계를 claude 대체 모델(dev 와 다른 것)로 **폴백 + 경고**, 배치는 계속.
- **Codex cwd 프라이버시 가드**(순수 `codexCwdAllowed`): marker(`.auto-batch-worktree` · `.baroos-auto-worktree` · `--codex-cwd-marker`) 또는 linked worktree(`.git` 이 파일) 또는 `AUTO_CODEX_ALLOW_CWD=1`. 아니면 codex 사용 안 함(폴백 + 사유 기록).
- **Codex 리뷰**: `codex exec -s read-only -C <cwd> --json --output-schema codex-review.schema.json -o <last> -` · 프롬프트 = 자립형 3렌즈(Blind Hunter · Edge Case Hunter · Acceptance Auditor) + 「정확성·명시 요구사항 영향만 finding, 나머지 optional」 + pre-existing 분리. 엔진이 diff 를 파일로 만들어 넘긴다(`auto-pipeline-logs/<story>-review-diff.txt` — gitignore 대상). **엔진(node)이 JSON 을 원장 형식으로 렌더**해 스토리 파일 `### Review Findings` 에 기재하고(발견 0건도 라운드 기록), bmad-code-review 와 같은 상태 전이(patch/decision 있음 → in-progress · 0 → done)를 스토리 Status + sprint-status.yaml 에 반영한다. 코드 수정 0 · 커밋 0.
- **Codex dev**: `-s workspace-write -c sandbox_workspace_write.network_access=true`(설정으로 끌 수 있음) · 자립형 dev 프롬프트(bmad-dev-story 계약 요약: 미완 Task 순서대로 · TDD · 허용 절만 수정 · File List · Status→review · sprint-status 갱신 · commit 금지 · 루트 스크래치 금지 · CLAUDE.md/AGENTS.md 절대 제약). 사후조건은 종전과 동일(스토리 md mtime).
- **사다리/폴백**: limit 시 같은 프로바이더 차순위 → 없으면 **다른 프로바이더**(허용 역할일 때 · 전환 1회 상한 · dev 와 같은 모델/프로바이더 회피). spend 는 종전대로 사다리·대기 없음. auth 는 그 프로바이더만의 문제이므로 다른 프로바이더가 있으면 전환, 없으면 종전 대기.
- **교차검증 확장**: `enforceCrossModel` 이 provider 차원까지 본다 — dev 와 review 가 같은 provider·같은 model 이면 다른 model, 다른 provider 가 있고 설정이 허용하면 provider 우선.

### 2-3. 품질 게이트 + 자율 수리 (엔진)
- 게이트 탐지 `detectGates(pkg.scripts)`: qa(정본) · lint · typecheck · build · test · coverage · e2e 존재 여부. **없는 명령은 만들지 않는다** — 매니페스트에 `n/a(사유)`.
- dev 뒤: ① 테스트 무결성 검사(`testIntegrityFindings`) — `.only`·테스트 파일 삭제(사유 미기재) = 차단 / `skip`·`@ts-ignore`·`eslint-disable`·coverage exclude = 경고 기록 ② qa 게이트 ③ RED 면 **수리 루프**: `classifyQaFailure(log)` → 원인 서명(typecheck/lint/test/build/other + 첫 오류) → `repairDecision` (같은 원인 3회 · 총 5회 · 설정) → dev 워커에 수리 프롬프트(로그 발췌·금지 행동 목록·무결성 규칙) → 재검증. 예산 소진 = 종전 qa RED STOP(exit 1) + **에스컬레이션 보고**(상황·원인·시도·선택지·추천·위험).
- 기본값: `--auto-repair 0`(꺼짐 — 종전 동작). 러너가 `cfg.quality` 로 켠다.
- 조건부 게이트: `securityTriggers`/`performanceTriggers`(변경 파일·diff 키워드) → 프로젝트에 해당 테스트 스크립트가 있으면 실행, 없으면 `required-missing` 으로 정직 기록(거짓 통과 없음).
- **검증 매니페스트** `auto-pipeline-logs/<story>-verification.json`(기존 폴더 · 커밋 화이트리스트 안): provider/model/role/commit/checks/review/repair/integrity/escalation.

### 2-4. 러너 (night-batch-ops)
- 설정(전부 선택 · 없으면 종전 동작):
```jsonc
"workers":  { "max": 3, "batchSize": 2 },                       // max ≤ 6(절대 상한) · batchSize = 규칙 5 짝 크기
"providers": {
  "claude": { "enabled": true,  "max": 3 },
  "codex":  { "enabled": false, "max": 1, "roles": ["review"], "reviewKinds": ["new","recovery"],
              "model": null, "networkAccess": true, "fallback": true }
},
"quality": { "autoRepair": true, "sameRootCauseMaxRetries": 3, "totalRepairAttempts": 5,
             "changedCodeCoverageTarget": null, "testIntegrity": true },
"integrationGate": { "enabled": true }   // pushOnFail 은 2026-09-02 hardening 에서 폐지 — RED 는 항상 rollback·STOP·push 금지
```
- 편성기 `modelsFor`: `providers.codex.enabled` 이고 roles 에 review, kind 가 reviewKinds 에 있으면 `review: "codex"`(closeout 은 기본 제외 — 최종 done 판정은 Claude 교차). `exhaustedModels` 에 `"codex"` 를 적으면 종전 짝 회피가 그대로 작동.
- 러너 시작 시 능력 감지 1회(`codex --version`·`login status`) → 불가면 큐의 codex 스펙을 claude 로 재작성 + 경고(기존 배치 중단 없음).
- 병렬 경로: **워커 풀** — 프로바이더별 동시 상한(`codex.max` 기본 1 · `claude.max`) + 총 상한(`workers.max`, 종전 `PARALLEL_MAX=3` 기본 유지 · 절대 상한 6). `providers.codex.roles` 에 dev 가 있으면 병렬 짝의 두 번째 스토리부터 codex dev(교차: review 는 claude)로 분할.
- 병렬 위험 판정 `parallelHazards`: File List 겹침(종전) + 둘 다 `supabase/migrations/` 신규(번호 경합) + 공유 설정 파일(package.json·tsconfig·vite/eslint config·`src/types/database.ts`) 동시 수정 → 순차 폴백.
- **통합 게이트**: 병렬 landing 뒤 배치 트리에서 `qa` 1회 → RED 면 record·알림·**landing 되돌림(reset 실측 검증)·push 금지**(설정으로 우회 불가 · `pushOnFail` 폐지 2026-09-02)·배치 STOP(exit 1 → 차단기). 순차 경로는 같은 트리에서 이미 스토리마다 qa 를 돌므로 대상 아님.
- 로그 태그: `[<story>][CLAUDE|CODEX][DEV|REVIEW|REPAIR|QUALITY|LANDING|INTEGRATION][…]`. 현황판이 읽는 기존 줄(`→ [story] stage (model=…)` · `exit=`)은 **그대로** 둔다.

### 2-5. 하지 않는 것 (이번 판)
- 스토리 내부 역할 병렬(구현‖테스트 작성) — 같은 스토리 md·같은 테스트 파일을 두 워커가 만져 충돌이 확실. 어댑터는 role 을 받지만 러너에 배선하지 않는다(후속).
- API 키·크레딧 경로 · 프록시 게이트웨이 · 벤더 3사.
- 기존 순차 경로·가드·차단기·원장 규칙 삭제/단순화.

## 3. 위험 요소와 대응
| 위험 | 대응 |
|---|---|
| Codex 가 리뷰 findings 를 파일에 안 씀 → NO-OP | 엔진이 JSON 을 받아 **직접 렌더·기재**(read-only 샌드박스) · 스키마 강제 · JSON 불량 = exit 4 종전 경로 |
| Codex dev 가 코드 밖(스토리 절·설정)을 망침 | 프롬프트 허용 절 명시 + 엔진 커밋 가드(화이트리스트·시크릿) 그대로 + 테스트 무결성 검사 |
| Codex 동시 실행이 auth.json 갱신 경합 | `providers.codex.max` 기본 1 · 초과 설정은 경고와 함께만 |
| 한도 전환 핑퐁 | 스토리·단계당 프로바이더 전환 1회 상한 |
| 수리 루프 무한/헛돌기 | 같은 원인 3회 · 총 5회 · 진전 없는 동일 서명 즉시 종료 · 예산 소진 = 종전 STOP |
| 새 로그 줄이 현황판 파서를 깨뜨림 | 기존 줄 형식 보존 · 태그 줄은 추가만 |
| 러너 가동 중 전역 엔진 교체 → 진행 중 배치 오염 | 이 작업은 `claude-skills` 저장소에서만 · 설치(전역·프로젝트)는 러너 정지 확인 후 별도 승인 |
| 병렬 폭 확대 → qa 자원 경합 플레이크 | `workers.max` 기본 3 유지 · 절대 상한 6 · 늘리는 것은 실측 후 사람 결정(문서화) |
| 엔진 앵커 문자열 깨짐 | failure-classify 가드 유지 + 새 소스 앵커 가드 추가 |

## 4. 테스트 계획 (전부 `node --test` · LLM 호출 0)
기준선(이식): runner-rules · plan-queue(+story-ledger) · telegram-rules(+폴러 DI). 신규: providers(스펙 파서·감지 폴백·사다리·codex 분류·이벤트 파서·cwd 가드·렌더러·인자 빌더·dry-run) · quality-rules(게이트 탐지·qa 분류·수리 예산·무결성·트리거·매니페스트·에스컬레이션) · worker-pool(프로바이더 상한·서로소 병렬·겹침 순차·위험·실패 격리·통합 게이트·설정 하위 호환) · 소스 앵커 가드(엔진·러너: dry-run 무실행 · 권한 모드 · deny 설정 · auto/ 가드 보존).

## 5. 구현 결과 (2026-09-02 · 설계 대비 달라진 것 · 실측)

적대 검토 3렌즈 40건(하위 호환 16 · Codex 현실성 11 · 동시성/품질 루프 13) 중 설계에 이미 반영된 것을 뺀 **15건을 코드로 고쳤다**.
설계 §2 에서 바뀐 결정:

| 항목 | 설계 | 구현 | 이유(검토 번호) |
|---|---|---|---|
| Codex dev 네트워크 | 기본 열림 | **기본 닫힘**(`providers.codex.network: true` 옵트인 · 엔진 `--codex-network on`) | workspace-write + 네트워크 = push·외부 전송 가능(F4) |
| 프로바이더 전환 상한 | 단계당 1회 | **스토리당 1회** + dev 부분 산출물 폐기(시작 트리가 clean 이었을 때만) | 두 벤더 왕복·이어받기 금지(F33 · 👤 08-29 §5-3) |
| Codex 실패 후 대기 | 종전 프로브 대기 | **대기 없이 STOP**(`pollable=false` · 러너가 다음 슬롯 재시도) | Claude 프로브가 codex 복구를 오판(F3) |
| reviewKinds 기본 | new·recovery | **new·closeout** | recovery 는 review 단계가 없다(F27/F40) |
| 병렬 위험 | migrations 신규·공유 설정 | **package.json/lock 만**(한쪽만 만져도 순차) | migrations 는 오탐 · node_modules junction 공유가 진짜 위험(F35) |
| 통합 게이트 RED | push 보류 | **landing 되돌림**(`git reset --hard <landingBase>`) + `archive/integration-fail-*` 태그 + STOP | RED 트리 승계 방지(F11/F29) |
| Codex 동시 상한 | 러너 풀만 | 러너 풀 + **머신 전역 슬롯 잠금**(`~/.claude-auto/locks/codex-slot-*.lock` · pid 생존·심박 3h) | 엔진 내부 단계 타이밍은 풀이 못 본다(F17/F28) |
| 리뷰 신뢰 | JSON 유효성만 | + 「명령 0건 + clean」 무효(exit 4) · 빈 diff 는 claude 리뷰 전환 · 이전 라운드 열린 findings 잔존 시 done 금지 | 거짓 clean/done 차단(F10/F18/F30) |
| 프라이버시 | cwd 가드 | + 실행 중 `.env*` 격리·복원 · 리뷰 diff 에서 env/키/시크릿 파일 제외 + 시크릿 마스킹 · 로그 마스킹 | 워크트리에도 실자격증명 사본(F19) — **실제 Codex 리뷰가 픽스처의 `.env.local` 노출을 스스로 지적**해 확인 |
| 수리 중 꼼수 | 경고 | **수리 라운드가 새로 만든 흔적은 차단** · 게이트 설정 변조(`package.json` scripts·tsconfig·eslint/vite) 탐지 | qa RED 가드의 실질 완화 방지(F5/F32) |
| 워커 커밋 가드 | 없음 | HEAD·브랜치·stash 변동 시 COMMIT GUARD STOP(exit 6) | Codex 는 pipeline-settings deny 가 없다(F4/F23) |
| Decision 등재 | 스토리 파일만 | + `DECISIONS-INBOX.md` 맨 위 절(스토리 번호 포함) | 편성기 규칙 2 인박스 검사(F22) |
| STOP 부기 | 없음 | `auto-pipeline-logs/exit-info.json`(provider·kind) → 러너가 남은 병렬 스토리를 다른 레인으로 | exit 5 만으로는 레인을 모른다(F36) |
| 실패 증거 | 워크트리와 함께 소멸 | 상태 폴더 `archive/<날짜>-<ts>-evidence/<story>/` 보관 | (F39) |
| 실패 분류 입력 | stdout 전체 | Codex 는 **오류 이벤트 + stderr** 우선(둘 다 비면 stdout 꼬리 4KB) | 도구 출력 속 401/429 오판 방지(F21) |

### 실측 (2026-09-02)
- `node --test`: **201/201**(단위 193 + 종단 8 · 실 LLM 0 · 실 알림 0 · 실제 git). 기준선(이식 vitest 79종)은 변경 전 GREEN 을
  먼저 확인했다(실패 3건 = CRLF 체크아웃 · 중립화 문구 차이 → 테스트 쪽을 고쳤다).
- 실제 `codex exec` 리뷰 1회(엔진 경유 · linked worktree · 의도적 결함 `add` 뺄셈): **2분 6초 · 입력 126,706 토큰 · 명령 12건** ·
  patch 2(high 1 = 자격증명 노출 · medium 1 = 뺄셈 결함) → 스토리 Status in-progress · sprint-status 동기 · 매니페스트 기록.
  ⇒ Plus 한도에서 리뷰 1건 ≈ 100k+ 입력 토큰. 하루 몇 건인지는 첫 주 실측 대상.

### 남은 제한
- `spawnSync` 타임아웃은 cmd.exe 만 끊는다 — Codex 자식이 고아로 남을 수 있다(스테이지 타임아웃으로만 제동 · 다음 라운드 슬롯 잠금이 stale 판정).
- 프로바이더 전환 횟수·수리 예산은 프로세스 메모리(엔진 1회 실행)에만 있다 — 슬롯을 넘어가는 반복은 편성기 규칙 9(무진전 스트릭)가 잡는다.
- `AUTO_CODEX_ALLOW_CWD=1` 은 본 트리 실행을 한 줄로 허용한다 — 사람이 실데이터 부재를 보증할 때만.
- 스토리 내부 역할 병렬(구현‖테스트 작성)은 배선하지 않았다(같은 스토리 md·테스트 파일 충돌).
- Codex dev 역할(`roles: ["dev"]` + `split`)은 종단 스텁으로만 검증했다 — 실제 Codex dev 1회 실측은 첫 야간 적용 시 사람이 결과를 본다.
