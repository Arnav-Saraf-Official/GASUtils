# GASMail

A Google Apps Script email platform bound to a Google Sheet. Compose, template, and mass-send emails through a built-in web app UI — or drive everything programmatically via a POST API designed for AI agents and automation libraries.

## Features

- **Single emails** — plain text or HTML, sent from your Google account
- **Templates** — reusable subject/body templates stored in the bound spreadsheet, with safe `{{field}}` merge tokens (supports defaults: `{{name:Fallback}}`)
- **Mass sends** — to inline recipient arrays or saved contact lists; small batches send immediately, large ones queue as resumable campaigns drained by time-driven triggers
- **Contacts & lists** — flexible-schema contacts stored in the sheet (custom columns are created automatically)
- **Send log** — every send is recorded (to, template, status, error) for auditing
- **Web UI + POST API** — both surfaces call the exact same handlers

## Architecture

```
Web App UI (HtmlService) ──┐
                           ├──> doGet/doPost ──> Router ──> Handlers ──> Mail / Store (bound Sheet)
POST API (agents) ─────────┘
```

| File | Responsibility |
|---|---|
| `Code.js` | `doGet` (web app), `doPost` (JSON RPC), `webCall` (UI bridge) |
| `Router.js` | Action registry, dispatch, response envelope |
| `Auth.js` | SHA-256-hashed API key in Script Properties |
| `Mail.js` | send / sendTemplated / sendMass / quota |
| `Merge.js` | `{{field}}` rendering (no code evaluation — safe for untrusted content) |
| `Templates.js` | Template CRUD, 48K char body cap validation |
| `Contacts.js`, `Lists` | Contacts, lists, import, membership |
| `Scheduler.js` | Campaign persistence + trigger-based chunked draining |
| `Store.js` | Sheet data layer (locking, dynamic columns, batched writes) |
| `Log.js` | Send log |

Storage sheets: `templates`, `contacts`, `lists`, `send_log`, `campaigns`, `campaign_recipients`, hidden `_config`.

## Setup

1. `clasp push` from `appsScript/` (script ID already in `.clasp.json`), or paste the files into the Apps Script editor.
2. Deploy **Manage deployments → New deployment → Web app**: *Execute as: Me*, *Who has access: Anyone*.
3. Open the web app once — sheets are auto-created.
4. Run `gasmailSetup()` in the editor. It prints your API key **once** (only its hash is stored).

Quota notes: consumer Gmail ≈ 100 recipients/day, Workspace ≈ 1,500/day. Campaigns check remaining quota before every chunk and pause/resume automatically.

## Web UI

- **Compose** — manual or template-based single email, plain/HTML toggle, live preview, per-template variable inputs
- **Mass Send** — saved list or pasted emails; shows estimated mode (immediate vs queued campaign)
- **Templates** — card grid editor with character counters (48K cap)
- **Contacts** — table with search, import (`email | Name | list1,list2` per line), list manager
- **Campaigns & Log** — campaign progress, cancel, retry failed recipients, recent sends
- **Settings / API** — endpoint URL, curl samples, key rotation

## POST API

All requests: `POST <web-app-url>` with JSON body `{ "action": "...", "key": "API_KEY", "params": {...} }`.
Response envelope is always `{ "ok": true, "data": ... }` or `{ "ok": false, "error": { "message", "code" } }`.

Use `-L` with curl (Apps Script redirects), and prefer `Content-Type: text/plain` if calling from browsers to avoid CORS preflights (server-side clients like Node fetch work as-is).

### Actions

| Action | Params |
|---|---|
| `ping` | — (no key required) |
| `mail.send` | `to`, `subject`, required; `body` or `htmlBody`; optional `cc`, `bcc`, `vars`, `options` (`name`, `replyTo`, `attachments[]`) |
| `mail.sendTemplated` | `templateId`, `to`, optional `cc`, `bcc`, `vars` |
| `mail.sendMass` | audience: `recipients[]` (`{email, name, vars}` or strings) or `listName`/`listId`; content: `templateId` or `subject`+`htmlBody`/`body`; optional `name`, `defaultVars`. Sends ≤25 immediately, otherwise queues a campaign |
| `mail.previewCampaign` | same content params; returns rendered sample |
| `mail.quota` | — → `{remainingDailyQuota}` |
| `template.list` / `get` / `create` / `update` / `delete` / `preview` | standard CRUD (`templateId`, fields); bodies capped at 48K chars |
| `contact.list` / `get` / `find` / `create` / `update` / `delete` / `import` | CRUD + bulk `import {rows[], listName?}` |
| `list.list` / `create` / `delete` / `contacts` / `addContacts` / `removeContacts` | list management |
| `campaign.list` / `get` / `recipients` / `cancel` / `retryFailed` | monitor/control campaigns |
| `scheduler.status` | drain trigger state |
| `log.get` | `limit`, `status`, `campaignId`, `to` filters |
| `admin.keyInfo` / `admin.rotateApiKey` | key metadata / rotation |

### Examples

```bash
# Simple email
curl -L -X POST "$URL" -d '{"action":"mail.send","key":"$KEY","params":{"to":"a@b.com","subject":"Hi","body":"Hello"}}'

# Templated send with vars
curl -L -X POST "$URL" -d '{"action":"mail.sendTemplated","key":"$KEY","params":{"templateId":"t_abc123","to":"a@b.com","vars":{"firstName":"Jane"}}}'

# Mass send from a saved list (queues a campaign)
curl -L -X POST "$URL" -d '{"action":"mail.sendMass","key":"$KEY","params":{"templateId":"t_abc123","listName":"newsletter"}}'

# Ad-hoc mass send with per-recipient vars
curl -L -X POST "$URL" -d '{"action":"mail.sendMass","key":"$KEY","params":{"subject":"Hello {{name}}","body":"Hi {{name}}","recipients":[{"email":"a@b.com","name":"A"},{"email":"c@d.com","name":"C"}]}}'
```

### Agent library sketch

```javascript
class GasMail {
  constructor(url, key) { this.url = url; this.key = key; }
  async call(action, params = {}) {
    const res = await fetch(this.url, {
      method: 'POST',
      body: JSON.stringify({ action, key: this.key, params }),
    });
    const json = await res.json();
    if (!json.ok) throw new Error(`${json.error.code}: ${json.error.message}`);
    return json.data;
  }
}

const mail = new GasMail(URL, KEY);
await mail.call('mail.sendMass', { templateId: 't_abc', listName: 'newsletter' });
```
