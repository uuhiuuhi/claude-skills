| 구분 | 결과 | 핵심 판단 |
|---|---:|---|
| Round 1 finding 13건 | FIXED 8 · PARTIAL 5 · NOT FIXED 0 | 주요 구현은 실제 동작이지만 git 차단·무결성·clean-review는 우회 가능 |
| BRIEF 정책 16건 | IMPLEMENTED 6 · PARTIAL 10 · MISSING 0 | “형식상 배선”보다 강제력과 실패 경로가 부족 |
| 신규 correctness/safety finding | High 4 · Medium 4 · Low 1 | 순차 E2E RED 후 push, git guard 우회, 시크릿 노출, RED 매니페스트 누락이 핵심 |
| 실행 테스트 | 53/53 PASS | `quality-rules.test.mjs`, `runner-rules.test.mjs`; 약 98ms |
| 파일 변경 | 없음 | 읽기 전용 검토 |

## 1. Round 1 finding 재판정

| # | 기존 심각도 | 판정 | 실질 수정 여부와 근거 |
|---:|:---:|:---:|---|
| 1 | 높음 | **FIXED** | 추적·baseline diff 모두 민감 pathspec 제외 후 파일 섹션 제거, 최종 재마스킹한다. [auto-story-pipeline.mjs:634](C:/Projects/claude-skills/auto-story-finish/auto-story-pipeline.mjs:634), [auto-story-pipeline.mjs:643](C:/Projects/claude-skills/auto-story-finish/auto-story-pipeline.mjs:643), [auto-story-pipeline.mjs:671](C:/Projects/claude-skills/auto-story-finish/auto-story-pipeline.mjs:671). 실제 git 저장소 E2E도 있다. 다만 마스커 자체의 누락은 신규 finding N3이다. |
| 2 | 높음 | **FIXED** | 고정 `codex-slot-N.lock`을 `openSync(..., 'wx')`로 직접 원자 선점한다. [codex.mjs:314](C:/Projects/claude-skills/auto-story-finish/providers/codex.mjs:314), [codex.mjs:339](C:/Projects/claude-skills/auto-story-finish/providers/codex.mjs:339). `providers-hardening`은 실제 자식 프로세스 4개를 경쟁시킨다. stale 회수 경계는 N9. |
| 3 | 높음 | **PARTIAL** | 일반 `git push/commit/reset`은 PATH shim으로 실행 단계 차단되고 실제 git E2E도 있다. [git-guard.mjs:27](C:/Projects/claude-skills/auto-story-finish/providers/git-guard.mjs:27), [auto-story-pipeline.mjs:838](C:/Projects/claude-skills/auto-story-finish/auto-story-pipeline.mjs:838). 그러나 guard 생성 실패 시 사후 비교만으로 계속하며, 절대경로 git 및 환경변수 재정의 우회를 코드가 명시적으로 인정한다. [git-guard.mjs:14](C:/Projects/claude-skills/auto-story-finish/providers/git-guard.mjs:14), [auto-story-pipeline.mjs:841](C:/Projects/claude-skills/auto-story-finish/auto-story-pipeline.mjs:841). |
| 4 | 높음 | **FIXED** | `--commit`은 현재 위치가 detached HEAD 또는 `auto/*`가 아니면 시작·커밋 시점 모두 exit 6이다. [auto-story-pipeline.mjs:510](C:/Projects/claude-skills/auto-story-finish/auto-story-pipeline.mjs:510), [auto-story-pipeline.mjs:531](C:/Projects/claude-skills/auto-story-finish/auto-story-pipeline.mjs:531), [auto-story-pipeline.mjs:558](C:/Projects/claude-skills/auto-story-finish/auto-story-pipeline.mjs:558). 실제 git E2E 포함. |
| 5 | 높음 | **FIXED** | 기존 `pushOnFail`은 무시되고 RED 판정은 항상 rollback이며, `skipPush`를 reset 전에 세운다. [runner-rules.mjs:401](C:/Projects/claude-skills/night-batch-ops/engine/runner-rules.mjs:401), [runner-rules.mjs:484](C:/Projects/claude-skills/night-batch-ops/engine/runner-rules.mjs:484), [run-night.mjs:1020](C:/Projects/claude-skills/night-batch-ops/engine/run-night.mjs:1020). 실제 원격 저장소 E2E도 있다. 단 순차 E2E 경로는 N1. |
| 6 | 높음 | **PARTIAL** | 정상 Claude/Codex worker 실행은 실행파일과 argv가 분리되고 `.cmd` 전용 경로 및 메타문자 검증이 있다. [spawn-safe.mjs:65](C:/Projects/claude-skills/auto-story-finish/providers/spawn-safe.mjs:65), [claude.mjs:16](C:/Projects/claude-skills/auto-story-finish/providers/claude.mjs:16). 하지만 인증 probe는 여전히 `${claudeBin} ...` 문자열과 `shell:true`를 사용한다. [auto-story-pipeline.mjs:390](C:/Projects/claude-skills/auto-story-finish/auto-story-pipeline.mjs:390), [auto-story-pipeline.mjs:398](C:/Projects/claude-skills/auto-story-finish/auto-story-pipeline.mjs:398). `CLAUDE_BIN` 주입 경로가 남았다. |
| 7 | 중간 | **FIXED** | 남은 단계가 실제로 Claude로 resolve되는지 계산하고 전부 Codex이면 Claude probe를 생략한다. [auto-story-pipeline.mjs:1225](C:/Projects/claude-skills/auto-story-finish/auto-story-pipeline.mjs:1225), [auto-story-pipeline.mjs:1269](C:/Projects/claude-skills/auto-story-finish/auto-story-pipeline.mjs:1269). Claude 401/Codex 정상 실제 엔진 E2E가 있다. |
| 8 | 중간 | **PARTIAL** | 미추적 파일을 unified diff로 만들어 검사하는 구현과 실제 엔진 테스트는 진짜다. [auto-story-pipeline.mjs:1090](C:/Projects/claude-skills/auto-story-finish/auto-story-pipeline.mjs:1090). 하지만 검사는 `--integrity on` 또는 `autoRepair>0`일 때만 켜진다. [auto-story-pipeline.mjs:155](C:/Projects/claude-skills/auto-story-finish/auto-story-pipeline.mjs:155), [auto-story-pipeline.mjs:1137](C:/Projects/claude-skills/auto-story-finish/auto-story-pipeline.mjs:1137). 기본 직접 실행에서는 신규 `.only`가 검사되지 않는다. |
| 9 | 중간 | **FIXED** | 실패 워크트리 제거 전에 `code.diff`, untracked 사본, summary, 복구 절차를 상태 폴더에 보존한다. [run-night.mjs:238](C:/Projects/claude-skills/night-batch-ops/engine/run-night.mjs:238), [run-night.mjs:250](C:/Projects/claude-skills/night-batch-ops/engine/run-night.mjs:250), [run-night.mjs:257](C:/Projects/claude-skills/night-batch-ops/engine/run-night.mjs:257). 실제 `git apply` 복구 E2E가 있다. 일부 실패 형태 누락은 정책 12/N3에서 별도 지적. |
| 10 | 중간 | **FIXED** | security/performance trigger에 대응 script가 있으면 실제 spawn하고 실패를 품질 RED로 전파한다. [auto-story-pipeline.mjs:1105](C:/Projects/claude-skills/auto-story-finish/auto-story-pipeline.mjs:1105), [auto-story-pipeline.mjs:1150](C:/Projects/claude-skills/auto-story-finish/auto-story-pipeline.mjs:1150). 실제 엔진/스크립트 E2E 포함. |
| 11 | 중간 | **FIXED** | 발견된 `.env*`의 격리 실패는 실행 전 throw, 복원 실패·충돌은 exit 6이다. [codex.mjs:260](C:/Projects/claude-skills/auto-story-finish/providers/codex.mjs:260), [codex.mjs:288](C:/Projects/claude-skills/auto-story-finish/providers/codex.mjs:288), [auto-story-pipeline.mjs:845](C:/Projects/claude-skills/auto-story-finish/auto-story-pipeline.mjs:845). 실제 rename 실패/충돌 테스트가 있다. 탐색 누락은 N5. |
| 12 | 낮음 | **PARTIAL** | clean review가 story와 diff/변경 파일 열람 증거를 요구하도록 강화됐다. [codex.mjs:423](C:/Projects/claude-skills/auto-story-finish/providers/codex.mjs:423). 그러나 story 파일 자체가 `changedFiles`에 포함되면 한 번 읽은 행위가 두 조건을 동시에 만족한다. [codex.mjs:433](C:/Projects/claude-skills/auto-story-finish/providers/codex.mjs:433), [auto-story-pipeline.mjs:787](C:/Projects/claude-skills/auto-story-finish/auto-story-pipeline.mjs:787). |
| 13 | 낮음 | **FIXED** | 인박스 부재 시 안전한 골격을 만들고, 생성/등재 실패를 리뷰 적용 실패로 반환한다. [auto-story-pipeline.mjs:681](C:/Projects/claude-skills/auto-story-finish/auto-story-pipeline.mjs:681), [auto-story-pipeline.mjs:735](C:/Projects/claude-skills/auto-story-finish/auto-story-pipeline.mjs:735). 실제 파일 생성/실패 E2E가 있다. 단 쓰기 순서의 비원자성은 N8. |

## 2. BRIEF 필수 정책 16건

| # | 판정 | 근거·부족점 |
|---:|:---:|---|
| 1 | **PARTIAL** | 추적·미추적·baseline diff 민감 섹션 제거 및 최종 재마스킹은 구현됐다. [auto-story-pipeline.mjs:643](C:/Projects/claude-skills/auto-story-finish/auto-story-pipeline.mjs:643). 하지만 공통 마스커가 JSON key/value, Bearer 토큰, 공백 포함 인용값을 놓친다(N3). |
| 2 | **PARTIAL** | QA/worker/conditional gate 로그는 마스킹한다. [auto-story-pipeline.mjs:874](C:/Projects/claude-skills/auto-story-finish/auto-story-pipeline.mjs:874), [auto-story-pipeline.mjs:1062](C:/Projects/claude-skills/auto-story-finish/auto-story-pipeline.mjs:1062). 배치 E2E와 integration 로그는 원문이다. |
| 3 | **PARTIAL** | 발견된 파일의 rename/restore는 fail-closed. 하지만 탐색 `readdir` 오류를 무시하고 깊이 4까지만 본다. [codex.mjs:242](C:/Projects/claude-skills/auto-story-finish/providers/codex.mjs:242). |
| 4 | **IMPLEMENTED** | 고정 슬롯 파일을 `wx`로 직접 원자 선점. [codex.mjs:338](C:/Projects/claude-skills/auto-story-finish/providers/codex.mjs:338). |
| 5 | **PARTIAL** | PATH shim은 구현됐지만 생성 실패가 fail-open이고, 절대경로 git 우회가 남는다. |
| 6 | **IMPLEMENTED** | detached 또는 `auto/*`에서만 무인 commit 가능. 시작과 commit 시점 양쪽 확인. |
| 7 | **PARTIAL** | 병렬 integration gate RED는 무조건 rollback/STOP/push 금지. 하지만 순차 실행의 배치 E2E는 story push 뒤 실행된다(N1). |
| 8 | **PARTIAL** | worker 및 provider 탐지는 argv 분리. 인증 probe와 설치기 Codex 검사에는 `shell:true` 문자열 실행이 남았다. [auto-story-pipeline.mjs:398](C:/Projects/claude-skills/auto-story-finish/auto-story-pipeline.mjs:398), [install.mjs:57](C:/Projects/claude-skills/night-batch-ops/install.mjs:57). |
| 9 | **IMPLEMENTED** | 실제 실행 provider만 검사. Codex-only 실제 E2E 포함. |
| 10 | **PARTIAL** | 미추적 테스트 내용 검사 자체는 구현됐으나 기본 직접 실행에서는 integrity가 꺼진다. |
| 11 | **IMPLEMENTED** | `rule|file|정규화 내용 지문` 비교. [quality-rules.mjs:102](C:/Projects/claude-skills/auto-story-finish/quality-rules.mjs:102), [quality-rules.mjs:105](C:/Projects/claude-skills/auto-story-finish/quality-rules.mjs:105). |
| 12 | **PARTIAL** | 코드 diff/untracked/복구 절차는 보존한다. 다만 로그 디렉터리는 재마스킹 없이 복사하고, diff 기준이 `HEAD`라 우회 commit된 변경은 `code.diff`에 빠진다. [run-night.mjs:247](C:/Projects/claude-skills/night-batch-ops/engine/run-night.mjs:247), [run-night.mjs:251](C:/Projects/claude-skills/night-batch-ops/engine/run-night.mjs:251). |
| 13 | **IMPLEMENTED** | 조건부 script 실제 실행, 실패 RED 전파. |
| 14 | **PARTIAL** | 명령 수 대신 열람 증거를 보지만 story 파일이 target으로 중복 인정되는 우회가 있다. |
| 15 | **IMPLEMENTED** | 인박스 생성 및 생성/등재 불가 시 실패 처리. |
| 16 | **PARTIAL** | GREEN은 story 및 batch manifest에 반영한다. RED/rollback은 batch manifest에만 남기고 story manifest는 명시적으로 갱신하지 않는다. [run-night.mjs:1038](C:/Projects/claude-skills/night-batch-ops/engine/run-night.mjs:1038). |

## 3. 신규 correctness/safety findings

### N1. High — 순차 경로는 배치 E2E RED 전에 이미 push한다

- 근거: story마다 `commitStory()`에서 즉시 push한다. [auto-story-pipeline.mjs:595](C:/Projects/claude-skills/auto-story-finish/auto-story-pipeline.mjs:595), [auto-story-pipeline.mjs:1337](C:/Projects/claude-skills/auto-story-finish/auto-story-pipeline.mjs:1337)
- 배치 E2E는 모든 story 처리 뒤 실행한다. [auto-story-pipeline.mjs:1342](C:/Projects/claude-skills/auto-story-finish/auto-story-pipeline.mjs:1342)
- 러너 순차 경로가 `--push`를 그대로 전달한다. [run-night.mjs:1221](C:/Projects/claude-skills/night-batch-ops/engine/run-night.mjs:1221)
- 실패 시나리오: 두 story가 개별 QA GREEN으로 `auto/*`에 push된 뒤 결합 E2E가 RED. 프로세스는 exit 1이지만 원격에는 이미 RED 조합이 존재한다.
- 최소 수정: `--e2e` 또는 integration gate가 있으면 story별 push를 금지하고, 전부 GREEN 후 러너가 한 번만 push. RED면 landing base로 rollback 후 push 0을 검증한다.

### N2. High — 워커 git 차단이 fail-open이고 절대경로 우회로 main push 가능

- guard 생성 실패 시 경고만 남기고 worker를 실행한다. [auto-story-pipeline.mjs:840](C:/Projects/claude-skills/auto-story-finish/auto-story-pipeline.mjs:840)
- 구현도 절대경로 `git.exe`, Git Bash wrapper, 직접 spawn 우회를 명시한다. [git-guard.mjs:14](C:/Projects/claude-skills/auto-story-finish/providers/git-guard.mjs:14)
- `GIT_ALLOW_PROTOCOL=none`은 worker가 명령 앞에서 환경변수를 다시 지정할 수 있으므로 강제 경계가 아니다.
- 실패 시나리오: worker가 절대경로 git을 사용하고 `GIT_ALLOW_PROTOCOL=https`를 덮어쓴 뒤 `push origin HEAD:main`; 로컬 HEAD/branch/stash는 불변이어서 사후 검사도 통과한다.
- 최소 수정: guard 생성 실패는 즉시 exit 6. worker OS 프로세스를 네트워크와 git 실행이 불가능한 강제 sandbox/job/container에서 실행하고, 원격 ref 검사도 인증정보 없이 별도 제어 프로세스가 담당하게 한다.

### N3. High — 공통 마스커가 일반적인 자격증명 형식을 놓치며 일부 로그는 마스킹 자체가 없다

- 마스커 정규식은 key 바로 뒤의 따옴표와 공백 포함 인용값을 처리하지 못한다. [codex.mjs:158](C:/Projects/claude-skills/auto-story-finish/providers/codex.mjs:158)
- 실제 호출 결과:

  - `{"api_key":"JSONSECRET123456"}` → 원문 유지
  - `Authorization: Bearer TOKENVALUE123456` → `Bearer`만 가리고 토큰 원문 유지
  - `PRIVATE_KEY="alpha beta gamma secret"` → 원문 유지

- 배치 E2E 로그는 stdout/stderr 원문 기록. [auto-story-pipeline.mjs:1348](C:/Projects/claude-skills/auto-story-finish/auto-story-pipeline.mjs:1348)
- integration 로그도 원문 기록. [run-night.mjs:1002](C:/Projects/claude-skills/night-batch-ops/engine/run-night.mjs:1002)
- 실패 증거는 로그 폴더를 재마스킹 없이 복사한다. [run-night.mjs:245](C:/Projects/claude-skills/night-batch-ops/engine/run-night.mjs:245)
- 최소 수정: JSON/string-literal/Bearer/cookie/header 패턴을 포함한 구조 인식 마스커를 하나로 통합하고, 파일 기록·알림·archive 직전에 반드시 그 함수를 거치게 한다. 위 세 문자열을 회귀 테스트로 추가한다.

### N4. High — diff에서 제외한 secret 파일을 Codex가 작업 디렉터리에서 직접 읽을 수 있다

- Codex는 전체 작업 루트를 `-C`로 받고 review도 read-only일 뿐 읽기는 가능하다. [codex.mjs:117](C:/Projects/claude-skills/auto-story-finish/providers/codex.mjs:117)
- 실행 전에 숨기는 것은 `.env*`뿐이다. [auto-story-pipeline.mjs:845](C:/Projects/claude-skills/auto-story-finish/auto-story-pipeline.mjs:845)
- PEM, `auth.json`, service account JSON, secret YAML 등은 diff 목록에서는 제외되지만 filesystem에는 남는다.
- 실패 시나리오: prompt injection 또는 worker 오판으로 `cat auth.json`, `type secrets.yml`; 내용이 Codex 모델 입력으로 전송된다.
- 최소 수정: Codex용 sanitized 임시 worktree/view를 만들거나, 모든 `isSensitivePath` 파일을 실행 동안 격리한다. 프롬프트 금지 문구를 보안 경계로 간주하지 않는다.

### N5. Medium — `.env` 탐색 실패와 깊이 초과가 fail-open

- 탐색 깊이가 4로 고정되고, `readdirSync` 실패는 빈 디렉터리처럼 처리한다. [codex.mjs:234](C:/Projects/claude-skills/auto-story-finish/providers/codex.mjs:234), [codex.mjs:242](C:/Projects/claude-skills/auto-story-finish/providers/codex.mjs:242)
- 실패 시나리오: `packages/a/services/api/config/.env.production` 또는 접근 오류가 난 하위 디렉터리의 `.env`가 남은 채 Codex 실행.
- 최소 수정: git/파일시스템 기반 전체 탐색을 사용하고, 제외 디렉터리가 아닌 곳에서 열람 실패가 하나라도 발생하면 `ENV_ISOLATION_FAILED`로 중단한다.

### N6. Medium — integration rollback을 각 story manifest에 남기지 않는다

- RED 후 story manifest 갱신을 의도적으로 생략한다. [run-night.mjs:1038](C:/Projects/claude-skills/night-batch-ops/engine/run-night.mjs:1038)
- 테스트도 이 정책 위반을 정답으로 고정한다. [e2e-parallel.test.mjs:292](C:/Projects/claude-skills/night-batch-ops/engine/e2e-parallel.test.mjs:292)
- 실패 시나리오: batch manifest를 보지 않는 story 단위 도구는 `unknown` 또는 매니페스트 부재로 보고 rollback 사실을 알 수 없다.
- 최소 수정: rollback 전에 각 manifest를 상태 폴더 증거 영역에 복사·갱신하거나, reset 후 untracked sidecar manifest를 생성해 `rollback`을 남긴다. 이전 라운드 파일을 덮지 않도록 batch ID를 포함한다.

### N7. Medium — story 파일 한 번 읽기로 clean-review의 두 열람 조건을 만족할 수 있다

- `targets`에 `changedFiles` 전부가 들어가며 story 파일 제외가 없다. [codex.mjs:433](C:/Projects/claude-skills/auto-story-finish/providers/codex.mjs:433)
- dev가 story 문서를 수정하므로 `prepareReviewDiff().files`에 그 story 파일이 흔히 들어간다. [auto-story-pipeline.mjs:649](C:/Projects/claude-skills/auto-story-finish/auto-story-pipeline.mjs:649), [auto-story-pipeline.mjs:787](C:/Projects/claude-skills/auto-story-finish/auto-story-pipeline.mjs:787)
- 실패 시나리오: Codex가 story만 읽고 diff·구현 파일을 전혀 읽지 않은 채 clean; `readStory=true`, `readTarget=true`.
- 최소 수정: target 목록에서 story 파일을 제거하고 diff 파일 열람을 필수화하거나, story와 별개의 구현 파일 열람을 요구한다.

### N8. Medium — Decision inbox 실패 전에 story/sprint를 이미 수정한다

- story 및 sprint-status를 먼저 기록한다. [auto-story-pipeline.mjs:720](C:/Projects/claude-skills/auto-story-finish/auto-story-pipeline.mjs:720)
- inbox 생성/등재는 그 뒤에 수행하고 실패를 반환한다. [auto-story-pipeline.mjs:735](C:/Projects/claude-skills/auto-story-finish/auto-story-pipeline.mjs:735)
- 실패 시나리오: 인박스가 디렉터리이거나 쓰기 불가. 엔진은 exit 4지만 story에는 열린 Decision과 변경 상태가 남아 부분 적용된다.
- 최소 수정: 모든 결과를 메모리에서 만든 뒤 임시 파일에 기록하고 rename하는 트랜잭션형 적용, 또는 inbox를 먼저 확정한 뒤 story/sprint를 기록한다.

### N9. Low — Codex slot은 heartbeat를 갱신하지 않는다

- lock에는 획득 시각만 쓰고 실행 중 heartbeat 갱신이 없다. [codex.mjs:358](C:/Projects/claude-skills/auto-story-finish/providers/codex.mjs:358)
- PID 생존 판정이 불명확한 환경에서는 고정 3시간 뒤 stale로 회수될 수 있다. [codex.mjs:307](C:/Projects/claude-skills/auto-story-finish/providers/codex.mjs:307), [codex.mjs:323](C:/Projects/claude-skills/auto-story-finish/providers/codex.mjs:323)
- 실패 시나리오: 3시간 이상 허용된 stage + `process.kill(pid,0)`이 EPERM/unknown인 Windows 환경에서 살아 있는 슬롯을 회수해 Codex가 중복 실행.
- 최소 수정: 실행 중 주기적으로 `hb`를 원자 갱신하고, stale 기준을 stage timeout보다 크게 계산한다.

## 4. 테스트 품질

대부분의 중요한 신규 테스트는 실제 동작을 확인한다.

- 실제 process + 실제 git: `engine-e2e.test.mjs`, `e2e-parallel.test.mjs`, `bench.test.mjs`
- 실제 다중 process/rename/git: `providers-hardening.test.mjs`
- 순수 규칙의 입력→출력 검증: `quality-rules`, `providers`, `runner-rules`, `plan-queue`, `plan-dag`, `orchestrate`, `assign`, `conflicts`, `metrics`
- `metrics.test.mjs`의 JSONL append는 실제 자식 프로세스도 사용한다.

중요 안전장치를 문자열로만 지키는 anchor-only 테스트는 다음이다.

| 테스트 | anchor-only 범위 | 문제 |
|---|---|---|
| [engine-guards.test.mjs:12](C:/Projects/claude-skills/auto-story-finish/engine-guards.test.mjs:12) | 사실상 파일 전체 | 특정 호출 문자열 존재만 확인한다. fail-open, 호출 순서, 우회 실행은 검증하지 않는다. |
| [worker-pool.test.mjs:253](C:/Projects/claude-skills/night-batch-ops/engine/worker-pool.test.mjs:253) | 통합 rollback, manifest, evidence, safe exec 배선 | `skipPush = true`, `applyIntegrationToManifest` 등이 존재하기만 하면 통과한다. N1/N6을 놓친다. |
| [runner-rules.test.mjs:260](C:/Projects/claude-skills/night-batch-ops/engine/runner-rules.test.mjs:260) | `core.quotePath=false` 배선 | 실제 한글 파일명을 이용한 git 행동이 아니다. |
| [runner-rules.test.mjs:324](C:/Projects/claude-skills/night-batch-ops/engine/runner-rules.test.mjs:324) | 지출 차단기 호출 배선 | 함수 호출 문자열과 조건 앵커만 확인한다. |

특히 [e2e-parallel.test.mjs:292](C:/Projects/claude-skills/night-batch-ops/engine/e2e-parallel.test.mjs:292)는 real-behavior 테스트이지만, BRIEF 정책 16과 반대로 “rollback이면 story manifest가 없어야 한다”를 명시적으로 고정하고 있다.

추가로 필요한 real-behavior 테스트:

- 순차 `--push + --e2e`에서 E2E RED 시 원격 `auto/*` ref 불변
- guard 생성 실패 시 worker 0회·exit 6
- 절대경로 git + `GIT_ALLOW_PROTOCOL` 재정의 push 차단
- JSON/Bearer/공백 포함 secret의 QA·integration·E2E·archive 로그 마스킹
- 깊이 5 `.env` 및 탐색 권한 오류 시 Codex 0회
- rollback 시 story manifest 각각 `rollback`
- story만 읽은 clean review 거부
- inbox 쓰기 실패 시 story/sprint 원상태 유지

Optional(코스메틱) 지적은 없습니다.