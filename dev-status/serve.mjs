// dev-status — BMad 프로젝트 개발 현황판: 로컬 정적 서버 + 생성기 핫리로드
// 현황판 페이지를 열거나 새로고침할 때마다 그 자리에서 다시 만든다 — 파일 감시·자동 리로드 없음.
import { createServer } from 'node:http'
import { existsSync, statSync, createReadStream, readdirSync } from 'node:fs'
import { join, extname, normalize, relative, sep } from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { build as buildStatic, renderRunner } from './build.mjs'
import { ROOT, OUT_DIR, parseRunner } from './scan.mjs'

// 전용 변수만 읽는다 — 범용 이름의 포트 변수는 앱 서버용으로 흔히 설정돼 있어 폴백으로 쓰면 위험하다.
// 기본 포트가 점유돼 있으면 +1 씩 올려 본다(여러 프로젝트에서 현황판을 동시에 띄우는 경우).
const BASE_PORT = Number(process.env.DEV_STATUS_PORT || 5180)
const MAX_PORT = BASE_PORT + 9
let port = BASE_PORT

// 출력 경로는 scan.mjs 의 OUT_DIR 상수 하나를 공유한다
const PAGE = '/' + relative(ROOT, OUT_DIR).split(sep).join('/') + '/index.html'
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.yaml': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
  '.map': 'application/json; charset=utf-8',
}

// 생성기를 고치면 서버를 껐다 켜지 않아도 반영되게 한다.
// `import('./build.mjs?v=…')` 는 build.mjs 만 새로 읽고 그 안의 scan.mjs·render-batch.mjs 등 하위 모듈은
// 옛 캐시를 그대로 쓴다(켜 둔 서버가 새 블록을 못 내던 실사고). 그래서 생성기 파일(이 폴더의 *.mjs 전부)
// 이나 프로젝트 설정(tools/dev-status/sources.json — 모듈이 적재될 때 한 번 읽는다)이 하나라도 바뀌면
// 그다음부터는 **새 node 프로세스**로 만든다.
const GEN_DIR = new URL('./', import.meta.url)
const SOURCES = join(ROOT, 'tools', 'dev-status', 'sources.json')
const genFiles = () => {
  try { return readdirSync(GEN_DIR).filter((n) => n.endsWith('.mjs') && !n.endsWith('.test.mjs')).sort() } catch { return ['build.mjs', 'scan.mjs'] }
}
let genStamp = ''
let useChild = false

async function build() {
  const stamp = genFiles().map((n) => {
    try { return n + ':' + String(statSync(new URL('./' + n, import.meta.url)).mtimeMs) } catch { return n + ':0' }
  }).concat([(() => { try { return 'sources:' + statSync(SOURCES).mtimeMs } catch { return 'sources:0' } })()]).join('|')
  if (stamp !== genStamp) {
    if (genStamp) { useChild = true; console.log('생성기·설정 갱신 감지 — 이제부터 새 프로세스로 만듭니다') }
    genStamp = stamp
  }
  if (!useChild) return buildStatic()
  const out = execFileSync(process.execPath,
    [fileURLToPath(new URL('./build.mjs', import.meta.url)), '--root', ROOT.slice(0, -1)],
    { cwd: ROOT.slice(0, -1), encoding: 'utf8', timeout: 120_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
  return { version: new Date().toISOString(), note: out.trim().split('\n')[0] }
}

// ── 서버 (127.0.0.1 전용 — 외부에 열지 않는다) ─────────────────
const notFound = (res, msg) => {
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(msg)
}

const server = createServer(async (req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0])

  if (url.endsWith('__served')) {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    return res.end('{"ok":true}')
  }
  // 러너 실황 — 페이지 JS 가 20초마다 부른다. 매 호출 상태 폴더의 slots.log 를 새로 읽는다(수 ms · 읽기 전용).
  if (url.endsWith('__runner/status')) {
    let html = ''
    try { html = renderRunner(parseRunner()) } catch { html = '' }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    return res.end(JSON.stringify({ html }))
  }

  if (url === '/' || url === '/index.html') {
    res.writeHead(302, { location: PAGE })
    return res.end()
  }
  if (url === PAGE) {
    // 열 때마다 원천에서 다시 만든다 — 켜 둔 동안 파일이 바뀌어도 F5 한 번이면 최신
    try {
      await build()
    } catch (err) {
      console.error('갱신 실패 — ' + err.message) // 실패하면 직전 생성물을 그대로 보여준다
    }
  }
  const file = join(ROOT, normalize(url).replace(/^([/\\])+/, ''))
  // ROOT 는 끝 구분자를 포함한다 — startsWith 비교가 형제 폴더(예: …-secret)로 새지 않는다
  if (!(file === ROOT.slice(0, -1) || file.startsWith(ROOT)) || !existsSync(file) || statSync(file).isDirectory()) {
    return notFound(res, '없는 경로입니다: ' + url)
  }
  const ext = extname(file).toLowerCase()
  const type = MIME[ext]
  if (!type) {
    console.error('MIME 미등록: ' + (ext || '(확장자 없음)'))
    return notFound(res, '제공하지 않는 파일 형식입니다: ' + url)
  }
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
  createReadStream(file).pipe(res)
})

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && port < MAX_PORT) {
    port += 1
    server.listen(port, '127.0.0.1')
    return
  }
  console.error('서버를 열지 못했습니다 — ' + err.message)
  process.exit(1)
})

server.on('listening', async () => {
  const addr = 'http://127.0.0.1:' + port + PAGE
  console.log(addr) // 확정 주소 — stdout 첫 줄
  console.log('브라우저에서 새로고침(F5)할 때마다 최신 내용으로 다시 만듭니다. 끄려면 Ctrl+C.')
  try {
    console.log('현황판 생성 — ' + (await build()).version)
  } catch (err) {
    console.error('생성 실패 — ' + err.message)
  }
  if (!process.env.NO_OPEN) {
    const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', addr]]
      : process.platform === 'darwin' ? ['open', [addr]]
        : ['xdg-open', [addr]]
    try {
      spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }).unref()
    } catch {
      // 브라우저 자동 열기 실패 시 주소를 직접 열면 된다
    }
  }
})

server.listen(port, '127.0.0.1')
