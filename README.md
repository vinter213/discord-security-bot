# AoS Security v2

Discord security bot prepared for Render.

## Уже есть

- Красивая верификация
- Автоматическая роль Unverified
- Verified после проверки
- Проверка возраста аккаунта
- Автоматическое уведомление в verification-канале
- Поддержка локальной картинки `assets/verification-banner.png`
- Anti-Spam
- Anti-Raid
- Anti-Nuke:
  - массовое удаление каналов
  - массовое удаление ролей
  - массовые баны
  - массовые webhook-изменения
- Автоматическое снятие доступных ролей с нарушителя
- `/lockdown`
- `/panic`
- `/security-status`
- Логи безопасности
- Render `/health`

## Discord Developer Portal

Bot -> Privileged Gateway Intents:

- Server Members Intent: ON
- Message Content Intent: ON

## Роли

Роль AoS Security должна быть выше:

1. AoS Security
2. Verified
3. Unverified
4. другие защищаемые роли

Чтобы Anti-Nuke мог снимать опасные роли, роль AoS Security должна находиться выше этих ролей.

## Environment Variables

Обязательные:

- DISCORD_TOKEN
- CLIENT_ID
- GUILD_ID
- VERIFIED_ROLE_ID
- UNVERIFIED_ROLE_ID

Канал верификации уже установлен по умолчанию:

- VERIFICATION_CHANNEL_ID=1546265698412794037

Рекомендуется добавить:

- SECURITY_LOG_CHANNEL_ID
- WHITELIST_USER_IDS

`WHITELIST_USER_IDS`:

```text
111111111111111111,222222222222222222
```

Владелец сервера автоматически считается доверенным.

## Картинка верификации

Положить файл:

```text
assets/verification-banner.png
```

После следующего запуска AoS Security автоматически начнёт показывать его в панели и уведомлениях.

## Обновление GitHub

```powershell
git add .
git commit -m "AoS Security v2"
git push
```
