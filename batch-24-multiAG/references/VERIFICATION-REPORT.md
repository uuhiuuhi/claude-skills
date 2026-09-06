# 통합 품질 검증 보고서 — 2026-09-06

저장소 구현·통합 검증은 끝났으며 **운영 이전은 미완료**다. 검토 대상은 `codex/quality-gates-9-consolidation`, 기준은 `166e28c`다. 별도 worktree `C:/Projects/claude-skills-quality-gates-9`에서 작업했다. 운영 프로젝트 파일·스토리·로그·예약 설정은 변경하지 않았다.

## 구조와 중복 제거

- 유일한 배치 정본: `batch-24-multiAG/`. `engine/`은 예약·lock·큐·워커·landing·복구, `engine/runtime/`은 create/dev/review·모델·품질·완료 근거를 담당한다.
- `finish-stories.mjs`가 수동 범위·의존성·중복 sprint row를 처리한다. 설치기는 runtime을 프로젝트에 고정한다.
- `quality-gates.mjs`, `authorization-matrix.mjs`, `schema-migration.mjs`를 추가했다. runner의 push guard는 runtime 정본을 재수출한다.
- 구 두 폴더의 92개 파일(2,180,069 bytes)을 이관 대조 후 저장소에서 제거했다. 이 수치는 제거 폴더의 크기이며 순수 저장소 절감량은 아니다. 필요한 테스트·문서는 정본으로 옮겼다. 46개 이관 파일은 byte-identical이고 46개는 통합 계약에 맞게 수정됐다.
- [이관 명세](consolidation-inventory.json), [이전 방법](MIGRATION.md), [품질 계약](QUALITY-GATES.md)에 원본/대상 해시와 사용법을 기록했다. 과거 복구·리뷰 문서는 역사 자료로 보존했다.

## 품질 항목 평가

아래 점수는 동일한 10점 척도를 사용한 구현자 평가다. 독립 평가나 보안 인증 점수가 아니다. 대상은 게이트 엔진이며, 미완료인 운영 이전을 완료로 평가하지 않는다.

| 항목 | 이전 | 이후 | 근거 |
|---|---:|---:|---|
| 변경 분류·검사 선택 | 5 | 8.5 | docs/fast/standard/api/auth-db/performance, 주석·정적 리소스 제외 |
| typecheck/lint/영향 unit 강제 | 6 | 9 | 프로젝트 필수 명령 부재·실패 차단, worker 전체 test 폴백 제거 |
| 변경 코드 coverage | 3 | 9 | LCOV diff 교집합, 90%·계측 누락 차단 |
| 정상·실패·경계 테스트 | 5 | 8.5 | 소스와 실제 통과 이름 모두 요구 |
| API·권한·테넌트 격리 | 4 | 8.5 | 실제 HTTP 401/403/2xx/403 또는 404 helper·신선한 보고서 |
| security/performance 조건 | 6 | 9 | 적용되는 필수 검사만 실행, required-missing 차단 |
| landing·rollback | 8 | 9 | full/integration 한 번, 첫 RED 즉시 rollback·push 차단 |
| 우회 방지 | 7 | 8.5 | only/skip/삭제/빈 테스트/단언·설정 완화/Node coverage 지시문 차단 |
| manifest·완료·발행 | 7 | 9 | 코드 지문·실행 명령·사유·결과·시간, 미검증 완료 차단 |
| 캐시·중복 제거·병렬 검사 | 4 | 8.5 | 동일 지문 결과 재사용, 15종 손상 캐시 재검사 |
| 평균 | **5.5** | **8.75** | Sol-high 독립 검토 전 잠정 평가 |

## 회귀와 coverage

- 기준 회귀: **897/897**, 991.66초.
- 최종 전체 실행: **966건 중 963 통과, 3 실패**, 2,416.79초. V8 계측과 소스 해시 수집을 포함했다.
- 실패 3건은 구 retry 기대값 2건과 순차 worker 검사 2회를 landing 재실행으로 잘못 센 기대값 1건이었다. worker 계약 **31/31**, 순차 rollback **3/3** 재검증으로 해결했다. 실제 rollback·원격 차단은 전체 실행에서도 통과했다.
- 이후 추가한 fixture 계약 6건, Telegram 구 offset/BOM 이전 1건, runtime 경로 1건도 통과했다. **현재 45개 테스트 파일, 중복을 제외한 974개 테스트의 미해결 실패 0건**이다. 이는 전체 실행과 영향 재검증을 합친 결과이며, 단일 실행 974/974라고 주장하지 않는다.
- 최신 품질 정책 **51/51**, canonical-only 설치 **4/4**, 실제 Claude·Codex 전역 라우팅 각각 **17/17**.
- JavaScript 구문 **87/87**, 이 중 동일 해시 **80개 재사용**. `git diff --check` 통과. 이 저장소에는 TypeScript/ESLint 프로젝트가 없으며 구문 검사를 의미적 타입 검사로 표기하지 않았다. 설치 대상 프로젝트의 typecheck/lint 명령 강제는 별도로 테스트했다.
- **변경 라인 97.79% (1150/1176), 변경 분기 90.51% (734/811), 계측 누락 0개.** 전체 저장소 수치로 변경 코드 누락을 가리지 않았다.
- [manifest](verification/manifest.json), [LCOV](verification/coverage.lcov), [변경 coverage](verification/changed-coverage.json)에 근거를 보관했다. 전체 실행·영향 재검증 출력 로그도 같은 폴더에 있다(행 끝 공백 정리, 원본은 로컬 보존).

## 실행 시간

기준 커밋의 완전한 `batch-24-multiAG/engine`과 최종 엔진을 같은 합성 CLI fixture에서 번갈아 3회씩 실행했다. 여섯 실행 모두 exit 0이다.

| 정상 배치 중앙값 | 이전 | 이후 | 증가 |
|---|---:|---:|---:|
| 최종 성공 표본 | 22.240초 | 26.408초 | **18.74%** |

30% 조사 기준을 넘지 않았다. 실 LLM·운영 DB 지연은 측정하지 않았다. [원본 표본](verification/benchmark.json)을 참고한다. 구 night 엔진과 새 runtime을 혼합해 실패한 재측정 표본은 비교에서 제외했다. 계측 전체 회귀 40분은 정상 배치 성능 수치로 사용하지 않았다. 중복 커버리지 복사는 중단하고 원본 직접 읽기로 바꿨다.

## 전역·운영 상태

Claude와 Codex의 `~/.claude/skills/batch-24-multiAG`, `~/.codex/skills/batch-24-multiAG`를 백업 후 갱신했다. 각 전역의 core 120개 파일을 원본과 해시 대조했고 라우팅 테스트를 통과했다.

**전역 단일화와 운영 반영은 아직 완료하지 않았다.** 실제 `jng-os`, `jng-os-auto`에는 `tools/auto/runtime/auto-story-pipeline.mjs`가 없으며 affected-unit/coverage/API/authorization/security/integration 스크립트도 없다. 구 전역을 지금 지우면 기존 실행을 깨뜨리므로 Claude의 구 두 스킬과 Codex의 구 auto-story-finish를 보존했다. 임시 설치 fixture의 pinned 실행 성공을 실제 기존 프로젝트 이전 성공으로 바꾸어 기록하지 않았다.

운영 예약 작업은 비활성화하거나 변경하지 않았다. 13:47 KST 조회 기준 `BaroOS-auto-slots`는 Ready, 다음 실행은 **2026-09-06 14:05 KST**였다. 구 night 작업은 Disabled였다. 운영 원격/main push는 수행하지 않았다.

다음 운영 단계는 프로젝트 검사 adapter 준비 → reviewed commit 확정 → no runner lock AND no matching PID → 예약 진입 중지·재확인 → 도구만 적용 → routing/quality/dry plan → 성공 시 예약 복원이다. 실제 프로젝트 pinned 실행을 검증한 뒤에만 구 전역을 제거한다.

## 한계와 독립 리뷰

분류·단언 검사는 완전한 AST 분석이 아니다. 테스트 이름과 coverage만으로 의미적 assertion 품질을 증명하지 않는다. API 보고서는 변경 source 파일의 계약이며 같은 파일 안 모든 endpoint/method와 middleware 위치는 독립 검토가 필요하다. 로컬 보고서·캐시는 엔진까지 수정할 수 있는 관리자에 대한 위조 방어 경계가 아니다. 운영 인증·테넌트 데이터는 이번 fixture 시험으로 검증됐다고 주장하지 않는다.

[Sol-high 리뷰 체크리스트](SOL-HIGH-REVIEW.md)를 준비했다. 실제 독립 리뷰는 아직 수행하지 않았다. 기능 브랜치와 draft PR을 검토 대상으로 사용하며 운영 배포 승인을 대신하지 않는다.
