#!/usr/bin/env node
// 本地验证用的最小 SMTP 收信器：接收 Worker 通过 SMTP_CONFIG 发出的邮件，存在内存里。
// SMTP 端口默认 1025，HTTP 端口默认 1080：
//   GET  /messages        列出收到的邮件 [{ from, to, data, received_at }]
//   DELETE /messages      清空
// 只支持明文 SMTP（不做 STARTTLS 和认证），只用于本地验证。
import { createServer as createTcpServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';

const SMTP_PORT = Number(process.env.SMTP_SINK_PORT || 1025);
const HTTP_PORT = Number(process.env.SMTP_SINK_HTTP_PORT || 1080);
const messages = [];

createTcpServer((socket) => {
    let buffer = '';
    let inData = false;
    let current = { from: '', to: [], data: '' };
    const reply = (line) => socket.write(`${line}\r\n`);
    reply('220 smtp-sink ready');
    socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        while (true) {
            if (inData) {
                const end = buffer.indexOf('\r\n.\r\n');
                if (end === -1) return;
                current.data = buffer.slice(0, end).replace(/\r\n\.\./g, '\r\n.');
                buffer = buffer.slice(end + 5);
                inData = false;
                messages.push({ ...current, received_at: new Date().toISOString() });
                current = { from: '', to: [], data: '' };
                reply('250 OK queued');
                continue;
            }
            const lineEnd = buffer.indexOf('\r\n');
            if (lineEnd === -1) return;
            const line = buffer.slice(0, lineEnd);
            buffer = buffer.slice(lineEnd + 2);
            const command = line.slice(0, 4).toUpperCase();
            if (command === 'EHLO') {
                reply('250-smtp-sink');
                reply('250-8BITMIME');
                reply('250 SMTPUTF8');
            } else if (command === 'HELO') {
                reply('250 smtp-sink');
            } else if (command === 'MAIL') {
                current.from = line.replace(/^MAIL FROM:\s*/i, '').replace(/[<>]/g, '').split(' ')[0];
                reply('250 OK');
            } else if (command === 'RCPT') {
                current.to.push(line.replace(/^RCPT TO:\s*/i, '').replace(/[<>]/g, '').split(' ')[0]);
                reply('250 OK');
            } else if (command === 'DATA') {
                inData = true;
                reply('354 End data with <CR><LF>.<CR><LF>');
            } else if (command === 'RSET') {
                current = { from: '', to: [], data: '' };
                reply('250 OK');
            } else if (command === 'NOOP') {
                reply('250 OK');
            } else if (command === 'QUIT') {
                reply('221 Bye');
                socket.end();
                return;
            } else {
                reply('502 Command not implemented');
            }
        }
    });
    socket.on('error', () => { /* 忽略客户端断开 */ });
}).listen(SMTP_PORT, '127.0.0.1');

createHttpServer((req, res) => {
    if (req.url === '/messages' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(messages));
        return;
    }
    if (req.url === '/messages' && req.method === 'DELETE') {
        messages.length = 0;
        res.writeHead(204);
        res.end();
        return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`smtp-sink: ${messages.length} messages\n`);
}).listen(HTTP_PORT, '127.0.0.1');

console.log(`smtp-sink listening on smtp://127.0.0.1:${SMTP_PORT}, http://127.0.0.1:${HTTP_PORT}`);
