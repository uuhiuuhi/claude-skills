# ops — 24시간 러너 운영 도구 (프로젝트 공용)

엔진(`engine/`)은 프로젝트에 설치되어 배치를 돌린다. 이 폴더는 **돌고 있는 러너를 사람·지휘 세션이 다루는 도구**다.
설치하지 않고 스킬 폴더에서 바로 쓴다 — 러너의 런타임 핀과 무관하므로 배치가 도는 중에 갱신해도 된다.

프로젝트 고유값은 스크립트에 없다. 전부 `AUTO_RUNNER_DIR`(러너 폴더)의 `tools/auto/auto.config.json` 에서 읽는다.

| 값 | 환경변수 | 설정 키 | 기본값 |
|---|---|---|---|
| 러너 폴더 | `AUTO_RUNNER_DIR` | — | 현재 폴더 |
| 상태 폴더 | `AUTO_BATCH_STATE_DIR` | `stateDir` | `~/.claude-auto/<project>` |
| 예약작업 이름 | `AUTO_RUNNER_TASK` | `watchdog.runnerTask` | `<project>-auto-slots` |
| 정본 스킬 폴더(감시자 재설치용) | `WD_CANONICAL_DIR` | `watchdog.canonicalDir` | 이웃 `claude-skills/batch-24-multiAG` → `~/.claude/skills/batch-24-multiAG` |
| 진단 세션 폴더(감시자) | `WD_PROJECT_DIR` | `watchdog.projectDir` | 러너 폴더 |

## 도구

| 파일 | 하는 일 | 바꾸는 것 |
|---|---|---|
| `watch-current.sh` | 지금 도는 스토리·단계·모델을 한 줄로. 바뀌면 찍고 끝난다(제목을 바꿔 다시 띄운다) | 없음 |
| `watch-progress.sh` | 진행 표시 + 정체 감지(20분 ⚠ · 40분 🔴 · 90분 자동 종료) | 없음 |
| `gap-apply.sh` | 라운드 경계에서 러너를 세우고 문서·설정 묶음을 적용·커밋한 뒤 재개. 예약 끄기·켜기·러너 정지·잔여물 보관·되돌림을 **매번 확인**하고, 확인하지 못하면 러너를 재개하지 않고 🔴 줄을 남긴다(종료 코드 3) | 러너 폴더 커밋 · 예약작업 끔/켬 |
| `gap-apply.sh --hold` | 경계에서 세우기만(릴리스 준비) | 예약작업 끔 |
| `stop-runner-tree.ps1` | **이 러너 폴더의** 프로세스 트리만 종료하고 남은 수(`remaining=`)를 알린다. 이름이 같은 다른 프로젝트의 러너·표시기 셸은 잡지 않는다 | 프로세스 종료 |
| `run-hidden.ps1` | 예약작업용 숨김 기동 래퍼(슬롯·감시자 공용) | 없음 |
| `cfg.mjs` | 설정 값 읽기 · 런타임 핀 재기록(위 도구가 부른다) | 핀 파일 |

## 새 프로젝트에 붙이는 순서

1. 프로젝트 루트에서 `node ~/.claude/skills/batch-24-multiAG/install.mjs --force` — 엔진이 `tools/auto/` 에 깔린다.
2. `tools/auto/auto.config.json` 에 `project` · `stateDir` · `epicOrder` 를 적는다. 예약작업 이름을 기본값과 다르게 쓰면 `watchdog.runnerTask` 도.
3. 러너 전용 복사본(clone)을 하나 둔다 — 사람이 쓰는 폴더와 같은 폴더에서 배치를 돌리면 서로의 변경을 쓸어 담는다.
4. 윈도우 예약작업 2개를 `run-hidden.ps1` 로 등록한다: `<project>-auto-slots`(30분 · `run-night.mjs --auto-plan`) · `<project>-watchdog`(30분 · 슬롯과 엇갈리게 · `watchdog.mjs`).
   둘 다 「배터리 전원이면 시작 안 함」·「배터리로 바뀌면 중지」를 끈다.
5. 대화 창에서 러너를 지켜볼 때는 `watch-current.sh ""` 로 키를 읽고 Monitor 로 `watch-current.sh "<키>"` 를 띄운다.

## 실사고에서 나온 규칙

- **틈은 lock 부재가 아니라 라운드 경계다.** 연속 실행 루프는 lock 을 놓지 않는다.
- **러너가 도는 동안 러너 폴더·기준 갈래(main)에 쓰지 않는다.** 커밋 가드가 원격 변화를 워커 푸시로 오인해 멈춘다.
- **`tools/auto/` 를 바꾼 커밋 뒤에는 런타임 핀을 다시 적는다.** 안 하면 다음 슬롯이 「핀 불일치」로 조용히 선다(`gap-apply.sh` 가 한다).
- **적용 스크립트는 사본에서 먼저 검산한다.** 셸 큰따옴표 문자열 안의 역따옴표는 명령으로 실행된다.
- **스토리 문서의 「선행」 줄에 `숫자-숫자` 꼴(예: T14-1)을 쓰지 않는다.** 편성기가 선행 스토리로 읽어 편성에서 뺀다.
- **감시에는 시한과 「시한이 지나면 할 일」을 둔다.** 라운드가 시한보다 길면 `적용 생략` 으로 끝나니 다시 건다.
- **비밀값(토큰·키)은 상태 폴더에 두고 저장소에 넣지 않는다.** 워커 환경에서는 원격 인증 수단을 지운다.
