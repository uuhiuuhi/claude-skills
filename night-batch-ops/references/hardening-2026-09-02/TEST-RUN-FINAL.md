# 전체 테스트 완주 기록 (하드닝 라운드 마감 · 워커 R4)

## 명령

```
cd /c/Projects/claude-skills
node --test --test-concurrency=2 $(git ls-files -co --exclude-standard | grep '\.test\.mjs$')
```

`--test-concurrency=2` 는 장식이 아니다 — Windows 에서 기본 동시성(코어 수)으로 돌리면 자식 프로세스를
쓰는 e2e 테스트들이 겹쳐 `0xC0000142`(프로세스 초기화 실패)로 무작위 실패한다. README 에 명시된 값이다.

## 환경

| 항목 | 값 |
| --- | --- |
| 실행 시각 | 2026-09-03 09:38:52 (시작) |
| OS | Windows 11 Pro 10.0.26200 · Git Bash 셸 |
| Node | v24.18.0 |
| 동시성 | `--test-concurrency=2` |
| 대상 파일 | 32개 (`git ls-files -co --exclude-standard` · 추적 + 미추적 신규 테스트 전부) |
| 저장소 상태 | 미커밋 작업 트리 위에서 실행(커밋·푸시·stash 없음) |

## 결과 — 실패 0

러너 요약 4줄 원문:

```
ℹ tests 774
ℹ suites 192
ℹ pass 774
ℹ fail 0
```

전체 요약:

```
ℹ tests 774
ℹ suites 192
ℹ pass 774
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 596549.8114
```

벽시계(`time`): `real 9m56.744s`.

- **로직 실패 0건**.
- **환경 실패(`0xC0000142`) 0건** — 동시성 2 로 낮춘 상태에서 한 번도 재현되지 않았다.
- skipped 0 / todo 0 — `.only`·skip 으로 빠진 테스트가 없다(미추적 신규 파일 포함).

## 이번 실행이 덮은 R4 수정 4건

| # | 파일 | 확인 방식 |
| --- | --- | --- |
| 1 | `night-batch-ops/engine/bench.mjs` (CODEX_STUB 열람 증거) | `bench.test.mjs` 3/3 — 수정 전 `runBench` 는 `exit 4`(NO-OP STOP)로 RED 였다 |
| 2 | `auto-story-finish/providers/redact.mjs` · `night-batch-ops/engine/diagnose.mjs` · `run-night.mjs` | `diagnose.test.mjs`·`report.test.mjs`·`providers-hardening.test.mjs` 전부 GREEN + 재수출 동일성 테스트 신설 |
| 3 | `auto-story-finish/providers/spawn-safe.mjs` (bare `.cmd`) | PATH 에 실제 `.cmd` 심을 놓고 `%~dp0` 로 옆 파일을 읽는 **실제 실행** 테스트 |
| 4 | `auto-story-finish/providers/codex.mjs` (git C-인용 경로) | 한글 스토리 파일명을 git 형식(8진 이스케이프)으로 만들어 story 제외·impl 열람 판정 |

## NOT VERIFIED

- 실제 `claude -p` / `codex exec` 호출은 이 라운드에서 한 번도 하지 않았다(BRIEF 금지 사항). 벤치(`bench-stub.md`)의
  수치도 스텁 실측이며 LLM 시간을 대표하지 않는다.

---

# 추기 — 워커 R5 (자율 마무리 진입 루프 수리 · codex-review-r4 NEW-H1~H4 · NEW-M1~M3)

## 명령

```
cd /c/Projects/claude-skills
node --test --test-concurrency=2 $(git ls-files -co --exclude-standard | grep '\.test\.mjs$')
```

## 환경

| 항목 | 값 |
| --- | --- |
| 실행 시각 | 2026-09-03T01:29:28Z 시작 → 2026-09-03T01:43:27Z 종료 (UTC) |
| OS | Windows 11 Pro 10.0.26200 · Git Bash 셸 |
| Node | v24.18.0 |
| 동시성 | `--test-concurrency=2` |
| 대상 파일 | 32개 (`git ls-files -co --exclude-standard` · 추적 + 미추적 신규 테스트 전부) |
| 저장소 상태 | 미커밋 작업 트리 위에서 실행(커밋·푸시·stash 없음) |

## 결과 — 실패 0

러너 요약 원문:

```
ℹ tests 793
ℹ suites 202
ℹ pass 793
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 838562.3206
```

- R4 기준선 774 → **793**(+19 = R5 신설). 실패 0 · skipped 0 · todo 0.
- 벽시계는 R4(596초)보다 길다 — 같은 창에서 앞선 완주 시도를 10분에 끊었고(SIGTERM) 그 잔여 자식
  프로세스가 초반에 겹쳤다. 로직 실패·`0xC0000142` 환경 실패는 0건이다.

## 이번 실행이 덮은 R5 수정 7건

| # | 파일 | 확인 방식(뮤테이션 = 코드를 되돌려 RED 를 실제로 봤다) |
| --- | --- | --- |
| NEW-H1 | `engine/autofinish.mjs` (`assertQueueDefaultsSafe` · `push: false` 리터럴) | `push: Boolean(defaults.push)` 로 되돌리고 거부 2곳 삭제 → 단위 2건 + E13 RED |
| NEW-H2 | `engine/autofinish.mjs` (`parseArgs` 거부 · diagnose-only 게이트 0) | 거부 삭제 + `if (o.gatesExplicit) runGate…` 복원 → 단위 1건 + E14 2건 RED |
| NEW-H3 | `engine/autofinish.mjs` (`assertOutsideRepo`) | `runAutoFinish` 의 호출 2줄 삭제 → 단위 2건 + E15 RED |
| NEW-H4 | `engine/orchestrate.mjs` (고정 코드 3종 · `plan.errorDetail`) | `errorCodeOf` 에 `+ ':' + detail` 을 되붙임 → orchestrate 단위 + E16 RED |
| NEW-M1 | `engine/autofinish.mjs` (최종 재진단 무조건) | `if (!diagnoseOnly && gates.length)` 로 되돌림 → E17 RED |
| NEW-M2 | `engine/autofinish.mjs` (절대 deadline) | 러너 timeout 을 `Math.max(60_000, 예산)` 으로 되돌리고 최종 게이트 잔여 검사 삭제 → 예산 단위 RED |
| NEW-M3 | `engine/autofinish.mjs` (BMAD 폐기 → 봉쇄) | `Object.assign(blocked, bmadBlocked)` 삭제 → E18 RED |

뮤테이션 7건 모두 원상 복구했고, 복구본이 백업과 **바이트 단위로 동일**함을 `diff` 로 확인했다.

## R5 신설 테스트

| 파일 | 테스트 |
| --- | --- |
| `engine/autofinish.test.mjs` | `--diagnose-only + --gates` 거부 · diagnose-only 게이트 0 · `assertQueueDefaultsSafe` 3종 · `buildQueueFromPlan` push 고정 · 설정 push:true 부작용 0 · 경로 경계 3건(실제 junction 생성) · 예산 deadline 2건 · `storiesOfBmadPlan` |
| `engine/autofinish-e2e.test.mjs` | E13(설정 push 거부 · 원격 ref 불변 / 러너 argv `--push` 부재) · E14(진단 전용 게이트 거부 · npm 호출 0) · E15(state/out/junction exit 2) · E16(Fable stderr 토큰 전수 grep 0) · E17(`--no-gates` 최종 재진단) · E18(BMAD 폐기 봉쇄 후 독립 스토리 계속) |
| `engine/orchestrate.test.mjs` | 실행기 오류 고정 코드 3종 · `source` 원문 0 · `makeClaudePlanRunner` 오류 `code`/`detail` 분리 |
| `engine/fixtures/stub-claude.mjs` | `STUB_PLAN=leak` — stderr 로 `Authorization: Bearer <토큰>` 을 흘리며 실패하는 갈래 추가 |

## NOT VERIFIED (R5)

- 실제 `claude -p` / `codex exec` 호출 0(BRIEF 금지). Fable 누출 시나리오는 **스텁 프로세스**의 stderr 로 재현했다.
- `assertQueueDefaultsSafe` 의 **선행** 검사는 기본 설정 경로(`tools/auto/auto.config.json`)만 읽는다.
  설정이 다른 경로에 있으면 이 자리에서는 못 걸르고 `buildQueueFromPlan` 의 2차 방어선이 잡는다
  (그때는 라운드 게이트가 이미 1회 돈 뒤다). 현재 `readProject` 의 `DEFAULT_PATHS.config` 가 그 경로로
  고정돼 있어 실전 간극은 없지만, 경로가 설정으로 바뀌면 이 검사도 같이 옮겨야 한다.
- `assertOutsideRepo` 의 링크 검사는 「저장소 **안**을 가리키는 링크」만 거부한다(밖을 가리키는 링크는
  통과). `bmad-sync.realPathAllowed` 처럼 모든 링크 구간을 거부하면 `/tmp` 가 symlink 인 환경에서
  정상 경로까지 막혀 오탐이 된다고 보고 좁혔다.
- NEW-M3 의 conflict 재현은 **경로 거부**(guards.allowedPathPrefixes)로 결정적으로 만들었다.
  해시 충돌(사람이 계획 후 파일을 고침)로 같은 봉쇄가 나는 것은 E6b 가 `applyBmadWrites` 수준에서
  이미 덮지만, 그 경로로 봉쇄까지 이어지는 종단 실측은 하지 않았다(코드 경로는 동일하다).

---

# 추기 — 워커 R6 (2026-09-03 · codex-review-r5 B절 Medium 1 · Low 1)

## 전체 완주

```
$ cd /c/Projects/claude-skills && node --test --test-concurrency=2 $(git ls-files -co --exclude-standard | grep '\.test\.mjs$')

시작 2026-09-03T11:10:51+09:00 · 종료 2026-09-03T11:20:36+09:00

ℹ tests 800
ℹ suites 203
ℹ pass 800
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 585085.6105
```

- R5 기준선 793 → **800**(+7 = R6 신설). 실패 0 · skipped 0 · todo 0. 벽시계 585초.
- 자기 소유 완주(`autofinish.test.mjs` + `orchestrate.test.mjs`): tests 57 · pass 57 · fail 0 · 19.2초.
  `autofinish-e2e.test.mjs` 단독: tests 27 · pass 27 · fail 0 · 83.5초.

## 이번 실행이 덮은 R6 수정

| # | 파일 | 확인 방식(뮤테이션 = 코드를 되돌려 RED 를 실제로 봤다) |
| --- | --- | --- |
| Medium ① 라운드 진입 | `engine/autofinish.mjs` (루프 머리 `remainingMs() <= 0` → `budgetStop` + break) | 그 줄 삭제 → 「시작 시점에 이미 마감이면 라운드를 한 번도 열지 않는다」 RED(`마감 뒤인데 라운드를 열었다`) |
| Medium ① BMAD 쓰기 | `engine/autofinish.mjs` (`executeRound` 의 `budgetHalt('BMAD 등재')`) | 그 줄 삭제 → 「예산이 다하면 BMAD 등재를 하지 않는다」 RED(`예산이 다한 뒤 BMAD 등재가 대상 저장소를 고쳤다` — **실제 파일 지문이 달라졌다**) |
| Medium ② Fable timeout | `engine/orchestrate.mjs` (`min(설정 상한, 잔여)`) · `engine/autofinish.mjs` (`planBudgetMs` 전달) | `const timeout = timeoutMs` 로 되돌림 → 「잔여 예산이 짧으면 잔여가 이기고…」 RED |
| Medium ③ `--no-gates` 초과 기록 | `engine/autofinish.mjs` (러너 spawn 직후 재확인 · 최종 확인의 `gates.length` 조건 제거) | 두 자리를 R5 형태로 되돌림 → 「러너를 실제 자식 프로세스로 띄우고…」 RED(`러너 초과 사유가 없다`) |
| Medium 부수 발견 | `engine/orchestrate.mjs` (timeout 을 error 보다 **먼저** 분류) | 순서를 되돌림 → 「실제 자식 프로세스가 timeout 을 넘기면…」 RED(`오류 코드가 다르다: runner-error`) |
| Low 상충 플래그 | `engine/autofinish.mjs` (`parseArgs` — `--gates` + `--no-gates` 거부) | 거부 블록 삭제 → 단위 「--gates 와 --no-gates 를 함께 주면…」 RED(`Missing expected exception`) |

뮤테이션 6건 모두 백업본에서 원상 복구했고, 복구 뒤 자기 소유 57/57 GREEN 을 다시 확인했다.

## R6 신설 테스트 (+7)

| 파일 | 테스트 |
| --- | --- |
| `engine/autofinish.test.mjs` (+4) | ① `--gates`+`--no-gates` 모드 무관 거부(진단 전용 조합 포함) ② **실제 자식 러너 스텁**(60초 sleep)이 잔여 예산 timeout 으로 죽고 `--no-gates` 여도 `budget.exhausted:true` · `run.json` 반영 · 보고서 ⑧ 에 「예산 소진」 ③ 예산 소진 뒤 BMAD 등재 0 — **픽스처 트리 해시 불변** · `round-0-bmad-apply.json` 부재 · 러너 0 ④ 시작 시점 마감이면 라운드 진입 0(스냅숏 파일 부재 · 게이트 0 · 러너 0 · 트리 해시 불변) |
| `engine/orchestrate.test.mjs` (+2) | ① **실제 자식 프로세스**(cmd/sh 심 → node, 2.5초 sleep)가 0.3초 상한에 걸려 죽고 `runner-timeout` · `requestPlan` 이 규칙 계획으로 흡수 ② `min(설정 상한, 잔여)` 3갈래 + `requestPlan` 이 잔여를 실행기에 전달 |
| `engine/autofinish-e2e.test.mjs` (+1) | E14 에 상충 플래그 2조합을 **실제 CLI 프로세스**로 — exit 2 · `qa-calls.log` 0줄 · porcelain·트리 해시 불변 · 산출물 폴더 미생성 |

## NOT VERIFIED (R6)

- 실제 `claude -p` / `codex exec` 호출 0(BRIEF 금지). Fable timeout 은 **스텁 프로세스**(node sleep)를
  실제 심으로 불러 재현했다 — 실제 CLI 가 SIGTERM 을 어떻게 처리하는지는 확인하지 않았다.
- 라운드 진입 가드는 **시계 주입**으로 재현했다(시작 시각 뒤로는 마감을 넘긴 시계). 실제 벽시계로
  라운드 사이에 마감이 지나는 상황은 러너·BMAD 가드가 먼저 잡아 그 자리에 도달하지 않는다.
- Windows 에서 `.cmd` 심을 통해 부른 자식은 spawnSync 의 timeout 이 **cmd.exe 만** 죽인다 —
  손자(node)가 파이프를 쥐고 있으면 부모는 손자가 끝날 때까지 기다린다(2026-09-03 실측: 30초 sleep →
  30.1초 대기). 그래서 계획 실행기 테스트의 sleep 을 2.5초로 잡았다. **엔진의 실제 계획 호출도 같은
  성질을 가진다** — `timeoutMs` 는 「그 시점부터 더 기다리지 않겠다」가 아니라 「cmd.exe 를 죽이겠다」다.
  손자 프로세스까지 확실히 끊으려면 job object·프로세스 그룹 kill 이 필요하고, 이번 라운드 범위 밖이다.


---

# 추기 — 워커 R7 (마감 수리 · 2026-09-03 · codex-review-r6 3건)

R6 가 남긴 **Medium 1 · Low 2** 를 닫았다. 위 「NOT VERIFIED (R6)」 마지막 항목
(「Windows `.cmd` 심의 손자 프로세스는 못 끊는다 · 이번 라운드 범위 밖」)이 **이번에 해소**됐다.

## 고친 것

| # | 파일:줄 | 무엇을 어떻게 |
| --- | --- | --- |
| Medium 프로세스 트리 hard stop | **신규** `engine/spawn-deadline.mjs` (`spawnWithDeadline`·`killTree`) | 동기 `spawnSync` 를 버리고 **비동기 `spawn` + 자기 타이머**로 바꿨다. 마감이면 win32 `taskkill /PID <pid> /T /F` · POSIX `detached:true` 프로세스 그룹 `process.kill(-pid,'SIGKILL')` 로 **트리 전체**를 끊고, 파이프 EOF 를 **기다리지 않고 즉시 반환**한다(수집한 stdout/stderr 유지 · `timedOut:true`). 반환 모양은 `spawnSync` 와 동일 |
| Medium — 계획 실행기 | `engine/orchestrate.mjs:15`·`:199`·`:250`·`:261` | `spawn` 기본값을 `spawnWithDeadline` 으로. `makeClaudePlanRunner` 가 만드는 실행기와 `requestPlan` 이 **async** 가 됐다(`await runner(...)`) |
| Medium — 게이트·러너 spawn | `engine/diagnose.mjs:29`·`:877`·`:884`·`:888` · `engine/autofinish.mjs:33`·`:463`·`:512`·`:560`·`:678`·`:956` | `runGateProbe` 와 `executeRound` 도 async. `exec`·`spawnRunner` 기본값을 같은 헬퍼로 통일했다(주입 스텁은 동기여도 그대로 산다). `runGateProbe` 의 timeout 판정에 `timedOut` 표식 추가 |
| Medium — 호출 사슬 | `engine/run-night.mjs` (`applyOrchestrator`·`selectQueue` → async · 호출부 `await`) | `requestPlan` 이 async 가 되면서 러너 쪽 사슬도 이었다(최상위 루프는 이미 `await` 안이다) |
| Low — 값 없는 상충 플래그 | `engine/autofinish.mjs:163~181` | 충돌 판정을 `gatesRaw !== null` → **`has('gates')`**(플래그 존재 기준)로. `--gates --no-gates` 는 다음 토큰이 `--` 라 값이 null 이 돼 예전엔 조용히 통과했다. 값 없는 `--gates` 단독도 거부(「--gates 에 값이 없습니다」) |
| Low — timeout 오분류 | `engine/orchestrate.mjs:273~281` | 분류 순서를 **① `timedOut`/`ETIMEDOUT` → ② 일반 `error`(ENOBUFS 등 = `runner-error`) → ③ signal(안전 폴백 `runner-timeout`)** 로. R6 의 signal-우선 순서는 `maxBuffer` 초과를 예산 초과로 둔갑시켰다 |

문서: `night-batch-ops/AUTOFINISH.md` 의 `--budget-min` 행과 불변식 6 에 **프로세스 트리 종료**를 명시.

## 추가 테스트 (실제 프로세스 · 스텁 아님)

| 파일 | 테스트 | 실제 실행 |
| --- | --- | --- |
| **신규** `engine/spawn-deadline.test.mjs` (+8) | ① `.cmd`/`.sh` 심 → **손자 node** 가 stdout 파이프를 30초 쥐어도 0.5초 마감에 **1초 안에 반환** + 손자 pid 사망(`process.kill(pid,0)`) ② 직접 자식이 먼저 끝나고 **떨어져 나간 손자**가 파이프를 쥔 경우도 마감에 반환 ③ 정상 종료 회귀(status·stdout·stderr) ④ stdin input 전달 ⑤ `maxBuffer` 초과 = ENOBUFS(≠ timeout) ⑥ 없는 실행 파일 = 던지지 않고 `error` ⑦⑧ `killTree` 플랫폼 분기·직접 종료 폴백 | 8/8 pass · 1.9초 |
| `engine/orchestrate.test.mjs` (+2) | ① **실제 프로세스가 12MB 를 뱉어** 8MB 상한을 넘김 → `runner-error`(detail 에 ENOBUFS) · `requestPlan` 은 `deterministic-fallback(runner-error)` ② `timedOut` 표식 · `ETIMEDOUT` · 다른 error+signal · 원인 없는 signal 4갈래 분류 | 16/16 pass · 1.1초 |
| `engine/autofinish.test.mjs` (기존 it 보강) | `--gates --no-gates`(값 없음) · `--no-gates --gates` · `--gates` 단독 · `--gates --dry-run` 거부 + 한쪽만 준 정상 조합 회귀 | 43/43 pass · 19.4초 |
| `engine/autofinish-e2e.test.mjs` (+1) | 위 4조합을 **실제 CLI 프로세스**로 — exit 2 · `qa-calls.log` 0줄 · porcelain·트리 해시 불변 · 산출물 폴더 미생성 | 28/28 pass · 약 84초 |
| `engine/diagnose.test.mjs` (기존 it 보강) | `runGateProbe` 4건을 async 계약으로 갱신 + `timedOut` 표식만으로도 exit 124 | 41/41 pass |

## 뮤테이션 (코드를 되돌려 RED 를 실제로 봤다 — 각 1회)

| 되돌린 것 | 결과 |
| --- | --- |
| `taskkill` 에서 `/T` 제거(= cmd.exe 만 죽인다) | 「손자가 파이프를 30초 쥐고 있어도…」 RED — `손자 pid 12620 가 살아남았다 — cmd.exe 만 죽었다(트리 종료 실패)` · killTree 단위도 RED |
| 마감 시 `finish()` 즉시 반환 → `child.on('close')` 대기 | 「떨어져 나간 손자…」 RED — **30099ms 걸렸다**(원래 사고 그대로 재현) |
| 분류 순서를 signal 우선으로 되돌림 | 「maxBuffer 초과(ENOBUFS)는 runner-error 다」 RED — `출력 과다가 runner-timeout 로 분류됐다` |
| `has('gates')` → `gatesRaw !== null` + 값 없음 검사 삭제 | 단위 「--gates 와 --no-gates 를 함께 주면…」 RED · 종단 「`--gates --no-gates`(값 없음)…」 RED |

뮤테이션 4건 모두 원상 복구했고, 복구 뒤 해당 파일이 다시 GREEN 임을 확인했다.

## 전체 실행 (R7 최종)

```
node --test --test-concurrency=2 $(git ls-files -co --exclude-standard | grep '\.test\.mjs$')

ℹ tests 811
ℹ suites 206
ℹ pass 811
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 643125.9592
```

R6 기준선 800 → **811**(+11 = spawn-deadline 8 · orchestrate 분류 2 · autofinish-e2e 1). 실패 0 · skipped 0 · todo 0.

## NOT VERIFIED (R7)

- 실제 `claude -p` / `codex exec` 호출 0(BRIEF 금지). 트리 종료는 **node 스텁 프로세스**로만 확인했다 —
  실제 CLI 가 `taskkill /F` 를 받았을 때 남기는 임시 파일·세션 상태는 확인하지 않았다.
- **POSIX 경로는 이 기계(Windows 11)에서 실행하지 못했다.** `detached:true` + `process.kill(-pid)` 는
  `killTree` 단위 테스트(주입 `kill` 로 인자 검증)까지만 검증했고, 실제 프로세스 그룹 종료는 미검증이다.
  트리 테스트 자체는 플랫폼 분기를 갖고 있어 Linux/macOS 에서 그대로 돌면 실측된다.
- `taskkill` 은 **비동기**로 띄운다(실측 250ms — 동기로 기다리면 「마감 즉시 반환」이 그만큼 깎인다).
  그래서 「반환 시점에 손자가 이미 죽어 있다」는 보장하지 않는다 — 테스트는 최대 6초 폴링으로 사망을
  확인한다. 호출부가 반환 직후 프로세스를 끝내면 종료 신호가 늦을 수 있다(러너·게이트 경로는 반환 뒤
  보고서 쓰기가 이어져 해당 없음).
- `spawnWithDeadline` 의 `encoding:'buffer'` 경로는 코드상 지원하지만 이 저장소에서 쓰는 곳이 없어
  테스트하지 않았다.

---

# 추기 — 워커 R8 (2026-09-03 · 최종 마감 수리 · opus)

`codex-review-r7.md` 잔여 **Medium 1 · Low 1** 을 닫았다.

## 고친 것

| finding | 파일:줄 | 무엇을 어떻게 |
|---|---|---|
| **Medium** — wrapper 선종료 시 고아 손자 미종료 | `engine/spawn-deadline.mjs:36`(`windowsSweepScript`) · `:92`(`killTree`) · `:167`(토큰·spawn 시각) | `taskkill /T` 는 **살아 있는 부모**의 트리만 걷는다 — wrapper 가 먼저 죽으면 고아 손자를 못 찾는다. win32 에 그물을 하나 더 던진다: 원래 wrapper PID 를 뿌리로 `Get-CimInstance Win32_Process` 의 `ParentProcessId` 를 **BFS 재귀 탐색**(손자의 손자까지 · Windows 는 부모가 죽어도 PPID 값을 남긴다) → 찾은 PID 전부 `Stop-Process -Force`. PID 재사용 오탐은 `CreationDate ≥ spawn 시각 −1초` 로 좁힌다. 스크립트는 `-EncodedCommand`(UTF-16LE base64)로 넘겨 셸/PS 재해석 자리를 없앴고, pid 는 정수 · 표식은 `[A-Za-z0-9-]` 만 싣는다. POSIX 는 종전대로 `detached:true` 프로세스 그룹 `SIGKILL`(고아도 같은 그룹) |
| **Low** — 게이트 ENOBUFS 오분류 | `engine/diagnose.mjs:855`(`GATE_EXIT_OVERFLOW`) · `:891~911`(`runGateProbe`) | 분류 순서를 계획 실행기(`orchestrate.mjs:279`)와 통일: ① `timedOut`/ETIMEDOUT → **124** ② 그 밖의 error(ENOBUFS) → **125 · 사유 「출력 과다」** ③ 원인 없는 signal → 124 폴백. 종전엔 `signal === 'SIGTERM'` 만으로 timeout 을 판정해 64MB 출력 초과가 `exit 124` 로 둔갑했다 |

`AUTOFINISH.md` 불변식 6 에 고아 손자 처리와 **한계 3가지**(ⓐ PID 재사용 ⓑ Job Object 부재 = 사후 스윕 ⓒ `AUTO_SPAWN_TOKEN` 폴백은 WMI 가 env 를 못 읽어 거의 무효)를 명시했다.

## 추가·변경 테스트 (실제 프로세스 · 스텁 아님)

| 파일 | 테스트 | 결과 |
|---|---|---|
| `engine/spawn-deadline.test.mjs` | **변경** 「wrapper 가 먼저 죽어 **고아가 된 손자**도 마감에 죽는다(재귀 스윕)」 — `.cmd` 심이 `start /b node`(30초 대기)로 손자를 띄우고 **즉시 종료** → 0.5초 마감 후 손자 pid 를 `process.kill(pid,0)` 로 **사망 단언**(종전 `:82` 는 「테스트가 직접 종료」였다) | pass · 1.08초 |
| `engine/spawn-deadline.test.mjs` | **변경** `killTree` 단위 — win32 는 그물 **둘**(taskkill + PowerShell 스윕) · `-EncodedCommand` 디코드해 `ParentProcessId`·BFS 루프·`CreationDate`·`Stop-Process`·하한 `spawn−1s` 를 문다 | pass |
| `engine/spawn-deadline.test.mjs` | **신규** 「스윕 스크립트는 정수 pid 만 받고 · 표식은 안전 문자만 싣는다」 — 비정수 pid 거부 · 위험한 표식은 스크립트에 실리지 않음 | pass |
| `engine/diagnose.test.mjs` | **신규** 「runGateProbe — 출력 과다(ENOBUFS)는 timeout 이 아니다 · exit 124 금지 · 사유 「출력 과다」」 — ENOBUFS+SIGTERM+timedOut:false → 125·「출력 과다」 / 진짜 timeout → 124 / 원인 없는 signal → 124 폴백 | pass |

자기 소유 실행: `spawn-deadline.test.mjs` **9/9 · 2.6초** · `diagnose.test.mjs` **42/42 · 8.9초**.

## 뮤테이션 (각 1회 · 코드를 실제로 되돌려 확인)

| 되돌린 것 | 결과 |
|---|---|
| `killTree` win32 ② 재귀 스윕 제거(throw 로 차단) | **RED** — 「고아 손자 pid 2572 가 마감 뒤에도 살아남았다」(20초 폴링 내내 생존) + `killTree` 단위도 RED(그물 1개) |
| `runGateProbe` 분류에 `\|\| r?.signal === 'SIGTERM'` 되돌림 | **RED** — 「출력 과다(ENOBUFS)는 timeout 이 아니다」 실패(exit 124 로 둔갑) |

## 전체 실행 (R8 최종)

```
node --test --test-concurrency=2 $(git ls-files -co --exclude-standard | grep '\.test\.mjs$')

ℹ tests 813
ℹ suites 206
ℹ pass 813
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 581872.6875
```

R7 811 → **813**(+2 = spawn-deadline 스윕 스크립트 가드 1 · diagnose ENOBUFS 1). 실패 0 · skipped 0 · todo 0. 다른 워커 없음.

## NOT VERIFIED (R8)

- **POSIX 고아 경로 미실측** — 이 기계는 Windows 11 뿐이다. `detach.sh` 분기는 코드에 있으나 실행하지 못했다(Linux/macOS 에서 그대로 돌면 실측된다).
- **PID 재사용 실사례 미재현** — `CreationDate` 필터가 실제 재사용 상황에서 오탐을 막는지는 재현 조건을 만들 수 없어 확인하지 못했다. 필터가 스크립트에 실리는 것까지만 단위로 문다.
- **`AUTO_SPAWN_TOKEN` 폴백 미실측** — WMI 가 프로세스 env 를 못 읽어 이 경로가 실제로 프로세스를 잡는 시나리오를 만들 수 없다. 스크립트 생성·주입 차단만 단위로 확인했고, 한계는 `AUTOFINISH.md` 불변식 6 ⓒ 에 명시했다.
- **깊은 다단(손자의 손자) 미실측** — BFS 루프는 스크립트 단위 앵커로만 확인했다. 실제 3단 이상 트리는 만들지 않았다.
- 실제 `claude -p` / `codex exec` 호출 0(BRIEF 금지) — R7 항목 그대로 유효.
