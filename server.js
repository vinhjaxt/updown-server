#!/usr/bin/env node
/* eslint-disable camelcase */
'use strict'
try {
  for (let k of ['error', 'log', 'warn']) {
    const native = console[k].bind(console)
    console[k] = (...args) => native((new Date()).toLocaleString(), ...args)
  }
} catch (e) { }
process.on('uncaughtException', console.error).on('unhandledRejection', reason => console.error('UncatchedPromise:', reason))
process.env.NODE_ENV = 'production'

const zlib = require('zlib')
const http = require('http')
const fs = require('fs')
const mkdirp = require('mkdirp')
const path = require('path')
const mime = require('mime')
const busboy = require('busboy')
const noop = () => {}

const compressPiper = {
  gzip: zlib.createGzip.bind(zlib),
  deflate: zlib.createDeflate.bind(zlib),
  br: zlib.createBrotliCompress && zlib.createBrotliCompress.bind(zlib)
}
function saveFile(fieldname, file, info) {
  if (!info || !info.filename) return file.resume()
  console.log('Uploading', fieldname, info)
  file.pipe(fs.createWriteStream(DIR + '/' + path.basename(info.filename) + '-' + Date.now() + path.extname(info.filename)))
}
function finishReq() {
  // Upload done
  console.log('All upload done')
  this.writeHead(200, {
    'Connection': 'close',
    'X-Robots-Tag': 'noindex, nofollow',
    'Content-Type': 'text/plain; charset=UTF-8'
  })
  this.end('\r\nOK\r\n')
}
const htmlspecialchars = { '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;', '&': '&amp;' }
const htmlspecial = s => s.replace(/[<>"'&]/g, $0 => htmlspecialchars[$0])
const ipHeaders = [
  'X-Originating-IP',
  'X-Remote-IP',
  'X-Remote-Addr',
  'True-Client-IP',
  'X-Forwarded-For',
  'Client-Ip',
  'Via',
  'CF-Connecting-IP'
]

// curl -F '=@/etc/passwd' localhost:8001
const PORT = parseInt(process.argv[3] || process.env.PORT) || 8001
const DIR = process.argv[2] || './uploads'

if (!fs.existsSync(DIR)) mkdirp(DIR).catch(e => console.error(e))
const LIST_FILES = true

http.createServer((req, res) => {
  try {
    if (req.method.toUpperCase() === 'GET') {
      if (req.url.substr(0, 5) === '/down') {
        if (~req.url.indexOf('/', 1)) {
          // download file
          const filename = decodeURIComponent(path.basename(req.url))
          const file = DIR + '/' + filename
          let fileStat
          try {
            fileStat = fs.statSync(file)
          } catch (e) { }
          if (fileStat && fileStat.isFile()) {
            const fileSize = fileStat.size
            const contentType = mime.getType(path.extname(filename)) || 'text/plain; charset=UTF-8' // || 'application/octet-stream'
            const headers = {
              'Accept-Ranges': 'bytes',
              'Cache-Control': 'no-cache',
              'Vary': 'Accept-Encoding',
              'Content-Disposition': 'filename="' + filename.replace(/[^\t\x20-\x7e\x80-\xff]|[\r\n\0]/g, '').replace(/"/g, '\\"') + '"', // https://github.com/nodejs/node/blob/master/lib/_http_common.js#L213
              // 'Content-Disposition': 'attachment; filename="' + filename.replace(/[^\t\x20-\x7e\x80-\xff]|[\r\n\0]/g, '').replace(/"/g, '\\"') + '"',
              'X-Robots-Tag': 'noindex, nofollow',
              'Content-Type': contentType
            }
            let httpCode = 200
            let bodyLength = fileSize
            const readOpts = {}

            if (req.headers.range) {
              const maxOffset = fileSize - 1
              const parts = req.headers.range.replace(/bytes=/i, '').split('-')

              const start = parseInt(parts[0] || '0', 10) || 0
              let end = parts[1] ? (parseInt(parts[1], 10) || 0) : maxOffset
              if (end > maxOffset) end = maxOffset

              if (start > end || start > maxOffset || end > maxOffset) {
                headers['Content-Length'] = 0
                headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + fileSize
                res.writeHead(206, headers)
                res.end()
                return
              }
              bodyLength = (end - start) + 1
              Object.assign(readOpts, { start, end })
              httpCode = 206
              headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + fileSize
            }
            let compressEncoding
            const acceptEncoding = req.headers['accept-encoding'] || ''
            // Note: This is not a conformant accept-encoding parser.
            // See https://www.w3.org/Protocols/rfc2616/rfc2616-sec14.html#sec14.3
            if (/\bgzip\b/.test(acceptEncoding)) {
              compressEncoding = 'gzip'
            } else if (/\bdeflate\b/.test(acceptEncoding)) {
              compressEncoding = 'deflate'
            } else if (/\bbr\b/.test(acceptEncoding) && compressPiper.br) { // fix
              compressEncoding = 'br'
            }
            if (compressEncoding) {
              headers['Content-Encoding'] = compressEncoding
              const compressPipe = compressPiper[compressEncoding]
              let ended = false
              bodyLength = 0
              const pipeLength = fs.createReadStream(file, readOpts)
              pipeLength.pipe(compressPipe()).on('data', c => {
                bodyLength += c.length
              }).once('error', e => {
                console.error('[pipe-length]', e)
                ended = true
                res.end()
                pipeLength.close()
              }).on('end', () => {
                if (ended) return
                headers['Content-Length'] = bodyLength
                res.writeHead(httpCode, headers)
                fs.createReadStream(file, readOpts).pipe(compressPipe()).pipe(res)
              })
              return
            }
            headers['Content-Length'] = bodyLength
            res.writeHead(httpCode, headers)
            fs.createReadStream(file, readOpts).pipe(res)
            return
          }
        }
        if (LIST_FILES) {
          // list files
          res.writeHead(200, {
            'Cache-Control': 'no-cache',
            'Vary': 'Accept-Encoding',
            'Content-Type': 'text/html; charset=UTF-8',
            'X-Robots-Tag': 'noindex, nofollow'
          })
          const files = fs.readdirSync(DIR)
          let body = '<meta name="robots" content="noindex, nofollow"><ol>'
          for (let f of files) {
            body += `<li><a href="/download/${encodeURIComponent(f)}">${htmlspecial(f)}</a></li>`
          }
          body += '<ol>'
          res.end(body)
          return
        }
        res.writeHead(404)
        res.end()
        return
      }
      if (req.url === '/robots.txt') {
        res.writeHead(200, {
          'X-Robots-Tag': 'noindex, nofollow',
          'Content-Type': 'text/plain; charset=UTF-8'
        })
        res.end('User-agent: *\r\nDisallow: /\r\n')
        return
      }
      if (req.url === '/up') {
        res.writeHead(200, {
          'X-Robots-Tag': 'noindex, nofollow',
          'Content-Type': 'text/html; charset=UTF-8'
        })
        res.end('<form method=post enctype="multipart/form-data"><input type=file name=f[]><br><input type=file name=f[]><br><input type=file name=f[]><br><input type=file name=f[]><br><input type=file name=f[]><br><input type=file name=f[]><br><input type=file name=f[]><br><input type=submit></form>')
        return
      }
      res.writeHead(404, {
        'Content-Type': 'text/html; charset=UTF-8',
        'X-Robots-Tag': 'noindex, nofollow'
      })
      res.end(`<meta name="robots" content="noindex, nofollow">`)
      return
    }
    // Logs ips
    const ips = []
    for (let h of ipHeaders) {
      h = h.toLowerCase()
      const val = req.headers[h]
      if (val && !ips.includes(val)) ips.push(val)
    }
    try {
      const ip = req.connection.socket.remoteAddress
      if (ip && !ips.includes(ip)) ips.push(ip)
    } catch (e) { }
    try {
      const ip = req.socket.remoteAddress
      if (ip && !ips.includes(ip)) ips.push(ip)
    } catch (e) { }
    try {
      const ip = req.connection.remoteAddress
      if (ip && !ips.includes(ip)) ips.push(ip)
    } catch (e) { }
    console.log('Upload from', { url: req.url, ips, userAgent: req.headers['user-agent'] })
    req.pipe(busboy({ headers: req.headers }).on('file', saveFile).on('field', noop).on('close', finishReq.bind(res)))
  } catch (e) {
    console.error(e)
    try {
      res.end('Error')
    } catch (e) { }
  }
}).listen(PORT, () => {
  console.log('Listening at', PORT, ', files will be written to', path.resolve(DIR))
  const os = require('os')
  const ifaces = os.networkInterfaces();

  Object.keys(ifaces).forEach(dev => {
    ifaces[dev].forEach(details => {
      if (details.family === 'IPv4') {
        console.log('  http://' + details.address + ':' + PORT)
      }
    })
  })

})
