# Post-audit improvement roadmap

Дата базовой оценки: 19 сентября 2026 года. Production baseline:
`28c4debb1cd62edd4735e2d08e27704e29698f9f`.

Этот документ продолжает [итоговый аудит](audit-remediation-2026-09-19.md) и превращает
оставшиеся рекомендации в проверяемый backlog. Оценка относится к состоянию после выпуска
аудит-исправлений в production. Она должна пересматриваться после закрытия каждого этапа,
а не повышаться только по факту написания кода или документации.

## Текущая оценка

Итоговая взвешенная оценка: **85/100**. Проект соответствует уровню сильного production-ready
продукта ранней стадии. Для уровня 90+ нужны эксплуатационные доказательства на реальных
устройствах, формализованные SLO и отработанное восстановление. Для 95+ дополнительно нужны
регулярные DR-учения, нагрузочный профиль, формальная модель угроз и статистика стабильной
эксплуатации.

| Категория | Вес | Оценка | Основание |
| --- | ---: | ---: | --- |
| Денежные операции и целостность данных | 15% | 91 | Атомарные резервации, идемпотентность, provenance, проверка подписанных байтов, reconciliation и защита от stale snapshots |
| Тестирование и QA | 8% | 92 | Unit, DB, race, contract, mobile, ops, smoke и изолированная PostgreSQL входят в обязательные проверки |
| DevOps и выпуск | 7% | 93 | Полный Git SHA, image digest, backup, миграционный gate, healthchecks и согласованный rollback |
| Безопасность | 11% | 86 | Fail-closed boot, строгая привязка кошелька, Lighthouse guards, закрытый Postgres, encrypted backups и dependency audit |
| Надёжность денежных очередей | 8% | 88 | Постоянные курсоры, полный обход, ручная сверка неоднозначных транзакций и независимые BUY/SELL-квоты |
| Архитектура | 10% | 82 | Разделены app, poller, migrate, database и ingress; финансовые модули всё ещё несут высокую внутреннюю сложность |
| Наблюдаемость и эксплуатация | 8% | 85 | Healthchecks, watchdog, GlitchTip, Telegram и runbook; не хватает единого набора финансовых SLO |
| Качество и поддерживаемость кода | 10% | 76 | Типы и сборка проходят, но остаются 60 lint-предупреждений и крупные финансовые модули |
| Продукт и UX | 8% | 84 | Buy/Pass, Portfolio, PAPER/REAL и inbox согласованы; негативные wallet-сценарии требуют полевых UX-проверок |
| Производительность и масштабирование | 5% | 74 | Устранено голодание очередей, но нет зафиксированных p95/p99 и capacity-модели |
| Mobile readiness | 6% | 72 | TypeScript и Hermes export проходят; установка и полный wallet-cycle на физических устройствах не доказаны |
| Документация | 4% | 91 | Есть runbook, incident, backup, rollback и migration-инструкции |

## План улучшений

### P0 — эксплуатационные доказательства

| ID | Работа | Ожидаемый результат | Критерий готовности и доказательство |
| --- | --- | --- | --- |
| R1 | Сертификация кошельков на физических Android/iOS устройствах | Подтверждён полный цикл Privy, Phantom и MWA вне симулятора | Матрица устройств покрывает login, link/unlink, buy, reject, timeout, background/return, reconnect, sell и смену аккаунта. Приложены версии ОС, wallet и tx signatures контролируемых canary-сделок |
| R2 | Disaster-recovery exercise | Известны фактические RPO/RTO и проверен путь восстановления после потери VPS1 | Production backup восстановлен в изолированную БД; проверены ключевые таблицы и инварианты; зафиксированы RPO/RTO. Отдельно подтверждены свежая offsite-копия и состояние standby без promotion |
| R3 | Операторская очередь manual review | Неоднозначная транзакция не зависит от ручных SQL-изменений | Безопасная CLI или admin UI показывает reason, payer, signature, wire hash и chain evidence; каждое решение имеет оператора, время, комментарий и append-only audit record |

R1 не следует автоматизировать через безусловные сделки в production. Реальный canary запускается
отдельным регламентом, с выделенными кошельками, минимальной суммой и заранее заданным лимитом.

### P1 — наблюдаемость и поддерживаемость

| ID | Работа | Ожидаемый результат | Критерий готовности и доказательство |
| --- | --- | --- | --- |
| R4 | Финансовые SLO и dashboard | Оператор видит деградацию до пользовательской жалобы | Есть метрики `built → sent → confirmed`, p95 confirmation time, oldest reconciliation age, manual-review count/age, RPC/Jupiter/Privy errors, sponsor balance и BUY/SELL quota usage. Для каждого SLO задан alert и владелец |
| R5 | Закрыть frontend lint debt | React-проблемы не теряются среди предупреждений | 0 lint errors и 0 предупреждений в изменяемом коде; устранены refs during render, synchronous state updates in effects, impure render calls, missing alt и unused values. CI запрещает рост baseline |
| R6 | Разделить денежные модули | Изменения state machine меньше затрагивают соседние этапы | Reservation, wire construction, provenance, submission, reconciliation и quota policy имеют отдельные модули и тестируемые интерфейсы; допустимые переходы статусов описаны одной таблицей |
| R7 | Synthetic canary внешних зависимостей | Поломка upstream обнаруживается без реальной сделки | Периодически проверяются quote, unsigned transaction construction, RPC preflight, Privy/Jupiter/Helius availability и schema compatibility; canary не подписывает и не отправляет пользовательскую транзакцию |

### P2 — масштабирование и дополнительное усиление

| ID | Работа | Ожидаемый результат | Критерий готовности и доказательство |
| --- | --- | --- | --- |
| R8 | Нагрузочный и capacity-тест | Известны пределы app, DB и poller | Для `/api/me`, portfolio refresh, параллельных BUY/SELL, confirmation и reconciliation записаны p50/p95/p99, throughput, DB CPU/locks и предел безопасной конкуренции; EXPLAIN-планы критичных запросов сохранены |
| R9 | Supply-chain security | Контролируется не только npm advisory database | CI формирует SBOM, запускает CodeQL/SAST, secret scan и Trivy/Grype для exact image digest; high/critical findings блокируют выпуск или имеют оформленное исключение со сроком |
| R10 | Accessibility и UX-аудит денежных ошибок | Пользователь понимает состояние денег и следующий шаг | Проверены keyboard/screen-reader/contrast; тексты различают rejected signature, unknown submission, manual review, insufficient rent, sponsor limit и Privy outage; retry не создаёт новую неоднозначную заявку |

## Целевые метрики

До начала измерений команда должна утвердить численные значения. Минимальный набор:

- успешность построения транзакции;
- доля отправленных транзакций с окончательным verdict;
- p95 времени `sent → confirmed`;
- возраст старейшей записи reconciliation и manual review;
- частота дубликатов, расхождений wire и stale snapshot rejection;
- доступность `/api/health`, app и poller;
- RPO/RTO последнего restore exercise;
- crash-free sessions и wallet-flow completion на mobile;
- p95 latency и error rate ключевых API;
- количество lint warnings, high/critical dependency и image findings.

Метрики должны быть разбиты по PAPER/REAL, BUY/SELL, embedded/external wallet и web/mobile,
иначе общая успешность может скрыть деградацию одного денежного пути.

## Переоценка

Оценку следует обновлять после каждого этапа и не реже одного раза в месяц:

1. Приложить ссылки на CI run, dashboard, drill report или device matrix.
2. Подтвердить критерии готовности, включая негативные сценарии.
3. Обновить балл только в затронутых категориях.
4. Записать новые ограничения и incidents, даже если они снижают оценку.

Ориентиры:

- **90–92/100**: закрыты R1–R5, SLO измеряются, restore exercise пройден;
- **93–94/100**: закрыты R6–R9, capacity и supply-chain gates работают в CI;
- **95+/100**: несколько недель SLO без критических нарушений, повторяемые DR-учения и
  подтверждённое восстановление при полной потере основной площадки.
