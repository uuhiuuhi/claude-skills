---
name: screen-check
description: 구현이 끝난 스토리를 실제 화면에서 직접 확인한다 — 격리 워크트리 + 별도 포트 dev 서버 + Playwright(playwright-core · Edge 채널 · 헤드리스)로 QA 계정 로그인부터 성공 경로·거부 경로·모바일까지 밟고 스크린샷·판정표를 남긴다. "실제 화면에서 확인해줘", "실화면 검증", "화면 테스트 돌려줘", 스토리 마감 전 「실제 화면 확인 항목」 실측, 자동 테스트가 사람 게이트로 남긴 성공 경로(관리자 계정) 실증에 사용한다. 비밀번호는 스크립트가 .env.local 에서 읽고 사람·AI 가 치지 않는다. 다른 창의 작업 트리를 건드리지 않는다(v0.2 · 2026-09-09 · 기본 1벌 · `--mode multi` 3벌 = A Sonnet 템플릿+링크 전수 / B Opus 탐색·쓰기 독점 / C Astra 대조 산출물만 · 취합 `merge-screen-check.mjs` · 러너 qa 창이면 시작 금지 · 평가 항목 10개 × 10점 채점표를 보고서 마지막에 낸다 · v0.3 보기 전용 방식 `view-check.mjs` = 운영·미리보기 주소용 · 쓰기 요청은 브라우저 단계에서 차단 · 비로컬 주소는 보기 전용으로 강제). 정본 = GitHub uuhiuuhi/claude-skills `screen-check/` · 24배치(batch-24-multiAG)와 별개 스킬.
---

# screen-check (v0.3)

**한 줄**: 스토리의 「실제 화면에서 확인할 항목」을 사람 대신 브라우저로 밟아 **판정표 + 스크린샷**을 낸다. qa(typecheck·lint·vitest)가 못 보는 것 — 실제 로그인 · 실제 DB 왕복 · 시트/모달 상호작용 · 뷰포트별 렌더 — 을 본다.

## 언제 쓰나
- 스토리 dev·리뷰가 끝나 `review` 인데 Completion Notes 에 「브라우저 실측 0」·「관리자 성공 경로 미검증(사람 게이트)」이 남아 있을 때.
- 목업 승인본과 구현 화면을 나란히 대조해야 할 때(1440 · 1024 · 390).
- 「머지해줘」 전에 배포본이 아니라 **작업 브랜치 기준** 실화면을 한 번 보고 싶을 때.

## 절대 규칙
1. **비밀번호를 치지 않는다** — 자격증명은 워크트리 `.env.local` 의 QA 계정(`QA_TEST_*` 직원 · `QA_ADMIN_*` 관리자)을 스크립트가 읽는다. 대화·로그·스크린샷에 값을 남기지 않는다. Browser 패널·Playwright MCP 로 로그인 폼에 직접 타이핑하는 방식은 쓰지 않는다.
2. **다른 창의 작업 트리를 건드리지 않는다** — `git worktree add <scratchpad>/e2e-wt <sha> --detach` 로 격리하고, `node_modules` 는 PowerShell `New-Item -ItemType Junction` 으로 잇는다(복사·설치 0). 끝나면 junction 은 `(Get-Item).Delete()` 로 **링크만** 지운 뒤 `git worktree remove`.
3. **포트 분리** — 본 창의 미리보기(5173)와 겹치지 않게 `vite --port 5174 --strictPort --host 127.0.0.1`.
4. **쓰기 프로브는 로컬 개발 주소 + 개발 DB 에서만** — 비로컬 주소(운영 · Cloudflare 미리보기 · 스테이징)에서는 쓰기 프로브를 절대 돌리지 않고, 거기서 허용되는 방식은 **보기 전용 방식(`view-check.mjs`) 하나뿐**이다(아래 v0.3). `lib.mjs`·`template.mjs` 는 기준 주소가 로컬(localhost · 127.0.0.1 · [::1] · *.localhost · *.test)이 아니거나 `SC_MODE=view` 면 브라우저를 열기 전에 멈춘다. 쓰기 프로브(승인·접수)는 남는다(AD-8 hard delete 금지)는 사실을 스토리 문서에 「개발 DB 잔여물」로 적는다. 프로브 라벨·코드에는 타임스탬프를 넣는다(`QA 프로브 MMDDHHmm`).
5. **판정은 문구·상태로** — 스크린샷은 증거이지 판정이 아니다. 각 항목을 `check(cat, name, ok, detail)` 로 남기고 실패 항목은 **대기 부족(타이밍)인지 결함인지** 스크린샷으로 가른 뒤, 타이밍이면 대기를 고쳐 **2차만** 다시 돈다(새 프로브 값을 또 만들지 않는다).
6. 결과는 스토리 Completion Notes 「실화면 확인」 절에 항목 수·통과·잔여물·스크린샷 위치를 기록하고, 문서 커밋은 즉시(배치 동시 쓰기 사고 방지).

## 절차
1. **재료**: 대상 커밋 SHA(보통 `auto/YYYY-MM-DD` tip) · 스토리 md 의 AC·「실제 화면에서 확인할 항목」 · 화면 셀렉터(입력 `id` · 버튼 문구 · `role`) — `grep -n "id=\"\|getByRole\|<Button" src/features/<domain>/*.tsx` 로 뽑는다.
2. **격리 실행 환경**: `references/setup.md` 의 5줄(worktree → junction → `.env.local` 복사 → vite 5174 백그라운드 → `playwright-core` 는 scratchpad `e2e-tools/` 에만 설치).
3. **스크립트**: `references/template.mjs` + `references/score.mjs` + `references/view-guard.mjs`(로컬 주소 확인용) 를 `e2e-tools/` 에 복사해 시나리오를 채운다 — 로그인 헬퍼 · 역할별 브라우저 컨텍스트(직원/관리자 분리) · `check(cat, name, ok, detail)`(cat = 평가 항목 키) · `fullPage` 스크린샷 · 끝에 `results-<story>.json` + `report-<story>.md`(채점표) 자동 생성.
4. **실행·판정**: `node <script>.mjs` → 실패 항목 스크린샷 확인 → 타이밍이면 2차 스크립트(기존 프로브 재사용) → 전건 통과까지.
5. **기록·정리**: 채점표를 스토리 Completion Notes 「실화면 확인」 절 + 사용자 보고서 마지막에 붙인다 → 커밋 → vite 종료 → junction 링크 삭제 → worktree 제거. 스크린샷은 scratchpad 에 두고 필요한 것만 사용자에게 보낸다.

## v0.2 — 3벌 모드(`--mode multi` · 파티 판정 2026-09-09 · 기본은 여전히 1벌)
기본(1벌)은 위 절차 그대로다. **전수 시범·마감 실측처럼 놓치면 비싼 화면**은 3벌로 돈다 — 벌마다 시나리오 **종류**가 다르지, 스크린샷을 3배 찍는 게 아니다.

| 벌 | 모델 | 무엇을 | 재료 | 브라우저·쓰기 |
|---|---|---|---|---|
| **A 템플릿** | Sonnet(1차) / Terra(2차 비교) | 계약·AC 실측 + **링크·화면 전수**(`SCREEN_DESTINATIONS` × 역할 · 막다른 골목 5종 = 빈 화면·안내 없는 거절·타이틀 없음·없는 화면·pageerror) + 뷰포트 3종 + 접근성 기본 | `references/template-A.mjs`(엔진 고정) + 배치별 `scenarios-<배치>.mjs`(AC 만 채운다) | 브라우저 O · **쓰기 0** |
| **B 탐색** | Opus | 상태 경합·리사이즈 중 입력·새로고침 복원·권한 경계·실패 주입·경계값 · **쓰기 프로브 독점** | `references/template-B.md` 체크리스트 B1~B12 · `lib.mjs` 재사용 · 스크립트는 스토리마다 직접 쓴다 | 브라우저 O · 쓰기 O(라벨 `QA 프로브 MMDDHHmm` · leftovers 기재) |
| **C 대조** | Codex Astra(`codex exec -s read-only`) | A/B 의 JSON·스크린샷 ↔ 승인 목업·문구 규율·5범주 대조 · 실측 오탐/누락 재검 | `references/brief-C.md` 를 채워 stdin 으로 · `-i` 로 스크린샷 첨부 | **브라우저 0 · 로그인 0** |
| 취합 | Fable | `node merge-screen-check.mjs results-A-*.json results-B-*.json results-C-*.json --triage triage.json --title …` → 합산 채점표 + **벌 × (고유 적중/중복/판정 불일치/오탐)** 표 · 결함은 파트 소유자(셸·권한·라우팅 = Opus · 폼·목록·위젯 = Sol)에게 수리 배정 → Astra/Opus 재검수 | `references/merge-screen-check.mjs` | — |

**동시성 규칙**: A·B 동시 시작 허용(로그인 합계 ≤ 6/실행 · 429 한도 30/5분/IP) · C 는 A·B 종료 후 · **러너 qa 진행 중이면 시작 금지** — `node references/runner-window.mjs [--wait 분]` 이 `runner.lock` · slots.log `qa-gate` · vitest/tsc 프로세스를 보고 FREE/BUSY 를 낸다(파티 판정 3항: 시작 간격 규칙은 폐기 · 러너 창 회피가 맞다). 스토리 파일은 Fable 만 쓴다(벌은 각자 `results-<벌>-<배치>.json`). **채택 유지 조건**: 취합 표에서 고유 적중 0 인 벌은 다음 실행에서 뺀다(Grumbal).

**엔진 안전장치(2026-09-17 T3 실사고 반영)**: 벌 A(`template-A.mjs`)는 예외를 삼키지 않는다 — 어디서 끊겼는지 `results-*.json` 의 `fatal{role, step, message, stack}` 과 보고서 머리의 「⚠️ 중단 — 미실행 시나리오 N건」에 적고 **exit 4** 로 나간다(옛 판은 마지막 역할의 예외를 삼키고 exit 0 · AC 시나리오 19건이 통째로 빠진 걸 결과만 봐선 알 수 없었다). 정상 종료에도 `notRun.scenarios` 를 **항상** 적는다(0 건이면 0 이라고). 문구 판정 규칙은 `references/judge.mjs` 가 소유하고 `node --test "screen-check/references/*.test.mjs"` 로 단위 검증한다 — 거절 판정은 부정형(「권한이 없습니다」)뿐 아니라 **제한형**(「…권한이 있는 분만 볼 수 있습니다」·「관리자에게만 열립니다」)도 잡는다(옛 규칙이 못 잡아 거절 6건이 오탐이었다).

**공용 헬퍼** `references/lib.mjs`: `setup({story, source, root})` → `{ check, shot, login(page,'QA_TEST'|'QA_ADMIN'), wire, browser, STAMP, finish }` · `loadDestinations(page, role)`(vite 가 주는 `/src/lib/routes.ts` 를 dynamic import — TS 파싱 0) · `judgeScreen(page, dest)`(로딩 대기 + 막다른 골목 판정) · 역할 계정은 `QA_<ROLE>_EMAIL/PASSWORD` 가 있으면 자동 편입, 없으면 미측정.

**전수 시범에서 배운 것(2026-09-09 밤 · Epic 1·2·3·11·4 · 2,400건 · 산출물 `_bmad-output/implementation-artifacts/screen-check-full-2026-09-09/`)**
- 벌별 고유 적중 합산 A 12 · B 25 · **C 47** — C(Astra 소스·목업 대조 · 브라우저 0 · 10분)가 5범주·설계형을 가장 많이 잡았다. 세 벌 모두 > 0 이라 3벌 유지.
- A 의 JARGON 정규식은 영문 식별자(`SERVER`·`TEAM1`·`(equipment_type)`)를 못 잡는다 — C 가 뒤집은 「판정 불일치」의 대부분. 엔진의 「화면 열림」은 id 없는 상세/수정 진입을 통과시키므로 `lib.mjs` `GUIDED` 판정으로 「선택 안내」를 따로 센다.
- 취합기는 `[역할 /경로 @폭]` 접두를 접는다(A 가 6역할 × 3폭으로 같은 결함을 반복) · 벌이 항목에 `triage` 필드를 직접 적어도 받는다.
- 개발 DB 에 미적용 마이그레이션이 있으면 화면에서 42703/PGRST205 로 나타난다 — 실측 전에 객체 프로브(42501 = 있음)로 확인하고 `apply-migration.mjs` 로 개발 ref 에 적용한다.
- 워크트리 `.env.local` 복사 뒤 QA 계정 키가 늘면 재복사(배치 1 이 2역할로 돈 실사례). `runner-window.mjs` 는 runner.lock 을 막지 않고 qa 프로세스·`codex exec` 만 본다.
- Sonnet/Opus 벌이 「실행을 백그라운드로 돌려 놓고 종료」하는 일이 잦다 — 지휘 세션이 `until [ -f results-… ]` 로 기다려 직접 triage 하는 편이 빠르다.

## v0.3 — 보기 전용 방식(`view-check.mjs` · 운영 주소 · 미리보기 주소용)
배포 뒤 바뀐 화면을 운영에서 확인하거나, `wrangler versions upload` 가 준 **미리보기 주소**(운영 DB·운영 비밀값에 붙어 있다)를 배포 전에 볼 때 쓴다. 쓰기는 약속이 아니라 **브라우저 단계에서 기술로 막는다** — 막을 수 없으면(예: playwright-core 1.48 미만이라 WebSocket 차단 불가) 시작하지 않는다(exit 3).

**언제 무엇을 쓰나**

| 시점 | 대상 주소 | 방식 | 쓰기 |
|---|---|---|---|
| 머지 전 | 로컬 dev 서버(127.0.0.1:5174) + 개발 DB | 로컬 방식(`template*.mjs`·`lib.mjs`) | 허용(프로브 라벨·잔여물 기재) |
| 운영 배포 전 | 미리보기 주소(`wrangler versions upload` 출력 · 운영 DB 연결) | 보기 전용 | 차단 |
| 운영 배포 후 | 운영 주소 | 보기 전용 | 차단 |
| 배포 후 실패 | — | 되돌리기: `wrangler deployments list` → `wrangler rollback <version-id>` | — |

되돌리기는 **Worker 코드만** 이전 판으로 돌린다. 이미 적용한 DB 마이그레이션 · Edge Function · 비밀값은 그대로다 — 코드가 새 DB 객체를 읽는 배포라면 DB 를 먼저 되돌릴 수 없으므로, 배포 전 「덧셈만 한 마이그레이션인가」를 확인해 두는 것이 되돌리기의 전제다.

**방식 결정 규칙**: `--mode view`(또는 `SC_MODE=view`)로 켜고, 기준 주소가 로컬 개발 주소가 아니면 **무엇을 넘겨도 보기 전용으로 강제**된다 — 비로컬에서 쓰기 프로브를 여는 옵션은 없다. `view-check.mjs` 는 `--mode local` 을 거부한다.

**실행**: `node view-check.mjs --base <주소> --root <scratchpad> --story <라벨> --routes /login,/ --auth-routes /home,/tickets --deny-routes /admin --expect <번들 해시·버전 표식> --config view-config.json` (워크트리·dev 서버 불필요 · `view-check.mjs`·`view-guard.mjs`·`score.mjs`·`judge.mjs` 를 `e2e-tools/` 에 복사). 결과 = `results-V-<라벨>.json` + `report-V-<라벨>.md`.

**쓰기 차단(`view-guard.mjs` → `context.route` 로 모든 요청 판정 · 서비스 워커 차단)**
- GET · HEAD · OPTIONS 만 통과. 그 밖의 메서드는 abort 하고 「차단된 쓰기 시도」로 적는다(보고서 머리줄 건수 + 목록 · `errors` 항목 실패로 올린다 — 차단은 안전장치가 동작했다는 뜻이지만, 그 화면은 쓰기가 실패한 상태로 그려졌을 수 있다).
- **허용 목록 기본값 = 로그인·토큰 갱신 하나**: `POST /auth/v1/token?grant_type=password|refresh_token` 을 **보기 전용 로그인 단계에서만** 통과. 비로그인 단계는 모든 쓰기 메서드를 막는다. 로그아웃·가입·메일 링크 소비(`/auth/v1/verify` 등)는 GET 이어도 막는다.
- **RPC**: `POST /rest/v1/rpc/<함수>` 는 읽기일 수도 쓰기일 수도 있으므로 **기본 전부 차단**. 읽기 전용 함수만 프로젝트가 `readOnlyRpc` 에 **이유 한 줄과 함께** 적는다(이유가 없으면 설정을 거부한다 · 「읽기 전용인가」의 판단과 책임은 프로젝트 몫). PostgREST 의 GET 은 읽기 전용 트랜잭션으로 돈다.
- **Edge Function**(`/functions/v1/<이름>`)은 GET 이어도 코드가 무엇을 하는지 모르므로 `readOnlyFunctions` 에 없으면 차단.
- **WebSocket**: 기본 차단(연결 자체를 닫는다 · 실시간 갱신은 안 보이지만 첫 데이터는 REST 로 온다). `allowWebSocket: true` 면 연결하되 페이지 → 서버 메시지는 `phx_join`·`phx_leave`·`heartbeat`·`access_token` 만 보내고 `broadcast`·`presence` 등은 버린다(다른 사용자에게 닿는 송신).
- **누르지 않는 조작**: 이름에 저장·등록·승인·반려·삭제·발송·전송·제출·확인·완료·처리·접수·배정·수정·취소·요청… (영문 save·submit·delete·send·approve… · `extraDestructive` 로 추가)이 든 버튼·링크, 폼 제출 버튼, 이름 없는 버튼. 탭은 눌러 본다(최대 6개/화면). 건너뛴 조작은 보고서에 목록으로 남는다. 실행기는 탭 외의 버튼을 누르지 않는다.

**자격증명**: `SC_VIEW_EMAIL` / `SC_VIEW_PASSWORD` 한 쌍만(셸 환경변수 또는 `--env-file <gitignore 된 파일>`). **QA_* 개발 계정으로 대체하지 않고**, 같은 주소가 `QA_*_EMAIL` 에 있으면 거부한다(exit 2). 계정은 **운영에 만든 최소 권한 전용 계정**이어야 한다. 한 쌍이 없으면 **비로그인 단계만** 돈다 — 경로 200 · 로그인 화면 렌더(1440·390) · 배포본 표식(`--expect`) · 콘솔 오류 0 · 문구 규율 — 그리고 보고서 머리에 **「로그인 안쪽 화면은 확인하지 못함」**을 적는다. 값은 출력·오류 문구에서 가린다.

**보고서**: 기존 판정표·채점표 형식 그대로 + 머리줄 `방식: 보기 전용 · 대상 <host> · 단계: 비로그인|보기 전용 로그인 · 차단된 쓰기 시도 N건 · 건너뛴 조작 N개`. 볼 수 없는 평가 항목은 점수 없이 **「—」 판정 불가**(합계 제외): 두 단계 모두 `success`·`guard`, 비로그인은 `ac`·`deny`·`a11y` 까지.

**설정 예(`view-config.json` · 모든 키 선택 · 모르는 키는 거부)**
```json
{
  "readOnlyRpc": { "list_my_items": "STABLE 함수 — SELECT 만 하고 기록을 남기지 않는다" },
  "readOnlyFunctions": {},
  "allowPost": { "/storage/v1/object/list/*": "첨부 목록 조회 — POST 본문으로 읽기만 한다" },
  "extraDestructive": ["출근 찍기"],
  "denyUrlPatterns": ["/track/click"],
  "allowWebSocket": false,
  "login": { "path": "/login", "email": "#login-email", "password": "#login-password", "submit": "button[type=submit]" }
}
```

**보기 전용 방식의 한계(증명하지 못하는 것)**
- 쓰기 경로가 운영에서 성공하는지(접수·승인·저장) — 판정 불가. 머지 전 로컬 방식 결과로 대신한다.
- GET 요청이 서버에서 기록을 남기는지(열람 기록·조회수·링크 추적) — GET 은 통과시키므로 막지 못한다. 알면 `denyUrlPatterns` 로 막는다.
- `readOnlyRpc`·`readOnlyFunctions`·`allowPost` 에 적은 항목이 정말 읽기 전용인지 — 도구는 이름만 본다. 목록이 틀리면 쓰기가 통과한다.
- 로그인 요청 자체의 부수효과(마지막 로그인 시각·감사 기록·토큰 발급 기록)는 남는다.
- 보기 전용 계정 한 역할이 보는 화면만 본다 — 다른 역할의 화면·권한 경계 전체는 못 본다. 계정이 없으면 로그인 안쪽은 0.
- 차단 때문에 앱이 오류를 던지면 `pageerror` 에 섞일 수 있다(차단 목록과 나란히 읽는다). 실시간 갱신은 기본 차단이라 안 보인다.
- 스크립트가 `page.request`·`context.request`(브라우저 밖 요청)를 쓰면 차단 장치를 거치지 않는다 — 실행기는 쓰지 않으며, 고칠 때도 쓰지 않는다.
- 미리보기·운영 주소가 접근 통제(Cloudflare Access 등) 뒤에 있으면 비로그인 단계부터 막힌다(미확인 — 이 경우 사람이 확인).

## 평가 항목 — 10개 × 10점 (보고서 필수)
실행이 끝나면 **반드시** `references/score.mjs` 로 아래 표를 만들어 보고서 마지막에 붙인다(👤 2026-09-09 「각 항목이 10점 만점에 몇 점인지」). 자동 채점 = 그 항목에 태그된 `check()` 통과율 × 10(반올림). 자동 체크가 없는 항목은 수동 점수 + 한 줄 이유. **보지 않은 항목은 점수를 지어내지 않고 「—(미측정)」** 으로 두고 합계에서 뺀다.

| # | 키 | 평가 항목 | 무엇을 보는가 |
|---|---|---|---|
| 1 | `ac` | AC 충족 | 스토리 수용 기준을 화면에서 하나씩 실측한 통과율 |
| 2 | `success` | 성공 경로 실증 | 핵심 쓰기 경로(접수·승인·저장)가 실제 DB 왕복으로 성공 |
| 3 | `deny` | 권한·거부 경로 | 비권한 진입 3요소 안내 · 서버 거절 문구가 바르게 선다 |
| 4 | `copy` | 문구 규율 | 한글 · 무엇/왜/어떻게 · 원시 에러·영문 식별자·표 이름 노출 0 |
| 5 | `responsive` | 반응형 | 1440 · 1024 · 390 렌더 · 모바일 열람 전용 등 뷰포트 계약 |
| 6 | `guard` | 상호작용 안전장치 | 잠금(disabled) · 확인 · 되돌리기 경로가 실제로 동작 |
| 7 | `mockup` | 목업 대조 | 승인 목업과 구조·문안 일치(스크린샷 나란히 · 확정 결정 반영) |
| 8 | `a11y` | 접근성 기본 | role/label · 키보드(Tab·Esc) · 44px 터치 타깃 |
| 9 | `errors` | 콘솔·네트워크 오류 | `pageerror` 0 · 예상 밖 4xx/5xx 0 |
| 10 | `honesty` | 정직성·잔여물 | 미측정 항목·프로브 잔여물·타이밍 vs 결함 구분이 보고에 적혔는가 |

**보고서 형식(마지막 절 고정)** — `## 화면 확인 평가 — <스토리> (<일시>)` → `**총점 N / M**` → 10행 표(`# · 평가 항목 · 점수 · 근거`) → 자동 체크 수 · **미측정** · **잔여물(개발 DB)** · 스크린샷 위치. 예시 = `references/example-report-1-12.md`(2026-09-09 실측 · 총점 86/100).

**점수 해석(👤 기준)**: 9~10 = 계약대로 · 7~8 = 사소한 보완(문서·꼬리) · 5~6 = 회수 라운드 필요 · 4 이하 = 머지 보류.

## 자주 걸리는 것
- 「불러오는 중」·안내 문구가 **스트립과 시트 양쪽**에 같은 단어로 있으면 `page.getByText` 대기가 조기 통과한다 → **dialog 로 범위를 좁혀** 기다린다(`page.locator('[role=dialog]').last().getByText(...)`).
- 모바일 뷰포트는 `setViewportSize` 뒤 **`goto` 로 다시 마운트**하고 화면 고유 문구(예: 「보기 전용입니다」)를 기다린다 — 골격 로딩 중 스크린샷은 판정이 아니다.
- `select` 의 `innerText` 는 옵션 전체를 포함한다 — 문구 판정은 `inputValue()` 로.
- Edge 채널: `chromium.launch({ channel: 'msedge' })` — 브라우저 다운로드 없이 로컬 Edge 를 쓴다.
- **Git Bash 는 `--scope /attendance,/tickets` 의 맨 앞 경로를 윈도 경로(`C:/Program Files/…`)로 바꿔** 첫 항목이 검사 범위에서 조용히 빠진다(2026-09-17 T3 실사고) → `MSYS_NO_PATHCONV=1` 을 붙이거나 PowerShell 로 실행한다.
- **실패 주입(네트워크 차단·강제 오류) 뒤 안내 문구는 10초까지 기다린다** — 3.5초에 샘플링해 「안내 없음」으로 오판했는데 실제로는 8초에 정상 안내가 떴다(2026-09-17 D-20). 느린 것과 없는 것을 가르고 나서 결함으로 적는다.

## 다음 단계(v1 후보 · 👤 결정)
- **TestSprite MCP**(testsprite.com · CLI Apache-2.0 · MCP 서버 · 실행 중 URL + 자격증명 + PRD 입력 → 50~100 e2e 자동 생성·클라우드 실행 · 실패 번들(스크린샷·DOM·원인 가설·수정 제안)·영상 · 무료 티어): 스토리 AC 를 PRD 로 넣어 **테스트 생성**을 맡기고, 이 스킬은 「격리 환경 + 판정 기록」만 맡기는 분업이 가능. 단 자격증명이 클라우드로 나간다(QA 계정 한정 · 운영 계정 금지).
- **Playwright MCP**(공식 `@playwright/mcp`): 대화형 탐색·셀렉터 발견용. 로그인은 여전히 스크립트(env)로.
- **배치 편입**: `batch-24-multiAG` 의 `closeout` 단계 뒤에 `screen-check` 를 T-게이트로 붙이면 「사람 게이트 = 관리자 성공 경로」가 자동 실증된다 — 엔진 동결(9/14) 해제 뒤 정본(claude-skills)에서.
