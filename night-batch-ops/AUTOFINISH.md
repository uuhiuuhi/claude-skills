# 자율 마무리(Autonomous Finish) 사용 설명

> 「이 프로젝트의 지금 상태를 파악하고 **배포 가능한 수준까지 자율적으로 마무리**해줘.」
> 이 한 줄이 들어왔을 때 도는 것이 자율 마무리다. 범위·우선순위·완료 기준을 사람이 쓰지 않아도,
> 하네스가 BMAD 산출물과 **실제 구현 상태**를 읽어 남은 일을 스스로 계획하고 밤 배치로 돌린다.
>
> 요구 SoT: `references/hardening-2026-09-02/AUTONOMOUS-FINISH-SPEC.md` ·
> 설계 SoT: `references/hardening-2026-09-02/AUTONOMOUS-FINISH-DESIGN.md`

**「배포 가능한 상태」와 「배포」는 다른 말이다.** 자율 마무리는 커밋(워크트리·`auto/*` 브랜치)까지만 하고,
**푸시·main 머지·배포·외부 발송은 하지 않는다.** 그것은 언제나 사람 승인이다.

---

## 1. 언제 쓰나

| 이럴 때 | 쓴다 | 대신 쓸 것 |
|---|---|---|
| 「지금 어디까지 됐는지 보고, 되는 데까지 밀어 줘」 | ✅ 자율 마무리 | — |
| 「어젯밤 뭐 됐는지만 보자」 | ❌ | `morning-brief` |
| 「오늘 밤 이 스토리들을 돌려」(범위를 사람이 정했다) | ❌ | `night-batch` · `run-night.mjs --queue` |
| 「지금 상태만 진단해 줘. 아무것도 건드리지 마」 | ✅ `--diagnose-only` | `dev-status`(현황판) |

트리거 문구 예 — 「배포 가능한 수준까지 자율적으로 마무리해줘」 · 「남은 거 알아서 끝내 줘」 ·
「지금 상태 파악하고 할 수 있는 데까지 진행해」 · 「자율 마무리 돌려줘」.

---

## 2. 명령

```bash
node <skill>/engine/autofinish.mjs --root <프로젝트 경로>
```

| 옵션 | 기본값 | 뜻 |
|---|---|---|
| `--root <경로>` | `.` | 대상 프로젝트 루트(`package.json` 이 있는 곳) |
| `--diagnose-only` | 꺼짐 | **읽기만** 한다 — 게이트 0회 · 러너 0회 · 대상 저장소 쓰기 0바이트. `--gates` 와 **같이 쓸 수 없다**(아래 거부 규칙 ②) |
| `--dry-run` | 꺼짐 | 러너까지 띄우되 실제 작업은 하지 않는다(무엇을 돌릴지만 본다). BMAD 쓰기도 하지 않는다 |
| `--max-rounds <n>` | `3` | 진단→실행 라운드 상한 |
| `--budget-min <분>` | `480` | 전체 예산. **절대 deadline** 이다 — 게이트·러너·계획의 timeout 이 `min(개별 상한, 잔여)` 로 잘리고, 잔여가 0 이면 **라운드 진입·BMAD 등재·계획·러너·최종 게이트를 전부 건너뛴다**. 마감은 **프로세스 트리 종료**(win32 `taskkill /T /F` · POSIX 그룹 SIGKILL)로 집행하고 파이프를 기다리지 않는다 |
| `--gates qa,build` | `qa` | 돌릴 검사. **qa 는 라운드마다 + 마지막 1회**, 나머지는 마지막 1회. `--no-gates`·`--diagnose-only` 와 **같이 쓸 수 없다**(거부 규칙 ②·④) |
| `--no-gates` | — | 검사를 한 번도 돌리지 않는다(진단만 빨리 볼 때). **최종 재진단은 그래도 한다**. `--gates` 와 **같이 쓸 수 없다**(거부 규칙 ④) |
| `--state <폴더>` | `$AUTO_BATCH_STATE_DIR` 또는 `~/.baroos-auto/autofinish` | 산출물·감사 기록이 쌓이는 곳. **대상 저장소 밖이어야 한다**(아래 거부 규칙 ③) |
| `--out <경로>` | `<state>/autofinish/<runId>/report.md` | 사람이 읽는 보고서 경로. 역시 **대상 저장소 밖**이어야 한다 |
| `--bmad-writes on\|plan` | `plan` | `plan` = 계획만 세운다 / `on` = `_bmad-output/` 에 실제로 등재한다 |
| `--plan-model <모델>` | `fable` | 편성 계획을 짜는 지휘 모델 |

환경변수 — `CLAUDE_BIN`/`CODEX_BIN`(실행 파일 지정) · `AUTOFINISH_NO_LLM=1`(지휘 모델을 부르지 않고 규칙 계획만 쓴다).

경로·모델 인자는 실행 **전에** 검사한다(`providers/spawn-safe`). 셸 메타문자가 하나라도 있으면 프로세스도
파일도 만들지 않고 종료 코드 2 로 거부한다.

### 거부 규칙 3종 — 조용히 무시하지 않는다 (2026-09-02 codex-review-r4)

무시는 「켰다고 믿는 사람」을 만들고, 그 믿음이 다음 사고다. 아래 넷은 **종료 코드 2 · 부작용 0**
(폴더도 만들지 않고 게이트·러너·모델을 부르지 않는다)으로 끊는다.

| # | 무엇 | 왜 |
|---|---|---|
| ① | `auto.config.json` 의 `autofinish.queueDefaults.push: true` | 큐의 `defaults.push` 는 **언제나 `false`** 다. 설정으로 켜면 러너가 `--push` 를 붙여 원격에 밀 수 있다 — 외부 반영은 사람 승인이다 |
| ② | `--diagnose-only` 와 `--gates` 동시 지정 | `npm run <게이트>` 는 코드젠·포맷으로 대상 저장소에 **쓸 수 있다**. 진단 전용의 「쓰기 0바이트」가 그 자리에서 깨진다. `--diagnose-only` 는 기본 `qa` 도 빈 배열로 접는다 |
| ③ | `--state`·`--out`(그리고 `$AUTO_BATCH_STATE_DIR` 기본값)이 대상 저장소 **안** | 스냅숏·로그·큐·보고서가 저장소를 더럽힌다. 판정은 문자열 포함 + **realpath**(가장 가까운 기존 조상) + 경로 구간의 symlink·junction 세 갈래다 — 저장소 밖처럼 보이는 링크가 안을 가리키면 거부한다 |
| ④ | `--gates` 와 `--no-gates` 동시 지정 | 예전에는 `--no-gates` 가 조용히 이겼다. 안전하게 **안** 돌긴 하지만 사람은 「내가 적은 qa 가 돌았다」고 읽는다 — 모드와 무관하게 거부한다(`--diagnose-only --gates qa --no-gates` 도 같다) |

### 첫 실행 권장 순서

```bash
# ① 아무것도 건드리지 않고 지금 상태만 본다
node <skill>/engine/autofinish.mjs --root <프로젝트> --diagnose-only --no-gates --out ~/af-report.md

# ② 무엇을 돌릴지만 본다(러너는 리허설로 돈다)
node <skill>/engine/autofinish.mjs --root <프로젝트> --dry-run --max-rounds 1

# ③ 실제로 돌린다
node <skill>/engine/autofinish.mjs --root <프로젝트> --max-rounds 3 --bmad-writes on
```

---

## 3. 무엇을 하는가 (한 라운드)

```
readProject        대상 저장소를 읽는다(쓰기 0) — 에픽·원장·스토리 md·코드·테스트·배포 설정·git
  ↓
runGateProbe(qa)   npm run qa 를 1회 돌린다 — 「된다」의 유일한 1급 증거
  ↓
diagnose           스토리마다 실제로 되는가를 판정한다. **문서의 done 은 단독으로 완료가 아니다**
  ↓
buildBacklog       남은 일을 7단계 우선순위로 세운다(①비밀·데이터 … ⑦내부 구조·문서)
  ↓
needsHuman         사람이 정해야 하는 8범주만 질문으로 뽑아 결정 인박스에 올린다(나머지는 묻지 않는다)
  ↓
mapToStories       기존 스토리에 붙일지 · 새 스토리를 만들지 정한다(BMAD 를 우회하지 않는다)
  ↓
planBmadWrites     `_bmad-output/` 쓰기 계획(덧붙이기만 · 사람 변경은 해시로 지킨다)
  ↓
buildDag/assign    선행·파일 충돌로 순서를 세우고, 만든 쪽과 다른 제공자에게 리뷰를 맡긴다
  ↓
requestPlan(fable) 지휘 모델이 「무엇부터 묶을까」를 낸다 → **검증기를 통과할 때만** 채택
  ↓                 (어긋나면 말없이 규칙 계획으로 — 밤은 서지 않는다)
  ↓                 ※ 자율 마무리는 라운드마다 후보가 바뀌므로 **매 라운드 새로 묻는다**.
  ↓                    후보 지문 캐시(`orchestrator-cache.json` · 기본 12시간)는 30분 슬롯이
  ↓                    반복되는 `run-night --auto-plan` 쪽에만 있다(👤 2026-09-03 「(가)」).
buildQueueFromPlan run-night 가 그대로 먹는 큐 JSON
  ↓
run-night --queue  기존 러너 계약 그대로(워크트리 · `auto/*` 브랜치 · 커밋 가드 · 통합 게이트)
```

라운드가 끝나면 다시 진단하고 **계속할지 정한다**:

| 판정 | 언제 | 무슨 일 |
|---|---|---|
| `continue` | 진전이 있고 예산·상한 안 | 다음 라운드 |
| `escalate` | 상위 3단계 문제가 **늘었다** / 같은 원인으로 **3회** 막혔다 | 즉시 중단 · `escalation.md` 6항 · 종료 코드 1 |
| `stop` | 라운드 상한 · 백로그가 **한 건도** 달라지지 않음 · 예산 초과 | 정리하고 보고 |
| (환경 실패) | 인증·사용 한도·네트워크·권한으로 막혔다 | **재실행하지 않는다** — 그 자리에서 끊고 `escalation.md` · 종료 코드 1 |

`--diagnose-only` 는 이 루프를 한 바퀴만 돌되 게이트·러너·쓰기를 전부 건너뛴다. 그래도
**「사람이 정해 줘야 넘어가는 것」은 계산해서 보고서 10절에 싣는다**(인박스에 쓰지는 않는다).

---

## 4. 안전 경계 — 승인 없이 하지 않는 것

1. **푸시·main 머지·배포·외부 발송 0.** 큐의 `defaults.push` 는 항상 꺼진 채로 나간다 — 값이 리터럴
   `false` 고, 설정(`autofinish.queueDefaults.push`)에 `true` 가 있으면 무시가 아니라 **거부**한다
   (거부 규칙 ①). 그래서 `run-night` 로 넘어가는 인자에 `--push` 가 붙을 길이 없다.
2. **main 직접 작업 0.** 실행은 전부 러너 계약(워크트리 · `auto/<날짜>` 브랜치)을 탄다.
3. **대상 저장소 쓰기는 `_bmad-output/` 뿐이다.** 그 밖 경로가 계획에 섞이면 **계획 전체를 폐기**한다.
   경로 판정은 문자열 접두사가 아니라 **실경로**다 — 경로 구간에 심볼릭 링크·junction(reparse point)이
   있거나, 가장 가까운 기존 부모의 `realpath` 가 `realpath(<저장소>/_bmad-output)` 밖을 가리키면 거부한다.
   (2026-09-02 codex-review-r3 M3: `_bmad-output/implementation-artifacts` 를 바깥 폴더 junction 으로
   걸어 두면 경로는 여전히 `_bmad-output/…` 인데 실제 쓰기는 저장소 밖에서 일어났다.)
4. **덧붙이기만 한다.** 허용된 절(`### Review Findings` · `### Completion Notes List` · `### File List` ·
   `## Change Log` 등)에만 쓰고, 원문의 줄이 하나라도 사라지거나 `Status:` 줄이 바뀌면 거부한다.
   계획을 세운 뒤 사람이 그 파일을 고쳤으면 해시가 어긋나 **전체 폐기**한다(부분 적용 없음).
5. **비밀정보는 어디에도 원문으로 남기지 않는다.** 스냅숏·진단·게이트 로그·러너 로그·보고서 전부
   쓰기 직전에 다시 마스킹한다. **콘솔로 나가는 줄도 같다** — `log()` 와 최상위 CLI 오류 출력이
   전부 `maskSecrets` 를 지난다. 그래서 지휘 모델(Fable)이 stderr 에 토큰을 뱉으며 실패해도
   그 문자열이 터미널·CI 로그에 남지 않는다. 실패 사유는 `plan.source` 에 **고정 코드**
   (`runner-error` · `runner-timeout` · `runner-nonzero`)로만 적히고, 상세는 `plan.errorDetail`
   한 자리로만 흘러 산출물 쓰기 직전에 `deepRedact` 를 지난다
   (2026-09-02 codex-review-r4 NEW-H4: `deterministic-fallback(runner-error:<stderr 원문>)` 이
   `[ORCHESTRATOR] source=…` 로그로 그대로 재출력됐다).
   **마스커는 단 하나다** — `auto-story-finish/providers/redact.mjs`(`redactSecrets` = 값 그물 ·
   `isSecretFieldName` = 키 이름 판정). Codex 입력·워커 로그·archive 가 쓰는 그물과 같은 것이다.
   `night-batch-ops/engine/diagnose.mjs` 가 `maskSecrets`(문자열) · `deepRedact`(객체 전체)로 그것을
   감싸고, 진단·자율 마무리 산출물·보고서가 모두 이 둘만 쓴다(감싼 이유는 서명부가 잘린 2조각 JWT
   하나뿐이다 — 공용 그물이 그것까지 흡수하면 감싸개를 지우고 그대로 재수출한다).
   모듈마다 자체 정규식을 두지 않는다 — 그물이 갈리면 한쪽만 고쳐지고 나머지가 샌다(2026-09-02
   codex-review-r3 H1: 진단의 자체 마스커가 R2 에서 이미 고친 세 형식 — JSON 키 · `Authorization` 헤더 ·
   인용값 — 을 전부 통과시켰고, `scripts`·`manifests`·`engineState` 는 아예 원문 객체로 실렸다).
   `readProject()` 는 **반환 직전 스냅숏 전체**를 `deepRedact` 한다 — 값 패턴뿐 아니라 **키 이름**으로도
   가린다(`{"api_key":"…"}` 처럼 값만 떼어 놓으면 어떤 패턴에도 안 걸리는 자리가 유출 경로였다).
   탐지(security findings)는 원문 기준으로 이미 끝난 뒤라 판정은 흐려지지 않는다.
6. **무한 재시도 금지.** 라운드 상한 · 예산 · 무진전 중단 · 같은 원인 3회 escalate.
   예산은 **절대 deadline** 이다 — 시작 시각 + `--budget-min` 이 고정 마감이고, 게이트·러너·계획의
   spawn timeout 은 `min(개별 상한, 잔여)` 로 잘린다. 마감은 **hard stop** 이라 다음 자리마다 잔여를
   다시 본다: ① 라운드 진입 ② BMAD 등재(대상 저장소 쓰기) 직전 ③ 계획 생성 직전 ④ 모든 spawn
   직전 **과 직후**(자식이 마감을 넘겨 끝났을 수 있다) ⑤ 최종 게이트. 0 이하면 그 단계를 돌리지
   않고 라운드를 접으며, `run.json` 의 `budget.stops` 에 「예산 소진」을 적는다 — 그래서 마감 뒤에는
   **대상 저장소 쓰기 0 · 러너 0 · 라운드 진입 0** 이다. 게이트가 없는 실행(`--no-gates`)에서도
   초과 사실은 `budget.exhausted:true` 로 남는다. 건너뛴 단계는 보고서 ⑧「확인하지 못한 것」에
   그대로 실린다 — 안 돌린 검사는 통과가 아니라 **`not-verified`** 다
   (2026-09-02 codex-review-r5 Medium).
   마감은 **프로세스 트리 종료**로 집행한다(2026-09-03 codex-review-r6 Medium). timeout 을 직접
   자식에게만 걸면 Windows 에서는 `cmd.exe` 만 죽고 실제 일을 하던 **손자**(node·vitest)가 상속받은
   파이프를 쥔 채 남아, 마감이 지나도 호출이 돌아오지 않았다 — deadline 이 종이 약속이 되는 자리다.
   게이트·러너·계획 spawn 은 전부 `engine/spawn-deadline.mjs` 의 `spawnWithDeadline` 하나를 쓰고,
   마감이면 **win32 `taskkill /PID <pid> /T /F` · POSIX 프로세스 그룹 `SIGKILL`** 로 트리를 끊은 뒤
   **파이프가 닫히기를 기다리지 않고 즉시 반환**한다(그때까지 모은 stdout/stderr 는 유지 ·
   `timedOut:true` · 계획 실행기는 `runner-timeout` 으로 분류). 출력 과다(`maxBuffer` 초과)는 같은
   모양(error+signal)으로 오지만 **`runner-error`(ENOBUFS)** 로 갈라 적는다 — 사유가 뒤바뀌면
   운영자가 예산을 늘리며 헛발질한다. **게이트도 같은 순서로 가른다**(2026-09-03 codex-review-r7 Low):
   `timedOut`/ETIMEDOUT → `exit 124` · 그 밖의 error(ENOBUFS) → **`exit 125` · 사유 「출력 과다」** ·
   원인 없는 signal → 124 폴백.
   **고아 손자까지 끊는다**(2026-09-03 codex-review-r7 Medium). `taskkill /T` 는 **살아 있는 부모**의
   트리만 걷는다 — wrapper(`cmd.exe`)가 먼저 끝나 손자가 고아가 되면 `/T` 가 그 트리를 못 찾아,
   마감 뒤에도 손자가 계속 돌았다. 그래서 win32 는 그물을 **둘** 던진다: ① `taskkill /T /F`(빠른 경로)
   ② PowerShell **재귀 스윕** — 원래 wrapper PID 를 뿌리로 `Win32_Process.ParentProcessId` 를
   손자의 손자까지 따라가(Windows 는 부모가 죽어도 PPID 값을 남긴다) 찾은 PID 를 전부
   `Stop-Process -Force` 한다. 스크립트는 `-EncodedCommand`(UTF-16LE base64)로 넘겨 셸 재해석 자리를
   없앤다. POSIX 는 `detached:true` 프로세스 **그룹** kill 하나로 고아까지 같이 끊긴다.
   **한계 3가지**(감춰 두지 않는다):
   ⓐ **PID 재사용** — 죽은 PID 를 OS 가 재활용하면 무관한 프로세스가 그 PID 를 부모로 가질 수 있다.
   `CreationDate ≥ spawn 시각 −1초` 로 창을 좁히지만 없애지는 못한다.
   ⓑ **Job Object 없음** — 생성 시점부터 자손을 강제로 묶는 수단(Windows Job Object)을 쓰지 않으므로,
   스윕은 「마감 시점에 조회해서 찾는」 사후 방식이다. 스윕 사이에 새로 뜬 손자는 그 회차엔 안 걸린다.
   ⓒ **표식(`AUTO_SPAWN_TOKEN`) 폴백은 약하다** — 워커 env 에 고유 UUID 를 넣지만 **WMI 는 프로세스
   env 를 못 읽는다**. 재귀 결과가 0 건일 때 `CommandLine` 에 표식이 남은 경우만 걸리며, 우리는 자식
   argv 를 바꾸지 않으므로 실제로는 거의 0 건이다(자손이 스스로 표식을 argv 에 실어야 유효하다).
7. **자동 수리 금지 5범주** — 보안·권한 / 개인정보 / 데이터 손실·복구 / 결제·청구 / 외부 발송·배포
   안전장치. 이 범주는 심각도와 무관하게 큐에 넣지 않고 사람에게 넘긴다.
8. **묻는 것은 8범주뿐이다** — 제품 의도 / UX·문구·사업 / 되돌릴 수 없는 데이터 / 비용 /
   계정·인증·비밀 / 법률·개인정보 / 외부 공개·발송 / 커밋·푸시·머지·배포. 기술 판단은 묻지 않는다.
9. **BMAD 등재가 폐기되면 그 스토리는 이번 라운드에서 뺀다.** 해시 충돌·경로 거부·junction 으로
   `applyBmadWrites` 가 `rolledBack`·`rejected`·`conflicts` 를 내면, 그 계획에 걸린 스토리를 전부
   봉쇄하고(사유는 큐의 `_편성.excluded`) 남은 후보로 계속한다. 남는 후보가 0 이면 그 라운드는
   러너를 띄우지 않는다. **계속 도는 것은 이번 계획에 쓰기가 없던 스토리뿐**이다 — 지적·완료기준이
   원장에 붙지 않은 채로 구현을 시작하면 「무슨 근거로 고쳤나」가 사라진다
   (2026-09-02 codex-review-r4 NEW-M3).
10. **보고는 언제나 실행 뒤 상태다.** `--no-gates` 여도 마지막에 `readProject → diagnose → 백로그 병합`
    을 다시 돌린다(게이트 호출만 옵션으로 가른다). 러너가 스토리·코드를 고친 뒤의 스냅숏으로
    「이번에 끝낸 것 / 남은 문제」를 센다(NEW-M1).

---

## 5. 산출물 — 어디에 무엇이 남나

전부 `<state>/autofinish/<runId>/` 아래다(`runId` = `YYYY-MM-DD-HHmmss`, UTC).

| 파일 | 무엇 |
|---|---|
| `report.md` | **사람이 읽는 것.** 10절 — 할 수 있는 것 / 끝낸 것 / 검사 결과 / 확인한 흐름 / 자동 수정·교차 검토 / 시간 / 남은 위험 / **확인하지 못한 것** / 배포 가능 여부 / 결정할 것 |
| `report.json` | 같은 내용의 기계용 |
| `run.json` | 실행 요약 — 옵션·라운드별 판정·게이트 호출 수·**예산(`budget.deadline`·`exhausted`·`stops`)**·산출물 목록·최종 판정 |
| `round-N-snapshot.json` | 그 라운드에 읽은 프로젝트 상태 전부 |
| `round-N-diagnosis.json` | 스토리별 판정과 findings |
| `round-N-backlog.json` | 우선순위가 매겨진 남은 일(라운드 사이 병합 · `closed[]` = 이번에 사라진 문제) |
| `round-N-questions.json` | 사람에게 물을 것과 인박스 반영 계획 |
| `round-N-bmad-plan.json` / `-apply.json` | BMAD 쓰기 계획 / 적용 결과(`rolledBack:true` = 하나도 안 들어갔다) |
| `round-N-plan.json` | 지휘 모델 계획 · 규칙 계획 · 검증 결과 · 워커 배정 · 뺀 스토리와 사유 |
| `round-N-queue.json` | 러너에게 넘긴 큐(=`run-night --queue` 형식) |
| `round-N-runner.json` / `.log` | 러너 결과와 출력(마스킹됨) |
| `gate-<태그>-<이름>.json` / `.log` | 게이트 1회 실행 결과와 출력(마스킹됨) |
| `readiness.json` | 작업 8조건 · 프로젝트 8조건 판정표 |
| `escalation.md` | 사람 호출이 났을 때만 — 상황·원인·시도·선택지·추천·위험도 6항 |

**보고서를 읽는 법**: 맨 위 한 줄이 결론이다.
`✅ 배포해도 됩니다` / `❌ 아직 배포하면 안 됩니다` / `⚠ 배포해도 되는지 확인하지 못했습니다`.
세 번째는 **통과가 아니라 「모른다」** 다 — 확인 못 한 것이 하나라도 남으면 「배포 가능」이라고 적지 않는다.

---

## 6. 자주 막히는 곳

| 증상 | 원인 | 할 일 |
|---|---|---|
| `✖ 인자 거부: … 셸 메타문자` | 경로·모델 값에 `;` `&` `$()` 등이 있다 | 값을 고친다(거부는 안전장치다 — 우회하지 않는다) |
| `✖ 인자 거부: --diagnose-only 는 … --gates 를 함께 줄 수 없다` | 진단 전용은 실행 0 이다(거부 규칙 ②) | `--gates` 를 빼거나 `--diagnose-only` 를 뺀다 |
| `✖ 인자 거부: --gates 와 --no-gates 는 함께 쓸 수 없다` | 상충하는 게이트 플래그다(거부 규칙 ④) | 돌릴 검사를 적든지(`--gates`) 끄든지(`--no-gates`) 하나만 준다 |
| `✖ 설정 거부: … .push 는 켤 수 없다` | `auto.config.json` 의 `autofinish.queueDefaults.push: true`(거부 규칙 ①) | 그 줄을 지운다. 푸시가 필요하면 사람이 승인하고 직접 민다 |
| `✖ 설정 거부: --state/--out 은 대상 저장소 안에 둘 수 없다` | 산출물 경로가 저장소 안이거나 링크로 안을 가리킨다(거부 규칙 ③) | 저장소 밖 폴더를 준다(`$AUTO_BATCH_STATE_DIR` 도 같은 잣대) |
| `run.json` 의 `budget.exhausted: true` | 예산(`--budget-min`)을 다 썼다 | `budget.stops` 에 무엇을 건너뛰었는지 있다(보고서 ⑧ 에도 실린다). 예산을 늘리거나 범위를 줄인다 |
| 러너가 `exit 3` · `pipeline-settings.json 이 없다` | nested 워커 deny 설정이 없다 | `.claude/pipeline-settings.json` 을 만든다(`Bash(git commit:*)` 등 deny) |
| 러너가 `exit 6` · `COMMIT GUARD STOP` | 시작 시점 작업 트리가 dirty | 사람이 먼저 커밋·정리한다 |
| 러너가 `exit 4` · `NO-OP STOP … 읽은 증거 없이 clean` | 교차 리뷰가 파일을 읽지 않고 「문제 없음」을 냈다 | 리뷰 무효가 정상 동작이다 — 리뷰 모델·프롬프트를 확인한다 |
| 한 라운드만에 `escalation.md` 가 나왔다 | 인증·한도·네트워크(환경 실패) | 원인을 풀고 같은 명령을 다시 돌린다(끝난 단계는 자동으로 건너뛴다) |
| codex 를 켰는데 `codex 폴백 → claude` | 엔진은 Codex 를 **배치 워크트리에서만** 돌린다(본 트리 실데이터 반출 방지) | 병렬 배치로 돌리거나, 위험을 이해한 뒤에만 `AUTO_CODEX_ALLOW_CWD=1` |
| 편성 0건 | 후보가 전부 봉쇄·자동 수리 금지·md 부재 | `round-N-queue.json` 의 `_편성.excluded` 에 스토리별 사유가 있다 |
| 계획 출처가 늘 `deterministic-fallback(...)` | 지휘 모델이 없거나 응답이 형식에 안 맞는다 | 괄호 안이 사유다. 규칙 계획으로 도는 것 자체는 정상이다 |
| 계획 출처가 `deterministic-fallback(runner-cooldown)` | (run-night 슬롯) 실행기 오류가 연속 3회라 `cacheHours` 동안 쉬는 중이다 | `claude --version` 으로 CLI 를 확인하고, 고쳤으면 상태 폴더의 `orchestrator-cache.json` 을 지운다 |
| 계획 출처가 `fable(cache)` | 후보 지문이 지난 슬롯과 같아 **실행기를 부르지 않았다**(정상 · 한도 절약) | 강제로 다시 묻고 싶으면 `orchestrator-cache.json` 삭제 또는 `cacheHours: 0` |
| 판정이 늘 `not-ready` | 그게 결론이다 | `report.md` 9절 「막고 있는 것」 목록부터 지운다 |

---

## 7. 하위 호환

자율 마무리는 **얹는 것**이다. 기존 경로는 그대로다.

- `run-night.mjs --queue <수동 큐>` 단독 실행 — 변화 없음.
- `plan-queue.mjs --dry` 편성 판단 — 변화 없음.
- Claude 단독(코덱스 없음) 설정 — 변화 없음.
- `auto.config.json` 에 `autofinish` 블록이 없으면 기본값(라운드 3 · 게이트 qa · 신규 스토리 3 ·
  BMAD 쓰기는 계획만)으로 돈다.

---

## SKILL.md 삽입 초안

> 이 절은 **워커 H1/H2 가 소유한 두 `SKILL.md` 에 끼워 넣을 초안**이다. 여기 적어 두기만 하고
> `SKILL.md` 는 직접 고치지 않았다(소유 경계). 문구는 그대로 써도 되고 줄여도 된다.

### (A) `night-batch-ops/SKILL.md` 에 넣을 절

```markdown
## 자율 마무리 — 범위를 사람이 정하지 않을 때

「지금 상태를 파악하고 배포 가능한 수준까지 자율적으로 마무리해줘」 같은 요청이면
큐를 손으로 짜지 말고 **자율 마무리 진입점**을 쓴다.

    node <skill>/engine/autofinish.mjs --root <프로젝트> --max-rounds 3 --bmad-writes on

하는 일: 프로젝트를 읽어 진단 → 남은 일을 7단계 우선순위로 세움 → 사람이 정할 8범주만 결정 인박스에
올림 → BMAD 스토리에 등재 → 지휘 모델 계획(검증 통과 시에만 채택 · 아니면 규칙 계획) →
`run-night --queue` 로 실행 → 다시 진단해 계속/중단/사람 호출을 판정 → 비개발자용 보고서.

**하지 않는 일**: 푸시 · main 머지 · 배포 · 외부 발송 · main 직접 작업 · `_bmad-output/` 밖 쓰기.
커밋은 종전 러너 계약대로 워크트리·`auto/<날짜>` 브랜치에서만 일어난다.

먼저 볼 것: `--diagnose-only --no-gates` 는 **대상 저장소에 한 바이트도 쓰지 않고** 판정만 낸다.

옵션·산출물 경로·안전 경계·문제 해결은 `AUTOFINISH.md` 에 있다.
```

### (B) `auto-story-finish/SKILL.md` 에 넣을 절

```markdown
## 자율 마무리가 부를 때

스토리 범위가 **주어지지 않은** 요청(「알아서 마무리해줘」)은 이 스킬이 직접 받지 않는다.
`night-batch-ops` 의 자율 마무리(`engine/autofinish.mjs`)가 진단·우선순위·BMAD 등재·편성을 먼저 하고,
그 결과 큐를 `run-night --queue` 로 넘기면 이 엔진은 **종전 계약 그대로** 스토리 단위로 돈다
(create→dev→qa→review · 커밋 가드 · 통합 게이트 · 실패 격리).

즉 이 스킬이 바뀌는 것은 없다 — 큐가 어디서 왔는지만 다르다. 자율 마무리가 만든 큐는
`planned: "autofinish"` 이고 `defaults.push` 는 항상 `false` 다(외부 반영은 사람 승인).

자세한 것은 `night-batch-ops/AUTOFINISH.md`.
```
