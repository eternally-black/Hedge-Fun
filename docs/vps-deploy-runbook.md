# HedgeFun — VPS deploy runbook

Пошагово для прод-деплоя через Docker Compose. Репо-часть уже сделана и запушена в `main`.
Всё ниже выполняется **тобой** на VPS / в GitHub UI (у ассистента нет SSH наружу).

Плейсхолдеры: `ДОМЕН`, `IP_VPS`, `СИЛЬНЫЙ_ПАРОЛЬ`, `РОТИРОВАННЫЙ_СЕКРЕТ`.

---

## 0. GitHub: финализировать ветку
В GitHub → **Settings → Branches → Default branch** → сменить на `main`.
Затем локально удалить старую:
```bash
git push origin --delete master
```

## 1. DNS (до всего)
A-запись `ДОМЕН` → `IP_VPS`. Проверить: `dig +short ДОМЕН` отдаёт IP VPS.
Без этого Caddy не выпустит TLS-сертификат.

## 2. Провижининг VPS (root)
```bash
apt-get update && apt-get install -y docker.io docker-compose-plugin git ufw
systemctl enable --now docker
useradd -m -s /bin/bash deploy && usermod -aG docker deploy
mkdir -p /opt/hedgefun && chown deploy:deploy /opt/hedgefun
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw --force enable
```

## 3. SSH-ключи
**Публичный CI-ключ** (выдан ассистентом, `hedgefun-ci-deploy`) и **твой личный .pub** — оба в authorized_keys юзера `deploy`:
```bash
sudo -u deploy bash -c '
  mkdir -p ~/.ssh && chmod 700 ~/.ssh
  echo "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIE/XFDiku26iD0rhXTmSShCOofCdU9yjScrBLCqpwVBo hedgefun-ci-deploy" >> ~/.ssh/authorized_keys
  # сюда же добавь свой личный публичный ключ
  chmod 600 ~/.ssh/authorized_keys
'
```
Хардненинг (`/etc/ssh/sshd_config`): `PasswordAuthentication no`, `PermitRootLogin no` → `systemctl restart ssh`.
(Сначала убедись, что заходишь по ключу — иначе запрёшь себя.)

## 4. GitHub Secrets (Settings → Secrets and variables → Actions)
| Secret | Значение |
|---|---|
| `SSH_HOST` | `IP_VPS` (или `ДОМЕН`) |
| `SSH_USER` | `deploy` |
| `SSH_KEY` | приватный `hedgefun_ci` целиком (с `-----BEGIN/END-----`) |
| `SSH_PORT` | `22` (или твой порт) |

## 5. Прод-env на VPS (как deploy)
```bash
cd /opt && git clone https://github.com/eternally-black/Hedge-Fun.git hedgefun
cd hedgefun && git checkout main
cp .env.example .env
nano .env          # заполнить реальные значения (см. ниже)
chmod 600 .env
```
В `.env`:
```
POSTGRES_USER=hedgefun
POSTGRES_PASSWORD=СИЛЬНЫЙ_ПАРОЛЬ
POSTGRES_DB=hedgefun
DATABASE_URL=postgresql://hedgefun:СИЛЬНЫЙ_ПАРОЛЬ@db:5432/hedgefun?schema=public
PRIVY_APP_SECRET=РОТИРОВАННЫЙ_СЕКРЕТ
NEXT_PUBLIC_PRIVY_APP_ID=cmk7iandy02wkjv0bds00zo4j
NODE_ENV=production
```
(`POSTGRES_PASSWORD` и пароль в `DATABASE_URL` должны совпадать. `DEV_USER_EMAIL` НЕ задавать.)

## 6. Caddyfile — подставить домен
```bash
sed -i 's/your-domain.com/ДОМЕН/' /opt/hedgefun/Caddyfile
```

## 7. Первый запуск
```bash
cd /opt/hedgefun && bash deploy.sh
```
Это: build образа → `prisma db push` (migrate) → `up -d` → Caddy выпустит TLS.

## 8. Проверка (см. также план, секция Verification)
```bash
docker compose ps                                  # db healthy, migrate exited 0, app healthy, poller+caddy up
docker run --rm hedgefun:latest ls node_modules/.prisma/client | grep -i 'engine\|\.so'   # движок есть
curl -I https://ДОМЕН/                              # 200, валидный TLS
curl -s -o /dev/null -w '%{http_code}\n' https://ДОМЕН/api/me   # 401 (не 500)
docker compose logs --tail=50 poller               # "poller started… 60000 ms", "[deck] refreshed N markets"
```

## 9. Privy dashboard (вручную)
- Allowed Origins: добавить `https://ДОМЕН`.
- X (Twitter) OAuth callback: под прод-домен.
- **Ротировать `PRIVY_APP_SECRET`**, новый — в `.env` на VPS.

## 10. Дальше — автоматика
`git push origin main` → GitHub Actions → SSH → `deploy.sh`. Ничего вручную.

---

## Откат (rollback)
Образы тегаются git-SHA. Посмотреть: `docker images hedgefun`. Откатить:
```bash
docker tag hedgefun:<старый_sha> hedgefun:latest && docker compose up -d
```
