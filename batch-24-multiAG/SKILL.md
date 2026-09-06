---
name: batch-24-multiag
description: BMad 프로젝트에서 Claude Fable, Opus, Sonnet과 Codex Astra, Sol, Terra를 품질 등급별 구현·독립 리뷰 쌍으로 자동 운용하는 24시간 배치를 설치·업데이트·실행·진단할 때 사용한다. Fable 한도 시 Opus 전환, 공유 모델 상태, 병렬 워커, QA 게이트, 재개 근거와 운영 러너의 무중단 교체를 포함한다.
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
