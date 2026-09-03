| # | 심각도 | 위치 | 요약 |
|---:|:---:|---|---|
| 1 | 높음 | `auto-story-pipeline.mjs:537` | 추적된 `.env*`/키 파일의 diff가 Codex로 전송될 수 있음 |
| 2 | 높음 | `providers/codex.mjs:202` | 머신 전역 Codex 슬롯 획득이 원자적이지 않아 동시 실행 가능 |
| 3 | 높음 | `auto-story-pipeline.mjs:709` | 워커 커밋 가드가 `push`와 원상복구된 git 조작을 감지하지 못함 |
| 4 | 높음 | `auto-story-pipeline.mjs:125` | `--commit`만 주면 main 등 임의 현재 브랜치에 커밋 가능 |
| 5 | 높음 | `runner-rules.mjs:472` | `pushOnFail:true`가 통합 RED 결과를 그대로 push함 |
| 6 | 높음 | `providers/claude.mjs:10` | 모델/실행 파일 문자열의 셸 주입으로 임의 명령 및 외부 push 가능 |
| 7 | 중간 | `auto-story-pipeline.mjs:1008` | Codex 전용 작업도 Claude 인증 프로브 실패 때문에 시작하지 못함 |
| 8 | 중간 | `auto-story-pipeline.mjs:885` | 새로 생성된 미추적 테스트 파일은 anti-cheat 검사를 우회함 |
| 9 | 중간 | `run-night.mjs:98` | 실패 워크트리의 실제 코드 diff가 보존되지 않음 |
| 10 | 중간 | `auto-story-pipeline.mjs:907` | 존재하는 보안·성능 게이트를 실제로 실행하지 않음 |
| 11 | 중간 | `providers/codex.mjs:149` | `.env` 격리 실패를 무시하고 Codex를 계속 실행함 |
| 12 | 낮음 | `providers/codex.mjs:236` | “읽지 않은 clean” 판정이 단순 명령 개수만 확인함 |
| 13 | 낮음 | `auto-story-pipeline.mjs:600` | 결정 인박스가 없으면 Decision을 등록하지 않음 |

## 상세 Findings

### 1. 추적된 민감 파일 diff가 필터링되지 않는다

- 심각도: 높음
- 위치: [auto-story-pipeline.mjs](C:/Projects/claude-skills/auto-story-finish/auto-story-pipeline.mjs:537)
- 무엇이 깨지는가: `REVIEW_EXCLUDE_RE`는 `files` 목록과 미추적 파일에만 적용됩니다. 이미 `git diff HEAD`로 만든 `diff` 본문에서는 `.env.local`, PEM, secrets JSON 등의 파일 섹션을 제거하지 않습니다. 더구나 `baseline..HEAD` 폴백은 `redactSecrets()` 호출 이후 원문으로 `diff`를 덮어씁니다(555–556행).
- 실패 시나리오: 실수로 추적된 `.env.production`에 정규식이 모르는 OAuth secret 또는 DB URL이 추가됩니다. 파일명은 변경 목록에서 빠지지만 diff 본문과 리뷰 입력 파일에는 그대로 남아 Codex로 전송됩니다. 재검수에서 baseline 폴백을 타면 알려진 `sk-` 형식도 마스킹되지 않습니다.
- 최소 수정: 추적 diff를 생성할 때부터 민감 pathspec을 제외하거나 unified diff를 파일 단위로 필터링하고, baseline 폴백을 포함해 최종 diff 생성이 끝난 뒤 반드시 `redactSecrets()`를 다시 적용하십시오. 민감 파일명이 diff 본문에도 없는지를 테스트해야 합니다.

추가로 QA 로그는 stdout/stderr를 그대로 기록하고([auto-story-pipeline.mjs:875](C:/Projects/claude-skills/auto-story-finish/auto-story-pipeline.mjs:875)), Claude 로그에는 마스킹을 적용하지 않습니다(701–702행). QA 오류가 토큰이나 URL credential을 출력하면 로그와 Claude repair 프롬프트에 남습니다.

### 2. 전역 Codex 슬롯 잠금에 TOCTOU 경쟁이 있다

- 심각도: 높음
- 위치: [codex.mjs](C:/Projects/claude-skills/auto-story-finish/providers/codex.mjs:202)
- 무엇이 깨지는가: 각 프로세스가 슬롯 목록을 읽어 빈자리를 확인한 뒤 서로 다른 이름의 lock 파일을 만듭니다. 빈자리 확인과 획득이 하나의 원자 연산이 아닙니다.
- 실패 시나리오: 두 러너가 동시에 빈 디렉터리를 읽어 둘 다 `free=1`을 얻고, 각각 고유한 lock 파일을 성공적으로 생성합니다. `max=1`인데 Codex 두 개가 같은 `auth.json`을 동시에 사용합니다.
- 최소 수정: `max=1`이면 하나의 고정 lock 파일을 `flag:'wx'`로 획득하십시오. `max>1`이면 고정된 슬롯 번호별 파일을 순서대로 `wx` 생성하여 성공한 하나만 소유해야 합니다. 실제 동시 프로세스 테스트도 필요합니다.

### 3. 워커 커밋 가드는 push를 전혀 감지하지 못한다

- 심각도: 높음
- 위치: [auto-story-pipeline.mjs](C:/Projects/claude-skills/auto-story-finish/auto-story-pipeline.mjs:709)
- 무엇이 깨지는가: 가드는 실행 전후의 HEAD, 현재 브랜치, stash 개수만 비교합니다. `git push`는 셋 중 아무것도 바꾸지 않으며, 커밋 후 reset으로 상태를 복원하는 조작도 통과합니다.
- 실패 시나리오: 저장소 문서의 prompt injection이나 워커 오동작으로 `git push origin HEAD:main`이 실행됩니다. 로컬 HEAD·브랜치·stash가 그대로이므로 엔진은 성공으로 처리합니다. `pipeline-settings.json`이 없으면 프롬프트 경고밖에 없다는 것도 코드가 명시합니다(996–998행).
- 최소 수정: 워커 프로세스에서 git 실행 자체를 강제 차단하는 wrapper/PATH 격리 또는 샌드박스 정책을 필수화하십시오. 최소한 원격 ref 사전·사후 스냅샷과 reflog/index 상태를 검사해야 하지만, 사후 검사만으로 이미 수행된 push를 되돌릴 수는 없습니다.

### 4. `--commit`은 `auto/*` 브랜치를 요구하지 않는다

- 심각도: 높음
- 위치: [auto-story-pipeline.mjs](C:/Projects/claude-skills/auto-story-finish/auto-story-pipeline.mjs:125)
- 무엇이 깨지는가: `auto/*` 검사는 `--push` 또는 명시된 `--branch`에만 적용됩니다. `--commit`만 주고 `--branch`를 생략하면 현재 브랜치에 그대로 커밋합니다(468행).
- 실패 시나리오: 사용자가 main에서 `--commit`만 지정하거나 호출부가 branch 전달을 누락합니다. 배치는 main에 직접 스토리 커밋을 생성합니다.
- 최소 수정: detached worktree landing처럼 명시적으로 허용된 내부 모드를 별도 플래그로 구분하고, 일반 `--commit`은 현재 브랜치가 `auto/*`이거나 `--branch auto/*`가 아니면 중단하십시오.

### 5. 통합 RED rollback이 설정으로 우회된다

- 심각도: 높음
- 위치: [runner-rules.mjs](C:/Projects/claude-skills/night-batch-ops/engine/runner-rules.mjs:472)
- 무엇이 깨지는가: `pushOnFail:true`이면 RED 판정이 `push-anyway`가 되고 rollback하지 않습니다. 러너는 이후 `skipPush`도 설정하지 않아 실제 push 경로로 갑니다([run-night.mjs:668](C:/Projects/claude-skills/night-batch-ops/engine/run-night.mjs:668), 679행).
- 실패 시나리오: 잘못 남은 운영 설정 하나로 병렬 통합 QA가 실패해도 RED landing 커밋들이 `auto/*` 원격에 push되고 다음 슬롯의 베이스로 승계됩니다.
- 최소 수정: hardening 요구대로 RED는 무조건 rollback+STOP으로 고정하고 `pushOnFail`을 제거하십시오. 꼭 유지해야 한다면 무인 설정이 아니라 별도 사람 승인 명령으로 분리해야 합니다.

### 6. 셸 문자열 조합으로 임의 명령 실행이 가능하다

- 심각도: 높음
- 위치: [claude.mjs](C:/Projects/claude-skills/auto-story-finish/providers/claude.mjs:10)
- 무엇이 깨지는가: `bin`, `model`, `permMode`가 인용되지 않은 문자열로 합쳐지고 `shell:true`로 실행됩니다. Codex 감지도 `${bin} ${args.join(' ')}` 형태입니다([providers/index.mjs:47](C:/Projects/claude-skills/auto-story-finish/providers/index.mjs:47)).
- 실패 시나리오: 저장소 안 queue/config의 모델 값이 `opus & git push origin HEAD:main`이면 Windows `cmd.exe`가 두 번째 명령을 실행합니다. 공백이 있는 `CODEX_BIN=C:\Program Files\...\codex.cmd`는 반대로 정상 실행조차 되지 않습니다.
- 최소 수정: 실행 파일과 argv를 분리해 spawn하고, 모델 스펙을 허용 문자 집합으로 검증하십시오. `.cmd` 지원 때문에 셸이 필요하다면 Windows 전용 안전 인용을 적용하고 메타문자 입력을 거부해야 합니다.

### 7. Codex 전용 작업도 Claude 프로브에 종속된다

- 심각도: 중간
- 위치: [auto-story-pipeline.mjs](C:/Projects/claude-skills/auto-story-finish/auto-story-pipeline.mjs:1008)
- 무엇이 깨지는가: 작업이 있으면 실제 예정 provider와 관계없이 항상 `authProbe()`로 Claude를 먼저 실행합니다.
- 실패 시나리오: Claude 로그인이 만료됐지만 Codex는 정상이고 dev/review 모두 Codex로 배정되었습니다. 실제 Codex 워커를 실행하기 전에 Claude probe가 exit 3 또는 대기 상태로 들어갑니다.
- 최소 수정: 아직 실행할 단계 중 Claude로 resolve되는 단계가 있을 때만 경계 Claude probe를 수행하십시오. Codex→Claude 폴백이 실제로 필요해졌을 때 Claude 상태를 검사하면 됩니다.

### 8. 미추적 테스트 내용이 무결성 검사에서 빠진다

- 심각도: 중간
- 위치: [auto-story-pipeline.mjs](C:/Projects/claude-skills/auto-story-finish/auto-story-pipeline.mjs:885)
- 무엇이 깨지는가: 미추적 파일은 `changes`에만 추가되고, 내용 분석용 `diff`는 `git diff HEAD`만 사용합니다. 따라서 새 테스트 파일의 `.only`, `.skip`, 항상 참 단언, `@ts-ignore`를 검사하지 못합니다.
- 실패 시나리오: repair 워커가 `tests/new.test.ts`를 새로 만들면서 `describe.only(...)`를 넣습니다. QA는 일부 테스트만 실행해 GREEN이 되고 integrity 검사도 통과합니다.
- 최소 수정: 모든 미추적 파일을 `git diff --no-index` 등으로 integrity diff에 포함시키십시오. 바이너리·대용량 제한과 Windows `NUL` 처리도 같이 적용해야 합니다.

또한 repair 신규 여부를 `rule|file`만으로 비교하므로([quality-rules.mjs:101](C:/Projects/claude-skills/auto-story-finish/quality-rules.mjs:101)), 같은 파일에 동일 종류의 새 skip을 추가하면 기존 warning에 가려집니다. 줄 또는 정규화된 내용 지문까지 비교해야 합니다.

### 9. 실패 증거 보관에 실제 작업 diff가 없다

- 심각도: 중간
- 위치: [run-night.mjs](C:/Projects/claude-skills/night-batch-ops/engine/run-night.mjs:98)
- 무엇이 깨지는가: `archiveEvidence()`는 `auto-pipeline-logs`만 복사합니다. 엔진은 transient review diff를 실패 판정 전에 삭제하고([auto-story-pipeline.mjs:700](C:/Projects/claude-skills/auto-story-finish/auto-story-pipeline.mjs:700)), 실패한 dev/repair의 미커밋 코드 변경도 archive하지 않습니다.
- 실패 시나리오: repair가 유의미한 절반의 수정 후 exit 1로 종료합니다. 로그만 복사한 뒤 worktree가 강제 제거되어 코드 diff와 untracked 파일이 소실됩니다.
- 최소 수정: worktree 제거 전에 `git diff --binary HEAD`, untracked 파일 목록/내용 또는 복구 가능한 bundle/archive commit을 상태 폴더에 보존하십시오. 민감 파일 필터와 마스킹은 필수입니다.

### 10. 조건부 보안·성능 게이트가 탐지만 되고 실행되지 않는다

- 심각도: 중간
- 위치: [auto-story-pipeline.mjs](C:/Projects/claude-skills/auto-story-finish/auto-story-pipeline.mjs:907)
- 무엇이 깨지는가: 보안/성능 트리거가 발생하고 대응 npm script가 있어도 “qa 밖(사람 확인)” 로그만 남깁니다. 매니페스트도 `not-run`으로 끝납니다.
- 실패 시나리오: 인증/RLS 변경에 `test:security`가 정의되어 있지만 일반 QA에는 포함되지 않았습니다. 배치는 이를 실행하지 않고 QA PASS 및 완료 커밋을 만듭니다.
- 최소 수정: 트리거가 켜지고 script가 존재하면 해당 gate를 실행하고 실패를 quality loop의 RED로 처리하십시오. 실행하지 않을 정책이라면 SKILL/설계의 “있으면 실행” 요구를 제거해야 합니다.

### 11. `.env` 격리가 fail-closed가 아니다

- 심각도: 중간
- 위치: [codex.mjs](C:/Projects/claude-skills/auto-story-finish/providers/codex.mjs:149)
- 무엇이 깨지는가: `renameSync` 실패를 모두 무시합니다. 옮기지 못한 `.env`가 있어도 Codex 실행을 계속하며, 복원 실패도 경고 후 성공 처리가 가능합니다.
- 실패 시나리오: Windows에서 바이러스 검사기나 다른 프로세스가 `.env.local`을 잠급니다. rename이 실패해 파일이 작업 루트에 남고 Codex가 이를 읽을 수 있습니다. 반대로 워커가 같은 이름을 새로 만들면 원본 복원이 실패해 secret이 임시 폴더에 고립됩니다.
- 최소 수정: 대상 파일 하나라도 격리하지 못하면 Codex 실행을 중단하십시오. 복원 충돌도 exit 6으로 처리하고 임시 보관 위치를 보호하십시오. 중첩 디렉터리의 `.env*` 처리 정책도 명시해야 합니다.

### 12. “파일 미열람 clean”을 실제로 확인하지 않는다

- 심각도: 낮음
- 위치: [codex.mjs](C:/Projects/claude-skills/auto-story-finish/providers/codex.mjs:236)
- 무엇이 깨지는가: `commands > 0`이면 어떤 명령이었는지 보지 않고 clean을 인정합니다.
- 실패 시나리오: Codex가 `pwd` 한 번만 실행하고 `findings:[]`를 냅니다. 명령 수는 1이므로 리뷰가 유효하며 상태가 done으로 바뀝니다.
- 최소 수정: command event의 명령 문자열을 보존하고, 최소한 스토리 파일과 리뷰 diff 또는 변경 파일을 읽은 증거를 검증하십시오.

### 13. 인박스 파일 부재 시 Decision 등록이 누락된다

- 심각도: 낮음
- 위치: [auto-story-pipeline.mjs](C:/Projects/claude-skills/auto-story-finish/auto-story-pipeline.mjs:600)
- 무엇이 깨지는가: `DECISIONS-INBOX.md`가 이미 있을 때만 등록합니다.
- 실패 시나리오: 오래된 프로젝트나 불완전 설치에서 Codex가 Decision을 냅니다. 스토리에는 열린 Decision이 생기지만 단일 창구에는 아무것도 등록되지 않습니다.
- 최소 수정: Decision이 있으면 인박스를 안전한 기본 H1과 함께 생성하거나, 생성할 수 없으면 리뷰 적용을 실패 처리하십시오.

## 15개 hardening 검증

| # | 항목 | 판정 | 실제 근거 |
|---:|---|:---:|---|
| 1 | Codex dev 네트워크 기본 닫힘 | IMPLEMENTED | [auto-story-pipeline.mjs:151](C:/Projects/claude-skills/auto-story-finish/auto-story-pipeline.mjs:151), [codex.mjs:91](C:/Projects/claude-skills/auto-story-finish/providers/codex.mjs:91) |
| 2 | 스토리당 provider 전환 1회·부분 산출물 폐기 | PARTIAL | 카운터는 [auto-story-pipeline.mjs:793](C:/Projects/claude-skills/auto-story-finish/auto-story-pipeline.mjs:793)에 있으나 빈 diff/가용성 폴백 전환(616–636행)은 카운트하지 않음. 수동 no-commit 경로는 폐기를 생략함(436–440행). |
| 3 | Codex 실패 후 Claude probe 대기 금지 | IMPLEMENTED | [auto-story-pipeline.mjs:854](C:/Projects/claude-skills/auto-story-finish/auto-story-pipeline.mjs:854) |
| 4 | `reviewKinds` 기본 new·closeout | IMPLEMENTED | [runner-rules.mjs:370](C:/Projects/claude-skills/night-batch-ops/engine/runner-rules.mjs:370), [plan-queue.mjs:296](C:/Projects/claude-skills/night-batch-ops/engine/plan-queue.mjs:296) |
| 5 | package.json/lock 병렬 위험 차단 | IMPLEMENTED | [runner-rules.mjs:415](C:/Projects/claude-skills/night-batch-ops/engine/runner-rules.mjs:415) |
| 6 | 통합 RED rollback·STOP | PARTIAL | 기본 rollback은 [run-night.mjs:668](C:/Projects/claude-skills/night-batch-ops/engine/run-night.mjs:668)에 있으나 `pushOnFail`이 우회함. reset 성공도 확인하지 않음. |
| 7 | 머신 전역 Codex 슬롯 lock | MISSING | [codex.mjs:202](C:/Projects/claude-skills/auto-story-finish/providers/codex.mjs:202)의 check-then-create 경쟁 때문에 상호배제가 보장되지 않음. |
| 8 | 빈 diff·미열람 clean 무효, 이전 findings 위 done 금지 | PARTIAL | 빈 diff 전환 630–636행, 이전 findings 가드 581–587행은 구현. 미열람 검증은 명령 개수만 확인([codex.mjs:236](C:/Projects/claude-skills/auto-story-finish/providers/codex.mjs:236)). |
| 9 | `.env` 격리·diff 제외·마스킹 | PARTIAL | 격리 실패가 fail-open이고, 추적/baseline 민감 diff가 제외되지 않음. QA/Claude 로그도 미마스킹. |
| 10 | repair anti-cheat·게이트 설정 탐지 | PARTIAL | [quality-rules.mjs:101](C:/Projects/claude-skills/auto-story-finish/quality-rules.mjs:101), 157–160행에 구현됐으나 미추적 파일 내용과 동일 rule/file 신규 흔적을 놓침. |
| 11 | 워커 커밋 가드 | PARTIAL | HEAD/branch/stash 사후 비교는 709–718행에 있으나 push와 net-zero 조작은 감지 불가. |
| 12 | Decision 인박스 등록 | PARTIAL | [auto-story-pipeline.mjs:600](C:/Projects/claude-skills/auto-story-finish/auto-story-pipeline.mjs:600), 파일이 이미 있을 때만 동작. |
| 13 | `exit-info` 기반 lane switch | IMPLEMENTED | 엔진 [auto-story-pipeline.mjs:357](C:/Projects/claude-skills/auto-story-finish/auto-story-pipeline.mjs:357), 러너 [run-night.mjs:588](C:/Projects/claude-skills/night-batch-ops/engine/run-night.mjs:588) |
| 14 | 실패 증거 보존 | PARTIAL | [run-night.mjs:98](C:/Projects/claude-skills/night-batch-ops/engine/run-night.mjs:98)은 로그만 복사하며 미커밋 diff/untracked 산출물은 소실됨. |
| 15 | Codex 오류 이벤트+stderr 우선 분류 | IMPLEMENTED | [codex.mjs:58](C:/Projects/claude-skills/auto-story-finish/providers/codex.mjs:58), [auto-story-pipeline.mjs:653](C:/Projects/claude-skills/auto-story-finish/auto-story-pipeline.mjs:653) |

합계: IMPLEMENTED 6, PARTIAL 8, MISSING 1.

## 테스트 및 플랫폼 검증

- 파일 생성이 필요 없는 `node --test` 묶음: 117/117 통과.
- 변경된 `.mjs` 전부 `node --check` 통과.
- 전체 `node --test`는 현재 읽기 전용 실행 환경에서 `%TEMP%`의 `mkdtempSync`가 `EPERM`으로 막혀 e2e/파일 픽스처 테스트를 실행하지 못했습니다. 따라서 문서의 “201/201”을 현재 working tree에서 재현하지는 못했습니다.
- 누락된 핵심 테스트:

  - 추적 및 baseline 민감 파일 diff 제외
  - 두 실제 프로세스의 동시 슬롯 획득
  - 미추적 새 테스트의 `.only`/skip 탐지
  - `.env` rename/복원 실패
  - 워커의 직접 push 및 commit→reset
  - Claude 불가·Codex 정상인 Codex-only 실행
  - 인박스 파일 부재
  - `pushOnFail:true`에서 hardening 불변식
  - 공백 포함 Windows `CLAUDE_BIN`/`CODEX_BIN`
  - 셸 메타문자가 포함된 model spec 거부

- CRLF 보존 테스트와 `failure-classify`의 CRLF 정규화는 구현되어 있습니다. 반면 `shell:true` 문자열 실행은 Windows 공백 경로와 메타문자에 취약합니다.
- 배치가 `auto/*` 밖에 커밋·push할 수 있는 경로는 확인되었습니다: 일반 엔진의 `--commit` 무브랜치 실행, 워커의 감지되지 않는 직접 push, 셸 주입된 모델 문자열입니다.

## Optional

없음.