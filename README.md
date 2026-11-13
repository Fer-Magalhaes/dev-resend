# dev-resend

Resend falso para desenvolvimento e testes. Responde como `https://api.resend.com`, **não envia nada**
e mostra o que seria enviado.

- **Painel:** `/ui/emails`, a lista no estilo do Resend. O detalhe de cada e-mail tem Preview, HTML,
  Texto, Requisição e Eventos.
- **Caixa de entrada:** `/ui/inbox`, o e-mail como o destinatário vê, com filtro por destinatário e
  visão desktop/celular.
- **Receptor SMTP** na porta `2525`, para quem envia por SMTP em vez da API. Os e-mails aparecem no
  mesmo painel com a tag `via: smtp`.
- **Sem banco e zero dependências.** Roda com `node server.ts` (Node >= 22.18). Guarda até 1000 e-mails
  em memória ou, se `RESEND_LOCAL_DATA_FILE` estiver definido, num arquivo JSON.

## Rodar

```bash
npm start            # API e painel em http://localhost:3100, SMTP em localhost:2525
```

## Variáveis

| Variável | Padrão | Para quê |
|---|---|---|
| `PORT` | `3100` | Porta HTTP (API + painel) |
| `SMTP_PORT` | `2525` | Porta do receptor SMTP (sem TLS, sem senha) |
| `RESEND_LOCAL_API_KEY` | vazio | Se definida, só essa chave é aceita na API (403 nas outras). Vazia: qualquer `Bearer` |
| `RESEND_LOCAL_UI_PASSWORD` | vazio | Se definida, o painel pede Basic auth (qualquer usuário, esta senha) |
| `RESEND_LOCAL_DATA_FILE` | vazio | Caminho de um JSON onde os e-mails são gravados (sobrevivem a restart/sleep) |
| `RESEND_LOCAL_PUBLIC_URL` | vazio | URL pública, usada só nos exemplos da página `/ui/setup` |
| `RESEND_LOCAL_WEBHOOK_URL` | vazio | Para onde mandar `email.sent`, `email.delivered` e `email.bounced` |
| `RESEND_LOCAL_WEBHOOK_SECRET` | vazio | Segredo `whsec_…` para assinar os webhooks no padrão Svix |

Fora da sua máquina, defina sempre `RESEND_LOCAL_API_KEY` e `RESEND_LOCAL_UI_PASSWORD`: o painel mostra
o conteúdo dos e-mails, inclusive links e códigos.

## Apontar um app para cá

- **SDK oficial `resend` (Node):** `RESEND_API_KEY=<chave>` e `RESEND_BASE_URL=http://localhost:3100`.
- **HTTP direto:** troque `https://api.resend.com` pela URL do serviço.
- **SMTP:** host do serviço, porta `2525`, sem TLS e **sem usuário/senha**.

## API imitada

`POST /emails`, `POST /emails/batch` (até 100, modo estrito), `GET /emails`, `GET /emails/:id`.
O formato de resposta e de erro é o do Resend: `{ statusCode, name, message }` (401 `missing_api_key`,
403 `invalid_api_key`, 422 `validation_error`, 404 `not_found`). `GET /health` responde `{ ok: true }`.

## Deploy (Docker / Railway)

O `Dockerfile` usa `node:24-alpine` e não instala nada. No Railway:

1. Crie o serviço a partir deste repositório.
2. Defina `RESEND_LOCAL_API_KEY`, `RESEND_LOCAL_UI_PASSWORD` e, com um volume montado em `/data`,
   `RESEND_LOCAL_DATA_FILE=/data/emails.json`.
3. Gere um domínio para o painel e a API. O SMTP fica só na rede privada (`<serviço>.railway.internal:2525`).
4. Ative o **Serverless** (App Sleeping) para o serviço dormir quando ninguém usa.
