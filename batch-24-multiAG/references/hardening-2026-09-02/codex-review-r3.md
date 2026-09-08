| 구분 | 결과 | 핵심 |
|---|---:|---|
| Round-2 N1~N9 | FIXED 8 · PARTIAL 1 | N2의 절대경로 `git` 우회는 원격 변경 후에야 탐지 |
| BRIEF 정책 16개 | FIXED 13 · PARTIAL 3 | 정책 5·8·14 미완 |
| 신규 correctness/safety | High 3 · Medium 6 · Low 1 | 시크릿 유출, 거짓 GREEN, writer 경로 이탈 |
| 대시보드 포팅본 | 읽기 가능 | 공용 4파일은 SOURCE 주석 외 동일, `scan/build`은 jng-os 전용 구현 |
| 실행 테스트 | 151개 중 140 PASS · 11 NOT VERIFIED | 11건은 sandbox가 `%TEMP%` 생성을 EPERM으로 거부; assertion 실패 아님 |
| 파일 변경 | 없음 | 읽기 전용 리뷰 |

## 신규·잔존 이슈

### H1. High — 신규 진단의 시크릿 마스커가 R2에서 고친 대표 형식을 다시 놓치며 스냅숏은 원문 객체를 보존한다

- 위치: [diagnose.mjs](C:/Projects/claude-skills/night-batch-ops/engine/diagnose.mjs:78), [diagnose.mjs](C:/Projects/claude-skills/night-batch-ops/engine/diagnose.mjs:326), [report.mjs](C:/Projects/claude-skills/night-batch-ops/engine/report.mjs:390)
- 실제 결과:

  ```text
  {"api_key":"JSONSECRET123456"}
  Authorization: Bearer TOKENVALUE123456
  PRIVATE_KEY="alpha beta gamma secret"
  ```

  세 문자열 모두 `maskSecrets()`를 원문 그대로 통과했다.

- 또한 `readProject()`는 `scripts`, 검증 `manifests`, `engineState`를 깊은 마스킹 없이 스냅숏에 넣는다([diagnose.mjs](C:/Projects/claude-skills/night-batch-ops/engine/diagnose.mjs:332), [diagnose.mjs](C:/Projects/claude-skills/night-batch-ops/engine/diagnose.mjs:342)). package script, 상태 JSON, 과거 매니페스트 안의 토큰이 `snapshot.json`에 남을 수 있다.
- 보고서의 마지막 방어도 같은 불완전한 마스커를 사용하므로 JSON/Markdown 보고서까지 유출된다.
- 최소 수정: `providers/codex.mjs:redactSecrets`를 단일 공용 마스커로 분리해 진단·보고서도 사용하고, `readProject()` 반환 직전 전체 객체를 deep-redact. 위 세 R2 회귀 문자열과 `scripts/manifests/engineState` 주입 테스트를 추가한다.

### H2. High — 대시보드가 품질 계측·검증 증거 없이 GREEN을 반환하며 “진단 없음 AMBER 상한”도 우회된다

- 위치: [verdict.mjs](C:/Projects/claude-skills/dev-status/verdict.mjs:100), [verdict.mjs](C:/Projects/claude-skills/dev-status/verdict.mjs:109), [verdict.mjs](C:/Projects/claude-skills/dev-status/verdict.mjs:126)
- 실패 시나리오 1: `lastNight`의 integration만 pass이고 `metrics=[]`, `verifications=[]`, 빈 진단 객체만 있으면 실제 반환값이 `green`이었다. 빈 배열의 `.some()`이 false라 “품질 게이트 통과”로 간주된다.
- 실패 시나리오 2: diagnosis는 없고 backlog만 있으면 `!diagnosis && !readiness && !backlog`가 false가 되어 AMBER cap을 건너뛴다. 품질 metric 하나를 붙이면 역시 GREEN이 가능하다.
- 따라서 반환 이유의 “품질 게이트 통과 · 검사 실패 0”은 증거 부재를 통과로 바꾼 허위 문장이다.
- 포팅본도 공용 파일과 같은 로직이다: [ported verdict.mjs](C:/Projects/jng-os/tools/dev-status/verdict.mjs:101).
- 최소 수정: GREEN에 `metrics.length >= 1`, 모든 관련 metric의 `qualityGate.passed===true`, 필요한 verification 존재 및 실패 0, `diagnosis` 존재, `readiness.verdict==='ready'`를 적극 조건으로 요구한다. 진단 cap은 `if (!diagnosis)`로 독립 적용한다.

### H3. High — N2의 절대경로 git 우회는 여전히 실제 원격을 변경한 뒤에야 잡힌다

- 위치: [git-guard.mjs](C:/Projects/claude-skills/auto-story-finish/providers/git-guard.mjs:19), [auto-story-pipeline.mjs](C:/Projects/claude-skills/auto-story-finish/auto-story-pipeline.mjs:976)
- 구현 스스로 절대경로 `git.exe`가 shim을 우회한다고 명시한다. 사후 remote/ref 비교는 배치를 exit 6으로 만들 뿐 이미 수행된 push를 되돌리지 못한다.
- 실제 테스트도 우회 push가 성공한 것을 전제로 사후 탐지만 검증한다: [engine-e2e.test.mjs](C:/Projects/claude-skills/auto-story-finish/engine-e2e.test.mjs:625).
- 로컬 bare remote에는 `GIT_ALLOW_PROTOCOL=none`이 효과가 있지만, worker가 환경을 덮어쓰거나 허용 프로토콜을 재지정하는 경계는 아니다.
- 최소 수정: worker를 네트워크 및 임의 git 실행이 차단된 OS sandbox/job/container에서 실행한다. 최소한 원격 자격증명을 worker 환경에서 완전히 제거하고, 별도 제어 프로세스만 push 권한을 가져야 한다.

### M1. Medium — 교차 리뷰 제공자가 누락돼도 T6가 PASS가 된다

- 위치: [completion-rules.mjs](C:/Projects/claude-skills/auto-story-finish/completion-rules.mjs:87), [readiness.mjs](C:/Projects/claude-skills/night-batch-ops/engine/readiness.mjs:221)
- `devP && revP && devP === revP`만 실패시킨다. `review.provider` 또는 `workers.dev.provider`가 없고 열람 증거가 1개면 “다른 쪽”임을 확인할 수 없는데도 PASS다.
- 구형·부분 손상 매니페스트가 프로젝트를 `ready`로 올릴 수 있다.
- 최소 수정: 두 provider 중 하나라도 없으면 `not-verified`; 둘 다 있고 서로 다를 때만 PASS. 누락 provider 회귀 테스트를 completion/readiness 양쪽에 추가한다.

### M2. Medium — T2는 정상·실패·경계 테스트가 아니라 아무 테스트 한 건만 추가해도 PASS다

- 위치: [completion-rules.mjs](C:/Projects/claude-skills/auto-story-finish/completion-rules.mjs:157), [completion-rules.mjs](C:/Projects/claude-skills/auto-story-finish/completion-rules.mjs:223)
- 기준 문구는 정상·실패·경계를 요구하지만 판정은 `tests.cases > 0`뿐이다.
- 단일 happy-path 테스트 한 건으로 완료 판정이 `ready`가 될 수 있다. 현재 기준선 테스트도 이 동작을 정답으로 고정한다.
- 최소 수정: 매니페스트에 요구 테스트 유형과 실행 증거를 구조화해 기록하고 required 유형을 모두 충족해야 PASS. 유형을 판별할 증거가 없으면 `not-verified`.

### M3. Medium — append-only writer가 심볼릭 링크·junction을 따라 `_bmad-output/` 밖에 쓸 수 있다

- 위치: [bmad-sync.mjs](C:/Projects/claude-skills/night-batch-ops/engine/bmad-sync.mjs:74), [bmad-sync.mjs](C:/Projects/claude-skills/night-batch-ops/engine/bmad-sync.mjs:709), [bmad-sync.mjs](C:/Projects/claude-skills/night-batch-ops/engine/bmad-sync.mjs:762)
- `pathAllowed()`는 문자열 접두사만 검사하고 `join(root, rel)` 뒤 실제 경로를 검증하지 않는다.
- `_bmad-output/implementation-artifacts`가 외부 폴더 junction이면 `applyBmadWrites()`가 허용 범위 밖 파일을 생성·교체한다.
- 최소 수정: root와 기존 부모 경로를 `realpath`로 해석해 실제 대상이 `realpath(root/_bmad-output)` 내부인지 확인하고 reparse point/symlink를 거부한다. create 경로는 가장 가까운 기존 부모를 검증한다.

### M4. Medium — 대시보드 `scan()`은 손상·경합 입력에서 throw/프로세스 종료할 수 있다

- 위치: 정본 [scan.mjs](C:/Projects/claude-skills/dev-status/scan.mjs:20), [build.mjs](C:/Projects/claude-skills/dev-status/build.mjs:353); 포팅본 [scan.mjs](C:/Projects/jng-os/tools/dev-status/scan.mjs:38), [ported scan.mjs](C:/Projects/jng-os/tools/dev-status/scan.mjs:427), [ported build.mjs](C:/Projects/jng-os/tools/dev-status/build.mjs:606)
- `existsSync()` 뒤 `readFileSync()`가 catch 없이 실행된다. 파일이 그 사이 삭제되거나 잠기거나 권한 오류가 나면 전체 빌드가 중단된다.
- 정본은 BMad 원천 부재 시 import 단계에서 `process.exit(2)`도 수행한다([scan.mjs](C:/Projects/claude-skills/dev-status/scan.mjs:32)). 블록별 `safe()`는 이미 `scan()` 이후라 보호하지 못한다.
- 최소 수정: 모든 읽기를 `{value,error}` 또는 안전한 빈 블록으로 반환하고 `scan()` 자체를 최상위 try/catch로 감싼다. 라이브러리 import 경로에서는 `process.exit`하지 말고 구조화 오류를 반환한다.

### M5. Medium — BRIEF 정책 8의 셸 문자열 제거가 아직 완료되지 않았다

- 위치: [auto-story-pipeline.mjs](C:/Projects/claude-skills/auto-story-finish/auto-story-pipeline.mjs:224), [auto-story-pipeline.mjs](C:/Projects/claude-skills/auto-story-finish/auto-story-pipeline.mjs:1150), [auto-story-pipeline.mjs](C:/Projects/claude-skills/auto-story-finish/auto-story-pipeline.mjs:1170), [auto-story-pipeline.mjs](C:/Projects/claude-skills/auto-story-finish/auto-story-pipeline.mjs:1453), [run-night.mjs](C:/Projects/claude-skills/night-batch-ops/engine/run-night.mjs:837)
- provider probe와 worker 실행은 argv 분리됐지만 알림, QA, 조건부 gate, E2E, runner integration은 여전히 `shell:true` 문자열이다.
- 저장소·CLI 설정값이 셸 구문으로 재해석될 수 있고, 정책의 “셸 문자열 결합 제거”를 충족하지 않는다.
- 최소 수정: npm scripts는 `npm(.cmd) run <name>` 전용 argv 경로로 실행하고, 자유 형식 E2E/QA 명령은 승인된 executable+argv 구조로 정규화한다. curl 알림은 이미 runner가 쓰는 `fetch` 방식으로 통일한다.

### M6. Medium — clean review가 변경 구현 파일을 하나도 읽지 않아도 통과한다

- 위치: [codex.mjs](C:/Projects/claude-skills/auto-story-finish/providers/codex.mjs:539), [codex.mjs](C:/Projects/claude-skills/auto-story-finish/providers/codex.mjs:545)
- N7의 “스토리 한 번 읽기로 두 조건 충족”은 고쳤지만, 현재 필수 조건은 story+diff뿐이다. 구현 파일 미열람은 warning만 남기고 `ok:true`다.
- BRIEF 정책 14는 story·review diff·변경 파일의 실제 열람 증거를 모두 요구한다.
- 최소 수정: 구현 파일 목록이 비어 있지 않으면 최소 한 구현 파일 열람을 필수화하고, 없으면 clean을 거부한다.

### L1. Low — 선언된 증거 순위와 스토리 강등 실행 순서가 다르다

- 위치: [diagnose.mjs](C:/Projects/claude-skills/night-batch-ops/engine/diagnose.mjs:126), [diagnose.mjs](C:/Projects/claude-skills/night-batch-ops/engine/diagnose.mjs:628)
- 상수는 `gate > test > code > story > plan`이지만 D2(code)가 D3(test)보다 먼저 실행된다.
- File List 파일 부재와 테스트 부재가 동시에 있으면 더 높은 test 증거가 아니라 code 증거로 조기 반환한다.
- 최소 수정: 모든 적용 가능한 강등 증거를 수집한 뒤 rank 최소값으로 판정하거나 D3를 D2보다 앞에 둔다.

## Round-2 N1~N9 재검증

| 항목 | 판정 | 현재 근거 | 테스트 성격 |
|---|---|---|---|
| N1 순차 E2E 전 push | **FIXED** | 러너가 `--defer-push`를 붙이고 gate 후 단일 push: [run-night.mjs](C:/Projects/claude-skills/night-batch-ops/engine/run-night.mjs:1369) | 실제 git/bare remote E2E: [e2e-parallel.test.mjs](C:/Projects/claude-skills/night-batch-ops/engine/e2e-parallel.test.mjs:426) |
| N2 git guard fail-open·절대경로 우회 | **PARTIAL** | guard 생성 실패는 fail-closed지만 절대경로 우회 후 사후 탐지: [auto-story-pipeline.mjs](C:/Projects/claude-skills/auto-story-finish/auto-story-pipeline.mjs:919) | 실제 우회 push 성공을 확인하므로 결함도 실증됨 |
| N3 마스킹 누락 | **FIXED**(기존 엔진) | 공용 redactor 확장 및 로그/archive 적용: [codex.mjs](C:/Projects/claude-skills/auto-story-finish/providers/codex.mjs:165), [run-night.mjs](C:/Projects/claude-skills/night-batch-ops/engine/run-night.mjs:840) | 실제 프로세스 로그·archive 회귀. 단 신규 진단은 H1로 재발 |
| N4 secret 파일 직접 열람 | **FIXED** | 모든 sensitive path 실행 중 격리: [codex.mjs](C:/Projects/claude-skills/auto-story-finish/providers/codex.mjs:245) | 실제 파일 rename/복원 |
| N5 깊이·열람 실패 fail-open | **FIXED** | 전체 재귀 탐색, readdir 오류 시 중단: [codex.mjs](C:/Projects/claude-skills/auto-story-finish/providers/codex.mjs:275) | 실제 중첩 파일·주입된 실패 |
| N6 rollback story manifest 누락 | **FIXED** | 증거 사본+batchId sidecar: [run-night.mjs](C:/Projects/claude-skills/night-batch-ops/engine/run-night.mjs:893) | 실제 git rollback E2E |
| N7 story 읽기로 clean 충족 | **FIXED** | story와 diff를 별도 필수화: [codex.mjs](C:/Projects/claude-skills/auto-story-finish/providers/codex.mjs:534) | 구조화 이벤트 실동작 검증. 구현 파일 필수는 M6 |
| N8 inbox 실패 전 부분 적용 | **FIXED** | 메모리 staging 후 inbox를 먼저 rename: [auto-story-pipeline.mjs](C:/Projects/claude-skills/auto-story-finish/auto-story-pipeline.mjs:771) | 실제 디렉터리 충돌 E2E |
| N9 slot heartbeat 없음 | **FIXED** | 별도 child heartbeat 및 종료 순서: [codex.mjs](C:/Projects/claude-skills/auto-story-finish/providers/codex.mjs:446) | 실제 child process·lock mtime/JSON 갱신 |

## BRIEF 16개 정책 재검증

| # | 판정 | 비고 |
|---:|:---:|---|
| 1 | **FIXED** | 기존 Codex 입력의 tracked/untracked/baseline 민감 본문 제거·최종 재마스킹. 신규 진단 스냅숏은 별도 H1 |
| 2 | **FIXED** | QA·worker·repair·integration·archive에 공용 redactor 적용 |
| 3 | **FIXED** | 민감 파일 탐색·격리·복원 실패 모두 exit 6 |
| 4 | **FIXED** | 고정 slot `wx` 원자 획득 |
| 5 | **PARTIAL** | PATH 경로는 실행 중 차단, 절대경로 git은 사후 탐지 |
| 6 | **FIXED** | detached/`auto/*` 외 무인 commit 차단 |
| 7 | **FIXED** | RED 무조건 rollback·STOP·push 0, `pushOnFail` 폐지 |
| 8 | **PARTIAL** | provider/probe는 argv 분리, QA/E2E/gate/알림은 여전히 shell 문자열(M5) |
| 9 | **FIXED** | 실제 사용할 provider만 probe |
| 10 | **FIXED** | integrity 기본값 `on`, 미추적 신규 테스트 포함 |
| 11 | **FIXED** | 줄·정규화 내용 지문 비교 |
| 12 | **FIXED** | 민감 경로 제외+본문 마스킹한 diff/untracked 복구 자료 |
| 13 | **FIXED** | security/performance script 실제 실행 및 실패 전파 |
| 14 | **PARTIAL** | story+diff는 필수, 변경 구현 파일 미열람은 warning뿐(M6) |
| 15 | **FIXED** | inbox 부재 생성, 생성/확정 실패 시 Decision 적용 중단 |
| 16 | **FIXED** | pass/fail/rollback을 batch 및 story 증거/sidecar에 기록 |

`readProject()` 자체는 쓰기 API를 import하지 않고 git도 `rev-parse/status/log/ls-files`만 실행하므로 읽기 전용 요구는 충족합니다. `applyBmadWrites()`도 신규 모듈 중 유일한 writer이며 hash mismatch는 쓰기 전에 전체 폐기합니다. 다만 실제 경로 경계는 M3 때문에 아직 완전하지 않습니다.

대시보드의 HTML 본문 이스케이프와 `<script>` 내 JSON의 `<` 치환, 18:00 접기는 확인되었습니다. 17:59/18:00 및 새벽 03:00 경계 테스트도 통과했습니다.