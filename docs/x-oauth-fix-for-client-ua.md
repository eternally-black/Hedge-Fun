# Виправлення входу через X (Twitter) — інструкція для власника X-застосунку

## Симптом
При спробі увійти через X користувач бачить «Something went wrong / You weren't
able to give access to the App», а X повертає помилку **400** на запит авторизації.

## Причина
client_id у запиті правильний (застосунок існує), отже проблема — у **налаштуваннях
User Authentication** самого X-застосунку. У 95% випадків це **Callback URI**, який
не збігається з тим, що надсилає Privy.

## Що зробити (developer.x.com)

1. Зайти на **developer.x.com** → Projects & Apps → ваш застосунок.

2. Відкрити **User authentication settings** → **Edit** (або **Set up**, якщо ще не
   налаштовано).

3. **App permissions:** має бути щонайменше **Read** (для входу достатньо).

4. **Type of App:** обрати **Web App, Automated App or Bot**
   (це *confidential client* — саме він потрібен Privy; НЕ Native / SPA).

5. **Callback URI / Redirect URL** — вписати **точно** оце, без пробілів і без слеша
   в кінці:
   ```
   https://auth.privy.io/api/v1/oauth/callback
   ```
   ⚠️ Це найважливіше. Якщо там зараз вписано щось інше (наприклад наш домен
   app.hedgeyour.fun) — це і є причина 400. Має бути саме адреса Privy, бо X
   повертає користувача спочатку на сервер Privy, а вже Privy — у застосунок.

6. **Website URL** — будь-який валідний, напр. `https://app.hedgeyour.fun`.

7. **Зберегти.** Після збереження переконатися, що внизу показані
   **OAuth 2.0 Client ID and Client Secret** — це підтверджує, що OAuth 2.0 увімкнено.

## Перевірка
Після збереження — зачекати ~1 хв і спробувати вхід через X на app.hedgeyour.fun
ще раз. Помилка 400 має зникнути.

## Важливо: OAuth 2.0, а не 1.0a
Privy працює виключно через **OAuth 2.0**. Якщо застосунок налаштований лише під
старий **OAuth 1.0a** (ключі Consumer Key / Access Token, без блоку «OAuth 2.0
Client ID and Client Secret») — вхід через Privy дасть 400. У «User authentication
settings» має бути активований саме **OAuth 2.0** (після збереження кроку 5 внизу
з'являються OAuth 2.0 Client ID + Secret). Ці 2.0-креди (Client ID + Secret) мають
бути вставлені у Privy dashboard → Login methods → Twitter/X.

## Якщо все одно 400
Тоді надішліть нам скріншот сторінки **User authentication settings** (видно
Callback URI + Type of App + що активовано OAuth 2.0) — звіримо символ-у-символ.
Можлива також причина: scopes `users.read` / `tweet.read` вимкнені, або застосунок
прив'язаний до проєкту, де OAuth 2.0 недоступний.
