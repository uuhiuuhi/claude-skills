# 통합 품질 검증 보고서 — 2026-09-06

스킬 구현, Sol-high 독립 리뷰, 저장소 회귀와 격리 설치 검증을 완료했다. **운영 러너 전환과 기존 전역 스킬 삭제는 미완료**다. 엄격한 landing 계약을 충족하지 못하는 기존 앱 DB 통합 테스트를 먼저 정비해야 한다. 운영 프로젝트의 스토리·로그·예약 설정은 변경하지 않았다.

작업 위치는 `C:/Projects/claude-skills-quality-gates-9`, 브랜치는 `codex/quality-gates-9-consolidation`, 기준은 `166e28c`다. 검증된 구현 커밋은 `be8e77694c7f06e3dcee2eeb6d11dc6ceb0f5d3e`이며 [draft PR #1](https://github.com/uuhiuuhi/claude-skills/pull/1)에서 검토할 수 있다. 이후 문서 커밋은 실행 코드를 바꾸지 않는다.

## 변경 구조와 중복 제거

- `batch-24-multiAG/`를 유일한 저장소 정본으로 구성했다. `engine/`은 예약·lock·큐·병렬 워커·landing·복구, `engine/runtime/`은 create→dev→review·자동 수리·모델 호출·검증 manifest를 담당한다.
- `finish-stories.mjs`와 SKILL.md에 수동 스토리 범위 완료를 통합했다. 수동 실행과 예약 실행이 같은 runtime을 사용한다.
- `quality-gates.mjs`, `quality-rules.mjs`, `api-surface.mjs`, `authorization-matrix.mjs`가 위험도·검사 선택·API 목록·권한 증거를 검증한다. `schema-migration.mjs`는 구 상태를 읽고 새 기록을 `batch-24-multiag/*`로 쓴다.
- `landing-publication.mjs`, `runtime-pin.mjs`, `worktree-refresh.mjs`가 검토된 코드 지문과 발행·교체를 연결한다. dirty 작업을 보존하며, 검증 뒤 변경된 코드는 push할 수 없다.
- `adapters/vitest-quality.mjs`는 실제 영향 테스트와 LCOV를 연결하고 unit/integration 범위를 분리한다. 설치기는 runtime과 adapter를 프로젝트에 고정한다.
- 구 두 폴더의 **92개 파일, 2,180,069 bytes**를 대조 후 저장소에서 제거했다. **45개는 동일 바이트, 47개는 통합 계약에 맞게 수정**됐다. 제거 폴더 크기이며 순수 저장소 절감량은 아니다. 필요한 테스트·문서·복구 규칙은 정본으로 이관했다.

[이관 명세](consolidation-inventory.json), [마이그레이션](MIGRATION.md), [품질 계약](QUALITY-GATES.md), README에 새 명령과 이전 방법을 기록했다.

## 품질 항목별 이전·이후 평가

점수는 게이트 엔진에 대한 구현자 평가이며 보안 인증이나 운영 앱 품질 점수가 아니다. Sol은 독립적으로 코드 결함을 검토했으며 이 숫자를 인증한 것은 아니다.

| 항목 | 이전 | 이후 | 확인 근거 |
|---|---:|---:|---|
| 변경 분류·검사 선택 | 5 | 8.5 | docs/fast/standard/api/auth-db/performance, 주석·정적 리소스 제외 |
| typecheck/lint/영향 unit | 6 | 9 | 적용되는 필수 명령 부재·실패 차단, worker 전체 test 폴백 제거 |
| 변경 코드 coverage | 3 | 9 | diff 라인·분기 각각 90%, 계측 누락 차단 |
| 정상·실패·경계 테스트 | 5 | 8.5 | 소스와 실제 통과 기록 모두 요구 |
| API·권한·테넌트 격리 | 4 | 8.5 | source+method+route 단위 증거, 401/403/2xx/테넌트 행 검사 |
| security/performance 조건 | 6 | 9 | 해당 변경에만 실행, 필요한 검사 부재는 차단 |
| landing·rollback | 8 | 9 | 전체 회귀 landing 1회, RED rollback·push 차단 |
| 우회 방지 | 7 | 8.5 | only/skip/삭제/빈 테스트/단언·coverage·설정 완화 탐지 |
| manifest·완료·발행 | 7 | 9 | 명령·사유·결과·시간·지문, 미검증 완료와 stale 발행 차단 |
| 캐시·중복 제거·병렬 검사 | 4 | 8.5 | 동일 지문 재사용, 명령 공유, 독립 검사 병렬화 |
| 평균 | **5.5** | **8.75** | 독립 리뷰의 남은 코드 출시 차단 결함 0개 |

## 테스트와 coverage

최종 검증된 테스트는 **51개 파일의 고유 1,033건, 미해결 실패 0건**이다. 전체 실행과 변경 영향 재검증을 합친 결과이며, 단일 실행 1,033/1,033이라고 주장하지 않는다.

- 전체 회귀 1회: **1,010건 중 1,006 통과, 4 실패, skip 0**, 2,895.389초. V8 계측·소스 해시 수집과 동시성 3을 사용했다.
- 실패 4개 assertion은 두 child fixture가 계측 병렬 부하에서 300초 deadline에 도달한 결과였다. 코드·timeout·assertion을 완화하지 않고 동일 영향 범위만 별도 실행하여 benchmark **1/1**, integration RED **3/3** 통과를 확인했다.
- 전체 실행 뒤 runtime pin 9, refresh 6, installer 2, benchmark 입력 3, pin 입력 3의 고유 테스트를 추가·통과했다. 수정된 파일의 영향 테스트도 재검증했다.
- 마지막 핵심 경계 36/36, refresh 19/19, installer 2/2, benchmark 입력 3/3, pin 입력 3/3 통과. 이 숫자를 1,033건에 다시 더하지 않는다.
- Fable→Opus, Sonnet→Terra·Opus→Sol·Fable→Astra, 동일 제공자 자체 리뷰 금지, 모델 건강 공유, 파일 충돌, 중복 row, QA RED/push, integration RED/rollback, authorization matrix, coverage 차단, 조건부 검사, 우회 탐지, 구 상태·원장·예약 마이그레이션을 fixture와 회귀로 검증했다.
- **변경 라인 96.82% (1,523/1,573), 변경 분기 90.21% (1,051/1,165), 계측 누락 0개.** 현재 소스 SHA와 일치하는 계측 결과만 병합했다. 전체 저장소 coverage로 대체하지 않았다.

[검증 manifest](verification/manifest.json), [LCOV](verification/coverage.lcov), [changed coverage](verification/changed-coverage.json), [전체 실행 증거](verification/full-regression-evidence.json)에 명령·지문·결과를 남겼다. 로그는 같은 폴더에 있으며 행 끝 공백만 정리하고 원본은 로컬에 보존했다.

## 격리 프로젝트 설치 결과

`C:/Projects/jng-os-batch24-release`에 이전 로컬 tooling 커밋 `d77f61d`를 기반으로 설치했다. 실제 운영 프로젝트에 적용한 커밋이 아니며 아직 격리 준비 상태다.

- 실제 앱 unit: **169개 파일, 4,600 통과 + 기존 skip 3**, 65.39초. 전체 217개 테스트 파일은 unit 169와 DB integration 48로 나뉜다.
- 프로젝트 의미적 `npm run typecheck` 통과, `npm run lint` 오류 0·경고 0. 두 수동 명령의 정확한 시간은 보존되지 않아 수치를 만들지 않았다. 엔진 MJS 실행/구문 검증을 의미적 타입 검사로 표기하지 않는다.
- 설치된 모델 라우팅·품질·권한 테스트 **71/71, skip 0**, 83.356초.
- 정본과 설치된 실행 파일·필수 테스트 **53개 SHA 일치**, 기존 상태를 읽는 dry plan exit 0.
- 실제 Vitest adapter fixture 9/9 통과. 실제 앱 DB·외부 모델 요청은 실행하지 않았다. 엔진 HTTP matrix fixture 성공을 운영 endpoint 검증으로 바꾸어 기록하지 않는다.

## 성능과 오래 걸린 원인

| 정상 합성 배치 중앙값 | 이전 | 이후 | 증가 |
|---|---:|---:|---:|
| 성공 표본 각 3개 | 21.756초 | 26.124초 | **20.08%** |

30% 조사 기준을 넘지 않았다. 기준 커밋의 완전한 엔진과 같은 합성 CLI fixture를 비교했다. 최초 교차 측정 뒤 마지막 경로 guard 수정에 대해서만 후보 3회를 재측정하고 변하지 않은 기준 3회를 재사용했다. [표본](verification/benchmark.json)을 보존했다. 표본 수가 작고 실 LLM·운영 DB 지연은 포함하지 않는다.

작업 지연의 큰 원인은 전체 V8 계측 회귀가 48.26분 걸리고 병렬 child fixture가 deadline에 도달한 것이다. 이 시간을 정상 배치 비용으로 혼동하지 않는다. 이후 검증은 변경 파일별 검사와 기존 지문 증거를 재사용했으며, raw coverage 전체 복사·재처리를 반복하지 않고 증분 병합했다. 앞으로 전체 회귀는 비계측 실행, 변경 코드만 계측하고 시간 측정과 겹치지 않도록 한다. 품질 임계치·skip 허용을 완화하지 않았다.

## 전역 설치와 운영 상태

Claude `C:/Users/user/.claude/skills/batch-24-multiAG`와 Codex `C:/Users/user/.codex/skills/batch-24-multiAG`는 백업 후 검증된 구현 `be8e776`으로 갱신했다. 최초 갱신 시 각 146개 파일을 해시 대조했고, 16:01 KST 최종 문서·증거 동기화 후 각 156개 파일의 SHA 일치와 모델 정책·품질 모듈 로드를 확인했다. 기존 실행 중인 운영 runner가 이 갱신만으로 교체되는 것은 아니다.

**전역 단일화는 미완료다.** Claude의 `night-batch-ops`, `auto-story-finish`, Codex의 `auto-story-finish`를 보존했다. 구 전역 경로에 의존하는 실제 프로젝트가 남아 있기 때문이다. inspectier 두 프로젝트의 pinned runtime 이전은 빈 전역 환경에서 격리 smoke 6/6으로 검증했고 안전한 적용·rollback 스크립트를 준비했지만 실제 프로젝트에는 적용하지 않았다.

운영 `C:/Projects/jng-os-auto`는 `19cc0b85`이며 이번 작업에서 변경하지 않았다. 2026-09-06 **16:02 KST** 조회 당시 `BaroOS-auto-slots`는 Ready, 다음 실행은 **16:05 KST**였다. 예약 작업을 끄거나 켜지 않았으며 운영 원격/main push도 하지 않았다.

운영 전환의 차단 사유는 DB integration 준비 상태다. 실제 테스트는 존재하지만 48개 파일에 hardcoded `it.skip` 51개, `it.skipIf` 19개, `ctx.skip` 134개 사용 지점이 있다(실행 테스트 수가 아닌 소스 선언 수). 엄격한 zero-skip landing 검사는 일반 코드 배치도 차단할 수 있다. 외부 계정·이메일·DB 쓰기를 동반할 수 있는 probe를 임의로 켜거나 인증 정보를 복사하지 않았다. API/auth/security/performance 프로젝트 adapter 부재는 각각 해당 변경에만 차단 사유가 된다.

운영 적용 순서는 앱 DB 통합 계약 정비 → 검토된 tooling 커밋 확정 → no runner lock AND no matching PID → 예약 진입 중지 후 재확인 → 도구만 적용 → routing/quality/dry plan → 성공 시 예약 복원이다. 실제 프로젝트 pinned 실행 검증이 끝난 뒤 구 전역을 제거한다. 앱 DB 테스트 보완까지 이번 작업에 포함할지 사용자 범위 선택이 남아 있다.

## Sol 독립 리뷰와 남은 한계

**gpt-5.6-sol / high**가 독립 리뷰를 수행했다. 초기 API 일부 endpoint 누락, worktree 보존·runtime pin, 검증 이후 발행 변경 문제를 수정한 뒤 **남은 코드 출시 차단 결함 0개**로 확인했다. 검토된 구현 11개 파일 지문은 `02ff9429f77ad3c7b1ebd1988da8b3fa658e47e72e163044e1df7166676c5245`다. 구현자와 다른 모델이며 동일 OpenAI 제공자다. 엔진의 교차 제공자 리뷰 정책 검증과 구분한다.

[Sol 리뷰 결과](SOL-HIGH-REVIEW-RESULT.md)와 [후속 리뷰 체크리스트](SOL-HIGH-REVIEW.md)를 함께 제공한다. 다음 검토는 실제 앱 DB/권한 adapter와 배치 경계 전환 증거에 집중하면 된다. 새 대화를 만들어 이미 끝난 엔진 리뷰를 반복할 필요는 없다.

정적 분류·테스트 이름 검사는 assertion의 의미적 충분성을 완전히 증명하지 않는다. 동적·mounted route에는 소스 SHA에 묶인 명시적 inventory가 필요하다. 로컬 검증기까지 수정할 수 있는 관리자에 대한 위조 방어 인증은 아니다. 실제 앱 인증·RLS/테넌트 격리와 운영 DB 결과는 아직 검증되지 않았다. 따라서 저장소 gate verdict `ready`는 운영 스토리 완료나 운영 전환 승인을 의미하지 않는다.
