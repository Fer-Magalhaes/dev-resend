/**
 * Resend local: responde como https://api.resend.com, não envia nada e mostra o que seria enviado.
 *
 * - API compatível com o SDK `resend` e com `fetch` direto (POST /emails, POST /emails/batch,
 *   GET /emails, GET /emails/:id), com o mesmo formato de resposta e de erro.
 * - Painel em /ui/emails (como o do Resend) e caixa de entrada em /ui/inbox (como o destinatário vê).
 * - Sem banco: os e-mails ficam em memória (ou em RESEND_LOCAL_DATA_FILE, se definido).
 * - Opcional: dispara os webhooks email.sent / email.delivered / email.bounced assinados no padrão
 *   Svix, para testar o fluxo de entrega.
 *
 * Roda com `node server.ts` (Node >= 22.18 remove os tipos sozinho); zero dependências.
 */
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';

const PORT = Number(process.env.PORT ?? 3100);
const HOST = process.env.HOST ?? '0.0.0.0';
const WEBHOOK_URL = process.env.RESEND_LOCAL_WEBHOOK_URL?.trim() ?? '';
const WEBHOOK_SECRET = process.env.RESEND_LOCAL_WEBHOOK_SECRET?.trim() ?? '';
// Opcionais, para rodar fora da máquina (ex.: um ambiente de dev na nuvem):
// API_KEY fixa a chave aceita (vazia = qualquer uma); UI_PASSWORD protege o painel com Basic auth
// (usuário qualquer); DATA_FILE grava os e-mails em disco para sobreviver a um restart/sleep.
const API_KEY = process.env.RESEND_LOCAL_API_KEY?.trim() ?? '';
const UI_PASSWORD = process.env.RESEND_LOCAL_UI_PASSWORD?.trim() ?? '';
const DATA_FILE = process.env.RESEND_LOCAL_DATA_FILE?.trim() ?? '';
const PUBLIC_URL = process.env.RESEND_LOCAL_PUBLIC_URL?.trim().replace(/\/$/, '') ?? '';
const MAX_EMAILS = 1000;
const MAX_BODY_BYTES = 40 * 1024 * 1024; // limite do Resend com anexos
const TIME_ZONE = 'America/Sao_Paulo';

// ---------------------------------------------------------------------------------------------
// Modelo em memória
// ---------------------------------------------------------------------------------------------

type Attachment = { filename: string; content_type: string | null; content: string | null; path: string | null };
type EmailEvent = { type: string; at: string; webhook: string | null };
type Email = {
  id: string;
  created_at: string;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  reply_to: string[];
  subject: string;
  html: string | null;
  text: string | null;
  headers: Record<string, string>;
  tags: { name: string; value: string }[];
  attachments: Attachment[];
  scheduled_at: string | null;
  last_event: string;
  events: EmailEvent[];
  request: { method: string; path: string; headers: Record<string, string>; body: unknown };
  response: unknown;
};

const emails: Email[] = []; // mais novo primeiro
let version = 0; // muda a cada alteração; o painel recarrega quando vê outro número

// Persistência opcional: carrega na subida e grava (no máximo a cada 2 s) quando algo muda.
if (DATA_FILE) {
  try {
    emails.push(...(JSON.parse(readFileSync(DATA_FILE, 'utf8')) as Email[]));
    console.log(`[resend-local] ${emails.length} e-mail(s) carregados de ${DATA_FILE}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error('[resend-local] não li DATA_FILE:', error);
  }
  let saved = version;
  setInterval(() => {
    if (saved === version) return;
    saved = version;
    try {
      writeFileSync(`${DATA_FILE}.tmp`, JSON.stringify(emails));
      renameSync(`${DATA_FILE}.tmp`, DATA_FILE);
    } catch (error) {
      console.error('[resend-local] não gravei DATA_FILE:', error);
    }
  }, 2000).unref();
}

function sameSecret(given: string, expected: string) {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

class ApiError extends Error {
  status: number;
  constructor(status: number, name: string, message: string) {
    super(message);
    this.status = status;
    this.name = name;
  }
}

// ---------------------------------------------------------------------------------------------
// Validação no formato do Resend
// ---------------------------------------------------------------------------------------------

const ADDRESS = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/;
const ADDRESS_FORMAT = 'The email address needs to follow the `email@example.com` or `Name <email@example.com>` format.';

function addressOf(value: string) {
  const match = value.match(/<([^>]+)>\s*$/);
  return (match ? match[1] : value).trim();
}

function displayName(value: string) {
  const match = value.match(/^\s*"?([^"<]*?)"?\s*</);
  return match?.[1]?.trim() || addressOf(value);
}

function recipients(body: Record<string, unknown>, field: string): string[] {
  const value = body[field];
  if (value == null) return [];
  const list = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(list) || !list.every((item) => typeof item === 'string'))
    throw new ApiError(422, 'validation_error', `Invalid \`${field}\` field. ${ADDRESS_FORMAT}`);
  for (const item of list)
    if (!ADDRESS.test(addressOf(item)))
      throw new ApiError(422, 'validation_error', `Invalid \`${field}\` field. ${ADDRESS_FORMAT}`);
  if (list.length > 50)
    throw new ApiError(422, 'validation_error', `Too many recipients in \`${field}\` field. The maximum is 50.`);
  return list.map((item) => item.trim());
}

/** O SDK manda Buffer como `{ type: 'Buffer', data: [...] }`; o fetch direto manda base64. */
function attachmentContent(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && Array.isArray((value as { data?: unknown }).data))
    return Buffer.from((value as { data: number[] }).data).toString('base64');
  return null;
}

function parseEmail(input: unknown, request: Email['request']): Email {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new ApiError(422, 'validation_error', 'The request body must be a JSON object.');
  const body = input as Record<string, unknown>;

  const from = typeof body.from === 'string' ? body.from.trim() : '';
  if (!from) throw new ApiError(422, 'missing_required_field', 'Missing `from` field.');
  if (!ADDRESS.test(addressOf(from))) throw new ApiError(422, 'validation_error', `Invalid \`from\` field. ${ADDRESS_FORMAT}`);

  const to = recipients(body, 'to');
  if (to.length === 0) throw new ApiError(422, 'missing_required_field', 'Missing `to` field.');
  if (typeof body.subject !== 'string' || !body.subject.trim())
    throw new ApiError(422, 'missing_required_field', 'Missing `subject` field.');

  const html = typeof body.html === 'string' ? body.html : null;
  const text = typeof body.text === 'string' ? body.text : null;
  if (html === null && text === null)
    throw new ApiError(422, 'validation_error', 'Missing `html` or `text` field. (resend-local: `react` precisa ser renderizado pelo SDK antes.)');

  const attachments = Array.isArray(body.attachments)
    ? body.attachments.map((raw, index): Attachment => {
        const item = (raw ?? {}) as Record<string, unknown>;
        return {
          filename: typeof item.filename === 'string' ? item.filename : `anexo-${index + 1}`,
          content_type: typeof item.content_type === 'string' ? item.content_type : typeof item.contentType === 'string' ? item.contentType : null,
          content: attachmentContent(item.content),
          path: typeof item.path === 'string' ? item.path : null,
        };
      })
    : [];

  return {
    id: randomUUID(),
    created_at: new Date().toISOString(),
    from,
    to,
    cc: recipients(body, 'cc'),
    bcc: recipients(body, 'bcc'),
    reply_to: recipients(body, body.reply_to !== undefined ? 'reply_to' : 'replyTo'),
    subject: body.subject,
    html,
    text,
    headers: body.headers && typeof body.headers === 'object' ? (body.headers as Record<string, string>) : {},
    tags: Array.isArray(body.tags) ? (body.tags as Email['tags']) : [],
    attachments,
    scheduled_at: typeof body.scheduled_at === 'string' ? body.scheduled_at : null,
    last_event: 'queued',
    events: [],
    request,
    response: null,
  };
}

// ---------------------------------------------------------------------------------------------
// Eventos e webhooks (padrão Svix, igual ao Resend)
// ---------------------------------------------------------------------------------------------

function sign(id: string, timestamp: string, payload: string) {
  const secret = WEBHOOK_SECRET.startsWith('whsec_') ? WEBHOOK_SECRET.slice(6) : WEBHOOK_SECRET;
  return createHmac('sha256', Buffer.from(secret, 'base64')).update(`${id}.${timestamp}.${payload}`).digest('base64');
}

async function emit(email: Email, type: string, extra: Record<string, unknown> = {}) {
  const at = new Date().toISOString();
  const event: EmailEvent = { type, at, webhook: null };
  email.events.push(event);
  email.last_event = type.replace(/^email\./, '');
  version++;
  if (!WEBHOOK_URL) return;

  const payload = JSON.stringify({
    type,
    created_at: at,
    data: { email_id: email.id, created_at: email.created_at, from: email.from, to: email.to, subject: email.subject, ...extra },
  });
  const id = `msg_${randomBytes(12).toString('hex')}`;
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const headers: Record<string, string> = { 'content-type': 'application/json', 'svix-id': id, 'svix-timestamp': timestamp };
  if (WEBHOOK_SECRET) headers['svix-signature'] = `v1,${sign(id, timestamp, payload)}`;
  try {
    const response = await fetch(WEBHOOK_URL, { method: 'POST', headers, body: payload, signal: AbortSignal.timeout(5000) });
    event.webhook = `HTTP ${response.status}`;
  } catch (error) {
    event.webhook = `falhou: ${error instanceof Error ? error.message : String(error)}`;
  }
  version++;
}

function accept(email: Email) {
  emails.unshift(email);
  emails.length = Math.min(emails.length, MAX_EMAILS);
  version++;
  console.log(`[resend-local] ${email.id} para=${email.to.join(',')} assunto="${email.subject}"`);
  if (email.scheduled_at && new Date(email.scheduled_at).getTime() > Date.now()) {
    email.last_event = 'scheduled';
    return;
  }
  // Em ordem, como no Resend: sent e, logo depois, delivered.
  void emit(email, 'email.sent').then(() => setTimeout(() => void emit(email, 'email.delivered'), 500));
}

// ---------------------------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------------------------

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function apiError(res: ServerResponse, error: ApiError) {
  json(res, error.status, { statusCode: error.status, name: error.name, message: error.message });
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new ApiError(413, 'validation_error', 'The request body is too large.');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJson(req: IncomingMessage): Promise<{ raw: unknown }> {
  const text = await readBody(req);
  try {
    return { raw: JSON.parse(text || 'null') };
  } catch {
    throw new ApiError(422, 'validation_error', 'Invalid JSON body.');
  }
}

function requestInfo(req: IncomingMessage, path: string, body: unknown): Email['request'] {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers[name] = name === 'authorization' ? String(value).replace(/(Bearer\s+\S{0,6})\S*/i, '$1…') : String(value);
  }
  return { method: req.method ?? 'POST', path, headers, body };
}

function summary(email: Email) {
  return {
    object: 'email',
    id: email.id,
    to: email.to,
    from: email.from,
    created_at: email.created_at,
    subject: email.subject,
    html: email.html,
    text: email.text,
    cc: email.cc.length ? email.cc : null,
    bcc: email.bcc.length ? email.bcc : null,
    reply_to: email.reply_to.length ? email.reply_to : null,
    last_event: email.last_event,
    scheduled_at: email.scheduled_at,
  };
}

async function api(req: IncomingMessage, res: ServerResponse, url: URL, path: string) {
  const bearer = (req.headers.authorization ?? '').match(/^Bearer\s+(\S+)/i)?.[1];
  if (!bearer)
    throw new ApiError(401, 'missing_api_key', 'Missing API key in the authorization header. Include the following header Authorization: Bearer YOUR_API_KEY in the request.');
  if (API_KEY && !sameSecret(bearer, API_KEY)) throw new ApiError(403, 'invalid_api_key', 'API key is invalid');

  const notAllowed = () => new ApiError(405, 'method_not_allowed', 'Method is not allowed for the requested path.');

  if (path === '/emails') {
    if (req.method === 'POST') {
      const { raw } = await readJson(req);
      const email = parseEmail(raw, requestInfo(req, path, raw));
      email.response = { id: email.id };
      accept(email);
      return json(res, 200, email.response);
    }
    if (req.method === 'GET') {
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 20) || 20, 1), 100);
      const after = url.searchParams.get('after');
      const start = after ? emails.findIndex((email) => email.id === after) + 1 : 0;
      const page = emails.slice(start, start + limit);
      return json(res, 200, { object: 'list', has_more: start + limit < emails.length, data: page.map(summary) });
    }
    throw notAllowed();
  }

  if (path === '/emails/batch') {
    if (req.method !== 'POST') throw notAllowed();
    const { raw } = await readJson(req);
    if (!Array.isArray(raw)) throw new ApiError(422, 'validation_error', 'The request body must be an array of emails.');
    if (raw.length > 100) throw new ApiError(422, 'validation_error', 'Too many emails in the batch. The maximum is 100.');
    // Modo estrito (padrão do Resend): um inválido recusa o lote inteiro.
    const batch = raw.map((item, index) => {
      try {
        return parseEmail(item, requestInfo(req, path, item));
      } catch (error) {
        if (error instanceof ApiError) error.message = `emails[${index}]: ${error.message}`;
        throw error;
      }
    });
    for (const email of batch) {
      email.response = { id: email.id };
      accept(email);
    }
    return json(res, 200, { data: batch.map((email) => ({ id: email.id })) });
  }

  const match = path.match(/^\/emails\/([^/]+)$/);
  if (match) {
    if (req.method !== 'GET') throw notAllowed();
    const email = emails.find((item) => item.id === match[1]);
    if (!email) throw new ApiError(404, 'not_found', 'Email not found.');
    return json(res, 200, summary(email));
  }

  throw new ApiError(404, 'not_found', 'The requested endpoint does not exist.');
}

// ---------------------------------------------------------------------------------------------
// Painel
// ---------------------------------------------------------------------------------------------

function esc(value: unknown) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function when(iso: string) {
  return new Date(iso).toLocaleString('pt-BR', { timeZone: TIME_ZONE, dateStyle: 'short', timeStyle: 'medium' });
}

function snippet(email: Email) {
  const source = email.text ?? (email.html ?? '')
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  return source.replace(/\s+/g, ' ').trim().slice(0, 140);
}

function badge(status: string) {
  const tone = { delivered: 'ok', bounced: 'bad', failed: 'bad', scheduled: 'warn' }[status] ?? 'info';
  return `<span class="badge ${tone}">${esc(status)}</span>`;
}

const CSS = `
:root{--bg:#0a0a0a;--panel:#111;--line:#232323;--text:#ededed;--muted:#8f8f8f;--accent:#fff;--ok:#3ecf8e;--bad:#ff6b6b;--warn:#f5a524;--info:#7aa2ff;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
@media (prefers-color-scheme:light){:root{--bg:#fafafa;--panel:#fff;--line:#e5e5e5;--text:#111;--muted:#666;--accent:#000}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 Inter,system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:inherit}header{display:flex;align-items:center;gap:24px;padding:0 24px;height:56px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg);z-index:2}
.logo{font-weight:700;letter-spacing:-.02em}.logo small{font-weight:500;color:var(--muted);margin-left:6px}
nav{display:flex;gap:4px}nav a{padding:6px 10px;border-radius:6px;text-decoration:none;color:var(--muted)}nav a.on,nav a:hover{color:var(--text);background:var(--panel)}
.grow{flex:1}.muted{color:var(--muted)}main{padding:24px;max-width:1200px;margin:0 auto}
h1{font-size:22px;margin:0 0 4px;letter-spacing:-.02em}.toolbar{display:flex;gap:8px;align-items:center;margin:16px 0}
input,select,button{font:inherit;color:var(--text);background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:6px 10px}
button{cursor:pointer}button:hover{border-color:var(--muted)}button.danger{color:var(--bad)}
table{width:100%;border-collapse:collapse}th{text-align:left;font-weight:500;color:var(--muted);font-size:12px;padding:8px 12px;border-bottom:1px solid var(--line)}
td{padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:top}tr.row{cursor:pointer}tr.row:hover td{background:var(--panel)}
.badge{display:inline-block;font-size:12px;padding:1px 8px;border-radius:999px;border:1px solid currentColor}
.ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warn)}.info{color:var(--info)}
.empty{padding:64px 0;text-align:center;color:var(--muted)}
dl{display:grid;grid-template-columns:120px 1fr;gap:6px 16px;margin:16px 0}dt{color:var(--muted)}dd{margin:0;word-break:break-all}
.tabs{display:flex;gap:4px;border-bottom:1px solid var(--line);margin-top:24px}.tabs button{border:0;border-bottom:2px solid transparent;border-radius:0;background:none;color:var(--muted);padding:8px 12px}
.tabs button.on{color:var(--text);border-color:var(--accent)}.tab{display:none;padding:16px 0}.tab.on{display:block}
pre{font:12px/1.6 var(--mono);background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:16px;overflow:auto;white-space:pre-wrap;word-break:break-word;margin:0}
iframe.mail{width:100%;height:70vh;border:1px solid var(--line);border-radius:8px;background:#fff;display:block;margin:0 auto;transition:width .2s}
.events li{margin:4px 0}.mono{font-family:var(--mono);font-size:12px}
.inbox{display:grid;grid-template-columns:360px 1fr;height:calc(100vh - 56px)}.inbox aside{border-right:1px solid var(--line);overflow:auto}
.inbox aside .filter{padding:12px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg)}.inbox aside .filter select{width:100%}
.item{display:block;padding:12px 16px;border-bottom:1px solid var(--line);text-decoration:none}.item:hover{background:var(--panel)}.item.on{background:var(--panel);box-shadow:inset 3px 0 var(--accent)}
.item .top{display:flex;justify-content:space-between;gap:8px}.item b{font-weight:600}.item .s{margin-top:2px}.item .p{color:var(--muted);font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.reader{overflow:auto;padding:24px 32px}.reader h2{font-size:22px;font-weight:500;margin:0 0 16px}
.sender{display:flex;gap:12px;align-items:center;margin-bottom:16px}.avatar{width:40px;height:40px;border-radius:50%;display:grid;place-items:center;background:#5b6cff;color:#fff;font-weight:600}
.view{display:flex;gap:4px;margin-left:auto}.view button.on{border-color:var(--accent)}
.attach{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}.attach a{border:1px solid var(--line);border-radius:6px;padding:6px 10px;text-decoration:none}
@media (max-width:800px){.inbox{grid-template-columns:1fr;height:auto}.reader{padding:16px}header{gap:12px;padding:0 16px}main{padding:16px}dl{grid-template-columns:1fr}}
`;

function page(title: string, active: string, body: string, wide = false) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Resend local</title><style>${CSS}</style></head><body>
<header><span class="logo">Resend<small>local</small></span>
<nav><a href="/ui/emails" class="${active === 'emails' ? 'on' : ''}">Emails</a><a href="/ui/inbox" class="${active === 'inbox' ? 'on' : ''}">Caixa de entrada</a><a href="/ui/setup" class="${active === 'setup' ? 'on' : ''}">Como conectar</a></nav>
<span class="grow"></span><span class="muted">${emails.length} e-mail(s) em memória</span></header>
${wide ? body : `<main>${body}</main>`}
<script>
let v=${version};
setInterval(async()=>{try{const r=await fetch('/ui/version');const j=await r.json();if(j.v!==v)location.reload()}catch{}},2000);
document.querySelectorAll('[data-href]').forEach(el=>el.addEventListener('click',()=>location.href=el.dataset.href));
function tab(name){document.querySelectorAll('.tabs button').forEach(b=>b.classList.toggle('on',b.dataset.tab===name));document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('on',t.id==='tab-'+name));history.replaceState(null,'','#'+name)}
document.querySelectorAll('.tabs button').forEach(b=>b.addEventListener('click',()=>tab(b.dataset.tab)));
if(document.querySelector('.tabs'))tab(location.hash.slice(1)||'preview');
document.querySelectorAll('.view button').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('.view button').forEach(x=>x.classList.toggle('on',x===b));document.querySelector('iframe.mail').style.width=b.dataset.w}));
</script></body></html>`;
}

function listPage(url: URL) {
  const q = (url.searchParams.get('q') ?? '').toLowerCase().trim();
  const shown = q
    ? emails.filter((e) => [e.subject, e.from, ...e.to, ...e.cc, ...e.bcc, e.id].some((v) => v.toLowerCase().includes(q)))
    : emails;
  const rows = shown
    .map(
      (e) => `<tr class="row" data-href="/ui/emails/${e.id}"><td>${esc(e.to.join(', '))}</td><td>${badge(e.last_event)}</td>
<td>${esc(e.subject)}<div class="muted">${esc(e.from)}</div></td><td class="muted">${when(e.created_at)}</td></tr>`,
    )
    .join('');
  return page(
    'Emails',
    'emails',
    `<h1>Emails</h1><div class="muted">Tudo o que os sistemas mandaram para o Resend. Nada sai daqui.</div>
<div class="toolbar"><form><input name="q" value="${esc(q)}" placeholder="Buscar por destinatário, assunto ou id" size="40"></form>
<span class="grow"></span><form method="post" action="/ui/clear"><button class="danger">Limpar tudo</button></form></div>
${shown.length ? `<table><thead><tr><th>Para</th><th>Status</th><th>Assunto</th><th>Enviado</th></tr></thead><tbody>${rows}</tbody></table>` : `<div class="empty">Nenhum e-mail ainda. Veja <a href="/ui/setup">Como conectar</a>.</div>`}`,
  );
}

function pretty(value: unknown) {
  // Anexo em base64 vira um resumo, senão o JSON fica ilegível.
  return JSON.stringify(value, (key, v) => (key === 'content' && typeof v === 'string' && v.length > 120 ? `${v.slice(0, 60)}… (${v.length} caracteres)` : v), 2);
}

function attachments(email: Email) {
  if (!email.attachments.length) return '';
  return `<div class="attach">${email.attachments
    .map((a, i) => `<a href="/ui/emails/${email.id}/attachments/${i}" target="_blank">📎 ${esc(a.filename)}${a.path ? ' (link)' : ''}</a>`)
    .join('')}</div>`;
}

function detailPage(email: Email) {
  const field = (label: string, value: string[] | string | null) =>
    value && value.length ? `<dt>${label}</dt><dd>${esc(Array.isArray(value) ? value.join(', ') : value)}</dd>` : '';
  const events = email.events
    .map((e) => `<li>${badge(e.type.replace('email.', ''))} <span class="muted">${when(e.at)}</span>${e.webhook ? ` <span class="mono muted">webhook: ${esc(e.webhook)}</span>` : ''}</li>`)
    .join('');
  return page(
    email.subject,
    'emails',
    `<a href="/ui/emails" class="muted">← Emails</a>
<h1 style="margin-top:12px">${esc(email.subject)}</h1>${badge(email.last_event)}
<dl>${field('De', email.from)}${field('Para', email.to)}${field('Cc', email.cc)}${field('Cco', email.bcc)}${field('Responder a', email.reply_to)}
${field('Enviado', when(email.created_at))}${field('Agendado', email.scheduled_at)}<dt>ID</dt><dd class="mono">${email.id}</dd>
${field('Tags', email.tags.map((t) => `${t.name}=${t.value}`))}</dl>
<div class="toolbar"><a href="/ui/inbox?to=${encodeURIComponent(addressOf(email.to[0]))}&id=${email.id}"><button>Ver como o destinatário</button></a>
<form method="post" action="/ui/emails/${email.id}/bounce"><button class="danger">Simular bounce</button></form></div>
<div class="tabs"><button data-tab="preview">Preview</button><button data-tab="html">HTML</button><button data-tab="text">Texto</button><button data-tab="request">Requisição</button><button data-tab="events">Eventos</button></div>
<div class="tab" id="tab-preview"><iframe class="mail" sandbox="allow-popups allow-popups-to-escape-sandbox" src="/ui/emails/${email.id}/render"></iframe>${attachments(email)}</div>
<div class="tab" id="tab-html"><pre>${email.html === null ? '<span class="muted">(sem HTML)</span>' : esc(email.html)}</pre></div>
<div class="tab" id="tab-text"><pre>${email.text === null ? '<span class="muted">(sem texto)</span>' : esc(email.text)}</pre></div>
<div class="tab" id="tab-request"><p class="muted">${esc(email.request.method)} ${esc(email.request.path)}</p><pre>${esc(pretty(email.request.headers))}</pre>
<p class="muted">Corpo</p><pre>${esc(pretty(email.request.body))}</pre><p class="muted">Resposta 200</p><pre>${esc(pretty(email.response))}</pre></div>
<div class="tab" id="tab-events"><ul class="events">${events || '<li class="muted">Nenhum evento.</li>'}</ul>
<p class="muted">${WEBHOOK_URL ? `Webhooks indo para ${esc(WEBHOOK_URL)}${WEBHOOK_SECRET ? ' (assinados)' : ' (sem assinatura)'}.` : 'Webhooks desligados (RESEND_LOCAL_WEBHOOK_URL vazio).'}</p></div>`,
  );
}

function inboxPage(url: URL) {
  const all = [...new Set(emails.flatMap((e) => [...e.to, ...e.cc, ...e.bcc].map(addressOf)))].sort();
  const to = url.searchParams.get('to') ?? '';
  const shown = to ? emails.filter((e) => [...e.to, ...e.cc, ...e.bcc].some((r) => addressOf(r) === to)) : emails;
  const open = shown.find((e) => e.id === url.searchParams.get('id')) ?? shown[0];
  const link = (id: string) => `/ui/inbox?${new URLSearchParams({ ...(to ? { to } : {}), id })}`;

  const items = shown
    .map(
      (e) => `<a class="item ${e === open ? 'on' : ''}" href="${link(e.id)}"><div class="top"><b>${esc(displayName(e.from))}</b>
<span class="muted">${new Date(e.created_at).toLocaleTimeString('pt-BR', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit' })}</span></div>
<div class="s">${esc(e.subject)}</div><div class="p">${esc(snippet(e))}</div></a>`,
    )
    .join('');

  const reader = open
    ? `<h2>${esc(open.subject)}</h2>
<div class="sender"><div class="avatar">${esc(displayName(open.from).charAt(0).toUpperCase())}</div>
<div><b>${esc(displayName(open.from))}</b> <span class="muted">&lt;${esc(addressOf(open.from))}&gt;</span>
<div class="muted">para ${esc(open.to.join(', '))}${open.cc.length ? `, cc ${esc(open.cc.join(', '))}` : ''} · ${when(open.created_at)}</div></div>
<div class="view"><button class="on" data-w="100%">Desktop</button><button data-w="390px">Celular</button></div></div>
<iframe class="mail" sandbox="allow-popups allow-popups-to-escape-sandbox" src="/ui/emails/${open.id}/render"></iframe>${attachments(open)}
<p><a class="muted" href="/ui/emails/${open.id}">Ver detalhes técnicos →</a></p>`
    : `<div class="empty">Caixa vazia.</div>`;

  return page(
    'Caixa de entrada',
    'inbox',
    `<div class="inbox"><aside><div class="filter"><select onchange="location.href='/ui/inbox'+(this.value?'?to='+encodeURIComponent(this.value):'')">
<option value="">Todos os destinatários (${emails.length})</option>${all.map((a) => `<option ${a === to ? 'selected' : ''}>${esc(a)}</option>`).join('')}</select></div>
${items || '<div class="empty">Nada aqui.</div>'}</aside><section class="reader">${reader}</section></div>`,
    true,
  );
}

function setupPage(origin: string) {
  return page(
    'Como conectar',
    'setup',
    `<h1>Como conectar</h1><p class="muted">Aponte a URL do Resend para cá. ${API_KEY ? 'Use a chave configurada em <code>RESEND_LOCAL_API_KEY</code>' : 'Qualquer chave <code>re_…</code> serve'}; nada é enviado.</p>
<h3>SDK oficial <code>resend</code> (Node)</h3><p class="muted">O SDK lê <code>RESEND_BASE_URL</code> do ambiente.</p><pre>RESEND_API_KEY=re_local
RESEND_BASE_URL=${esc(origin)}</pre>
<h3>Chamada HTTP direta</h3><pre>POST ${esc(origin)}/emails
Authorization: Bearer re_local</pre>
<h3>SMTP</h3><p class="muted">Receptor SMTP sem TLS e sem senha, na porta ${SMTP_PORT}. Deixe usuário e senha do SMTP vazios no cliente.</p><pre>host: ${esc(PUBLIC_URL ? '<host interno deste serviço>' : 'localhost')}
port: ${SMTP_PORT}
secure: false, sem STARTTLS</pre>
<h3>Webhooks de entrega (opcional)</h3><p class="muted">Suba o resend-local com estas variáveis e use o mesmo segredo no verificador de webhook do seu app.</p>
<pre>RESEND_LOCAL_WEBHOOK_URL=http://localhost:4200/webhooks/resend
RESEND_LOCAL_WEBHOOK_SECRET=whsec_${randomBytes(24).toString('base64')}</pre>
<h3>Rotas da API</h3><pre>POST /emails         envia (guarda e devolve { id })
POST /emails/batch   até 100 de uma vez
GET  /emails         lista ({ object: "list", data })
GET  /emails/:id     um e-mail</pre>`,
  );
}

function renderEmail(res: ServerResponse, email: Email) {
  let html = email.html ?? `<pre style="white-space:pre-wrap;font:14px/1.5 system-ui,sans-serif;margin:16px">${esc(email.text)}</pre>`;
  // Links abrem em outra aba; a <base> vai dentro do <head> para não tirar o HTML do modo padrão.
  const base = '<base target="_blank">';
  if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, (m) => m + base);
  else if (/^\s*<!doctype[^>]*>/i.test(html)) html = html.replace(/^\s*<!doctype[^>]*>/i, (m) => m + base);
  else html = base + html;
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    // Sem script: o HTML vem dos sistemas, e o iframe também roda sem permissão de script.
    'content-security-policy': "default-src 'none'; img-src * data: blob:; style-src 'unsafe-inline' *; font-src * data:",
  });
  res.end(html);
}

async function ui(req: IncomingMessage, res: ServerResponse, url: URL, path: string) {
  const html = (body: string) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body);
  };
  const back = (to: string) => {
    res.writeHead(303, { location: to });
    res.end();
  };
  const find = (id: string) => emails.find((e) => e.id === id);

  if (path === '/ui/version') return json(res, 200, { v: version });
  if (path === '/ui/emails') return html(listPage(url));
  if (path === '/ui/inbox') return html(inboxPage(url));
  if (path === '/ui/setup') return html(setupPage(PUBLIC_URL || `http://localhost:${PORT}`));
  if (path === '/ui/clear' && req.method === 'POST') {
    emails.length = 0;
    version++;
    return back('/ui/emails');
  }

  let m = path.match(/^\/ui\/emails\/([^/]+)(?:\/(render|bounce|attachments\/(\d+)))?$/);
  const email = m ? find(m[1]) : undefined;
  if (m && email) {
    if (!m[2]) return html(detailPage(email));
    if (m[2] === 'render') return renderEmail(res, email);
    if (m[2] === 'bounce' && req.method === 'POST') {
      await emit(email, 'email.bounced', { bounce: { message: 'Simulação local: caixa inexistente.', type: 'Permanent', subType: 'General' } });
      return back(`/ui/emails/${email.id}#events`);
    }
    const attachment = m[3] !== undefined ? email.attachments[Number(m[3])] : undefined;
    if (attachment?.path) return back(attachment.path);
    if (attachment?.content) {
      res.writeHead(200, {
        'content-type': attachment.content_type ?? 'application/octet-stream',
        'content-disposition': `inline; filename="${attachment.filename.replace(/"/g, '')}"`,
      });
      return res.end(Buffer.from(attachment.content, 'base64'));
    }
  }
  res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
  res.end(page('Não encontrado', '', '<div class="empty">Não encontrado (o resend-local perde tudo ao reiniciar). <a href="/ui/emails">Voltar</a></div>'));
}

// ---------------------------------------------------------------------------------------------
// Servidor
// ---------------------------------------------------------------------------------------------

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (path === '/health') return json(res, 200, { ok: true });
  if (UI_PASSWORD && (path === '/' || path.startsWith('/ui'))) {
    const basic = (req.headers.authorization ?? '').match(/^Basic\s+(\S+)/i)?.[1];
    const password = basic ? Buffer.from(basic, 'base64').toString('utf8').split(':').slice(1).join(':') : '';
    if (!sameSecret(password, UI_PASSWORD)) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="resend-local", charset="UTF-8"' });
      return void res.end('Senha necessária.');
    }
  }
  const work = path === '/'
    ? Promise.resolve(void (res.writeHead(302, { location: '/ui/emails' }), res.end()))
    : path.startsWith('/ui') ? ui(req, res, url, path) : api(req, res, url, path);
  work.catch((error) => {
    if (res.headersSent) return res.end();
    if (error instanceof ApiError) return apiError(res, error);
    console.error('[resend-local]', error);
    apiError(res, new ApiError(500, 'internal_server_error', 'An unexpected error occurred.'));
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[resend-local] API em http://localhost:${PORT}  ·  painel em http://localhost:${PORT}/ui/emails`);
  console.log(`[resend-local] webhooks: ${WEBHOOK_URL ? `${WEBHOOK_URL}${WEBHOOK_SECRET ? ' (assinados)' : ' (sem assinatura)'}` : 'desligados'}`);
});

// ---------------------------------------------------------------------------------------------
// SMTP (para quem envia por SMTP em vez da API do Resend)
// ---------------------------------------------------------------------------------------------
//
// Sem TLS e sem autenticação: é só local. Aceita qualquer remetente e destinatário, junta a
// mensagem MIME e guarda no mesmo lugar dos e-mails da API, para aparecer no painel e na caixa
// de entrada.

const SMTP_PORT = Number(process.env.SMTP_PORT ?? 2525);
const MAX_SMTP_BYTES = MAX_BODY_BYTES;

type MimePart = { headers: Record<string, string>; body: string };

function splitMime(raw: string): MimePart {
  const at = raw.search(/\r?\n\r?\n/);
  const head = at < 0 ? raw : raw.slice(0, at);
  const body = at < 0 ? '' : raw.slice(at).replace(/^\r?\n\r?\n/, '');
  const headers: Record<string, string> = {};
  // Cabeçalho dobrado (linha seguinte começando com espaço) continua o anterior.
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { headers, body };
}

/** `=?UTF-8?B?...?=` e `=?UTF-8?Q?...?=` (RFC 2047) para texto legível. */
function decodeWords(value: string) {
  return value.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, _charset: string, kind: string, text: string) =>
    kind.toUpperCase() === 'B'
      ? Buffer.from(text, 'base64').toString('utf8')
      : Buffer.from(text.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16))), 'latin1').toString('utf8'),
  );
}

function decodeBody(part: MimePart): Buffer {
  const encoding = (part.headers['content-transfer-encoding'] ?? '').toLowerCase();
  if (encoding === 'base64') return Buffer.from(part.body.replace(/\s+/g, ''), 'base64');
  if (encoding === 'quoted-printable')
    return Buffer.from(
      part.body.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16))),
      'latin1',
    );
  return Buffer.from(part.body, 'utf8');
}

function param(header: string | undefined, name: string) {
  return header?.match(new RegExp(`${name}="?([^";]+)"?`, 'i'))?.[1] ?? null;
}

/** Percorre o MIME e separa texto, HTML e anexos. */
function walk(part: MimePart, out: { html: string | null; text: string | null; attachments: Attachment[] }) {
  const type = (part.headers['content-type'] ?? 'text/plain').toLowerCase();
  const boundary = param(part.headers['content-type'], 'boundary');
  if (type.startsWith('multipart/') && boundary) {
    const sections = part.body.split(`--${boundary}`).slice(1);
    for (const section of sections) {
      if (section.startsWith('--')) break;
      walk(splitMime(section.replace(/^\r?\n/, '')), out);
    }
    return;
  }
  const disposition = part.headers['content-disposition'] ?? '';
  const filename = param(disposition, 'filename') ?? param(part.headers['content-type'], 'name');
  if (/attachment/i.test(disposition) || filename) {
    out.attachments.push({
      filename: filename ? decodeWords(filename) : `anexo-${out.attachments.length + 1}`,
      content_type: type.split(';')[0],
      content: decodeBody(part).toString('base64'),
      path: null,
    });
  } else if (type.startsWith('text/html')) out.html = decodeBody(part).toString('utf8');
  else if (type.startsWith('text/plain')) out.text = decodeBody(part).toString('utf8');
}

function fromSmtp(raw: string, envelopeFrom: string, envelopeTo: string[]): Email {
  const message = splitMime(raw);
  const out = { html: null as string | null, text: null as string | null, attachments: [] as Attachment[] };
  walk(message, out);
  const list = (value?: string) =>
    value ? decodeWords(value).split(',').map((item) => item.trim()).filter(Boolean) : [];
  const to = list(message.headers.to);
  return {
    id: randomUUID(),
    created_at: new Date().toISOString(),
    from: decodeWords(message.headers.from ?? envelopeFrom),
    to: to.length ? to : envelopeTo,
    cc: list(message.headers.cc),
    // Quem estava no envelope e não aparece em To/Cc recebeu como cópia oculta.
    bcc: envelopeTo.filter((address) => ![...to, ...list(message.headers.cc)].some((item) => addressOf(item) === address)),
    reply_to: list(message.headers['reply-to']),
    subject: decodeWords(message.headers.subject ?? '(sem assunto)'),
    html: out.html,
    text: out.text,
    headers: message.headers,
    tags: [{ name: 'via', value: 'smtp' }],
    attachments: out.attachments,
    scheduled_at: null,
    last_event: 'queued',
    events: [],
    request: { method: 'SMTP', path: `smtp://localhost:${SMTP_PORT}`, headers: {}, body: { mailFrom: envelopeFrom, rcptTo: envelopeTo } },
    response: null,
  };
}

const smtp = createNetServer((socket) => {
  let buffer = '';
  let inData = false;
  let mailFrom = '';
  let rcptTo: string[] = [];
  const reply = (line: string) => socket.write(`${line}\r\n`);
  const reset = () => {
    mailFrom = '';
    rcptTo = [];
  };

  reply('220 resend-local ESMTP pronto');
  socket.setEncoding('latin1');
  socket.on('error', () => socket.destroy());
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    if (buffer.length > MAX_SMTP_BYTES) {
      reply('552 mensagem grande demais');
      return socket.end();
    }
    for (;;) {
      if (inData) {
        const end = buffer.indexOf('\r\n.\r\n');
        if (end < 0) return;
        // Volta a "transparência" do SMTP: linha que começa com "." veio com um ponto a mais.
        const raw = Buffer.from(buffer.slice(0, end).replace(/\r\n\.\./g, '\r\n.'), 'latin1').toString('utf8');
        buffer = buffer.slice(end + 5);
        inData = false;
        try {
          const email = fromSmtp(raw, mailFrom, rcptTo);
          accept(email);
          reply(`250 OK id=${email.id}`);
        } catch (error) {
          console.error('[resend-local] SMTP', error);
          reply('554 não foi possível ler a mensagem');
        }
        reset();
        continue;
      }
      const lineEnd = buffer.indexOf('\r\n');
      if (lineEnd < 0) return;
      const line = buffer.slice(0, lineEnd);
      buffer = buffer.slice(lineEnd + 2);
      const command = line.slice(0, 4).toUpperCase();
      if (command === 'EHLO') {
        reply('250-resend-local');
        reply('250-8BITMIME');
        reply('250 SIZE 41943040');
      } else if (command === 'HELO') reply('250 resend-local');
      else if (command === 'MAIL') {
        mailFrom = line.match(/<([^>]*)>/)?.[1] ?? '';
        reply('250 OK');
      } else if (command === 'RCPT') {
        const address = line.match(/<([^>]*)>/)?.[1];
        if (address) rcptTo.push(address);
        reply('250 OK');
      } else if (command === 'DATA') {
        if (!rcptTo.length) reply('554 sem destinatário');
        else {
          inData = true;
          reply('354 termine com <CRLF>.<CRLF>');
        }
      } else if (command === 'RSET') {
        reset();
        reply('250 OK');
      } else if (command === 'NOOP') reply('250 OK');
      else if (command === 'QUIT') {
        reply('221 até logo');
        socket.end();
        return;
      } else reply('502 comando não suportado');
    }
  });
});

smtp.on('error', (error) => console.error(`[resend-local] SMTP na porta ${SMTP_PORT} indisponível:`, error.message));
smtp.listen(SMTP_PORT, HOST, () => console.log(`[resend-local] SMTP em localhost:${SMTP_PORT} (sem TLS, sem autenticação)`));
