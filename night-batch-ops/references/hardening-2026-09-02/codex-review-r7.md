| 구분 | 판정 / 잔여 |
|---|---:|
| R6 Medium — Windows 프로세스 트리 hard stop | **PARTIAL** |
| R6 Low — 값 없는 `--gates --no-gates` | **FIXED** |
| R6 Low — timeout 오분류 | **FIXED** |
| R7 신규 발견 | **Medium 1 · Low 1** |
| 최종 잔여 | **High 0 · Medium 1 · Low 1** |
| Commit-ready | **아니오** |
| Engine-install-ready | **아니오** |

## 핵심 발견

### [Medium] wrapper가 먼저 종료되면 Windows 자손 프로세스는 deadline 뒤에도 살아남는다

Windows 종료는 deadline 시점의 직접 자식 PID에 `taskkill /T /F`를 실행하는 방식입니다. 이미 wrapper가 종료되어 자손이 고아가 된 경우에는 그 트리를 찾을 수 없습니다: [spawn-deadline.mjs:38](C:/Projects/claude-skills/night-batch-ops/engine/spawn-deadline.mjs:38), [spawn-deadline.mjs:43](C:/Projects/claude-skills/night-batch-ops/engine/spawn-deadline.mjs:43), [spawn-deadline.mjs:153](C:/Projects/claude-skills/night-batch-ops/engine/spawn-deadline.mjs:153).

테스트도 이 한계를 실제로 재현합니다. `start /b`로 떨어져 나간 손자를 만들지만, deadline 후 손자 사망을 검증하지 않고 테스트가 직접 종료합니다: [spawn-deadline.test.mjs:82](C:/Projects/claude-skills/night-batch-ops/engine/spawn-deadline.test.mjs:82), [spawn-deadline.test.mjs:115](C:/Projects/claude-skills/night-batch-ops/engine/spawn-deadline.test.mjs:115).

따라서 호출부가 제시간에 반환하는 것은 고쳐졌고 일반적인 `npm.cmd`/`claude.cmd` 동기 wrapper 트리도 종료되지만, “deadline이면 실행 중인 프로세스 트리가 모두 hard-stop된다”는 보장은 아직 성립하지 않습니다. Windows Job Object처럼 생성 시점부터 자손을 묶는 수단이 필요합니다.

### [Low] 게이트에서 ENOBUFS가 다시 timeout으로 오분류된다

새 헬퍼는 버퍼 초과를 의도적으로 `error.code='ENOBUFS' + signal='SIGTERM' + timedOut=false`로 반환합니다: [spawn-deadline.mjs:121](C:/Projects/claude-skills/night-batch-ops/engine/spawn-deadline.mjs:121), [spawn-deadline.mjs:126](C:/Projects/claude-skills/night-batch-ops/engine/spawn-deadline.mjs:126).

하지만 `runGateProbe()`는 `signal === 'SIGTERM'`만으로 timeout 처리하므로 64MB 출력 초과가 `exit 124`로 기록됩니다: [diagnose.mjs:888](C:/Projects/claude-skills/night-batch-ops/engine/diagnose.mjs:888), [diagnose.mjs:889](C:/Projects/claude-skills/night-batch-ops/engine/diagnose.mjs:889). 계획 실행기에서 적용한 것과 동일하게 `timedOut/ETIMEDOUT → 일반 error → 원인 없는 signal` 순서가 필요합니다.

현재 진단 테스트는 ETIMEDOUT과 `timedOut`만 검사하고 ENOBUFS 조합을 다루지 않습니다: [diagnose.test.mjs:508](C:/Projects/claude-skills/night-batch-ops/engine/diagnose.test.mjs:508).

## A. R6 세 항목 판정

| 항목 | 판정 | 근거 |
|---|:---:|---|
| Windows 프로세스 트리 hard stop | **PARTIAL** | 비동기 timer와 `taskkill /T /F`가 일반 wrapper 트리는 실제 종료하지만, wrapper 선종료 시 고아 자손은 살아남음 |
| 값 없는 `--gates --no-gates` | **FIXED** | 값이 아닌 플래그 존재로 충돌 검사: [autofinish.mjs:163](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:163), [autofinish.mjs:173](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:173). 값 없는 단독 `--gates`도 거부: [autofinish.mjs:177](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:177) |
| 계획 실행기 timeout 오분류 | **FIXED** | `timedOut/ETIMEDOUT → error → signal` 순서가 정확함: [orchestrate.mjs:279](C:/Projects/claude-skills/night-batch-ops/engine/orchestrate.mjs:279) |

플래그 테스트는 단위뿐 아니라 실제 CLI 프로세스에서 exit 2와 실행 0회를 확인합니다: [autofinish-e2e.test.mjs:639](C:/Projects/claude-skills/night-batch-ops/engine/autofinish-e2e.test.mjs:639), [autofinish-e2e.test.mjs:654](C:/Projects/claude-skills/night-batch-ops/engine/autofinish-e2e.test.mjs:654). ENOBUFS 계획 분류도 실제 12MB 출력 프로세스를 사용합니다: [orchestrate.test.mjs:250](C:/Projects/claude-skills/night-batch-ops/engine/orchestrate.test.mjs:250). 트리 종료 테스트 역시 실제 `.cmd`/Node 손자를 사용하지만, 위 고아 자손의 사망까지는 검증하지 않습니다.

## B. async 회귀 스캔

누락된 `await`나 남은 동기 호출자는 발견하지 못했습니다.

- `runGateProbe()` 호출: [autofinish.mjs:523](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:523)
- `executeRound()` 호출: [autofinish.mjs:625](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:625)
- `requestPlan()` 호출: [autofinish.mjs:909](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:909), [run-night.mjs:726](C:/Projects/claude-skills/night-batch-ops/engine/run-night.mjs:726)
- `applyOrchestrator()` 호출: [run-night.mjs:784](C:/Projects/claude-skills/night-batch-ops/engine/run-night.mjs:784)
- `selectQueue()` 호출: [run-night.mjs:1561](C:/Projects/claude-skills/night-batch-ops/engine/run-night.mjs:1561)
- 러너 spawn도 await됨: [autofinish.mjs:956](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:956)

관련 5개 파일은 `node --check`를 통과했습니다. 독립 재실행은 현재 읽기 전용 환경이 `%TEMP%`의 fixture 생성을 `EPERM`으로 차단해 완료하지 못했으며, 이는 코드 실패로 집계하지 않았습니다. 따라서 `811/811`은 [TEST-RUN-FINAL.md:246](C:/Projects/claude-skills/night-batch-ops/references/hardening-2026-09-02/TEST-RUN-FINAL.md:246)의 기록을 확인한 것이며 이번 리뷰에서 독립 재현한 수치는 아닙니다.

## 최종 판정

현재 상태는 **High 0, Medium 1, Low 1**입니다. `INSTALL-ISOLATION.md`의 **A+D는 반드시 충족해야 하는 별도 운영 전제**이며, 이를 적용하더라도 고아 자손이 deadline 뒤에 계속 실행될 수 있는 Medium 문제가 남으므로 아직 commit-ready도 engine-install-ready도 아닙니다. Windows 생성 시점의 강제 수명 관리와 게이트 ENOBUFS 분류를 보완하고, A+D 적용 증거와 전체 테스트를 쓰기 가능한 격리 환경에서 다시 확인한 뒤 설치 후보로 올리는 것이 안전합니다.