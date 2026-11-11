# 배포 요청서 — 새 작업 창용 (깃러너 · 2026-11-11)

> 배포·main 반영은 **깃러너 한 곳**만 한다. 작업 창(러너 지휘 창 포함)은 리뷰까지 끝낸 뒤 이 요청서를 **스스로** 넣고 끝낸다.
> 직접 `main` 에 푸시하거나 `wrangler deploy` 를 치지 않는다(창마다 배포하면 나중 판이 앞 판의 수정을 빠뜨린다 — 11-09 실사례).

## 1. 넣기 전 조건
- 작업 갈래 `auto/<날짜>-<주제>` 에 커밋 · **origin 에 푸시**(또는 본선 저장소 `C:/Projects/jng-os` 에 갈래가 있으면 됨).
- **가능하면 최신 `origin/main` 위에서** 만든다(`git fetch && git rebase origin/main` 또는 merge). 깃러너가 합치긴 하지만 충돌이 나면 멈춘다.
- `npm run qa` GREEN · 교차 검토(다른 회사 모델) 끝 · 스토리 done.
- 새 마이그레이션이 있으면 개발 DB 에 적용돼 있고 가드 시험이 파일명을 참조한다.

## 2. 요청서 파일
`C:/Users/user/.baroos-auto/gitrunner/queue/<YYYYMMDD-HHMM>-<주제>.json` 에 아래 모양으로 저장(파일 이름 = `id` + `.json`). 이름 순서대로 한 건씩 처리된다.

```json
{
  "id": "20261111-1030-quote-finder",
  "requester": "견적 창 (local_…)",
  "humanRequested": false,
  "branch": "auto/2026-11-11-quote-finder",
  "commit": "<갈래 끝 40자리 커밋 번호>",
  "base": "<만든 기준 main 40자리 커밋 번호>",
  "summary": "무엇이 바뀌었는지 한 줄(사람이 읽는 말)",
  "checks": "qa GREEN(… 파일 · … 통과) · 검토 astra 2회 · 화면 확인 …",
  "db": {
    "files": ["supabase/migrations/2027…_x.sql"],
    "compat": "ⓖ 지금 운영 화면(직전 배포본)이 이 DB 변경 뒤에도 그대로 도는 이유",
    "access": "ⓗ 새 정책·함수·뷰를 누가 읽고 실행하나(GRANT·RLS·SECURITY DEFINER)",
    "index": "ⓘ 색인 대상 표와 행 수(유일 색인이면 깃러너가 멈춘다)"
  },
  "ef": [],
  "screens": ["https://baro.jngsystem.co.kr/… — 볼 역할 · 메뉴 · 상자 이름"],
  "rollback": "되돌리는 법(화면은 깃러너가 직전 판으로 · DB 는 무엇을 남겨도 되는지)"
}
```
- DB 변경이 없으면 `"db": { "files": [] }`. Edge Function 변경이 있으면 `ef` 에 함수 이름 — **자동 배포 밖**이라 깃러너가 멈추고 깃러너 창이 👤 승인을 받아 처리한다.
- **배포 안 하는 시간(👤 2026-11-11)**: 매일 **08:50~12:00 · 13:00~18:10** 에는 요청서가 대기열에서 기다린다(시간이 끝나면 자동 처리). 👤 박장훈님이 직접 「배포해줘」라고 한 건만 `"humanRequested": true` 로 적어 그 시간에도 바로 처리한다 — 작업 창이 스스로 true 를 적지 않는다.
- `요청서 넣기` = 파일 하나 쓰기. 쓰고 나면 1분 안에 예약 작업 `BaroOS-gitrunner` 가 집어 간다.

## 3. 깃러너가 하는 일(한 건씩 · 잠금)
- **미리 검사(👤 2026-11-11)**: 배포 안 하는 시간에도 아래 1~3(합치기·검사·판정)은 미리 돌린다. 걸리면 그때 바로 `held/` 로 옮겨 요청 창이 고칠 시간을 준다 · 통과하면 `precheck/<id>.ok` 를 남기고, 배포 가능 시간에 main 이 그대로면 검사 없이 4번부터 한다(main 이 바뀌었으면 다시 검사).
1. 최신 `origin/main` 과 합치기(앞으로 감기 우선) — 충돌이면 **멈춤**.
2. 합친 판 검사: 타입 검사 · 바뀐 파일 eslint · 정적 시험(원장 · 마이그레이션 가드 · 바뀐 시험).
3. 판정: Edge Function 변경 → 멈춤 · 이미 있던 마이그레이션 수정 → 멈춤 · `tools/ops/additive-check.mjs` 가 덧셈 아님 → 멈춤 · 유일 색인 → 멈춤.
4. **main 푸시 먼저**(실측) → 운영 DB 덧셈 적용(운영 장부에 없는 파일만 · 한 트랜잭션 · 교체 전 정의 보관) → 화면 배포(main 판 그대로).
5. 실측: 번들 해시 일치 · 조각 200 · `/manual/` 크기·장 표식 — RED 면 직전 판으로 되돌림.
6. RELEASE-LOG 기록 + 운영 판 태그 `prod/<날짜-시각>-<판>` → main 푸시.

## 4. 결과 보기
- 성공: `gitrunner/done/<id>.result.json` · 멈춤: `gitrunner/held/<id>.result.json`(이유 한 줄 · 깃러너 창이 처리)
- 한 줄 기록: `gitrunner/STATUS.log` · 자세한 기록: `gitrunner/logs/` · 산출물: `~/.baroos-auto/archive/release-<날짜>-gitrunner-<id>/`
- 멈춤이 생기면 깃러너 창에 「배포 요청 <id> 멈춤 — 봐 줘」 한 줄을 보낸다(깃러너 창 = 대화 목록의 「깃러너」).
