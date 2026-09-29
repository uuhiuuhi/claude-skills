# 프로젝트 값 — 읽는 순서와 기본값

`daily-brief` · `my-todo` · `runner-start` 세 스킬이 같은 규칙을 쓴다. 스킬 본문에 회사·사람·경로 이름을 박지 않는다.

## 1. 러너 값 — batch-24-multiAG `ops/lib.sh` 와 같은 순서

| 값 | 1순위(환경변수) | 2순위(`<RUNNER>/tools/auto/auto.config.json`) | 기본값 |
|---|---|---|---|
| `RUNNER` 러너 폴더 | `AUTO_RUNNER_DIR` | — | 현재 폴더 |
| `PROJECT` | — | `project` | 러너 폴더 이름 |
| `STATE` 상태 폴더 | `AUTO_BATCH_STATE_DIR` | `stateDir` (`~` 는 홈으로) | `~/.claude-auto/<PROJECT>` |
| `TASK` 예약작업 이름 | `AUTO_RUNNER_TASK` | `watchdog.runnerTask` | `<PROJECT>-auto-slots` |
| 목업 판정 파일 | — | `mockupGate.verdictsPath` | `tools/dev-status/mockup-verdicts.json` |
| 자율 모드 | — | `autonomy.mode` | `guarded` (`full` 이면 결정을 AI 가 채택하고 사후 확인) |

직접 계산하지 말고 lib.sh 를 하위 셸에서 읽는다(설정이 없으면 lib.sh 가 exit 2 로 끝나므로 하위 셸로 감싼다):

```bash
( source ~/.claude/skills/batch-24-multiAG/ops/lib.sh && echo "RUNNER=$RUNNER STATE=$STATE TASK=$TASK LOCK=$LOCK SLOTS=$SLOTS" )
```

실패하면 「배치 설정 없음 — 러너 관련 항목 확인 못 함」으로 적고 나머지 절은 계속한다.

## 2. 문서 경로 — 기본값 표 (프로젝트가 CLAUDE.md 에서 재정의)

| 키 | 기본값 | 쓰는 곳 |
|---|---|---|
| `ART` | `_bmad-output/implementation-artifacts` | 스토리 파일·산출물 폴더 |
| `LOGS` | `ART/auto-pipeline-logs` | 러너 요약·실행 로그·매니페스트·계측 |
| `INBOX` | `ART/DECISIONS-INBOX.md` | 결정 대기 · AI 결정 사후 확인 |
| `RELEASE_LOG` | `ART/RELEASE-LOG.md` | 기준 갈래 병합·운영 반영 기록 |
| `SCORECARD` | `ART/WORK-LEVEL-SCORECARD.md` | 작업수준 평가표 |
| `DEFERRED` | `ART/deferred-work.md` | 미뤄 둔 지적 원장 |
| `QUEUE_MANUAL` | `tools/auto/night-queue.json` | 사람이 확정한 편성 큐 |
| `BASE` | `main` | 기준 갈래 |
| `WORK_PREFIX` | `auto/` | 러너·작업 갈래 접두사 |
| `PROD_URL` | **없음** | 운영 화면 바로가기. 없으면 링크를 만들지 않는다 |
| `USAGE_CMD` | **없음** | 모델별 사용량 집계 명령(예: 사용량 집계 CLI). 없으면 「사용량 집계 못 함」 |
| `HUMAN_TITLE` | `👤 내 차례` | 사람 몫을 모으는 마지막 절 제목 |

## 3. 프로젝트가 재정의하는 법

프로젝트 CLAUDE.md 에 아래 모양의 절을 두면 기본값 대신 쓴다. 없는 키는 기본값이다.

```markdown
## 브리핑 설정
- HUMAN_TITLE: 👤 ○○님 차례
- PROD_URL: https://app.example.com
- RELEASE_LOG: docs/release-log.md
- USAGE_CMD: <사용량 집계 명령>
```

`HUMAN_TITLE` 은 이 절이 없어도 CLAUDE.md 가 「답변 마지막에 ○○ 라는 고정 제목의 섹션」을 정해 두었으면 그 제목을 쓴다.
`PROD_URL` 은 CLAUDE.md·설정 어디에도 없으면 **추측하지 않는다** — 배포 설정 파일 이름에서 주소를 조합하지 않는다.

## 4. 되돌리기 어려운 실행 — 프로젝트 규칙이 정한다

기준 갈래 병합 · 운영 배포 · 운영 DB 쓰기 · 외부 발송 · 삭제 · 인증정보 변경은 이 스킬들이 **위임을 가정하지 않는다.**
CLAUDE.md 에 「○○ 라고 하면 병합까지 한다」 같은 위임 문구가 있을 때만 그 범위 안에서 움직이고, 없으면 승인 항목으로 올리기만 한다.
