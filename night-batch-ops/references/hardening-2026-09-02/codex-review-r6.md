| 항목 | 판정 | 핵심 근거 |
|---|:---:|---|
| R5 Medium — deadline hard stop | **PARTIAL** | BMAD·후속 라운드·`--no-gates` 기록은 수정됐지만 Windows 프로세스 트리의 실제 종료는 보장되지 않음 |
| R5 Low — `--gates`/`--no-gates` 충돌 | **PARTIAL** | 정상 형식은 거부하지만 값 없는 `--gates --no-gates`는 통과 |
| R6 신규 회귀 | **Low 1건** | timeout 우선 분류가 비-timeout 오류까지 timeout으로 오분류 가능 |
| 테스트 품질 | **대체로 실제 동작** | 실제 CLI·자식 프로세스·파일 지문을 사용하지만 Windows 후손 프로세스 종료는 미검증 |

## A. R5 지적 검증

### Medium — PARTIAL

수정된 부분은 유효합니다.

- 라운드 진입 전 deadline 검사: [autofinish.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:537)
- BMAD 쓰기 직전 중단: [autofinish.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:820)
- Fable timeout을 설정 상한과 잔여 예산 중 작은 값으로 제한: [autofinish.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:882), [orchestrate.mjs](C:/Projects/claude-skills/night-batch-ops/engine/orchestrate.mjs:240)
- 러너 직후 소진 재확인 및 다음 라운드 중단: [autofinish.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:960), [autofinish.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:631)
- `--no-gates`에서도 최종 budget 소진 기록: [autofinish.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:662)

다만 Windows의 `.cmd/.bat` 경로는 `cmd.exe`만 직접 spawn하며 [orchestrate.mjs](C:/Projects/claude-skills/night-batch-ops/engine/orchestrate.mjs:249), timeout도 그 프로세스에만 적용됩니다. 후손 프로세스가 파이프를 유지하면 `spawnSync`가 deadline 뒤까지 반환하지 않을 수 있어, Fable에 대한 벽시계 기준 hard stop은 아직 보장되지 않습니다. R6 기록도 이 제한을 명시합니다: [TEST-RUN-FINAL.md](C:/Projects/claude-skills/night-batch-ops/references/hardening-2026-09-02/TEST-RUN-FINAL.md:184). 따라서 BMAD·후속 라운드·소진 플래그는 FIXED지만 Medium 전체는 PARTIAL입니다.

### Low — PARTIAL

정상적인 `--gates qa --no-gates` 조합은 실행 전에 거부됩니다: [autofinish.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:163), [autofinish.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:171).

하지만 충돌 판정이 `--gates`의 존재가 아니라 `gatesRaw !== null`에 의존합니다. 따라서 값이 빠진 `--gates --no-gates`는 `gatesRaw === null`이 되어 거부되지 않고 `--no-gates`로 실행됩니다. `has('gates') && has('no-gates')`를 기준으로 해야 계약을 완전히 충족합니다.

## B. R6 신규 회귀

**Low — 비-timeout spawn 오류를 timeout으로 오분류할 수 있습니다.**

R6는 `r.signal` 검사를 `r.error`보다 앞으로 옮겼습니다: [orchestrate.mjs](C:/Projects/claude-skills/night-batch-ops/engine/orchestrate.mjs:266). 이제 `maxBuffer` 초과 같은 `ENOBUFS` 오류가 종료 signal과 함께 반환되면 실제 원인은 출력 과다인데 `runner-timeout`으로 기록됩니다. 안전 폴백 자체는 유지되지만 진단 사유가 틀려 운영자가 예산 문제로 잘못 대응할 수 있습니다. 조건은 `ETIMEDOUT`만 먼저 처리하고, 그다음 일반 `r.error`, 마지막으로 signal을 분류하는 편이 정확합니다.

테스트는 anchor-only가 아닙니다. 실제 장시간 자식 프로세스를 죽이는 테스트 [autofinish.test.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.test.mjs:334), 실제 대상 파일 지문으로 BMAD 무변경을 확인하는 테스트 [autofinish.test.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.test.mjs:364), 실제 계획 자식 프로세스 timeout [orchestrate.test.mjs](C:/Projects/claude-skills/night-batch-ops/engine/orchestrate.test.mjs:201), 실제 CLI의 충돌 거부와 부수효과 0 검사 [autofinish-e2e.test.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish-e2e.test.mjs:639)가 있습니다. 다만 Windows `.cmd` 후손 프로세스 종료와 `error + signal` 비-timeout 조합은 빠져 있습니다. 요청에 따라 파일을 변경하지 않았고 테스트도 재실행하지 않았으므로 800/800은 기록 검증 기준입니다.

## 최종 판정

남은 항목은 **High 0, Medium 1, Low 2**입니다. R6는 핵심 deadline 경계를 상당 부분 올바르게 보강했지만 Windows 프로세스 트리 hard stop이 완결되지 않았고, 값 없는 상충 플래그 및 timeout 오분류가 남아 있으므로 현재 상태는 **commit-ready도 engine-install-ready도 아닙니다**. 또한 `INSTALL-ISOLATION.md`의 운영 격리 **A+D는 별도 필수 전제**이며, 이를 실제로 적용하더라도 위 코드 문제는 해소되지 않습니다.