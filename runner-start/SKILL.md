---
name: runner-start
description: 24시간 러너(batch-24-multiAG)를 지금 바로 깨우고 첫 편성을 실측해 보고한다. "러너 시작", "러너 깨워줘", "자율 작업 시작", "배치 돌려줘", "24시간 작업 시작", "설정 바꿨으니 바로 돌려줘" 같은 요청에 사용한다. 예약작업이 30분마다 이미 돌지만, 이 스킬은 즉시 기동하고 첫 라운드가 무엇을 골랐는지·어떤 모델로 도는지 확인해 비개발자에게 쉬운 말로 알린다. 커밋·푸시는 러너가 작업 갈래(`auto/*`)까지만 한다 — 기준 갈래 병합·배포는 프로젝트 규칙이 정한 사람 지시로.
---

# runner-start — 지금 기동 → 첫 편성 실측

24시간 러너는 예약작업(기본 30분마다)이 깨우는 무인 배치다. 이 스킬은 그 러너를 **지금 깨우고, 첫 편성이 실제로 무엇을 골랐는지** 보고한다.
엔진·모델 정책·품질 게이트의 정본은 batch-24-multiAG 스킬이다. 여기서는 그 위에서 「시작 → 확인」만 한다.

사용자에게는 「24시간 러너」·「지난 라운드」라고 부른다. 대화 창에서 특정 스토리를 바로 끝내는 것은 「지휘 실행」(batch-24-multiAG 의 `finish-stories.mjs`)이며 이 스킬의 일이 아니다.

## 먼저 정하는 값

값의 읽는 순서·기본값은 [references/parameters.md](references/parameters.md)가 정본이다. batch-24-multiAG `ops/lib.sh` 와 같은 순서로 읽는다:

```bash
export AUTO_RUNNER_DIR=<러너 폴더>   # 사람 작업 폴더와 다른 러너 전용 복사본. 없으면 현재 폴더
( source ~/.claude/skills/batch-24-multiAG/ops/lib.sh && echo "RUNNER=$RUNNER STATE=$STATE TASK=$TASK LOCK=$LOCK SLOTS=$SLOTS" )
```

- 아래 명령 속 `$RUNNER` · `$STATE` · `$LOCK` · `$SLOTS` · `$TASK` · `$BASE`(기본 `main`)는 여기서 읽은 값으로 바꿔 넣는다.
- `RUNNER` = `AUTO_RUNNER_DIR` → 현재 폴더 · `STATE` = `AUTO_BATCH_STATE_DIR` → `stateDir` → `~/.claude-auto/<project>` · `TASK` = `AUTO_RUNNER_TASK` → `watchdog.runnerTask` → `<project>-auto-slots`.
- 설정 파일이 없으면(lib.sh exit 2) **기동하지 않는다** — 「배치가 설치돼 있지 않습니다」라고 알리고 batch-24-multiAG 설치를 사람 몫에 올린다.
- 사람 몫 절 제목 `HUMAN_TITLE` = 프로젝트 CLAUDE.md 정의 → 기본 「👤 내 차례」.

## 1. 상태를 읽는다 (쓰기 전에)

```bash
git fetch --all --quiet; git status -sb; git branch -r --no-merged origin/$BASE | grep auto/   # BASE 기본 main
ls -la "$LOCK" "$SLOTS" 2>/dev/null; tail -n 5 "$SLOTS" 2>/dev/null
```

- **러너 폴더가 실행 트리다**(사람 작업 폴더가 아니다). 사람 폴더와 같은 폴더에서 배치를 돌리면 서로의 변경을 쓸어 담는다 — `RUNNER` 가 현재 사람 폴더와 같으면 그 위험을 먼저 알린다.
- `tools/auto/auto.config.json` 의 `autonomy.mode` 확인 — `full` = 결정을 AI 가 추천안으로 채택하고 사후 확인 / 그 밖 = 결정 대기 스토리는 멈춘다.
- 사람 폴더에 저장 안 한 코드 변경이 있으면 먼저 정리한다(정리 방법은 프로젝트 규칙). 러너 폴더가 미정리 상태면 러너가 시작을 거부한다(exit 4).
- lock 이 있고 `slots.log` 가 최근 45분 안에 바뀌었으면 **이미 돌고 있다** — 새로 깨우지 않고 5절(표시기)로 간다.

## 2. 편성을 미리 본다 (읽기 전용)

```bash
cd "$RUNNER" && node tools/auto/plan-queue.mjs --dry
```

- 첫 줄 `# 편성 <날짜> [자율운전 full] — 고름 N · 뺌 M · 배치 K …` 를 읽는다. `V` = 편성(단계 표시 `replan→dev` 등) · `X` = 제외 · `?` = 사람 몫(question/gate/post-hoc).
- 자율 모드에서 `X` 사유는 이연 확정 · 선행 미완 · 사람 질문 대기 · 사람 게이트 · 자율 한계뿐이어야 한다. 그 밖의 사유가 보이면 설정이 자율 모드가 아닌지 확인한다.
- 스크립트가 없으면 「편성 도구 없음 — 설치 확인 필요」로 멈춘다(추측으로 기동하지 않는다).
- 모델 배정 규칙은 `tools/auto/MODEL-ROUTING.md`(설치본). 적합한 모델이 없으면 품질 기준을 낮추지 않고 보류하는 것이 정상이다.

## 3. 기동한다

| 환경 | 명령 |
|---|---|
| Windows(예약작업 등록됨) | `Start-ScheduledTask -TaskName "<TASK>"` |
| 예약작업이 없는 환경 | 프로젝트가 등록한 동등 예약(cron 등)을 즉시 1회 실행. 그것도 없으면 러너 폴더에서 `node tools/auto/run-night.mjs --auto-plan` 을 백그라운드로 — 제목 `[지금작업중·<계획 모델>] 24시간 러너 1라운드 …` |

- 중복 기동은 lock(`STATE/runner.lock`)이 막는다. 이미 돌고 있으면 그대로 둔다.
- 예약작업이 「사용 안 함」이면 켜는 것은 설정 변경이다 — 누가 왜 껐는지(`STATE` 의 로그·감시자 기록) 먼저 보고, 이유가 불분명하면 사람에게 묻는다.
- 편성을 바꾸고 싶으면 큐를 손으로 고치지 않는다 — 설정(`auto.config.json`)이나 스토리 원장을 고친 뒤 2절을 다시 실측한다. 러너가 도는 중에는 `ops/gap-apply.sh` 로 라운드 경계에 반영한다.

## 4. 첫 라운드를 실측해 보고한다 (5분 안에)

`STATE/slots.log` 꼬리에서:

- 편성 줄 `# 편성 … — 고름 N` — N 이 0 이면 `?` 줄(사람 몫)을 그대로 보고한다.
- `[ORCHESTRATOR] source=<실제 모델>` 또는 `(cache …)` — 폴백(`deterministic-fallback(…)`)이면 사유를 적는다.
- 첫 배치 라벨과 단계(`replan→dev` · `mockup→dev→review` 등) · `실행 대상 배치: N건` · 병렬 폭.
- `[MODEL-ROUTE] … model=` — 구현·리뷰에 **실제로** 배정된 모델(추측 금지 · 없으면 「—」).
- `STATE/human-gates.json` 의 `humanGates` 건수 — `my-todo` 스킬의 재료.
- 5분 안에 새 줄이 없으면 「기동 확인 못 함」이다. 예약작업 마지막 실행 결과와 lock 을 보고, exit 코드가 있으면 뜻을 적는다(`3` 인증 만료 · `4` 러너 폴더 미정리 · `5` 한도 대기 · `6` 저장 가드).

## 5. 진행 표시기를 켠다

러너는 Claude 밖에서 돌아 대화 창에 보이지 않는다. batch-24-multiAG SKILL.md 「백그라운드 작업 표기 규칙」대로:

```bash
bash ~/.claude/skills/batch-24-multiAG/ops/watch-current.sh ""     # 지금 키를 한 번 읽는다
```

- Monitor 로 `watch-current.sh "<키>"` 를 띄우고 제목에 **스토리 번호·단계·모델·슬롯 진행**을 적는다 — 예 `[지금작업중·opus] 진행중인 작업 — 스토리 3-2 (신규) · dev 단계 · 슬롯 1/4건 (바뀌면 새 번호로 다시 띄움)`.
- 키가 바뀌어 표시기가 끝나면 새 키로 다시 띄운다. 기다리기만 하는 감시는 `[지금감시중]` 으로 따로 두고, 시한(20분 ⚠ 정체 의심 · 40분 🔴 사람 확인 · 감시 자체 종료 시각)과 시한 뒤 할 일을 정한다.
- **`[지금감시중]` 만 떠 있고 `[지금작업중]` 이 없는 화면을 남기지 않는다.**

## 보고 형식

진행 보고(쉬운 말 · 결론 먼저: 「러너 기동됨 / 이미 도는 중 / 기동 못 함」)를 위에, `HUMAN_TITLE` 절을 맨 아래에. 그 절에는 사람 몫만 — 항목마다 무엇을 / 왜 / 안 하면 어떻게 되는지 + ⭐추천안. 없으면 「지금 답하실 것 없음 — 다음 확인 시점 ○○」.

## 하지 않는 것

- 기준 갈래 병합·푸시, 운영 배포, 운영 DB 적용, 외부 발송, 삭제, 인증정보 — 프로젝트 CLAUDE.md 가 정한 사람 지시·위임 범위로만. 이 스킬은 위임을 가정하지 않는다.
- 사람 작업 폴더에서 러너 돌리기 — 실행 트리는 러너 전용 복사본이다.
- 편성 결과를 손으로 고쳐 넣기 · 도는 러너의 폴더에 직접 쓰기.
- 전역 스킬·러너 설치본을 배치가 도는 중에 고치기 — 스킬 개선은 별도 작업 폴더(worktree)에서 하고, 검증된 버전은 워커가 없는 경계에서 반영한다(batch-24-multiAG 「운영 러너 업데이트」).
