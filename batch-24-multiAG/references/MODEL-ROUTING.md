# 여섯 모델 라우팅 계약

## 기본 쌍

| 등급 | Claude 구현 | Codex 리뷰 | 용도 |
|---|---|---|---|
| fast | Sonnet | Terra medium | 범위가 작고 되돌리기 쉬운 작업 |
| standard | Opus | Sol high | 일반 기능과 복합 수정 |
| critical | Fable | Astra high | 보안·데이터·아키텍처·최종 검증 |

구현과 리뷰는 다른 제공자를 사용한다. 모델 이름을 직접 고정한 프로젝트 설정이 있으면 명시적 설정이 우선하지만, 빈 값은 정책을 끄는 값으로 쓰지 않는다.

## 한도와 장애 전환

- Fable 사용량 한도는 Opus로 전환하고 전환 사유를 기록한다.
- 모델 상태는 한 워커 안에 가두지 않고 상태 폴더를 통해 공유한다. 다른 워커가 같은 실패 모델을 즉시 재호출하지 않는다.
- 인증 오류, 사용량 한도, 일시 장애를 서로 다른 상태로 기록한다. 제공자 전체 장애와 특정 모델 장애도 분리한다.
- 대체 후에도 구현자와 리뷰어가 같아지면 독립 리뷰 조건을 만족하는 다음 쌍을 고른다.
- 회복 시각이나 사용자가 해제한 근거가 없으면 소진 모델을 자동 복구로 추정하지 않는다.

### 한도 강등 정책 (👤 2026-09-07 「1 추천대로」)

사용량 한도(`limit` · exit 5)를 만났을 때 **다른 모델을 고를지**는 단계와 배치 종류가 정한다. 러너가 `--batch-kind new|recovery|closeout` 으로 종류를 넘기고, 엔진은 `modelPolicy.limitDowngrade` 로 판정한다. 기본값:

| 단계 · 배치 | 판정 | 뜻 |
|---|---|---|
| review (마감 재검수·신규 리뷰) | **block** | 다른 모델을 고르지 않는다. 한도를 공유 상태에 기록하고 exit 5(날씨)로 나가 리셋 뒤 같은 모델로 재시도한다. 리뷰어 품질을 깎아 통과시키지 않는다. |
| dev · 회수(recovery) | **relax** | 품질 하한을 sonnet(tier 1)까지 내려 계속한다. 범위가 고정된 회수 diff 는 sonnet 으로도 마감할 수 있다. |
| dev · 신규(new) · 마감 재검수 뒤 dev | **floor** | 종전 그대로 — 역할 하한 안에서만 다음 모델(fable→opus). 하한 아래 모델이 없으면 exit 5. |
| create · replan · mockup | **floor** | 정책 대상이 아니다(계획 단계는 fable→opus 만). |

설정으로 넓히거나 좁힌다: `"modelPolicy": { "limitDowngrade": { "review": false, "dev": { "recovery": true, "new": false } } }`. review 하한(고위험 tier 3 · 그 외 tier 2)은 어떤 설정으로도 내려가지 않는다 — `review: true` 는 「하한 안에서 다음 모델」까지만 연다. 라우팅을 끈(legacy) 경로와 스토리 경계 프로브도 같은 모드를 따른다 — `floor` 는 사다리에서 sonnet 을 빼고, dev 의 한도 전환은 어떤 모드든 Claude 안에서만이다(Codex 로 넘어가지 않는다).

### Codex 구현 허용 — sol 구현 → astra 리뷰 (👤 2026-09-26 「astra·sol 을 더 써서 opus 사용량을 줄여줘」 → (나))

기본은 종전 경계다: **구현은 Claude, 리뷰는 Codex**(고위험 risk ≥ 4 구현은 Claude 만 · codex 끼리 리뷰 금지). 설정 `modelPolicy.codexDev` 를 켜면 Codex 도 구현을 맡는다 — Claude(Opus) 주간 한도를 아끼기 위한 스위치다.

```json
"modelPolicy": { "codexDev": { "enabled": true, "maxRisk": 10, "models": ["codex:gpt-6-astra"], "review": "opus" } }
```

- `enabled`(기본 false): 켜면 dev 후보에 `models`(기본 sol 하나)가 들고, 편성기 `models.new.dev / models.recovery.dev` 에 적힌 `codex:gpt-5.6-sol` 을 배정기가 claude 로 되돌리지 않는다.
- `maxRisk`(기본 3): 이 위험도까지만 Codex 구현. 넘으면 종전대로 Claude(fable→opus). 10 이면 전부.
- `models`: dev 를 맡을 Codex 모델. **astra 는 여기 넣지 않는다** — 리뷰 몫이다. dev 가 astra 면 고위험 리뷰 후보(tier 3 = astra 뿐)가 없어 보류(exit 5)된다.
- `review`(기본 없음 · 👤 2026-09-26 20:5x 「opus 를 astra 로 대체 · astra 하던 일을 opus 가」): Codex 구현 스토리의 리뷰를 맡을 **Claude** 모델(예 `opus`). 적으면 그 스토리의 review 후보가 `[review, …codex]` 가 되고, **그 모델에 한해** 리뷰 품질 하한이 그 모델의 tier 까지 내려간다(고위험 tier 3 규칙의 유일한 예외). Claude 리뷰는 `--output-format stream-json` 추적의 Read 기록으로 열람 증거를 채운다 — 스토리·diff·변경 파일을 전부 읽지 않으면 `not-run(missing read evidence)` 로 완료가 막힌다. 구현자가 Claude(옛 opus 스토리의 마감 재검수)면 예외가 아니라 종전대로 codex(astra)가 리뷰한다. 편성기가 review 를 `codex` 로 덮지 않게 `providers.codex.reviewKinds` 를 `[]` 로 둔다.
- 교차 검토(T6): dev·review 가 **둘 다 codex** 면 제공자가 아니라 **모델**이 다를 때 「만든 쪽과 다른 쪽」으로 인정한다(sol ≠ astra). claude 끼리는 여전히 미달(print 어댑터가 열람 증거를 못 낸다) · 같은 codex 모델·모델 기록 누락도 미달. `completion-rules.crossReviewResult` · `readiness.crossReviewVerdict` · 파이프라인 `REVIEW STOP — same-provider` · 배정기 · 편성기가 같은 잣대다.
- 한도·실패: sol 이 한도(limit)면 라우터가 Claude 후보로 내려간다(배치가 서지 않는다). 같은 스토리에서 codex dev 가 연속 2회 실패하면 배정기가 claude 로 피한다(assign-history). 마감 재검수(closeout · review 만)는 구현자 기록(sol)을 보고 astra 를 고른다.
- 되돌리기: `enabled: false`(또는 키 삭제) + `models.*.dev` 를 `opus` 로(+ `models.*.review` 를 codex 로 · `reviewKinds` 복원). 엔진 재설치 없이 설정만으로 종전 경계로 돌아간다.

### 리뷰 비용 상한 (👤 2026-09-07 「2 예」)

편성기 `autonomy.maxReviewRoundsPerStory`(기본 2). 스토리 파일에서 **마지막 replan 표식(`### Replan <날짜>` · `### 회수 라운드 <날짜>`) 뒤의** Codex 교차리뷰 헤딩(`### Review Findings — Codex 교차리뷰`)을 센다. 상한에 닿은 스토리에 review 를 편성해야 하면 `replan` 을 먼저 세운다 — 마감 재검수는 `replan → dev → review`(replan 이 연 Task 를 dev 가 반영한 뒤에만 리뷰), 그 외는 `replan` 을 앞에 붙인다. replan 은 표식을 남기므로 그 뒤로 다시 상한만큼 리뷰할 수 있다(무한 replan 방지). 회수(dev 만) 배치는 review 단계가 없어 대상이 아니다. `0` 이면 끈다.

**총량 상한 = 사람 게이트.** replan 이 카운터를 되돌리므로 since-카운터만 보면 replan→dev→review 가 사람 없이 무한히 돈다. 그래서 스토리의 Codex 리뷰 **총량**이 `maxReviewRoundsPerStory × (maxReplansPerStory + 1)`(기본 2 × 3 = 6 — dev-status 리뷰 반복 게이트와 같은 잣대)에 닿으면 그 스토리만 「자율 한계」로 사람 질문(`human-gates.json` → 「내가 할 일 뭐야」)에 올린다. 사람이 원인을 판단해 풀 때는 스토리 파일 0열에 `REVIEW-CAP-RESET: <날짜> — <사유>` 한 줄을 적는다 — 그 뒤부터 다시 센다. 펜스(```/~~~) 안의 헤딩은 세지도 되돌리지도 않는다.

### 사용량 API 직접 읽기 (👤 2026-09-09 「2 a」 — 엔진 동결 예외)

CLI 실패 문구는 한도의 종류를 말하지 않는다. 2026-09-09 실측: Fable **주간 모델별 한도 100%** 인데 `claude -p --model fable` 은
「You've hit your monthly spend limit」(크레딧 문구)를 냈고, 엔진이 이를 spend(프로바이더 전체 30분 차단)로 적어 살아 있는 opus 까지
「가용 모델 없음」으로 세웠다(밤 신규 dev 0건 · 같은 시각 헤드리스 opus·sonnet 정상).

- `runtime/usage-probe.mjs` 가 사용량 화면과 같은 응답(`api/oauth/usage` · `~/.claude/.credentials.json` 의 OAuth 토큰)을 읽는다.
  토큰은 어떤 로그·스냅샷·오류에도 실리지 않는다. 조회 실패는 null — 프로브가 배치를 세우지 않는다(종전 동작).
- 러너는 **슬롯 시작**(오케스트레이터 사다리 직전)에 한 번 조회해 `[USAGE] 세션 51%(리셋 …) · 주간 52% · fable 100%🔴(09-14 02:00) · 크레딧 소진`
  한 줄을 남기고 `<stateDir>/usage-snapshot.json` 을 쓴 뒤, 한도를 model-health 에 **limit(모델 스코프 · retryAt = 리셋 시각)** 으로 적는다.
  판정: 모델별 한도 → 그 모델만 · 세션/주간 전체 100% → Claude 전 모델 · 크레딧 → 차단 사유 아님(플랜 몫으로 계속).
- 워커는 「spend limit」 문구를 받으면 스냅샷(45분 이내)이 그 모델의 플랜 한도를 증언할 때만 limit 으로 재분류해 사다리(fable→opus)를 탄다.
  증언이 없으면 종전대로 spend(진짜 크레딧 지갑 문제).
- 해제(2026-10-11): 같은 조회가 세션·주간 전체·그 모델의 모델별 한도를 **모두 실측해 100% 아래**로 읽었는데 그 모델의 최신 사건이
  아직 유효한 limit 이면 **clear(모델 스코프)** 를 한 건 적어 그 모델만 푼다. 계정을 바꿔 한도가 내려와도 예전 limit 이 라우터를 막아
  success 가 영영 적히지 않던 문제(닭·달걀)의 수리다. 값이 하나라도 없으면(측정 실패) 적지 않고, 최신이 이미 clear/success 면 다시 적지 않으며,
  프로바이더 전체 auth·spend·transient 는 풀지 않는다(실제 호출 성공이 아니므로). 기존 사건 파일은 지우지 않는다.
- 끄기: `auto.config.json` `usageProbe: false`. 테스트: `engine/usage-probe.test.mjs`.

## 완료 증거

각 단계는 선택 모델과 제공자, 입력 기준 커밋, 작업 후 코드 지문, QA 결과, 리뷰 지문을 남긴다. 리뷰 완료 표시는 현재 코드 지문과 일치할 때만 재사용한다. 구현 뒤 코드가 바뀌었거나 리뷰 대상 지문이 다르면 리뷰를 다시 실행한다.

로그의 `[MODEL-ROUTE]`는 요청 등급, 최초 선택, 실제 선택, 대체 이유를 보여야 한다. 검증 매니페스트는 QA 성공과 독립 리뷰 성공을 함께 포함해야 한다. 둘 중 하나라도 없으면 완료로 승격하지 않는다.

## 병렬성과 운영 경계

병렬화 단위는 파일 충돌이 없는 스토리다. 모델 수가 여섯 개라는 이유로 여섯 작업을 동시에 시작하지 않는다. `workers.max`와 제공자별 `max`를 기기 성능, API 한도, 충돌 가능성에 맞춰 제한한다.

엔진 업데이트는 활성 lock과 PID가 모두 없는 라운드 경계에서만 한다. 새 예약 실행을 잠시 막고 검토된 커밋을 적용한 뒤 라우팅 테스트와 dry plan을 통과시키고 예약을 복구한다. 진행 중 산출물을 reset이나 clean으로 제거하지 않는다.

프로젝트 설치본은 모델 런타임을 `tools/auto/runtime/`에 고정한다. 한 라운드 안에서 전역 스킬 업데이트와 프로젝트 실행 코드가 섞이지 않게 하는 경계다.
