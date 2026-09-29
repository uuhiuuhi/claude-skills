// dev-status — DB 마이그레이션 적용 상태 실측(선택 기능 · 사람이 직접 실행한다)
//
// scan/build/serve 어디서도 부르지 않는다(네트워크 + DB CLI 인증 + 수 초 소요 — 새로고침 경로에 넣지 않는다).
// 결과는 산출물 JSON 하나에 남고, 현황판은 그 산출물과 측정 시각만 읽는다(scan.mjs parseMigrationProbe).
// 기록 문서의 「미적용 N」 기재를 믿지 않고 실측한다 — 권한 거부를 「부재」로 오독한 기재가 여러 번
// 틀렸던 것이 이 도구가 생긴 이유다.
//
// 지금은 Supabase CLI(`npx supabase migration list --linked`)만 지원한다. 다른 DB 를 쓰는 프로젝트는
// 같은 모양의 산출물(아래 `out` 참조)을 만드는 자기 도구를 두면 현황판이 그대로 읽는다.
//
// 실행: node <이 폴더>/probe-migrations.mjs --root <프로젝트 루트>
//   · 프로젝트 루트의 tools/dev-status/sources.json 에 devProjectRef(개발용 프로젝트 식별자)가 있어야 한다.
//     없으면 재지 않는다 — 무엇을 재는지 확인 못 한 채 재면 운영 측정값이 개발 기준값을 덮을 수 있다.
//   · 링크된 프로젝트(supabase/.temp/project-ref)가 devProjectRef 와 다르면 재지 않는다.
//   · 인증은 Supabase CLI 가 스스로 한다(환경변수 SUPABASE_ACCESS_TOKEN 또는 CLI 로그인). 이 도구는
//     토큰을 읽거나 저장하지 않는다.
//   · 쓰는 파일은 산출물 하나뿐이다(기본 tools/dev-status/migration-probe.json · sources.json 의
//     migrationProbeFile 로 바꿀 수 있다). 임시 파일에 쓴 뒤 이름을 바꾼다(원자적 쓰기).
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, renameSync, readdirSync, existsSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve, isAbsolute, dirname } from 'node:path'
import { ROOT } from './scan.mjs' // --root 해석은 scan.mjs 가 한다 — 여기서 다시 정의하지 않는다

const root = ROOT.replace(/[\\/]+$/, '')
const cfg = (() => {
  try { return JSON.parse(readFileSync(join(root, 'tools', 'dev-status', 'sources.json'), 'utf8')) || {} } catch { return {} }
})()
const str = (k) => (typeof cfg[k] === 'string' ? cfg[k].trim() : '')
const pathOf = (k, def) => { const v = str(k); return v ? (isAbsolute(v) ? v : resolve(root, v)) : def }

const MIG_DIR = pathOf('migrationsDir', join(root, 'supabase', 'migrations'))
const OUT = pathOf('migrationProbeFile', join(root, 'tools', 'dev-status', 'migration-probe.json'))
const TMP = OUT + '.tmp'
const DEV = str('devProjectRef')

if (!DEV) {
  console.log('측정하지 않았습니다 — tools/dev-status/sources.json 에 devProjectRef(개발용 프로젝트 식별자)가 없습니다.')
  process.exit(1)
}

// 측정 시점의 로컬 파일 목록 지문 — 화면이 「측정 이후 파일이 바뀌었는가」를 판정하는 1차 신선도 신호
const localFiles = existsSync(MIG_DIR) ? readdirSync(MIG_DIR).filter((n) => n.endsWith('.sql')).sort() : []
const localFilesHash = createHash('md5').update(localFiles.join('\n')).digest('hex').slice(0, 12)
const refPath = join(root, 'supabase', '.temp', 'project-ref')
const projectRef = existsSync(refPath) ? readFileSync(refPath, 'utf8').trim() : ''

// 링크 대상이 개발이 아니면 재지 않는다 — 재면 운영 측정값이 개발 기준값(lastSuccess)을 덮어쓴다.
if (projectRef !== DEV) {
  console.log('측정하지 않았습니다 — 링크 대상이 개발용 프로젝트가 아닙니다(현재: ' + (projectRef || '없음') + ' · 기대: ' + DEV + ').')
  process.exit(1)
}

const prev = (() => { try { return JSON.parse(readFileSync(OUT, 'utf8')) } catch { return {} } })()
const at = new Date().toISOString()

// cwd 는 반드시 프로젝트 루트 — 어긋나면 CLI 가 링크 정보를 못 찾는다.
// 파이프로 받으면 JSON 이 나온다(TTY 면 표가 나올 수 있다).
// Windows 는 npx 가 .cmd 라 cmd /c 를 거쳐야 한다.
const WIN = process.platform === 'win32'
const r = WIN
  ? spawnSync('cmd', ['/c', 'npx', 'supabase', 'migration', 'list', '--linked'],
    { cwd: root, encoding: 'utf8', timeout: 120000, windowsHide: true })
  : spawnSync('npx', ['supabase', 'migration', 'list', '--linked'],
    { cwd: root, encoding: 'utf8', timeout: 120000 })

let ok = false
let rows = null
let errorSummary = ''
if (r.error) errorSummary = '실행 실패: ' + r.error.message
else if (r.status !== 0) {
  errorSummary = 'CLI 종료코드 ' + r.status +
    (/401|Unauthorized|access token/i.test(String(r.stdout ?? '') + String(r.stderr ?? '')) ? ' — 인증이 필요합니다(CLI 로그인 또는 SUPABASE_ACCESS_TOKEN)' : '')
} else {
  try {
    const j = JSON.parse(r.stdout)
    if (!Array.isArray(j.migrations)) throw new Error('migrations 배열 없음')
    rows = j.migrations
    ok = true
  } catch (e) { errorSummary = '출력 형식 인식 실패(CLI 버전 변경 가능): ' + e.message }
}

// 불변식: 개수 필드는 lastSuccess 안에만 둔다(최상위에 0 초기값 금지 — 결측이 0 으로 둔갑하지 않게).
// 실패는 lastSuccess 를 절대 덮지 않는다 — 직전 성공값 유지 + lastAttempt 에 실패만 기록.
// rawTail = 실패 원문. 화면은 원시 에러를 싣지 않으므로 사후 진단은 이 필드와 터미널 출력이 맡는다.
const out = {
  lastSuccess: prev.lastSuccess || null,
  lastAttempt: { at, ok, errorSummary, rawTail: ok ? '' : String(r.stdout || r.stderr || '').slice(-400) },
}
if (ok) {
  out.lastSuccess = {
    measuredAt: at,
    projectRef,
    total: rows.length,
    applied: rows.filter((x) => x.local && x.remote).length,
    localOnly: rows.filter((x) => x.local && !x.remote).length,
    remoteOnly: rows.filter((x) => !x.local && x.remote).length,
    // 개수만으로는 「번호표만 다른 과거 적용분」과 「진짜 규칙 위반」을 가를 수 없다 — 화면이 성격을
    // 나누려면 버전 목록이 있어야 한다. 목록이 없는 옛 산출물은 화면이 「가르지 못했습니다」로 적는다.
    remoteOnlyVersions: rows.filter((x) => !x.local && x.remote).map((x) => String(x.remote)),
    localFilesCount: localFiles.length,
    localFilesHash,
  }
}
mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(TMP, JSON.stringify(out, null, 2), 'utf8')
renameSync(TMP, OUT)
console.log(ok
  ? '측정 완료 — ' + out.lastSuccess.total + '개 중 미적용 ' + out.lastSuccess.localOnly + ' · 대상 ' + projectRef
  : '측정 실패 — ' + errorSummary + ' (직전 성공값은 그대로 두었습니다)')
process.exit(ok ? 0 : 1)
