// Story 1.12 실화면 확인 — Playwright(playwright-core · Edge 채널) · 대상 = 격리 워크트리 dev 서버(5174) · 개발 DB
// 자격증명은 워크트리 .env.local 의 QA 계정(QA_TEST_* = engineer · QA_ADMIN_* = admin)을 스크립트가 읽는다(값은 출력하지 않는다).
import { chromium } from 'playwright-core'
import { readFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const BASE = 'http://127.0.0.1:5174'
const ROOT = 'C:/Users/user/AppData/Local/Temp/claude/C--Projects-jng-os/f30fdb04-628a-4fd6-b961-5958ecc4b985/scratchpad'
const OUT = resolve(ROOT, 'e2e-shots'); mkdirSync(OUT, { recursive: true })
const env = Object.fromEntries(readFileSync(resolve(ROOT, 'e2e-wt/.env.local'), 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')] }))
const need = (k) => { if (!env[k]) throw new Error(`${k} 없음`); return env[k] }
const STAMP = new Date().toISOString().slice(5, 16).replace(/[-T:]/g, '')
const LABEL = `QA 프로브 ${STAMP}`
const CODE = `QA_PROBE_${STAMP}`
const log = (...a) => console.log('[e2e]', ...a)
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); log(ok ? '✓' : '✗', name, detail) }

async function login(page, email, password) {
  await page.goto(`${BASE}/login`)
  await page.fill('#login-email', email)
  await page.fill('#login-password', password)
  await page.click('button[type=submit]')
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 })
}

async function newRequest(page, kindLabel, title, body) {
  await page.goto(`${BASE}/support-requests/new`)
  await page.getByRole('radio', { name: kindLabel }).waitFor({ timeout: 15000 })
  await page.getByRole('radio', { name: kindLabel }).click()
  await page.fill('#support-title', title)
  await page.fill('#support-body', body)
  await page.getByRole('button', { name: '지원요청 보내기' }).click()
  await page.waitForURL((u) => u.pathname === '/support-requests' || /support-requests\/(?!new)/.test(u.pathname), { timeout: 20000 })
}

const browser = await chromium.launch({ channel: 'msedge', headless: true })
try {
  // ── 1. 직원(engineer) — 요청 2건 + 관리 화면 접근 거부
  const eng = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const p1 = await eng.newPage()
  await login(p1, need('QA_TEST_EMAIL'), need('QA_TEST_PASSWORD'))
  await p1.goto(`${BASE}/support-requests/new`)
  await p1.getByRole('radio', { name: '목록 값 추가' }).waitFor({ timeout: 15000 })
  const kinds = await p1.getByRole('radio').allTextContents()
  check('AC-1 작성 화면 종류 5값(추가·내리기 포함)', kinds.includes('목록 값 추가') && kinds.includes('목록 값 내리기'), kinds.join(' · '))
  await p1.screenshot({ path: resolve(OUT, '01-support-new-kinds.png'), fullPage: true })
  await newRequest(p1, '목록 값 추가', `장비 유형에 「${LABEL}」 추가`, `장비 유형 목록에 「${LABEL}」 값을 넣어 주세요. 지금 목록에 방화벽만 있고 이 값이 없습니다.`)
  await newRequest(p1, '목록 값 내리기', `장비 유형에서 「${LABEL}」 내리기`, `장비 유형 목록의 「${LABEL}」 값을 사용 안 함으로 내려 주세요.`)
  check('요청 2건 접수(추가·내리기)', true)
  await p1.goto(`${BASE}/admin/code-requests`)
  await p1.waitForTimeout(1500)
  const denied = await p1.getByText('목록 관리 승인 화면을 볼 수 없습니다').count()
  check('AC-9 비관리자 직접 진입 → 3요소 권한 안내', denied > 0)
  await p1.screenshot({ path: resolve(OUT, '02-engineer-access-denied.png'), fullPage: true })
  await eng.close()

  // ── 2. 관리자 — 승인 화면
  const adm = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const p = await adm.newPage()
  p.on('pageerror', (e) => log('pageerror', e.message))
  await login(p, need('QA_ADMIN_EMAIL'), need('QA_ADMIN_PASSWORD'))
  await p.goto(`${BASE}/admin/code-requests`)
  await p.getByRole('status', { name: '목록 증감 안내' }).waitFor({ timeout: 20000 })
  await p.waitForFunction(() => !document.body.innerText.includes('불러오는 중입니다'), null, { timeout: 20000 })
  const strip1 = (await p.getByRole('status', { name: '목록 증감 안내' }).innerText()).replace(/\s+/g, ' ')
  check('AC-2 스트립(대기·이번 달·전체·목록·사용 안 함)', /건 대기/.test(strip1) && /개 이번 달 늘어남/.test(strip1) && /개 목록/.test(strip1), strip1)
  await p.screenshot({ path: resolve(OUT, '03-admin-list-1440.png'), fullPage: true })

  // 추가 요청 선택 → 상세
  await p.getByRole('button', { name: new RegExp(`「${LABEL}」 추가`) }).first().click()
  await p.waitForTimeout(500)
  const cat = await p.locator('#code-detail-category').inputValue()
  check('AC-3 ① 어느 목록 추정(장비 유형)', cat === 'equipment_type', cat)
  const detail = (await p.locator('main, body').first().innerText()).replace(/\s+/g, ' ')
  check('AC-3 ②③ 지금 값 수 · 이번 달 늘어난 값 표시', /지금 값 수/.test(detail) && /이번 달 늘어난 값/.test(detail))
  check('AC-3 ④ 비슷한 값 배너(본문의 「방화벽」 언급)', /비슷한 값이 이미 있습니다/.test(detail))
  await p.fill('#code-detail-memo', 'QA 실화면 확인 — 승인 메모')
  await p.screenshot({ path: resolve(OUT, '04-admin-detail-add.png'), fullPage: true })

  // 승인 시트
  await p.getByRole('button', { name: '승인하고 반영' }).click()
  await p.locator('#code-add-label').waitFor({ timeout: 10000 })
  check('시트 목록 초깃값 = 상세 선택', (await p.locator('#code-add-category').inputValue()) === 'equipment_type')
  check('시트 메모 = 상세 메모 승계', (await p.locator('#code-add-memo').inputValue()) === 'QA 실화면 확인 — 승인 메모')
  await p.fill('#code-add-label', LABEL)
  check('AC-5 코드 불변 안내 상시', (await p.getByText('나중에 못 바꿉니다').count()) > 0)
  check('한글 이름 → 코드 자동 제안 없음(직접 입력)', (await p.locator('#code-add-code').inputValue()) === '')
  await p.fill('#code-add-code', CODE)
  await p.screenshot({ path: resolve(OUT, '05-add-sheet.png'), fullPage: true })
  await p.getByRole('button', { name: '반영', exact: true }).click()
  await p.waitForFunction((l) => !document.body.innerText.includes(`「${l}」 추가`) , LABEL, { timeout: 20000 }).catch(() => {})
  await p.waitForFunction(() => !document.body.innerText.includes('불러오는 중입니다'), null, { timeout: 20000 })
  const strip2 = (await p.getByRole('status', { name: '목록 증감 안내' }).innerText()).replace(/\s+/g, ' ')
  const added1 = Number((strip1.match(/(\d+) 개 이번 달/) ?? strip1.match(/(\d+)개 이번 달/) ?? [0, 0])[1])
  const added2 = Number((strip2.match(/(\d+) 개 이번 달/) ?? strip2.match(/(\d+)개 이번 달/) ?? [0, 0])[1])
  check('AC-4 승인 성공 → 이번 달 늘어남 +1 · 요청이 대기 목록에서 사라짐', added2 === added1 + 1 && !(await p.getByRole('button', { name: new RegExp(`「${LABEL}」 추가`) }).count()), `${added1} → ${added2}`)
  await p.screenshot({ path: resolve(OUT, '06-after-approve.png'), fullPage: true })

  // 내리기 요청 → 시트 → 건수 확인 전 잠금 → 내리기
  await p.getByRole('button', { name: new RegExp(`「${LABEL}」 내리기`) }).first().click()
  await p.waitForTimeout(500)
  const bannerOnDown = await p.getByText('비슷한 값이 이미 있습니다').count()
  check('[Review2] 내리기 요청에는 비슷한 값 배너 없음', bannerOnDown === 0)
  await p.getByRole('button', { name: '사용 안 함으로 내리기' }).first().click()
  await p.locator('#code-down-code').waitFor({ timeout: 10000 })
  await p.selectOption('#code-down-category', 'equipment_type')
  await p.selectOption('#code-down-code', CODE)
  const confirm = p.locator('button', { hasText: '사용 안 함으로 내리기' }).last()
  await p.waitForFunction(() => document.body.innerText.includes('지워지지 않습니다'), null, { timeout: 15000 })
  const usageText = (await p.locator('[data-slot=sheet-content], [role=dialog]').last().innerText()).replace(/\s+/g, ' ')
  check('AC-7 사용 건수 문장(한글 · 0건 = 기록 없음)', /이 값을 쓰는 기록은 아직 없습니다|과거 기록/.test(usageText) && !/tickets|equipment\b/.test(usageText), usageText.slice(0, 160))
  check('건수 확인 뒤 내리기 버튼 활성', await confirm.isEnabled())
  await p.screenshot({ path: resolve(OUT, '07-down-sheet.png'), fullPage: true })
  await confirm.click()
  await p.waitForFunction(() => !document.body.innerText.includes('불러오는 중입니다'), null, { timeout: 20000 })
  await p.waitForTimeout(800)
  const strip3 = (await p.getByRole('status', { name: '목록 증감 안내' }).innerText()).replace(/\s+/g, ' ')
  check('AC-6 내리기 성공 → 사용 안 함 +1', /사용 안 함 [1-9]/.test(strip3), strip3)
  await p.screenshot({ path: resolve(OUT, '08-after-deactivate.png'), fullPage: true })

  // 사용 안 함 시트 → 근거 표기 → 다시 사용
  await p.getByRole('button', { name: /사용 안 함으로 내려진 값/ }).click()
  await p.getByText(LABEL).first().waitFor({ timeout: 10000 })
  const inactiveText = (await p.locator('[role=dialog]').last().innerText()).replace(/\s+/g, ' ')
  check('AC-8 사용 안 함 목록에 값 + 근거(SR-번호)', new RegExp(`${LABEL}.*SR-\\d{4}`).test(inactiveText), inactiveText.slice(0, 160))
  await p.screenshot({ path: resolve(OUT, '09-inactive-sheet.png'), fullPage: true })
  await p.getByRole('button', { name: '다시 사용' }).first().click()
  await p.waitForFunction((l) => { const d = document.querySelector('[role=dialog]'); return d && !d.innerText.includes(l) }, LABEL, { timeout: 15000 })
  check('AC-8 [다시 사용] → 시트 열린 채 목록에서 사라짐', true)
  await p.screenshot({ path: resolve(OUT, '10-after-reactivate.png'), fullPage: true })
  await p.keyboard.press('Escape')

  // 모바일 열람 전용
  await p.setViewportSize({ width: 390, height: 844 })
  await p.goto(`${BASE}/admin/code-requests`)
  await p.waitForFunction(() => !document.body.innerText.includes('불러오는 중입니다'), null, { timeout: 20000 })
  const mobile = (await p.locator('body').innerText()).replace(/\s+/g, ' ')
  const writeBtns = await p.getByRole('button', { name: /승인하고 반영|반려|사용 안 함으로 내리기|다시 사용/ }).count()
  check('AC-11 모바일 = 보기 전용 안내 + 쓰기 버튼 0', /보기 전용입니다/.test(mobile) && writeBtns === 0, `buttons=${writeBtns}`)
  await p.screenshot({ path: resolve(OUT, '11-mobile-390.png'), fullPage: true })
  await adm.close()
} finally {
  await browser.close()
}
const fail = results.filter((r) => !r.ok)
console.log(JSON.stringify({ label: LABEL, code: CODE, pass: results.length - fail.length, fail: fail.length, results }, null, 1))
process.exit(fail.length ? 1 : 0)
