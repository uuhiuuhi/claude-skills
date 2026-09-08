---
name: batch-24-multiag
description: BMad 프로젝트에서 Claude Fable, Opus, Sonnet과 Codex Astra, Sol, Terra를 품질 등급별 구현·독립 리뷰 쌍으로 자동 운용하는 24시간 배치를 설치·업데이트·실행·진단하거나 “Story 4-1부터 4-4까지 마무리해줘” 같은 수동 스토리 완료 요청에 사용한다. night-batch-ops와 auto-story-finish를 대체하는 유일한 canonical 스킬이다. Fable 한도 시 Opus 전환, 공유 모델 상태, 병렬 워커, QA 게이트, 재개 근거와 운영 러너의 무중단 교체를 포함한다.
---

# batch-24-multiAG

BMad 스토리를 24시간 자동 편성하면서 Claude와 Codex를 구현·독립 리뷰에 함께 사용한다. 작업 속도는 서로 독립인 스토리를 병렬 실행해 높이고, 품질은 구현자와 리뷰어를 다른 제공자·모델로 분리하고 QA 게이트와 산출물 지문으로 지킨다.

## 모델 정책

| 작업 등급 | 구현 | 독립 리뷰 |
|---|---|---|
| 빠른 처리 | Claude Sonnet | Codex Terra medium |
| 표준·복잡 | Claude Opus | Codex Sol high |
| 고위험·최종 검증 | Claude Fable | Codex Astra high |

계획 오케스트레이터는 Fable을 우선 사용하고 사용량 한도에 닿으면 Opus로 전환한다. 한 모델의 한도·인증·일시 장애 상태는 모든 워커가 공유하며, 같은 모델을 반복 호출하지 않는다. 세부 조건과 완료 근거는 [references/MODEL-ROUTING.md](references/MODEL-ROUTING.md)를 따른다.

## 프로젝트 설치

대상 프로젝트 루트에서 실행한다.

```powershell
node "$env:USERPROFILE\.claude\skills\batch-24-multiAG\install.mjs" --force
```

설치기는 실행 엔진과 모델 런타임을 프로젝트의 `tools/auto/` 아래에 함께 고정한다. 전역 스킬의 이후 변경이 실행 중인 배치에 섞이지 않는다. 기존 `auto.config.json`과 수동 큐는 보존한다.

설치 후 `tools/auto/auto.config.json`에서 프로젝트별 `epicOrder`, 상태 폴더, 동시 실행 수를 확인한다. 여섯 모델 정책은 `modelPolicy.enabled: true`일 때 적용된다. `workers.max`와 `providers.*.max`는 동시 실행 상한이며 하루 총 호출량 제한이 아니다.

## 실행과 검증

먼저 실제 호출 없이 편성 결과를 확인한다.

```powershell
node tools/auto/plan-queue.mjs --dry
node --test tools/auto/model-routing.test.mjs
```

실행 로그의 `[MODEL-ROUTE]`에서 선택 모델, 대체 이유와 구현·리뷰 분리를 확인한다. 상태 폴더의 모델 건강 상태와 검증 매니페스트에서 한도 전환, QA 결과, 코드·리뷰 지문을 확인한다. QA가 RED이면 중단하고 push하지 않는다.

## 운영 러너 업데이트

실행 중인 러너 파일을 덮어쓰지 않는다. lock의 PID와 실제 프로세스가 모두 사라진 배치 경계에서 예약 작업의 새 진입을 잠시 막고, 검토된 커밋을 운영 브랜치에 적용한 다음 라우팅 테스트와 dry plan을 실행한다. 검증이 통과한 뒤 예약 작업을 다시 활성화한다. 작업 트리에 배치 산출물이 남아 있으면 정리하거나 되돌리지 말고 현재 라운드의 정상 종료를 기다린다.

예약 등록과 복구 절차는 [AUTOFINISH.md](AUTOFINISH.md), 모델별 장애 범위와 증거 기준은 [references/MODEL-ROUTING.md](references/MODEL-ROUTING.md)를 참고한다.

## 수동 스토리 완료

“Story 4-1부터 4-4까지 마무리”, “11-2,11-3 create-dev-review”, “dev-review만”도 이 스킬로 처리한다.
먼저 실제 git worktree로 격리하고 프로젝트 설치본에서 sprint 키를 해석하고 done은 제외한다. 의존성이 해결되지 않은 스토리는 계획에서 보류한다.

```powershell
node tools/auto/finish-stories.mjs --from 4-1 --to 4-4 --dry-run
node tools/auto/finish-stories.mjs --from 4-1 --to 4-4
node tools/auto/finish-stories.mjs --stories 11-2,11-3 --stages dev,review
```

수동 명령은 create → dev → QA·자동 수리 → 교차 제공자 review를 수행하며 commit/push는 기본 꺼짐이다.
CLI 인증이 만료되면 살아 있는 기존 엔진이 없는지 확인한 뒤 대화창에서 같은 순서를 직접 진행한다.
직접 진행도 독립 제공자 리뷰와 동일 품질 manifest를 요구한다. 독립 리뷰 제공자를 호출할 수 없으면
구현은 보존하고 `not-verified`로 남긴다. 같은 제공자의 다른 모델을 독립 리뷰로 대신하지 않는다.

## 필수 품질 정책

[QUALITY-GATES.md](references/QUALITY-GATES.md)가 검사 선택·증거·캐시 계약의 정본이다.
먼저 docs / fast / standard / api / auth-db / performance를 판정한다. docs에는 코드 검사 없음.
코드에는 typecheck·lint·영향 unit 및 변경 줄/분기 coverage 90%를 요구한다.
API에만 관련 integration, 인증·권한·DB·RLS에만 authorization/security, 성능 변경에만 performance를 실행한다.
필수 스크립트·실행 증거·새 정상/실패/경계 테스트가 없으면 완료·commit·push를 차단한다.
`--no-manifest`, `--integrity off`, 예전 `integrationGate.enabled: false`로 필수 정책을 끌 수 없다.

전체 unit/integration은 병렬 landing 후 한 번 실행한다. 문서-only landing에는 실행하지 않는다.
같은 커밋·지문·diff·검사 구현·설정의 성공 결과만 재사용한다. 같은 명령은 한 번 실행해 공유한다.
중앙 실행 시간이 기존보다 30% 이상 늘면 원인을 분석하고 검사 선택·캐시·병렬화를 조정한다.

## 통합·복구

[마이그레이션](references/MIGRATION.md)을 따른다. `engine/`과 그 안의 `runtime/`이 유일한 소스다.
프로젝트는 이 트리를 `tools/auto/`로 고정하며 전역 스킬의 존재를 실행 조건으로 삼지 않는다.
기존 상태·원장 파일명과 예약 작업 ID는 보존하고 구 schema를 읽어서 새 기록만
`batch-24-multiag/*`로 쓴다. 두 구 스킬의 운영 복구 자료는 `references/`로 이관했다.
역사 문서의 과거 모델/검사 정책보다 현재 SKILL.md와 QUALITY-GATES.md가 우선한다.

전역 중복 스킬 삭제는 통합 전체 회귀와 격리 설치 스모크가 모두 통과한 후 수행한다.
운영 설치는 lock 파일과 실제 runner PID가 모두 없는 배치 경계에서만 한다.
예약 작업을 잠시 비활성화하고 기존 스토리·로그를 그대로 보존한 상태로 검토 커밋의 도구만 반영한다.
라우팅·품질 테스트와 dry plan 성공 후 원래 활성 상태를 복구한다. 운영 원격 브랜치는 명시 승인 없이 push하지 않는다.
