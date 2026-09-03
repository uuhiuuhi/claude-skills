| 요약 | 최종 판정 |
|---|---:|
| Round-3 H1~L1 | FIXED 9 · PARTIAL 1(H3) |
| 신규 correctness/safety | **High 4 · Medium 3** |
| SPEC §1~§10 | IMPLEMENTED 5 · PARTIAL 5 |
| BRIEF 16개 정책 | IMPLEMENTED 14 · PARTIAL 2 |
| 전체 테스트 기록 | 774/774 PASS · skip/todo 0 ([TEST-RUN-FINAL.md](C:/Projects/claude-skills/night-batch-ops/references/hardening-2026-09-02/TEST-RUN-FINAL.md:24)) |
| 이번 리뷰 파일 변경 | 없음 |

## 신규 발견

### NEW-H1 · High — autofinish 큐가 설정값으로 push를 다시 켤 수 있다

- 위치: [autofinish.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:297), [autofinish.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:303), [autofinish.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:730), [run-night.mjs](C:/Projects/claude-skills/night-batch-ops/engine/run-night.mjs:1381)
- 요구사항: 외부 반영은 사용자 승인 전 금지이며 autofinish 큐의 `defaults.push`는 항상 `false`여야 한다([AUTOFINISH.md](C:/Projects/claude-skills/night-batch-ops/AUTOFINISH.md:111)).
- 실패 시나리오: 대상 저장소의 `auto.config.json`에 `autofinish.queueDefaults.push: true`가 있으면 `Boolean(defaults.push)`가 `true`를 큐에 싣는다. `run-night`는 이를 실제 `--push`와 `pushBranchOnce()`로 연결한다.
- 기존 테스트 한계: 기본 설정에서만 `push === false`를 확인한다([autofinish-e2e.test.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish-e2e.test.mjs:301)). `queueDefaults.push=true` 변형은 없다.
- 최소 수정: autofinish 큐에서는 `push: false`로 고정하고, 설정에 `push:true`가 있으면 무시가 아니라 명시적으로 거부한다.

### NEW-H2 · High — `--diagnose-only --gates …`가 대상 저장소에서 npm 스크립트를 실행한다

- 위치: [autofinish.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:412), [autofinish.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:415)
- 요구사항: diagnose-only는 게이트 0회·러너 0회·대상 저장소 쓰기 0이어야 한다([AUTOFINISH.md](C:/Projects/claude-skills/night-batch-ops/AUTOFINISH.md:38), [DESIGN](C:/Projects/claude-skills/night-batch-ops/references/hardening-2026-09-02/AUTONOMOUS-FINISH-DESIGN.md:205)).
- 실패 시나리오: 사용자가 `--diagnose-only --gates qa`를 주면 대상 저장소 cwd에서 `npm run qa`가 실행된다. npm 스크립트는 생성·포맷·코드젠 등 임의 쓰기를 할 수 있어 read-only 보장이 깨진다.
- 테스트가 결함을 정답으로 고정한다: [autofinish.test.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.test.mjs:134)는 이 조합에서 게이트 1회를 기대한다. 주입된 무쓰기 함수라 실제 npm 부작용은 검증하지 않는다.
- 최소 수정: diagnose-only에서 `--gates`를 거부하거나 무조건 빈 배열로 강제한다.

### NEW-H3 · High — state/report 경로가 대상 저장소 안인지 검사하지 않아 `_bmad-output/` 밖에 쓴다

- 위치: [autofinish.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:362), [autofinish.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:372), [autofinish.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:374), [autofinish.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:364), [autofinish.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:552)
- 실패 시나리오:
  - `--state <root>/src`를 주면 스냅숏·로그·큐가 대상 저장소 `src/autofinish/...`에 생성된다.
  - `--out <root>/README.md`처럼 지정하면 보고서 쓰기가 BMAD writer를 우회해 대상 저장소 파일을 변경하려 한다.
  - diagnose-only에서도 동일하다.
- 기존 E1 테스트는 state를 외부 임시 폴더로만 지정한다([autofinish-e2e.test.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish-e2e.test.mjs:261)). 경계 공격 테스트가 없다.
- 최소 수정: `realpath` 기준으로 `stateDir`, `outDir`, `reportPath`가 대상 저장소 밖임을 강제하고, 기존 부모의 symlink/junction도 거부한다.

### NEW-H4 · High — Fable 실패 stderr가 마스킹 없이 콘솔 로그로 재출력된다

- 위치: [orchestrate.mjs](C:/Projects/claude-skills/night-batch-ops/engine/orchestrate.mjs:190), [orchestrate.mjs](C:/Projects/claude-skills/night-batch-ops/engine/orchestrate.mjs:235), [autofinish.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:704), [autofinish.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:724)
- 실패 시나리오: Claude/Fable가 `stderr` 첫 줄에 토큰이나 Authorization 값을 포함하고 실패하면 그 문자열이 `deterministic-fallback(runner-error:...)`의 `source`가 된다. JSON 산출물은 `deepRedact`되지만 `log("[ORCHESTRATOR] source=...")`는 원문을 출력한다.
- 테스트 한계: E10은 state 산출물만 전수 검색하며 프로세스 stdout/stderr의 Fable 실패 누출은 확인하지 않는다([autofinish-e2e.test.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish-e2e.test.mjs:532)).
- 최소 수정: 외부 오류를 `source` 식별자에 넣지 말고 고정 오류 코드만 기록한다. 모든 `log()` 및 최상위 CLI 오류도 공용 `maskSecrets()`를 거쳐야 한다.

### NEW-M1 · Medium — `--no-gates` 실행 후 최종 재진단을 하지 않아 보고서가 실행 전 상태다

- 위치: [autofinish.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:518), [autofinish.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:521), [autofinish.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:536)
- 실패 시나리오: 러너가 코드·스토리·매니페스트를 변경해도 `gates.length===0`이면 `readProject()`를 다시 하지 않는다. 보고서의 완료·남은 문제·매니페스트·교차 리뷰 수치는 러너 실행 전 스냅숏을 사용한다.
- 안전성: 게이트가 없으므로 `ready`로 승격되지는 않지만, “이번에 끝낸 것/남은 문제”가 실제 결과와 불일치할 수 있다.
- 최소 수정: 최종 `readProject → diagnose → mergeBacklog`는 항상 실행하고, 게이트 호출만 `gates.length`로 조건화한다.

### NEW-M2 · Medium — 전체 예산이 실질적인 deadline으로 적용되지 않는다

- 위치: [autofinish.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:441), [autofinish.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:744), [autofinish.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:524)
- 실패 시나리오: `--budget-min 1`이어도 첫 QA는 자체 최대시간만큼 실행될 수 있고, 러너에는 “남은 시간”이 아니라 다시 전체 1분을 준다. 이후 최종 qa/build도 예산 검사 없이 실행한다. “넘기면 그 자리에서 끊는다”는 문서 계약과 다르다.
- 무한 재시도는 `maxRounds`로 제한되므로 unbounded retry 자체는 아니다.
- 최소 수정: 시작 시 절대 deadline을 만들고 모든 gate/runner timeout을 `min(개별 상한, remainingMs)`로 제한한다. 각 spawn 전과 최종 게이트 전에도 잔여 시간을 검사한다.

### NEW-M3 · Medium — BMAD 계획 적용 전체 폐기 후에도 같은 라운드의 코드 실행을 계속한다

- 위치: [autofinish.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:654), [autofinish.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:657), [autofinish.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:662)
- 실패 시나리오: baseHash 충돌·경로 거부·junction 검출로 `applyBmadWrites()`가 `rolledBack:true`를 반환해도 엔진은 DAG·큐·러너 단계로 진행한다. 발견한 결함이나 새 완료기준을 BMAD에 연결하지 못한 상태에서 구현을 시작할 수 있다.
- 최소 수정: `rolledBack`, `rejected`, `conflicts`가 있으면 해당 매핑을 전부 봉쇄하고 재진단하거나 라운드를 중단한다. 독립적이며 이미 BMAD에 존재하는 스토리만 계속할 경우에는 그 구분을 명시적으로 계산해야 한다.

## Round-3 H1~L1 재검증

| 항목 | 판정 | 현재 근거 | 테스트 성격 |
|---|:---:|---|---|
| H1 진단·보고 시크릿 마스킹 | **FIXED** | 공용 redactor 재수출 및 전체 snapshot deep-redact: [diagnose.mjs](C:/Projects/claude-skills/night-batch-ops/engine/diagnose.mjs:27), [diagnose.mjs](C:/Projects/claude-skills/night-batch-ops/engine/diagnose.mjs:332), [report.mjs](C:/Projects/claude-skills/night-batch-ops/engine/report.mjs:390) | 실데이터 객체·실제 파일 기반 전수 grep + autofinish 실제 CLI spawn([autofinish-e2e.test.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish-e2e.test.mjs:532)). 앵커-only 아님. NEW-H4는 별도 로그 경로 |
| H2 증거 없이 dashboard GREEN | **FIXED** | 계측·검증·diagnosis·ready를 적극 요구: [verdict.mjs](C:/Projects/claude-skills/dev-status/verdict.mjs:104), [verdict.mjs](C:/Projects/claude-skills/dev-status/verdict.mjs:142). 포팅본도 동일 | 순수 판정 함수를 결손 입력으로 직접 호출하는 mutation 테스트([verdict.test.mjs](C:/Projects/claude-skills/dev-status/verdict.test.mjs:188)). 프로세스/git 불필요, 앵커-only 아님 |
| H3 절대경로 git 우회 | **PARTIAL** | 자격증명·helper·askpass·SSH agent 제거와 `GIT_ALLOW_PROTOCOL=none`: [git-guard.mjs](C:/Projects/claude-skills/auto-story-finish/providers/git-guard.mjs:118), [git-guard.mjs](C:/Projects/claude-skills/auto-story-finish/providers/git-guard.mjs:181). OS 차단은 아님 | 절대경로 실제 git/bare remote push 차단 및 실제 자식 env 검증([providers-hardening.test.mjs](C:/Projects/claude-skills/auto-story-finish/providers-hardening.test.mjs:705), [providers-hardening.test.mjs](C:/Projects/claude-skills/auto-story-finish/providers-hardening.test.mjs:860)). 우회자가 env·프로토콜을 복구하면 사후 탐지만 남는 E2E도 유지 |
| M1 provider 누락 T6 PASS | **FIXED** | 누락은 `not-verified`: [completion-rules.mjs](C:/Projects/claude-skills/auto-story-finish/completion-rules.mjs:90), [readiness.mjs](C:/Projects/claude-skills/night-batch-ops/engine/readiness.mjs:243) | 판정 함수를 누락 매니페스트로 직접 실행. 앵커-only 아님 |
| M2 happy-path 1건으로 T2 PASS | **FIXED** | 정상·실패·경계 세 유형을 구조화하고 전부 요구: [completion-rules.mjs](C:/Projects/claude-skills/auto-story-finish/completion-rules.mjs:227), [completion-rules.mjs](C:/Projects/claude-skills/auto-story-finish/completion-rules.mjs:276), [readiness.mjs](C:/Projects/claude-skills/night-batch-ops/engine/readiness.mjs:39) | 실제 diff 텍스트 파싱·판정 테스트. 매니페스트 배선 확인 일부는 소스 앵커지만 핵심 판정은 앵커-only 아님 |
| M3 BMAD junction 탈출 | **FIXED** | 구간별 `lstat`와 기존 부모 `realpath` 경계 검사: [bmad-sync.mjs](C:/Projects/claude-skills/night-batch-ops/engine/bmad-sync.mjs:94), [bmad-sync.mjs](C:/Projects/claude-skills/night-batch-ops/engine/bmad-sync.mjs:765) | Windows 실제 junction 생성 후 외부 파일 0건 확인([bmad-sync.test.mjs](C:/Projects/claude-skills/night-batch-ops/engine/bmad-sync.test.mjs:262)). 실제 동작 |
| M4 dashboard 손상·경합 throw | **FIXED** | 안전 읽기와 구조화 오류: [scan.mjs](C:/Projects/claude-skills/dev-status/scan.mjs:32), [scan.mjs](C:/Projects/claude-skills/dev-status/scan.mjs:522), 포팅본 [scan.mjs](C:/Projects/jng-os/tools/dev-status/scan.mjs:50), [scan.mjs](C:/Projects/jng-os/tools/dev-status/scan.mjs:787) | 실제 ENOENT/EISDIR/권한 오류와 별도 import 프로세스 검증. 앵커-only 아님 |
| M5 셸 문자열 실행 잔존 | **FIXED** | 운영 소스의 `shell:true` 0건, 자유형 명령은 argv 정규화: [spawn-safe.mjs](C:/Projects/claude-skills/auto-story-finish/providers/spawn-safe.mjs:144), [auto-story-pipeline.mjs](C:/Projects/claude-skills/auto-story-finish/auto-story-pipeline.mjs:1152) | QA/E2E·통합 게이트 메타문자 공격을 실제 프로세스로 실행해 부작용 파일 0 확인. 소스 앵커 테스트도 보조 |
| M6 구현 파일 미열람 clean | **FIXED** | story+diff+구현 파일 중 하나 이상 열람을 필수화: [codex.mjs](C:/Projects/claude-skills/auto-story-finish/providers/codex.mjs:507), [codex.mjs](C:/Projects/claude-skills/auto-story-finish/providers/codex.mjs:529) | 구조화 이벤트 직접 판정 + 실제 엔진/스텁 프로세스 E2E([engine-e2e.test.mjs](C:/Projects/claude-skills/auto-story-finish/engine-e2e.test.mjs:826)) |
| L1 증거 순위와 강등 순서 불일치 | **FIXED** | 모든 후보 강등을 모아 최소 rank로 결정: [diagnose.mjs](C:/Projects/claude-skills/night-batch-ops/engine/diagnose.mjs:639) | 실제 fixture 파일에서 D2+D3 동시 조건을 만든 함수 동작 테스트([diagnose.test.mjs](C:/Projects/claude-skills/night-batch-ops/engine/diagnose.test.mjs:243)). 앵커-only 아님 |

## SPEC §1~§10 준수표

| SPEC | 판정 | 근거·미달 |
|---:|:---:|---|
| §1 프로젝트 자동 진단 | **PARTIAL** | 진단 범위·증거 순위는 구현. 다만 diagnose-only가 명시 gate를 실행하고 state 경로를 저장소 안에 둘 수 있음(NEW-H2/H3) |
| §2 범위·우선순위 자동 결정 | **IMPLEMENTED** | 7단계 tier, 작업 메타데이터, 라운드 병합·closed 추적 구현 |
| §3 BMAD 흐름 유지 | **PARTIAL** | append-only·hash·실경로 제한은 구현. BMAD apply 전체 폐기 후 실행 지속(NEW-M3) |
| §4 Fable 오케스트레이션 | **IMPLEMENTED** | Fable 계획은 shape+결정적 검증 후 채택, 실패·허구 키는 deterministic fallback: [orchestrate.mjs](C:/Projects/claude-skills/night-batch-ops/engine/orchestrate.mjs:180) |
| §5 병렬·자동 수정 | **PARTIAL** | 충돌·보수 범주·실패 분류·상한은 구현. 전체 deadline 보장은 깨짐(NEW-M2) |
| §6 질문 최소화 | **IMPLEMENTED** | 허용 8범주 판정·비개발자 표현·봉쇄된 항목 외 독립 진행 구현 |
| §7 완료 기준 | **PARTIAL** | T1~T8/P1~P8와 not-verified 전파는 구현. `--no-gates` 최종 상태가 실행 전 snapshot이라 실제 완료/잔여 보고가 낡을 수 있음(NEW-M1) |
| §8 안전 경계 | **PARTIAL** | integration RED rollback, argv 분리, BMAD 경계, secret redaction 대부분 구현. 설정 기반 push, diagnose-only gate, 경로 경계, 콘솔 secret leak 존재(NEW-H1~H4). OS sandbox 잔여 |
| §9 측정 | **IMPLEMENTED** | 시간·병렬·첫 통과·리뷰 결함·반복 실패·통합·절약 지표와 비교 조건 구현 |
| §10 사용자 보고 | **PARTIAL** | 10개 요구 영역과 not-verified 표기는 구현. no-gates 최종 재수집 누락 및 plan 오류 콘솔 누출(NEW-M1/H4) |

## BRIEF 16개 정책 최종 판정

| # | 판정 | 비고 |
|---:|:---:|---|
| 1 | **IMPLEMENTED** | 민감 파일 diff 제거·최종 재마스킹 |
| 2 | **PARTIAL** | QA/worker/repair 산출물은 마스킹되지만 Fable 실패 stderr 콘솔 누출 가능(NEW-H4) |
| 3 | **IMPLEMENTED** | 격리·복원 실패 fail-closed |
| 4 | **IMPLEMENTED** | 고정 slot 파일 `wx` 원자 선점 |
| 5 | **PARTIAL** | PATH git은 실행 단계 차단. 절대경로 git·worker 자가 환경 복구는 OS 격리 없이 완전 차단 불가(H3) |
| 6 | **IMPLEMENTED** | detached/`auto/*` 외 무인 commit 거부 |
| 7 | **IMPLEMENTED** | Integration RED는 rollback·STOP·push 금지. NEW-H1은 GREEN 경로의 승인 없는 push 문제 |
| 8 | **IMPLEMENTED** | 운영 코드 argv 분리, 자유형 명령 메타문자 거부 |
| 9 | **IMPLEMENTED** | 실제 사용하는 provider만 probe |
| 10 | **IMPLEMENTED** | 미추적 신규 테스트 포함 integrity 검사 |
| 11 | **IMPLEMENTED** | 줄·정규화 내용 지문 비교 |
| 12 | **IMPLEMENTED** | 민감정보 제외한 diff·untracked 복구 |
| 13 | **IMPLEMENTED** | security/performance 실제 실행 및 실패 전파 |
| 14 | **IMPLEMENTED** | story·diff·변경 구현 파일 열람 증거 요구 |
| 15 | **IMPLEMENTED** | inbox 부재 생성, 적용 실패 구조화 |
| 16 | **IMPLEMENTED** | story/batch manifest에 integration pass/fail/rollback 기록 |

## Accepted residual — 신규 finding 아님

- **OS 수준 worker 격리 부재:** 절대경로 `git.exe`, worker가 `GIT_ALLOW_PROTOCOL`을 재설정하거나 저장소 안 자격증명을 직접 읽는 경우를 프로세스 내부 가드만으로 완전히 막을 수 없다. 현재 완화는 PATH shim, credential/helper/askpass/SSH agent 제거, 원격 URL 내장 자격증명 시작 전 거부, `GIT_ALLOW_PROTOCOL=none`, 원격 ref·reflog 사후 비교다([git-guard.mjs](C:/Projects/claude-skills/auto-story-finish/providers/git-guard.mjs:118)). 완전한 해결은 네트워크가 차단된 job/container와 push 권한을 가진 별도 제어 프로세스다.
- **BMAD 경로 검사 TOCTOU:** `lstat/realpath` 검사 후 실제 rename 사이에 외부 프로세스가 디렉터리를 junction으로 교체하는 경쟁은 애플리케이션 레벨 검사만으로 원자 차단하기 어렵다. 현재 완화는 구간별 링크 거부, 기존 부모 realpath 확인, hash 재검증, tmp→rename, 전체 계획 폐기다. 완전한 해결은 OS sandbox 또는 디렉터리 핸들 기반 원자 경로 API가 필요하다.