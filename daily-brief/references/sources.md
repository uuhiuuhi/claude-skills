# 브리핑이 읽는 파일

경로 이름(`ART` · `LOGS` · `STATE` …)은 [parameters.md](parameters.md) 기준이다. **없으면 「없음 / 확인 못 함」이라고 적는다 — 없는 파일을 「이상 없음」으로 읽지 않는다.**
미머지 `auto/*` 갈래가 있으면 저장소 안 파일은 `git show origin/auto/<최신>:<경로>` 로 읽는다(기준 갈래 쪽 사본은 과거다).

## 저장소 안

| 쓰임 | 경로 | 만드는 쪽 |
|---|---|---|
| 러너 요약(완주/중단) | `LOGS/night-last-run.md` | batch-24-multiAG `run-night.mjs` |
| 실행 로그(exit · `[ASSIGN]` · `[MODEL-ROUTE]`) | `LOGS/run-summary.log` | 엔진 |
| 배치 매니페스트(`integration` · `landing` · `workers`) | `LOGS/batch-<id>-manifest.json` | 엔진 |
| 검증 매니페스트(스토리별 모델·검사) | `LOGS/<story>-verification.json` | 엔진 |
| 계측 | `LOGS/metrics-<id>.json` | 엔진 |
| 결정 인박스 | `INBOX` | 엔진 · 사람 |
| 운영 반영 기록 | `RELEASE_LOG` | 병합·배포를 한 세션 |
| 작업수준 평가표 | `SCORECARD` | 이 스킬 |
| 사람이 확정한 큐 | `QUEUE_MANUAL` | 사람 |

## 상태 폴더(`STATE`) — 저장소 밖

| 쓰임 | 경로 |
|---|---|
| 러너 심박 | `STATE/slots.log` · `STATE/runner.lock` |
| 계측 이력 | `STATE/metrics-history.jsonl` |
| 배정 이력 | `STATE/assign-history.json` |
| 자동 편성 큐 | `STATE/auto-queue-*.json` 중 최신 |
| 사람 몫 | `STATE/human-gates.json` |
| 실패 증거 | `STATE/archive/*-evidence/<story>/` |
| 자율 마무리 진단 | `STATE/autofinish/<runId>/diagnosis.json` · `backlog.json` · `readiness.json` · `report.json` · `report.md` |

## 스크립트 — 다른 스킬이 제공

| 스크립트 | 제공 스킬 | 없을 때 |
|---|---|---|
| `tools/auto/plan-queue.mjs --dry` (편성 미리 보기 · 사람 몫 파일 갱신) | batch-24-multiAG 설치본 | 「편성 확인 못 함」 |
| `tools/auto/story-ledger.mjs` (원장 해석) | batch-24-multiAG 설치본 | 「원장 전수 확인 못 함」 |
| `build.mjs` · `scan.mjs` · `freshness.mjs` (현황판·신선도) | dev-status (프로젝트 사본 `tools/dev-status/` 우선) | 「현황판 도구 없음 — 신선도 확인 못 함」 |
| `ops/lib.sh` · `ops/watch-current.sh` (러너 값 · 진행 표시기) | batch-24-multiAG `ops/` | 「배치 설정 없음」 |
