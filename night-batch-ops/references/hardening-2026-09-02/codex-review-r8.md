| 항목 | R8 판정 | 근거 |
|---|:---:|---|
| R7 Medium — wrapper 선종료 후 고아 자손 생존 | **FIXED** | 이중 종료망과 실제 고아 사망 테스트 확인 |
| R7 Low — `runGateProbe` ENOBUFS 오분류 | **FIXED** | ENOBUFS → exit 125·`출력 과다` |
| 신규 must-fix | **없음** | High 0 · Medium 0 · Low 0 |
| Commit-ready | **예** | 선언된 잔여 한계를 수용하는 조건 |
| Engine-install-ready | **조건부** | `INSTALL-ISOLATION.md` **A+D 실적용 확인 후** |

## A. R7 항목 판정

### Medium — FIXED

Windows에서 두 종료망을 동시에 실행합니다.

- 살아 있는 wrapper 트리: `taskkill /PID <pid> /T /F` — [spawn-deadline.mjs:103](C:/Projects/claude-skills/night-batch-ops/engine/spawn-deadline.mjs:103)
- wrapper 선종료 고아: 원래 PID를 루트로 `ParentProcessId`를 BFS 탐색 — [spawn-deadline.mjs:47](C:/Projects/claude-skills/night-batch-ops/engine/spawn-deadline.mjs:47), [spawn-deadline.mjs:59](C:/Projects/claude-skills/night-batch-ops/engine/spawn-deadline.mjs:59)
- 생성시각 하한 적용 — [spawn-deadline.mjs:55](C:/Projects/claude-skills/night-batch-ops/engine/spawn-deadline.mjs:55), [spawn-deadline.mjs:64](C:/Projects/claude-skills/night-batch-ops/engine/spawn-deadline.mjs:64)
- 발견한 PID 강제 종료 — [spawn-deadline.mjs:74](C:/Projects/claude-skills/night-batch-ops/engine/spawn-deadline.mjs:74)
- 두 종료망 실제 발사 — [spawn-deadline.mjs:99](C:/Projects/claude-skills/night-batch-ops/engine/spawn-deadline.mjs:99), [spawn-deadline.mjs:110](C:/Projects/claude-skills/night-batch-ops/engine/spawn-deadline.mjs:110)

고아 테스트는 실제 동작 테스트가 맞습니다. Windows에서 실제 `.cmd`를 만들고 `cmd.exe /d /s /c`로 실행하며, `.cmd`가 `start /b "" node ...`로 손자를 띄운 뒤 즉시 종료합니다: [spawn-deadline.test.mjs:82](C:/Projects/claude-skills/night-batch-ops/engine/spawn-deadline.test.mjs:82), [spawn-deadline.test.mjs:97](C:/Projects/claude-skills/night-batch-ops/engine/spawn-deadline.test.mjs:97). 이후 PID 파일 존재와 유효 PID를 확인하고, deadline 뒤 `process.kill(pid, 0)` 기준 사망을 단언합니다: [spawn-deadline.test.mjs:116](C:/Projects/claude-skills/night-batch-ops/engine/spawn-deadline.test.mjs:116), [spawn-deadline.test.mjs:121](C:/Projects/claude-skills/night-batch-ops/engine/spawn-deadline.test.mjs:121). 테스트 정리는 `survived`를 먼저 저장한 다음 수행하므로 정리 코드가 성공을 위조하지 않습니다: [spawn-deadline.test.mjs:123](C:/Projects/claude-skills/night-batch-ops/engine/spawn-deadline.test.mjs:123).

판정은 “R7에서 재현된 고아가 계속 살아남는 결함”에 대해 FIXED입니다. 다만 Job Object 수준의 원자적·무조건적 수명 보장은 아닙니다.

### Low — FIXED

분류 순서가 정확합니다.

1. `timedOut`/`ETIMEDOUT` → 124
2. ENOBUFS → 125
3. 원인 없는 signal → 124

구현: [diagnose.mjs:891](C:/Projects/claude-skills/night-batch-ops/engine/diagnose.mjs:891), [diagnose.mjs:897](C:/Projects/claude-skills/night-batch-ops/engine/diagnose.mjs:897), [diagnose.mjs:902](C:/Projects/claude-skills/night-batch-ops/engine/diagnose.mjs:902), [diagnose.mjs:909](C:/Projects/claude-skills/night-batch-ops/engine/diagnose.mjs:909).

ENOBUFS와 SIGTERM이 함께 있는 실제 반환 모양을 검사하며, 124 금지·125·`출력 과다`를 모두 단언합니다: [diagnose.test.mjs:519](C:/Projects/claude-skills/night-batch-ops/engine/diagnose.test.mjs:519).

## B. 회귀 스캔

- **PID/토큰 주입:** 문제 없음. PID는 양의 정수만 허용하고 토큰은 `[A-Za-z0-9-]{0,64}` 밖이면 통째로 버립니다: [spawn-deadline.mjs:28](C:/Projects/claude-skills/night-batch-ops/engine/spawn-deadline.mjs:28), [spawn-deadline.mjs:47](C:/Projects/claude-skills/night-batch-ops/engine/spawn-deadline.mjs:47). 자식 환경의 기존 토큰도 UUID로 덮어씁니다: [spawn-deadline.mjs:162](C:/Projects/claude-skills/night-batch-ops/engine/spawn-deadline.mjs:162), [spawn-deadline.mjs:184](C:/Projects/claude-skills/night-batch-ops/engine/spawn-deadline.mjs:184).

- **EncodedCommand:** 올바릅니다. PowerShell 요구 형식인 UTF-16LE → base64이고, 실행파일과 인자가 분리돼 셸 재해석 경로가 없습니다: [spawn-deadline.mjs:112](C:/Projects/claude-skills/night-batch-ops/engine/spawn-deadline.mjs:112). 테스트도 base64를 UTF-16LE로 역해독해 핵심 구문과 시간 하한을 검사합니다: [spawn-deadline.test.mjs:175](C:/Projects/claude-skills/night-batch-ops/engine/spawn-deadline.test.mjs:175).

- **PowerShell 누락/기동 실패:** 호출자는 제시간에 반환합니다. 종료 프로세스를 기다리지 않고 deadline 콜백이 곧바로 `finish()`하기 때문입니다: [spawn-deadline.mjs:228](C:/Projects/claude-skills/night-batch-ops/engine/spawn-deadline.mjs:228). 다만 PowerShell이 없거나 정책으로 차단되면 고아 스윕은 실패하며, 이미 `taskkill`을 발사한 상태라 PowerShell의 비동기 `error`에서 직접 종료 폴백도 실행되지 않습니다: [spawn-deadline.mjs:104](C:/Projects/claude-skills/night-batch-ops/engine/spawn-deadline.mjs:104), [spawn-deadline.mjs:114](C:/Projects/claude-skills/night-batch-ops/engine/spawn-deadline.mjs:114). 현재 검토 호스트에서는 계산된 Windows PowerShell 경로가 실제 존재함을 확인했습니다. 이는 deadline 반환 회귀는 아니며, 아래 accepted residual에 포함합니다.

- **POSIX:** 기존 경로를 훼손하지 않았습니다. 자식을 별도 프로세스 그룹으로 만들고 음수 PID에 SIGKILL을 보냅니다: [spawn-deadline.mjs:119](C:/Projects/claude-skills/night-batch-ops/engine/spawn-deadline.mjs:119), [spawn-deadline.mjs:187](C:/Projects/claude-skills/night-batch-ops/engine/spawn-deadline.mjs:187). 단, R8은 Windows 실행이므로 실제 POSIX 고아 종료는 미실측입니다.

## 잔여 위험 분류

다음은 **accepted residual — 문서화되고 현실적으로 완화된 잔여**이며 이번 라운드의 must-fix로 세지 않습니다.

- PID 재사용 오탐 창: `spawnedAt − 1초`로 축소했지만 제거 불가.
- Job Object 부재: 사후 스냅숏과 종료 사이에 새 자손이 생기는 경합 가능.
- `AUTO_SPAWN_TOKEN` 폴백: WMI가 환경변수를 노출하지 않아 대체로 효과가 없음.
- PowerShell 부재·차단 시: caller deadline은 지키지만 고아 스윕은 보장되지 않음.

앞의 세 한계는 [AUTOFINISH.md:182](C:/Projects/claude-skills/night-batch-ops/AUTOFINISH.md:182)에 명시돼 있습니다. 절대적인 “생성 순간부터 어떤 자손도 탈출 불가”가 제품 요구라면 Job Object가 필요하지만, 현재 선언된 best-effort hard-stop 계약에서는 must-fix로 보지 않습니다.

## 최종 집계 및 준비도

**Must-fix 최종 집계: High 0 · Medium 0 · Low 0.** `TEST-RUN-FINAL.md`에는 R8 전체 **813/813 pass, fail/skipped/todo 0**이 기록돼 있습니다: [TEST-RUN-FINAL.md:293](C:/Projects/claude-skills/night-batch-ops/references/hardening-2026-09-02/TEST-RUN-FINAL.md:293). 이번 리뷰에서는 “파일을 수정하지 말라”는 지시 때문에 임시 fixture 파일을 생성하는 테스트를 재실행하지 않았고, 관련 모듈의 `node --check` 통과와 기록·코드를 대조했습니다.

결론적으로 코드는 **commit-ready**입니다. 엔진 설치는 아직 무조건 ready가 아니라, `INSTALL-ISOLATION.md`의 **A(러너 클론에 push 불가능한 자격증명)**와 **D(main/보호 브랜치 서버 측 직접 push 금지)**가 실제 적용됐다는 증거가 확보된 뒤에만 **engine-install-ready**입니다: [INSTALL-ISOLATION.md:7](C:/Projects/claude-skills/night-batch-ops/references/hardening-2026-09-02/INSTALL-ISOLATION.md:7), [INSTALL-ISOLATION.md:10](C:/Projects/claude-skills/night-batch-ops/references/hardening-2026-09-02/INSTALL-ISOLATION.md:10), [INSTALL-ISOLATION.md:12](C:/Projects/claude-skills/night-batch-ops/references/hardening-2026-09-02/INSTALL-ISOLATION.md:12).