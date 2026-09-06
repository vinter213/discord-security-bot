# Discord Security Bot — Render starter

Стартовый Security Bot с базовой верификацией и HTTP health endpoint для Render.

## Уже работает

- Discord.js v14
- Render Web Service
- `/health`
- автоматическая роль `Unverified` при входе
- `/verification-setup`
- кнопка верификации
- проверка возраста аккаунта (минимум 24 часа)
- выдача `Verified`
- снятие `Unverified`
- `/security-status`
- корректная обработка SIGTERM

## 1. Создай роли Discord

Создай две роли:

- `Verified`
- `Unverified`

Роль бота должна находиться ВЫШЕ этих ролей.

У `@everyone` желательно убрать доступ к основным каналам.
Для `Unverified` оставь доступ только к каналу верификации/правил.
Для `Verified` открой основные каналы.

## 2. Discord Developer Portal

В Bot -> Privileged Gateway Intents включи:

- Server Members Intent
- Message Content Intent

Для будущего расширения Anti-Raid/Anti-Spam этого будет достаточно вместе с intents в коде.

## 3. Environment Variables

Не загружай `.env` в GitHub.

На Render добавь:

- `DISCORD_TOKEN`
- `CLIENT_ID`
- `GUILD_ID`
- `VERIFIED_ROLE_ID`
- `UNVERIFIED_ROLE_ID`

## 4. Локальный запуск

```powershell
Copy-Item .env.example .env
npm install
npm start
```

Заполни `.env` перед запуском.

## 5. Render

Создай Web Service из GitHub-репозитория.

Build Command:

```text
npm install
```

Start Command:

```text
npm start
```

Health Check Path:

```text
/health
```

Render должен использовать `PORT`, который приложение уже читает автоматически.

## Следующие модули

- Anti-Raid
- Anti-Nuke
- Anti-Spam
- Anti-Bot
- Anti-Webhook
- Anti-Permissions
- Lockdown / Panic
- Whitelist
- Security Logs
- Backup / Restore
- Watchdog
- расширенная CAPTCHA / quarantine
