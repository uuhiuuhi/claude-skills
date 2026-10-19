// 감시자 텔레그램 발송 — 2026-10-19 실측: Windows 에서 한글 JSON 을 curl `-d` 인자로 넘기면 텔레그램이
// 「400 strings must be encoded in UTF-8」로 거절했는데 curl 종료 코드 0 이라 감시자는 「알림 발송 ok」로 적었다.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { telegramCurlRequest, telegramSent } from './runner-rules.mjs'

const BODY = JSON.stringify({ chat_id: 1, text: '🐶 감시자 · 러너 침묵 80분 — 즉시 기동합니다.' })

describe('telegramCurlRequest — 본문은 인자가 아니라 stdin UTF-8 바이트로', () => {
  it('인자에 본문이 없고 --data-binary @- 로 읽는다', () => {
    const { args, input } = telegramCurlRequest('https://example.invalid/send', BODY)
    assert.ok(!args.includes(BODY))
    assert.deepEqual(args.slice(args.indexOf('--data-binary'), args.indexOf('--data-binary') + 2), ['--data-binary', '@-'])
    assert.ok(Buffer.isBuffer(input))
    assert.equal(input.toString('utf8'), BODY)
  })
  it('실제 curl 이 받는 쪽에 한글 본문을 UTF-8 그대로 전한다', { skip: spawnSync('curl', ['--version']).status !== 0 && 'curl 없음' }, async () => {
    let got = null
    const server = createServer((req, res) => {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => { got = Buffer.concat(chunks); res.setHeader('Content-Type', 'application/json'); res.end('{"ok":true}') })
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    try {
      const { args, input } = telegramCurlRequest(`http://127.0.0.1:${server.address().port}/send`, BODY)
      const out = await new Promise((resolve, reject) => {
        const c = spawn('curl', args)
        let s = ''
        c.stdout.on('data', (d) => { s += d })
        c.on('error', reject)
        c.on('close', () => resolve(s))
        c.stdin.end(input)
      })
      assert.equal(got.toString('utf8'), BODY)
      assert.ok(got.equals(Buffer.from(BODY, 'utf8')))
      assert.equal(telegramSent(out), true)
    } finally { server.close() }
  })
})

describe('telegramSent — 성공은 응답의 "ok":true 로만', () => {
  it('ok:true 만 성공', () => {
    assert.equal(telegramSent('{"ok":true,"result":{}}'), true)
    assert.equal(telegramSent('{"ok":false,"error_code":400,"description":"Bad Request: strings must be encoded in UTF-8"}'), false)
    assert.equal(telegramSent(''), false)
    assert.equal(telegramSent(undefined), false)
    assert.equal(telegramSent('<html>502</html>'), false)
  })
})
