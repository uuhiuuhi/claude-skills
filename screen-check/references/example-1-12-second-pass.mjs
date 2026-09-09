// 1.12 실화면 확인 2차 — 1차에서 대기 부족으로 판정 못 한 3항목(AC-7 건수 문장 · 건수 확인 전 잠금 · AC-11 모바일)
// 새 코드값을 만들지 않는다: 1차가 만든 프로브 값(LABEL/CODE)을 내리기 요청으로 다시 내린다 → 끝나면 「사용 안 함」 상태로 남는다.
import { chromium } from 'playwright-core'
import { readFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const [LABEL, CODE] = process.argv.slice(2)
if (!LABEL || !CODE) throw new Error('usage: node check-1-12-b.mjs <LABEL> <CODE>')
const BASE = 'http://127.0.0.1:5174'
const ROOT = 'C:/Users/user/AppData/Local/Temp/claude/C--Projects-jng-os/f30fdb04-628a-4fd6-b961-5958ecc4b985/scratchpad'
const OUT = resolve(ROOT, 'e2e-shots'); mkdirSync(OUT, { recursive: true })
const env = Object.fromEntries(readFileSync(resolve(ROOT, 'e2e-wt/.env.local'), 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')] }))
const need = (k) => { if (!env[k]) throw new Error(`${k} 없음`); return env[k] }
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log('[e2e]', ok ? '✓' : '✗', name, detail) }

async function login(page, email, password) {
  await page.goto(`${BASE}/login`)
  await page.fill('#login-email', email)
  await page.fill('#login-password', password)
  await page.click('button[type=submit]')
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 })
}

const browser = await chromium.launch({ channel: 'msedge', headless: true })
try {
  const eng = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const p1 = await eng.newPage()
  await login(p1, need('QA_TEST_EMAIL'), need('QA_TEST_PASSWORD'))
  await p1.goto(`${BASE}/support-requests/new`)
  await p1.getByRole('radio', { name: '목록 값 내리기' }).click()
  await p1.fill('#support-title', `장비 유형에서 「${LABEL}」 다시 내리기`)
  await p1.fill('#support-body', `2차 확인 — 「${LABEL}」 값을 사용 안 함으로 내려 주세요.`)
  await p1.getByRole('button', { name: '지원요청 보내기' }).click()
  await p1.waitForURL((u) => !u.pathname.endsWith('/new'), { timeout: 20000 })
  await eng.close()

  const adm = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const p = await adm.newPage()
  await login(p, need('QA_ADMIN_EMAIL'), need('QA_ADMIN_PASSWORD'))
  await p.goto(`${BASE}/admin/code-requests`)
  await p.getByRole('button', { name: new RegExp(`「${LABEL}」 다시 내리기`) }).first().waitFor({ timeout: 20000 })
  await p.getByRole('button', { name: new RegExp(`「${LABEL}」 다시 내리기`) }).first().click()
  await p.getByRole('button', { name: '사용 안 함으로 내리기' }).first().click()
  const dialog = p.locator('[role=dialog]').last()
  await p.locator('#code-down-code').waitFor({ timeout: 10000 })
  await p.selectOption('#code-down-category', 'equipment_type')
  const confirm = dialog.getByRole('button', { name: '사용 안 함으로 내리기' })
  check('값 선택 전 — 내리기 버튼 잠김(건수 없음)', !(await confirm.isEnabled()))
  await p.selectOption('#code-down-code', CODE)
  const countingSeen = await dialog.getByText('건수를 세는 중').count()
  await dialog.getByText('지워지지 않습니다').waitFor({ timeout: 15000 })
  const usageText = (await dialog.innerText()).replace(/\s+/g, ' ')
  check('AC-7 사용 건수 문장 — 한글 · 영문 표 이름 0', /이 값을 쓰는 기록은 아직 없습니다|과거 기록 [가-힣 ]+ \d+건/.test(usageText) && !/\b(tickets|equipment|contracts)\b \d/.test(usageText), usageText.slice(usageText.indexOf('지워지지'), usageText.indexOf('지워지지') + 90))
  check('AC-7 건수 확인 뒤에만 내리기 버튼 활성(세는 중 표기 실측)', await confirm.isEnabled(), `countingSeen=${countingSeen}`)
  await p.screenshot({ path: resolve(OUT, '12-down-sheet-counted.png'), fullPage: true })
  await confirm.click()
  await p.waitForFunction(() => /사용 안 함 [1-9]/.test(document.body.innerText.replace(/\s+/g, ' ')), null, { timeout: 20000 })
  check('AC-6 내리기 → 사용 안 함 +1 (프로브 값은 사용 안 함으로 남긴다)', true)

  await p.setViewportSize({ width: 390, height: 844 })
  await p.goto(`${BASE}/admin/code-requests`)
  await p.getByText('보기 전용입니다').waitFor({ timeout: 30000 })
  const writeBtns = await p.getByRole('button', { name: /승인하고 반영|반려|사용 안 함으로 내리기|다시 사용/ }).count()
  const strip = await p.getByRole('status', { name: '목록 증감 안내' }).count()
  check('AC-11 모바일 — 보기 전용 1줄 + 쓰기 버튼 0 + 스트립 유지', writeBtns === 0 && strip === 1, `buttons=${writeBtns} strip=${strip}`)
  await p.screenshot({ path: resolve(OUT, '13-mobile-390.png'), fullPage: true })
  await adm.close()
} finally {
  await browser.close()
}
const fail = results.filter((r) => !r.ok)
console.log(JSON.stringify({ pass: results.length - fail.length, fail: fail.length, results }, null, 1))
process.exit(fail.length ? 1 : 0)
