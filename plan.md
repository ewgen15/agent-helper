# Figma plugin: Copy Node ID → Claude

## Мета
Швидко клікнути на елемент у Figma і одразу отримати його Node ID (без копіювання посилання), в ідеалі — відправити його в Claude.

## Стек
- Figma Plugin API (TypeScript)
- Файли: `manifest.json`, `code.ts`, `ui.html`
- Опційно: локальний HTTP/MCP-сервер на домашньому сервері

## Етапи

### 1. Каркас плагіна
- Figma Desktop → Plugins → Development → New plugin… → шаблон «Empty / Run once» (з UI)
- Назва: `Copy Node ID`
- Налаштувати TypeScript-збірку (`npm install`, `tsc` watch)

### 2. Отримання ID
- У `code.ts` підписатись на `figma.on('selectionchange', ...)`
- Брати `figma.currentPage.selection` → `id`, `name`, `type`
- Для кількох виділених елементів повертати список
- Передавати дані в UI через `figma.ui.postMessage`

### 3. Копіювання в буфер
- UI (`ui.html`) показує ID, назву, тип
- Кнопка «Copy» + опція автокопіювання при виборі елемента
- Використати `navigator.clipboard` або fallback `document.execCommand('copy')` (в iframe плагіна)
- Формат копіювання: лише `id`, або `id + name`, або посилання з `?node-id=` (через перемикач)

### 4. Відправка в Claude
- **Варіант A (простий):** копіювати у зручному форматі й вставляти в чат / Claude Code
- **Варіант B (просунутий):**
  - Плагін робить `fetch` POST на локальний сервер (`http://localhost:PORT/selection`)
  - Сервер зберігає останній вибраний елемент
  - MCP-сервер віддає Claude інструмент `get_figma_selection`
  - У `manifest.json` додати `networkAccess.allowedDomains` для localhost
- Claude отримує ID → через Figma MCP/REST API бере дані ноди

### 5. Полірування
- Гарячі клавіші / швидкий запуск плагіна
- Індикація «Copied!»
- Підтримка кількох елементів
- Обробка порожнього виділення

## Перший крок
Створити плагін через меню Figma та підготувати проєкт із TypeScript. Далі — Етап 2 (`selectionchange`).

## Нотатки
- Починаємо з Варіанта A, Варіант B — після того, як базовий плагін працює.
- Node ID у посиланні має формат `1-2`, а в API — `1:2`. Врахувати при копіюванні.

## План рішення

1. Каркас: manifest.json (editorType figma, ui, networkAccess none), code.ts, ui.html, збірка tsc.
   - Готово, коли: плагін запускається у Figma Desktop без помилок.
   - [ ] Крок 1 виконано

2. Selection у code.ts: selectionchange + запуск при старті; мапінг {id,name,type}; порожнє виділення → [], кілька → масив.
   - Готово, коли: UI показує 0, 1 і N елементів.
   - [ ] Крок 2 виконано

3. UI і формати: кнопка Copy, перемикач автокопіювання, формати id; id+name; посилання https://www.figma.com/design/{fileKey}/?node-id=1-2 (':'→'-'); без fileKey лише id.
   - Готово, коли: формати збігаються з посиланням Figma.
   - [ ] Крок 3 виконано

4. Копіювання: navigator.clipboard.writeText, fallback — прихована textarea + execCommand('copy'); статус Скопійовано/Помилка; автокопіювання лише після першого жесту.
   - Готово, коли: працює в Desktop і в браузері.
   - [ ] Крок 4 виконано

5. Формат для Claude: текст `Figma nodes: 1:2 "Button" (FRAME)` по рядку на вузол + режим JSON.
   - Готово, коли: get_design_context приймає id без правок.
   - [ ] Крок 5 виконано

6. Варіант B: MCP-сервер на 127.0.0.1:3846+ (3845 займає Figma Dev Mode MCP) (порт налаштовується), POST /selection, токен у заголовку, перевірка Origin, CORS лише null/figma, виділення в пам'яті, життя сервера = життя MCP-процесу, devAllowedDomains localhost у manifest, інструмент get_figma_selection.
   - Готово, коли: Claude отримує виділення за 1 с, запит без токена → 401.
   - [ ] Крок 6 виконано

> Примітка: етап 1 ставить networkAccess none, а етап 6 вимагає доступ до localhost — змінити manifest перед варіантом B.
