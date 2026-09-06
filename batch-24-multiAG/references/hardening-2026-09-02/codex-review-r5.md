| 항목 | 판정 | 핵심 근거 | 테스트 성격 |
|---|:---:|---|---|
| NEW-H1 push 재활성화 | **FIXED** | 설정 선행 거부 + 큐 리터럴 `push:false` | 실제 CLI·실제 git/bare remote + 주입 실행 |
| NEW-H2 diagnose-only gate 실행 | **FIXED** | 명시 gate 거부, 기본 gate도 `[]` | 실제 CLI·실제 git·npm 호출계수 |
| NEW-H3 state/out 저장소 내부 쓰기 | **FIXED** | lexical·realpath·junction 경계 검사 | 실제 CLI·파일; junction은 조건부 |
| NEW-H4 Fable stderr 노출 | **FIXED** | source 고정 코드, 상세 분리, 모든 로그 마스킹 | 실제 자식 스텁 프로세스 |
| NEW-M1 no-gates 최종 상태 누락 | **FIXED** | 게이트 유무와 무관하게 최종 재수집 | 실제 자식 러너·실제 파일 변경 |
| NEW-M2 전체 deadline | **PARTIAL** | gate/run-night timeout은 제한되나 Fable·후속 라운드·BMAD 쓰기는 미제한 | 실제 시간 사용, 실행기는 주입 |
| NEW-M3 BMAD 실패 후 실행 지속 | **FIXED** | 실패한 계획의 스토리를 후보에서 봉쇄 | 실제 BMAD 파일 처리, 러너는 주입 |
| 신규 회귀 | **Medium 1 · Low 1** | deadline 불완전, 상충 CLI 플래그 허용 | 아래 상세 |
| SPEC §1/§3/§5/§7/§8/§10 | **구현 4 · 부분 2** | §5·§8 PARTIAL | — |
| BRIEF 정책 2/5 | **IMPLEMENTED / PARTIAL** | 로그 마스킹 완료, git 격리는 OS 강제 아님 | — |

## A. Round-4 지적 재검증

### NEW-H1 — FIXED

- 설정의 truthy `push`를 부작용 전에 거부한다: [autofinish.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:73), [autofinish.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:460).
- 큐 생성 시 다시 검사하고 최종 값은 리터럴 `false`다: [autofinish.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:358), [autofinish.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:383).
- `run-night.mjs`에는 여전히 `defaults.push`를 실행하는 일반 수동 큐 경로가 있지만, autofinish 큐에서 이를 켤 두 번째 경로는 발견되지 않았다. 이는 수동 큐의 기존 기능이지 autofinish 우회가 아니다.
- 테스트는 anchor-only가 아니다. E13 첫 사례가 실제 CLI와 실제 bare remote ref 불변을 확인한다: [autofinish-e2e.test.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish-e2e.test.mjs:594). 두 번째 사례는 주입 러너로 실제 argv에서 `--push` 부재를 확인한다: [autofinish-e2e.test.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish-e2e.test.mjs:608).

### NEW-H2 — FIXED

- CLI에서 `--diagnose-only --gates …`를 거부하고, diagnose-only의 기본 gate도 빈 배열로 만든다: [autofinish.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:163), [autofinish.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:176).
- 직접 API 호출도 `gatesExplicit`이면 거부하며, 이후 gate 실행 조건에도 `!diagnoseOnly`가 있다: [autofinish.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:453), [autofinish.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:528).
- E14는 실제 CLI 프로세스, 실제 git 트리 지문, npm 호출 기록을 검사한다. anchor-only가 아니다: [autofinish-e2e.test.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish-e2e.test.mjs:625).
- 안전성 우회는 없지만 `--gates`와 `--no-gates`를 동시에 넣으면 거부되지 않는 계약 불일치가 있다. 이는 아래 Low 회귀로 분리한다.

### NEW-H3 — FIXED

- `stateDir`와 최종 `reportPath` 모두 폴더 생성 전에 검사한다: [autofinish.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:442), [autofinish.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:459).
- 문자열 포함, 기존 조상의 realpath, 저장소 안을 가리키는 링크 구간을 모두 검사한다: [autofinish.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:103), [autofinish.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:125).
- 보고서의 별도 직접 쓰기도 같은 `reportPath` 검사를 통과한 뒤만 가능하다: [autofinish.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:462), [autofinish.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:689).
- E15는 실제 CLI와 실제 파일 트리를 사용한다: [autofinish-e2e.test.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish-e2e.test.mjs:649). 다만 junction 생성 실패를 허용하므로 junction 갈래는 환경에 따라 실행되지 않아도 테스트가 통과한다: [autofinish-e2e.test.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish-e2e.test.mjs:660). 따라서 전체 테스트는 anchor-only가 아니지만 “실제 junction 검증” 자체는 조건부다.

### NEW-H4 — FIXED

- 외부 실행 오류는 `runner-error`, `runner-timeout`, `runner-nonzero`만 source에 넣고 원문은 `errorDetail`로 분리한다: [orchestrate.mjs](C:/Projects/claude-skills/night-batch-ops/engine/orchestrate.mjs:183), [orchestrate.mjs](C:/Projects/claude-skills/night-batch-ops/engine/orchestrate.mjs:193), [orchestrate.mjs](C:/Projects/claude-skills/night-batch-ops/engine/orchestrate.mjs:246).
- 모든 정상 로그는 공용 마스커를 거치며 CLI 최상위 오류도 마스킹된다: [autofinish.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:447), [autofinish.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:925).
- 산출물은 `deepRedact`/`maskSecrets`를 거친다. Markdown 보고서 자체도 renderer에서 마스킹된다: [autofinish.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:480), [report.mjs](C:/Projects/claude-skills/night-batch-ops/engine/report.mjs:378).
- E16은 실제 Node 자식 프로세스 스텁이 stderr에 Authorization 값을 출력하고, 부모 stdout/stderr와 모든 산출물을 검사한다: [stub-claude.mjs](C:/Projects/claude-skills/night-batch-ops/engine/fixtures/stub-claude.mjs:116), [autofinish-e2e.test.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish-e2e.test.mjs:677). anchor-only가 아니다.
- 검사한 autofinish/orchestrate 콘솔 경로에서 마스킹을 우회하는 별도 출력은 발견하지 못했다.

### NEW-M1 — FIXED

- 일반 실행은 `gates.length`와 관계없이 `readProject → diagnose → backlog merge`를 다시 수행한다: [autofinish.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:631), [autofinish.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:645), [autofinish.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:648).
- 이후 readiness와 보고서도 최종 snapshot/diagnosis를 사용한다: [autofinish.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:653), [autofinish.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:665).
- E17은 실제 자식 러너 스텁이 스토리 파일을 변경한 뒤 전후 진단이 달라지는지 확인한다: [autofinish-e2e.test.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish-e2e.test.mjs:699). anchor-only가 아니다.

### NEW-M2 — PARTIAL

고쳐진 부분:

- 단일 절대 deadline과 잔여 시간 계산은 존재한다: [autofinish.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:464).
- gate와 run-night 러너 timeout은 잔여 시간으로 제한된다: [autofinish.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:485), [autofinish.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:894).
- 예산 소진 시 최종 gate를 건너뛴다: [autofinish.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:639).

남은 문제:

- Fable 계획 프로세스는 잔여 예산을 전달받지 않고 고정 기본 180초를 쓴다: [autofinish.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:843), [orchestrate.mjs](C:/Projects/claude-skills/night-batch-ops/engine/orchestrate.mjs:233).
- 라운드 진입, BMAD 쓰기, 계획 생성 전에는 deadline 검사가 없다: [autofinish.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:519), [autofinish.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:791).
- `--no-gates`에서 러너가 deadline을 넘긴 경우 최종 gate 조건이 거짓이라 `budget.exhausted`가 계속 false일 수 있다: [autofinish.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:882), [autofinish.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:640).

테스트는 문자열 anchor-only는 아니며 실제 벽시계 sleep을 사용하지만 gate/runner 함수는 주입 스텁이다: [autofinish.test.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.test.mjs:292). 실제 timeout으로 종료되는 자식 프로세스와 Fable timeout 경로는 검증하지 않는다.

### NEW-M3 — FIXED

- `rolledBack`, `rejected`, `conflicts` 중 하나라도 있으면 계획에 연결된 스토리 키를 봉쇄한다: [autofinish.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:795).
- 봉쇄 맵은 후보 산출 전에 기존 decision 봉쇄와 합쳐진다: [autofinish.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:808).
- E18은 실제 BMAD 경로 거부와 실제 큐 파일을 사용하여 봉쇄된 스토리 제외 및 독립 스토리 지속을 확인한다: [autofinish-e2e.test.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish-e2e.test.mjs:721). 러너 spawn 자체는 주입이지만 anchor-only는 아니다.
- 해시 충돌에서 봉쇄까지 이어지는 종단 테스트는 없으나, 모든 실패 형태가 동일한 `failed` 분기를 지나므로 코드 경로상 약화는 없다.

## B. R5 회귀 검사

두 대상 파일 모두 untracked여서 `git diff HEAD -- …` 결과는 비어 있다. 따라서 HEAD 대비 R5-only patch를 정확히 분리할 수 없었으며, 현재 파일과 R4 지적·R5 테스트를 직접 비교했다.

### Medium — deadline이 아직 전체 실행의 hard stop이 아니다

- 위치: [autofinish.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:519), [autofinish.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:791), [autofinish.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:843)
- 실패 시나리오: 라운드 QA가 예산 대부분을 소비한 뒤 Fable이 고정 180초 동안 실행되거나, 예산 소진 뒤 BMAD 쓰기·다음 라운드 진단이 계속된다. `--no-gates`이면 실제 초과 후에도 `budget.exhausted:false`로 보고될 수 있다.
- 최소 수정: 라운드 시작과 모든 대상 저장소 쓰기 전에 `remainingMs() <= 0`이면 루프를 중단한다. Fable 생성 시 `timeoutMs: min(configuredPlanTimeout, remainingMs())`를 전달하고, 모든 spawn 반환 직후 deadline을 재확인해 `budgetStop()`을 기록한다. 실제 timeout 자식 프로세스와 `--no-gates` 초과 테스트를 추가한다.

### Low — 상충하는 gate 플래그가 문서와 달리 허용된다

- 위치: [autofinish.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:166), [autofinish.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.mjs:173), [autofinish.test.mjs](C:/Projects/claude-skills/night-batch-ops/engine/autofinish.test.mjs:139)
- 실패 시나리오: `--diagnose-only --gates qa --no-gates`가 거부되지 않고 `--no-gates`가 조용히 승리한다. 안전상 gate는 실행되지 않지만 사용자는 명시한 QA가 실행됐다고 오해할 수 있고, “함께 쓸 수 없다”는 문서 계약과 다르다.
- 최소 수정: `diagnoseOnly && gatesRaw !== null`이면 `--no-gates` 존재 여부와 무관하게 거부한다. 일반 모드에서도 `--gates`와 `--no-gates` 동시 사용을 거부하는 편이 명확하다.

### `assertOutsideRepo` 의 deliberate deviation

**수용 가능하다.** 이 함수의 보안 목표는 산출물이 대상 저장소 내부로 들어가는 것을 막는 것이다. 저장소 밖 링크가 다른 저장소 밖 위치를 가리키는 것은 이 불변식을 깨지 않으며, `/tmp` 자체가 링크인 환경의 오탐을 피하는 이점이 있다. 단, 검사와 쓰기 사이 junction 교체 TOCTOU는 남으므로 신뢰할 수 없는 동시 로컬 프로세스까지 위협 모델에 넣는다면 OS 격리 또는 handle-relative 원자 경로 API가 필요하다. 이는 accepted residual이다.

## C. 최종 요구사항 판정

| 요구사항 | 판정 | 근거 |
|---|:---:|---|
| SPEC §1 프로젝트 자동 진단 | **IMPLEMENTED** | diagnose-only gate 0 및 state/out 경계가 강제됨 |
| SPEC §3 BMAD 흐름 유지 | **IMPLEMENTED** | 등재 실패 스토리는 구현 후보에서 봉쇄됨 |
| SPEC §5 병렬·자동 수정 | **PARTIAL** | deadline이 Fable·BMAD·후속 라운드 전체를 제한하지 못함 |
| SPEC §7 완료 기준 | **IMPLEMENTED** | no-gates에서도 실행 후 최종 상태를 재수집하며 미검증을 통과로 승격하지 않음 |
| SPEC §8 안전 경계 | **PARTIAL** | H1~H4는 해결됐지만 워커의 절대경로 git·환경 복구 우회는 OS 격리 없이 완전 차단되지 않음 |
| SPEC §10 사용자 보고 | **IMPLEMENTED** | 실행 후 상태 사용 및 Fable 오류 로그 마스킹 완료 |
| BRIEF 정책 2 로그 동일 마스킹 | **IMPLEMENTED** | Fable stderr 포함 콘솔·산출물 마스킹 경계 확인 |
| BRIEF 정책 5 git 상태 변경 실행단계 차단 | **PARTIAL** | PATH shim과 환경 정리는 있으나 프로세스 권한/네트워크 수준 강제는 아님 |

`TEST-RUN-FINAL.md`에는 793/793, skip/todo 0이 기록돼 있다: [TEST-RUN-FINAL.md](C:/Projects/claude-skills/night-batch-ops/references/hardening-2026-09-02/TEST-RUN-FINAL.md:90). 이번 리뷰 환경에서는 임시 폴더 생성이 `EPERM`으로 차단되어 이를 독립 재실행하지 못했다. 순수 orchestrate 테스트는 통과했으며, 나머지 실패는 코드 assertion이 아니라 테스트 fixture 생성 권한 실패였다.

## D. 전체 평가

현재 하네스는 **그대로 설치할 준비가 완료됐다고 보기 어렵다**. **must fix before install**은 전체 deadline이 Fable·BMAD 쓰기·후속 라운드까지 실제 hard stop이 되도록 보강하고, `--no-gates` 초과 시 예산 상태를 정확히 기록하는 Medium 문제다; 상충 gate 플래그 거부는 함께 고치는 것이 안전하다. **accepted residual**은 저장소 밖→밖 링크 허용, 경로 검사와 쓰기 사이 junction TOCTOU, 실제 Claude/Codex 호출 미검증이다. 워커의 절대경로 git 우회는 전용 무자격증명 계정·push 권한 제거·네트워크 차단 중 하나가 설치 환경에서 강제된다면 accepted residual로 둘 수 있지만, 그런 운영 격리가 없다면 BRIEF 정책 5 위반이므로 역시 **must fix before install**이다. main 병합·배포를 사람 승인으로 남기는 것만으로는 워커의 직접 push 가능성을 제거하지 못한다.