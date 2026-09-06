# Sol-high 독립 리뷰 체크리스트

대상: `codex/quality-gates-9-consolidation`, 기준 `origin/codex/batch-24-multiag` (166e28c).
리뷰는 구현과 다른 제공자에서 수행한다. 이 문서는 리뷰 요청안이며 Sol의 실제 리뷰 완료 기록이 아니다.

## 출시를 막아야 하는 항목

- 변경 코드 라인·분기 coverage가 각각 90% 이상인지 원본 LCOV와 diff로 재계산한다. 계측 누락을 0개 분모로 숨기지 않는다.
- 전체 회귀, 설치 스모크, pinned runtime 검증의 성공 여부와 코드 지문이 최종 변경과 일치해야 한다.
- `not-ready` / `not-verified`, QA RED, 필수 스크립트 부재가 done·commit·push 어느 경로에서도 우회되지 않아야 한다.
- API authorization 보고서가 실제 미들웨어/요청 테스트에 의해 생성되는지 확인한다. 모든 변경 endpoint와 method를 확인한다.
- auth/permission/DB/RLS의 401·403·2xx·타 회사/테넌트 403 또는 404가 실제 테스트 데이터에 대해 성립해야 한다.
- `.only`, skip/todo, 테스트 삭제·빈 테스트·단언 약화, coverage exclude·임계치 저하, lint/typecheck 완화의 우회 사례를 직접 시도한다.

## 품질 정책과 검사 비용

- docs/주석/정적 리소스는 코드 게이트 0회, 일반 변경은 영향 검사만, API/auth-db/performance는 조건에 맞는 게이트만 실행하는지 확인한다.
- 보안 변경의 필수 스크립트 누락은 차단한다. 무관한 선택 스크립트 누락은 차단하지 않는다.
- test:affected 없이 전체 test를 스토리마다 실행하는 폴백이 없어야 한다.
- unit의 정상·실패·경계 테스트는 소스 존재뿐 아니라 실제 통과 기록도 필요하다. quoted fake test와 TAP SKIP/TODO를 거부해야 한다.
- 동일 명령의 중복 실행 방지, 독립 typecheck/lint/unit 병렬화, landing 전체 unit/integration 각 1회 실행을 호출 기록으로 확인한다.
- 같은 HEAD·base·코드 지문·설정·정책·환경에서만 캐시를 재사용한다. RED나 손상된 캐시는 재사용하지 않는다.
- 캐시는 로컬 신뢰 경계에 있다. 워커가 수정 가능한 캐시·매니페스트에 대한 위조 내성과 제공자 실행 권한을 별도로 검토한다.
- 기존 정상 배치와 같은 fixture/환경의 성공 표본만 비교한다. 중앙값 증가 >=30%면 명령별 병목을 분석한다. 스텁 시간과 실 LLM 시간을 구분한다.

## 모델·동시성·복구

- Fable limit → Opus, Sonnet→Terra, Opus→Sol, Fable→Astra 라우팅과 동일 제공자 리뷰 금지를 재현한다.
- 워커 간 모델 건강 상태 공유, 늦은 성공의 새 실패 상태 덮어쓰기 방지, cooldown 및 인증 장애 범위를 확인한다.
- 재개 시 이전 실제 구현자 기록과 코드 지문을 사용해야 한다. 과거 done만으로 QA/리뷰를 생략하지 않는다.
- dry run이 완료·리뷰·QA 성공 상태를 새로 만들지 않아야 한다.
- 중복 sprint row 단일 편성, 파일/SQL/manifest 충돌 회피, worker 경합을 실제 worktree에서 검증한다.
- integration RED 뒤 landing rollback, 증거 보관, push 차단 및 후속 코드 변경 시 publication 무효화를 확인한다.
- 워커 git guard, 원격 자격증명 제거, 민감 파일 복원, 로그 마스킹, 인박스 트랜잭션 규칙을 유지해야 한다.

## 통합·설치·운영

- consolidation-inventory.json의 92개 원본 파일과 canonical 경로·해시를 대조한다. 공개 export가 re-export 포함 보존되는지 확인한다.
- 구 schema/상태/원장/예약 task ID를 읽되 새 schema는 batch-24-multiag/*를 사용해야 한다. 미검증 상태의 자동 승격은 금지한다.
- 수동 Story 4-1~4-4와 예약 큐가 같은 runtime을 사용하고 의존성·중복·이미 완료된 행을 처리하는지 확인한다.
- 두 전역의 유일한 배치 스킬, 구 전역 제거 후 기존 프로젝트 pinned runtime, force 설치의 config/queue 보존을 검증한다.
- 운영 배포 전 적용 커밋을 검토한다. no lock AND no matching PID 확인 → 예약 진입 중지 → 재확인 → 적용 → 라우팅/품질/dry plan → 성공 시 예약 복원 순서를 지킨다.
- 운영 스토리 변경·로그는 보존하고 운영 원격 브랜치와 main에는 push하지 않는다.

최종 리뷰 결과는 결함별 파일/라인, 재현 명령, 예상/실제 결과, 심각도 및 출시 차단 여부로 작성한다.
