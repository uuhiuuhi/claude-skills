# 벌 B — 탐색적 결함 사냥 체크리스트 (Opus · v0.2)

> 벌 A 가 「목록 따라 누르기」라면 B 는 **「설계형 결함」**을 잡는 벌이다 — 1-13 에서 결함을 잡은 건 전부 이 종류였다(폭 전환 중 입력 유실 · 기간 다른 값의 파생 비율 · 권한 0행 = 거짓 빈 상태). 스크립트는 **스토리마다 Opus 가 직접 쓴다**(`lib.mjs` 의 `setup`·`judgeScreen` 재사용 · `source: 'B'`). 쓰기 프로브는 **B 만** 한다.

## 규칙
1. `setup({ story, source: 'B', root })` 로 시작 — 로그인은 `login(page, 'QA_TEST' | 'QA_ADMIN')`, 값은 치지 않는다. 로그인 합계 ≤ 4/실행(429 한도 30/5분/IP 공유).
2. **쓰기 프로브 규칙**: 라벨·제목·코드에 `QA 프로브 ${STAMP}` 를 넣는다(재실행 충돌 0 · 잔여물 추적) · 만든 것은 전부 `data.leftovers` 에 「표/화면 · 식별 문구 · 되돌리는 방법(사용 안 함·취소)」로 적는다 · hard delete 금지(AD-8) · **운영 URL 금지**.
3. 결과 항목은 `check(cat, name, ok, detail)` — cat 은 채점표 키(ac·success·deny·copy·responsive·guard·mockup·a11y·errors·honesty). 실패는 **결함인지 스크립트/타이밍 문제인지** detail 에 1차 판단을 적는다(취합기가 triage 를 받는다).
4. 스토리 파일·저장소는 쓰지 않는다(벌은 results JSON 만 · 취합·기록은 Fable).

## 탐색 체크리스트 — 화면마다 해당하는 것만 고른다
| # | 종류 | 무엇을 하나 | 결함이면 어떻게 보이나 |
|---|---|---|---|
| B1 | **상태 경합** | 같은 행을 두 탭(두 컨텍스트)에서 열고 한쪽이 상태 전이 → 다른 쪽에서 낡은 상태로 다시 전이 | 두 번째가 조용히 성공(서버 거절 문구 없음) · 낡은 화면이 갱신되지 않음 |
| B2 | **리사이즈 중 입력** | 폼에 값 입력 → `setViewportSize` 1440↔390 전환 → 값·시트·모달 유지 여부 | 입력 유실 · 시트가 닫힘 · 포커스 소실 |
| B3 | **새로고침 복원** | 필터·탭·시트·작성 중 폼에서 `reload()` → URL 쿼리·localStorage 복원 | 필터 초기화 · 작성 중 내용 소실(2.26 임시 보관 계약 화면은 복원돼야 함) |
| B4 | **뒤로가기** | 상세 → 뒤로 → 목록 위치·필터 유지 · 시트 열린 채 뒤로 | 시트 잔존 · 스크롤 0 으로 · 필터 소실 |
| B5 | **권한 경계** | 비권한 계정으로 **URL 직접 진입 + 버튼 노출 + 서버 거절** 3중 확인 · 0행 화면이 「권한 없음」이 아니라 「거짓 빈 상태」로 보이는지 | 화면은 숨겼는데 서버는 통과 · 빈 목록이 권한 없음을 숨김 |
| B6 | **실패 주입** | `page.route` 로 rest/rpc 를 abort/500 → 3요소 안내 + [다시 시도] → unroute 후 복귀 | 무한 로딩 · 원시 에러 노출 · 다시 시도가 없음/동작 안 함 |
| B7 | **더블 클릭·중복 제출** | 저장 버튼 2연타 · Enter 연타 | 행 2건 · 잠금 없음 |
| B8 | **경계값** | 빈 값 · 공백만 · 최대 길이 · 미래 날짜 · 0/음수 · 특수문자(`<script>` · 따옴표) | 서버 400 을 화면이 그대로 노출 · 저장되면 안 되는 값이 저장 |
| B9 | **파생 값** | 합계·비율·경과시간이 원천과 같은 기간·같은 필터로 계산되는가(1-13 「기간 다른 값의 비율」) | 분모·분자 기간 불일치 · 0 나누기 「NaN%」 |
| B10 | **모바일 상호작용** | 390 에서 시트·드로어·스와이프·긴 목록 스크롤 · 키보드 올라올 때 버튼 가림 | 닫기 불가 · 저장 버튼 화면 밖 |
| B11 | **되돌리기** | 삭제·해지·확정 뒤 되돌리기 경로가 실제로 있는가(AD-8 soft) | 되돌리기 없음 · 확인 대화상자 없음 |
| B12 | **세션** | 로그아웃 뒤 뒤로가기 · 만료 토큰(localStorage 토큰 삭제) 상태에서 저장 | 보호 화면 노출 · 저장이 조용히 실패 |

## 스크립트 뼈대
```js
import { setup, judgeScreen } from './lib.mjs'
const t = await setup({ story: 'epic-1', source: 'B', root: ROOT })
const { check, shot, login, wire, browser, BASE, STAMP, finish, data } = t
const LABEL = `QA 프로브 ${STAMP}`
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ko-KR' })
  const p = await ctx.newPage(); wire(p, 'adm'); await login(p, 'QA_ADMIN')
  // B2 예: 폼 입력 → 폭 전환 → 값 유지
  await p.goto(`${BASE}/customers/new`); await p.fill('#customer-name', LABEL)
  await p.setViewportSize({ width: 390, height: 844 }); await p.waitForTimeout(400)
  check('guard', '[1-7] 고객사 등록 폼 — 폭 전환 중 입력 유지', (await p.inputValue('#customer-name')) === LABEL)
  // B6 예: 실패 주입
  await p.route('**/rest/v1/customers*', (r) => r.abort()); await p.goto(`${BASE}/customers`)
  await p.waitForSelector('main [role="alert"]', { timeout: 10000 }).catch(() => {})
  check('guard', '[1-7] 목록 조회 실패 → 3요소 + 다시 시도', (await p.$('main [role="alert"] button:has-text("다시 시도")')) !== null)
  await p.unroute('**/rest/v1/customers*')
  await ctx.close()
} finally {
  data.leftovers.push(`customers 「${LABEL}」 (저장했다면 · 사용 안 함으로 내림)`)
  data.manual.honesty = { score: 10, why: '프로브 잔여물·타이밍 vs 결함 1차 판단 기재' }
  await finish()
}
```
