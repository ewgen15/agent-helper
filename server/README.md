# Figma selection server (Variant B)

Локальний сервер без залежностей. Він робить дві речі в одному процесі:

- **HTTP** на `127.0.0.1:${PORT}` (за замовчуванням `3846`): плагін Figma надсилає поточне виділення на `POST /selection`. Сервер зберігає лише останнє виділення в пам'яті.
- **MCP через stdio** (JSON-RPC по рядках): інструмент `get_figma_selection` повертає останнє виділення. Сервер живе, доки живе MCP-процес.

## Запуск

```bash
cd server
FIGMA_SELECTION_TOKEN=my-secret PORT=3846 node index.js
```

Якщо `FIGMA_SELECTION_TOKEN` не задано, сервер згенерує випадковий токен і виведе його в stderr.

## HTTP

`POST /selection`, заголовок `x-token` має дорівнювати `FIGMA_SELECTION_TOKEN`, тіло JSON до 100 KB. Тіло: `{"fileKey": string | null, "nodes": [{"id", "name", "type"}]}`, де `fileKey` можна не передавати (еквівалентно `null`):

```bash
curl -X POST http://localhost:3846/selection \
  -H "x-token: my-secret" -H "Content-Type: application/json" \
  -d '{"fileKey":"abc","nodes":[{"id":"1:2","name":"Button","type":"FRAME"}]}'
```

- `401`: відсутній або невірний `x-token`.
- `403`: `Origin` не дозволено. Дозволені: відсутній, `null`, `https://www.figma.com`.
- `400`: некоректний JSON або структура. `fileKey` має бути непорожнім рядком, `null` або бути відсутнім; будь-який інший тип (число, об'єкт) або порожній рядок дає `400`.
- `fileKey: null` (або відсутній) допустимий: плагін надсилає його, коли `figma.fileKey` недоступний. Тоді виділення зберігається без ключа файлу, а MCP-відповідь виводиться так само.
- `413`: тіло більше 100 KB.

`GET /health` для перевірки сервера (плагін опитує його кожні кілька секунд):

- Завжди `200` з тілом `{"ok":true,"authorized":<bool>}`. `authorized` дорівнює `true` лише якщо `x-token` збігається з токеном. Без токена або з невірним повертається `authorized:false`, без `401`.
- Тіло ніколи не містить токена чи збереженого виділення. Логів цей маршрут не пише.
- Ті самі правила `Origin` і CORS, що й для `/selection`. Preflight `OPTIONS` дає `204`. Інші методи дають `405`.

```bash
curl -s http://localhost:3846/health -H "x-token: my-secret"
# {"ok":true,"authorized":true}
```

## MCP

Інструмент: `get_figma_selection`. Відповідь має вигляд `Figma nodes:` і рядки `1:2 "Button" (FRAME)`, або `Немає виділення`.

Приклад конфігурації MCP-клієнта:

```json
{
  "mcpServers": {
    "figma-selection": {
      "command": "node",
      "args": ["/абсолютний/шлях/server/index.js"],
      "env": { "FIGMA_SELECTION_TOKEN": "my-secret" }
    }
  }
}
```

Логи йдуть лише в stderr, бо stdout зайнятий протоколом MCP.

## Маніфест плагіна

Щоб плагін міг звертатися до localhost, у `manifest.json` потрібно додати `devAllowedDomains` з адресою сервера (порт має збігатися з `PORT`):

```json
"devAllowedDomains": ["http://localhost:3846"]
```

Маніфест у цьому кроці не змінювався.
