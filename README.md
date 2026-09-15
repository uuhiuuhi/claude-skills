# Claude · Codex skills

Claude Code · Codex 스킬 백업이자 BMad 프로젝트의 현황판과 스토리 배치 도구입니다.
**현재 쓰는 배치의 유일한 정본은 `batch-24-multiAG`**(2026-09-06~)이며, 옛 판(`auto-story-finish` · `night-batch-ops`)은 이력 참조용으로만 남겨 둡니다.

| 스킬 | 용도 |
|---|---|
| [`batch-24-multiAG`](batch-24-multiAG/) | **현행 배치 정본(2026-09-06~)**. 수동 create→dev→review, 예약 실행, 공유 lock·모델 상태, 큐·병렬 워커, landing·QA·복구. 아래 `auto-story-finish`·`night-batch-ops` 를 대체한다. |
| [`dev-status`](dev-status/) | BMad v6 프로젝트의 **읽기 전용** 개발 현황판. `epics.md`·`sprint-status.yaml`·스토리 md·배치 로그를 규칙만으로 판정해 진행률·단계 배지·파일 겹침·불일치·다음 할 일을 로컬 HTML 한 장으로 낸다. 외부 의존성 0, LLM 호출 0. |
| [`screen-check`](screen-check/) | 구현이 끝난 스토리를 **실제 화면에서** 확인 — 격리 worktree + 별도 포트 dev 서버 + Playwright(playwright-core·Edge) 로 QA 계정 로그인·성공/거부 경로·모바일까지 밟고 **평가 항목 10개 × 10점 채점표**를 보고서 마지막에 낸다. 24배치(batch-24-multiAG)와 별개 스킬 |
| [`auto-story-finish`](auto-story-finish/) | **옛 판(2026-09-06 이전 · `batch-24-multiAG` 로 대체됨)**. BMad 스토리 배치를 create → dev → review 순으로 무인 완료한다(헤드리스 엔진). 단계별 모델 자동 선택, 인증 만료·사용량 한도 감지와 복구 대기, qa RED 시 중단, 옵트인 커밋·푸시(가드 하에). **v3(2026-09-02)**: 워커 프로바이더 계층 — `claude -p` 와 **`codex exec`** 를 모델 스펙(`"opus"` / `"codex"` / `"codex:<model>"`)으로 고른다 · Codex 리뷰는 read-only + 구조화 JSON → 엔진이 원장 기재 · 한도 시 프로바이더 전환(스토리당 1회) · 자동 수리 루프(`--auto-repair`) · 테스트 무결성 검사 · 검증 매니페스트. 플래그 없으면 종전 동작. |
| [`night-batch-ops`](night-batch-ops/) | **옛 판(2026-09-06 이전 · `batch-24-multiAG` 로 대체됨)**. **프로젝트 설치형** 24시간 **무정지** 무인 배치 체계 — 30분 반복 예약 **1개**(무기한 · 창 구분 없음) · 심박 lock(죽은 프로세스는 자동 탈취, 판정 불능은 6시간 심박으로 가름) · **선형 승계**(미머지 `auto/*` 가 있으면 쉬지 않고 그 브랜치를 이어 쌓는다 — 「미머지면 휴면」 폐지) · **공회전 가드**(엔진 로그 말고 바뀐 게 없는 라운드면 연속 루프를 끝내고 다음 정시 실행에 넘긴다) · 라운드마다 **하향 동기**(`origin/main` 병합 · 충돌은 해소/보류/중단 3처분) · 큐 자동 편성(규칙 10종, LLM 0)에 **무진전 연속 상한**(같은 스토리가 진전 없이 반복될 때만 제외) · **한도 대기(exit 5) 원장 환불** · 병렬 실행(File List 서로소 2폭, 워크트리 분리 + cherry-pick landing) · 중요도별 모델 배정 · 텔레그램 원격 명령(`/status` `/merge` `/resume` `/extend N` — 코드 되묻기) · 알림. `auto-story-finish` 를 엔진으로 쓴다. **원장 해석 단일 소스**(`story-ledger.mjs` — 굵게·인용·부정문 표기 흔들림 흡수) · **지출 한도 차단 알림**(원인을 이름으로 · 반복 억제) · **소진 모델 짝 단위 회피**. 프로젝트 고유값은 설치되는 `auto.config.json` 이 소유. |

## 통합 이유와 구조

`night-batch-ops`의 운영 엔진과 `auto-story-finish`의 스토리 엔진을 `batch-24-multiAG/engine/` 및 `engine/runtime/`로 모았습니다.
같은 엔진을 세 폴더에서 고치던 문제를 없애고, 수동·예약 실행에 같은 모델 정책과 필수 품질 게이트를 적용합니다.
이관 목록은 [consolidation-inventory.json](batch-24-multiAG/references/consolidation-inventory.json),
상세 복구 이력은 [마이그레이션 문서](batch-24-multiAG/references/MIGRATION.md)에 있습니다.
구 스킬 삭제는 전체 회귀·설치 스모크·기존 프로젝트의 pinned runtime 전환 검증 뒤에 진행합니다.

## 설치와 이전 사용자 마이그레이션

Claude와 Codex의 실제 사용자 스킬 폴더에 `batch-24-multiAG`를 복사합니다.
기존 전역 스킬을 지우기 **전에** 각 프로젝트에서 새 설치기로 런타임을 고정합니다.

```powershell
$Skills = 'C:\Projects\claude-skills'
Copy-Item -Recurse "$Skills\batch-24-multiAG" "$env:USERPROFILE\.claude\skills\"
Copy-Item -Recurse "$Skills\batch-24-multiAG" "$env:USERPROFILE\.codex\skills\"
Set-Location C:\path\to\project
node "$Skills\batch-24-multiAG\install.mjs" --force
node --test tools/auto/model-routing.test.mjs
node tools/auto/plan-queue.mjs --dry
```

설치기는 기존 `auto.config.json`, 수동 큐, 스토리, 로그를 보존합니다. 구 schema·상태 파일·예약 작업 ID는 계속 읽고,
새 상태 기록의 schema는 `batch-24-multiag/*`를 사용합니다. 기존 프로젝트는 `tools/auto/runtime/`을 사용하므로
전역 구 스킬이 없어도 실행됩니다. 전역 사본 갱신이 실행 중인 프로젝트 런타임을 바꾸지 않습니다.

운영 갱신은 runner lock과 PID가 모두 없는 배치 경계에서만 수행합니다. 예약 작업의 새 진입을 잠시 중지하고,
검토 커밋의 도구 변경을 적용한 뒤 라우팅·품질 테스트와 dry plan을 통과하면 원래 예약 상태를 복구합니다.
스토리 변경·로그를 reset/clean하지 않습니다. 운영 원격 push는 별도 명시 승인이 필요합니다.

## 새 명령

Claude 또는 Codex에서 “Story 4-1부터 4-4까지 마무리해줘” 또는 “24시간 배치를 진단해줘”라고 요청합니다.
수동 스토리 완료는 독립 제공자 리뷰가 가능한 격리 git worktree에서 실행합니다.

```powershell
node tools/auto/finish-stories.mjs --from 4-1 --to 4-4 --dry-run
node tools/auto/finish-stories.mjs --from 4-1 --to 4-4
node tools/auto/run-night.mjs --queue tools/auto/night-queue.json --dry-run
node tools/auto/autofinish.mjs --diagnose-only
```

품질 검사는 diff로 선택합니다. 문서·주석·정적 리소스에는 코드 검사를 실행하지 않습니다.
일반 코드는 typecheck·lint·영향 unit·변경 코드 coverage 90%, API는 관련 integration,
인증·권한·DB·RLS는 authorization/security, 성능 민감 변경은 performance를 요구합니다.
전체 회귀는 landing 뒤 한 번 실행하고 동일 커밋·코드 지문 결과를 재사용합니다.
필수 검사·테스트 종류·실행 증거가 없거나 완료 판정이 미달이면 done·commit·push를 차단합니다.

프로젝트별 스크립트와 report 계약은 [품질 게이트](batch-24-multiAG/references/QUALITY-GATES.md),
여섯 모델 라우팅은 [모델 정책](batch-24-multiAG/references/MODEL-ROUTING.md),
예약 및 복구는 [AUTOFINISH](batch-24-multiAG/AUTOFINISH.md)를 참조하세요.

엔진 자체는 외부 npm 의존성 없이 Node.js로 실행합니다. 선택적인 Vitest adapter는 대상 프로젝트의 Vitest와 같은 버전의 `@vitest/coverage-v8`를 사용합니다. Node 내장 coverage 회귀 픽스처는 Node 24에서 검증합니다.
