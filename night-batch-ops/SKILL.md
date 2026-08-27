# night-batch-ops — 24시간 무인 배치 러너 (프로젝트 설치형)

BMad 프로젝트에 **야간·낮 무인 배치 체계**를 설치·운영한다. `auto-story-finish` 전역 스킬(엔진)을
전제로, 그 위에 ① 예약 실행(18:00 + 4시간 슬롯) ② 큐 자동 편성(규칙 9종, LLM 호출 0)
③ 연속 실행 루프(작업 종료가 다음 배치를 연다) ④ 텔레그램/ntfy 알림을 얹는다.

**계층 원칙**: 이 폴더의 엔진 3파일은 프로젝트 중립이다. 프로젝트 고유값(에픽 순서·하루 상한·
모델·상태 폴더)은 전부 대상 프로젝트의 `tools/auto/auto.config.json` 이 소유한다 — 같은 엔진을
여러 프로젝트가 받아 쓰고, 설정만 다르게 갖는다.

## 구성

| 파일 | 역할 |
|---|---|
| `engine/run-night.mjs` | 러너 — 큐 실행·워크트리 새로고침·lock·연속 루프·알림 |
| `engine/plan-queue.mjs` | 편성기 — sprint-status·스토리 파일을 규칙만으로 판정해 큐 생성 |
| `engine/runner-rules.mjs` | 순수 판정 규칙(테스트 가능 분리) |
| `install.mjs` | 설치기 — 파일 복사·설정 템플릿·예약/클론(옵트인) |

## 설치 (Claude 가 "이 프로젝트에 야간 배치 적용해줘" 를 받으면)

1. **대상 프로젝트 루트**에서 `node <이 폴더>/install.mjs` — 파일 설치 + 안내 출력.
2. `auto.config.json` 의 **`epicOrder` 를 사용자와 정한다**(파일럿/목표 경로 순 — 사람 결정).
3. 실행 전용 클론(`--clone C:\Projects\<이름>-auto`) + `npm install` — 대화 세션의 발밑을
   배치가 절대 바꾸지 않게 하는 격리다.
4. 예약 등록은 **사용자 승인 후** `--register-tasks` (또는 출력된 PowerShell 을 직접).
   예약은 Interactive only — PC 가 로그온 상태로 켜져 있어야 돈다.
5. 알림: 공용 `~/.claude-auto/telegram-token.txt`(BotFather 토큰)와 `telegram-chat.json`
   (`{"chat_id": ...}`) — 여러 프로젝트가 같은 봇을 공유하고 머리말 `[프로젝트명]` 으로 구분된다.
   없으면 `~/.claude/ntfy-topic.txt`(공개 주제 — 내부 정보 최소화), 둘 다 없으면 무음.
6. 리허설: `node tools/auto/plan-queue.mjs --dry` → `node tools/auto/run-night.mjs --auto-plan --dry-run`.
7. 프로젝트 CLAUDE.md 에 아래 「운영 계약」 요약과 낮/밤 리듬을 기록한다.

## auto.config.json

```json
{
  "project": "이름(예약 작업·상태 폴더·알림 머리말에 쓰임)",
  "epicOrder": [2, 3, 11, 4],
  "parallelAllow": { "4-0": 11 },
  "dailyCap": 12,
  "models": { "dev": "fable", "review": "opus" }
}
```

- `epicOrder` **필수** — 비어 있으면 자동 편성이 이유를 말하고 선다(사람이 정하는 값이라서).
- `dailyCap` = 하루 편성 상한. 기준은 기술 한계가 아니라 **아침에 사람이 판정 가능한 양**.
- `models` — null 이면 CLI 기본 모델. dev/review 를 다른 모델로 두면 교차검증이 된다.

## 운영 계약 (러너·편성기에 하드코딩 — 프로젝트가 알아야 할 것)

- **브랜치는 항상 `auto/<날짜>`** · 커밋·푸시는 큐 `defaults` 옵트인 · **main 머지는 사람 승인**.
- **미머지 auto/* 가 남아 있으면 슬롯 휴면**(로컬+원격 스캔) — 아침/저녁 머지가 슬롯을 깨운다.
  자정 롤오버 중복 실행 사고(2026-08-27 실사례)의 재발 방지다.
- **연속 실행 루프**: `--auto-plan` 은 완주 후 재편성해 큐가 마를 때까지 돈다. 자정을 넘기면
  시작 시점 날짜로 고정된 채 종료하고 다음 슬롯에 넘긴다. lock 이 루프 내내 유지되므로
  정시 슬롯 겹침은 자동 회피된다.
- **한도 대기**: 슬롯 모드 30분(짧게 기다렸다 exit 5 — 이어하기는 state.json + 다음 슬롯),
  수동 실행 480분. 연속 STOP 차단기(2회)는 exit 5 를 세지 않는다(한도는 날씨).
- **편성 규칙 9종**: ① epicOrder 순서(첫 후보 보유 에픽까지) ② 열린 Decision = 제외(인박스
  미등재 의심 경고) ③ 재투입 금지 지시 ④ Patch 만 있고 Task 0 = 사람이 라운드를 열어야 함
  ⑤ File List 서로소 회수 2건 묶음 ⑥ 새 화면 목업 게이트 ⑦ 하루 상한 ⑧ 회수분 0 제외
  ⑨ **무인 편성 2회 소진 = 사람 판단으로**(리뷰 비수렴 상한).
- **수동 큐 우선**: `night-queue.json` 의 `planned` 가 `'auto'` 가 아니면 다음 슬롯이 1회 우선
  소비한다(전역 소비 표식 — 자정이 지나도 재실행되지 않는다).
- **exit code**: 0 완주 · 1 실패/qa RED · 2 인자 · 3 인증/편성기 실패 · 4 no-op/dirty · 5 한도.

## 하루 리듬 (권장 — 프로젝트 CLAUDE.md 에 기록)

「실행→판정→확정→장전」 폐루프: **밤**(결정이 필요 없는 물량 전량 소진 — 성과는 낮의 준비량에
비례) → **아침**(밤 결과 판정 + 결정 재고를 15~20분 분량으로 압축 · 슬롯 심박/한도 대기 의무
확인) → **오전**(결정 소진 + main 머지·배포 — 미머지가 남으면 밤이 휴면한다) → **오후**(밤배치
최대 가동환경: 스펙·목업 승인·게이트 해소·큐 장전).

## 전제

- Node 20+ · git 원격(origin) · `auto-story-finish` 전역 스킬 · `npm run qa` 게이트 정의
- BMad v6 산출물(`sprint-status.yaml`·`epics.md`·스토리 md) — 없으면 수동 큐만 가능
- 결정 단일 창구 `_bmad-output/implementation-artifacts/DECISIONS-INBOX.md`
