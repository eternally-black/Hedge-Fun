# Пастки Google Play для Hedge Fun (Shipaton 2026) — з посиланнями на правила

Кожен пункт: що це, чим б'є по нас, і посилання на офіційну сторінку Google з цитатою.
Перевірено 2026-09-17. Контекст і план — [shipaton.md](./shipaton.md).

---

## A. Акаунт розробника — те, що вирішує, чи існує Play-маршрут узагалі

### A1. Новий особистий акаунт → 12 тестерів × 14 днів → дедлайн 30 вересня не проходить
- Правило: [App testing requirements for new personal developer accounts](https://support.google.com/googleplay/android-developer/answer/14151465)
  — "Google Play requires personal developer accounts created after November 13, 2023, to test their apps";
  "minimum of 12 testers who have been opted in continuously for at least 14 days".
- Після 14 днів — ще заявка на production access: "Review usually takes seven days or less, but can occasionally take longer".
- Арифметика: реєстрація + верифікація (A3) + 14 днів + до 7 днів ревʼю заявки + ревʼю релізу = жовтень. Мертво.

### A2. Організаційний акаунт — без правила A1, але потрібен D-U-N-S
- Крок "Meet testing requirements … (Personal accounts only)" — [Get started with Play Console](https://support.google.com/googleplay/android-developer/answer/6112435).
- Що потрібно організації — [Required information to create a Play Console developer account](https://support.google.com/googleplay/android-developer/answer/13628312):
  "D-U-N-S number…", і про його отримання: "This process can take up to 30 days so you should plan ahead";
  "If you do not have a D-U-N-S number then you can apply for one from Dun & Bradstreet".
- Збіг реквізитів: "you must ensure that the legal name and address in your Google payments profile match those in your Dun & Bradstreet profile" (та сама сторінка).
- Практика: якщо юрособа власника вже є в базі D&B, номер знаходиться миттєво через
  [D&B lookup](https://www.dnb.com/duns-number/lookup.html). Якщо ні — до 30 днів. Це перше, що треба перевірити.

### A3. Верифікація особи/організації блокує публікацію
- [Verify your developer identity information](https://support.google.com/googleplay/android-developer/answer/10841920):
  для особи — "Official government identity document"; для організації — "D-U-N-S number (unless your developer account is for a known government organization or agency)";
  "you won't be able to republish your app until you've verified your information".
- Нові особисті акаунти додатково "verify that they have access to an Android device using the Play Console mobile app"
  ([Get started](https://support.google.com/googleplay/android-developer/answer/6112435)).

### A4. Базові умови
- "You must be at least 18 years of age"; "There is a US$25 one-time registration fee" —
  [Get started](https://support.google.com/googleplay/android-developer/answer/6112435).

### A5. Акаунт має бути власника, не розробника
- Перенести застосунок між акаунтами можна: "Our support team reviews and replies to transfer requests within 2 business days",
  але "Test groups (open, closed, internal test, and internal sharing) can't be transferred between accounts" —
  [Transfer apps to a different developer account](https://support.google.com/googleplay/android-developer/answer/6230247).
- Платіжним профілем керує лише власник акаунта (див. C2). Отже акаунт з самого початку створює власник.

---

## B. Політики контенту — чому Play-версія лише «паперова»

### B1. Реальні гроші на прогнозах = азартні ігри = ліцензія в кожній країні
- [Real-Money Gambling, Games, and Contests](https://support.google.com/googleplay/android-developer/answer/9877032):
  "we don't allow content or services that enable or facilitate users' ability to wager, stake, or participate using real money (including in-app items purchased with money) to obtain a prize of real world monetary value";
  дозволено лише з "a valid gambling license for each country or state/territory in which the app is distributed".
- Polymarket у Real-режимі — саме це. Окремої категорії «prediction markets» у політиці немає — це не виняток, а загальна заборона.

### B2. Свопи USDC→xStocks у застосунку = криптобіржа/гаманець = ліцензії по країнах
- [Cryptocurrency Exchanges and Software Wallets](https://support.google.com/googleplay/android-developer/answer/16329703):
  США — "registered with FinCEN as a Money Services Business and with a state as a money transmitter";
  ЄС — "authorised as a crypto-asset service provider (CASP) under … MiCA";
  без ліцензій — "remove them from your app's targeting countries/regions" (а Shipaton вимагає доступність у США).
- "Non-custodial wallets are out of scope" — але вбудований гаманець Privy зі свопом усередині застосунку
  ревʼюер прочитає як exchange-функцію. Не сперечатися з ревʼю за 13 днів: у Play-версії гаманця немає.

### B3. Декларація фінансових функцій — обовʼязкова для всіх
- [Financial Services](https://support.google.com/googleplay/android-developer/answer/9876821):
  "Any app that contains any financial features must complete the Financial features declaration form within Play Console."
- Категорії форми — [Provide information for the Financial features declaration](https://support.google.com/googleplay/android-developer/answer/13849271):
  серед них "Stock trading and portfolio management", "Cryptocurrency exchange", "Cryptocurrency wallet",
  і варіант "My app doesn't provide any financial features".
- Пастка: paper-версія відповідає «не надає», але екрани з «Portfolio», «Buy», «$» без слова «virtual/play money»
  спровокують ревʼюера. Скріншоти й опис мають явно казати «віртуальні бали, без реальних грошей».

### B4. Токенізовані активи (xStocks) — окрема політика, стосується Seeker-версії
- [Blockchain-based Content](https://support.google.com/googleplay/android-developer/answer/13607354):
  токенізовані активи треба "declare this via the Financial features declaration form on the App Content page";
  "may not promote or glamorize any potential earning from playing or trading activities".
- Для Play-версії: жодного «earn» у копірайті; для Seeker-версії політика Play не діє (інший стор).

### B5. Метадані лістингу
- [Metadata](https://support.google.com/googleplay/android-developer/answer/9898842):
  "We don't allow apps with misleading, improperly formatted, non-descriptive, irrelevant, excessive, or inappropriate metadata";
  "We also don't allow unattributed or anonymous user testimonials in the app's description."
- Заголовки карток від власника перевірити на обіцянки прибутку.

---

## C. Гроші всередині Play (RevenueCat Pro)

### C1. Цифрові товари — тільки через Google Play Billing
- [Payments](https://support.google.com/googleplay/android-developer/answer/9858738):
  "Play-distributed apps requiring or accepting payment for access to in-app features or services … must use Google Play's billing system";
  приклади — "virtual currencies … subscription services … service upgrades".
- Наслідок: Pro у Play-версії лише через Play Billing (RevenueCat його й використовує). Оплата Pro в USDC —
  лише в Seeker-версії, ніколи в Play-збірці.

### C2. Без платіжного профілю (merchant) продукти не створити
- [Create a payments profile](https://support.google.com/googleplay/android-developer/answer/7161426),
  [Create and manage subscriptions](https://support.google.com/googleplay/android-developer/answer/140504):
  спершу "set up a payments profile", керує ним лише власник акаунта; країну бізнесу потім змінити не можна;
  банківський рахунок — у тій самій країні.
- Україна підтримана і для developer-, і для merchant-реєстрації —
  [Supported locations for developer and merchant registration](https://support.google.com/googleplay/android-developer/answer/150324).

### C3. Правила підписок і тріалів
- [Create and manage subscriptions](https://support.google.com/googleplay/android-developer/answer/140504):
  "clearly disclose how a user can manage or cancel their subscription"; "Free trials must be between 3 days and 3 years";
  не називати підписку "Free Trial"; текст переваги "Try 7 days free" — заборонено.
- [Payments](https://support.google.com/googleplay/android-developer/answer/9858738):
  "Developers must clearly and accurately inform users about the terms and pricing of their app or any in-app features or subscriptions offered for purchase."

### C4. Промокоди для суддів — квартальна пастка
- [Create promotions](https://support.google.com/googleplay/android-developer/answer/6321495):
  промокод на підписку = тріал "between 3 and 90 days"; потрібна інтеграція "In-app Promotions" у застосунку;
  "If you don't use all of your promo codes in a quarter, you'll lose access to them. Unused codes won't carry over to the next quarter";
  першого дня кварталу — "wait for 24 hours and try again".
- Квартал закінчується 30 вересня, судять 1–13 жовтня → коди, створені у вересні, згорять. Створювати 1–2 жовтня,
  а основний безкоштовний доступ для суддів — тріал у самій підписці.

### C5. Тестові покупки
- [Test in-app products / license testing](https://support.google.com/googleplay/android-developer/answer/6062777):
  ліцензійні тестери "can also purchase one-time products and subscriptions without charging their accounts";
  умова — "Your app has been published to the open, closed, internal test, or production track."

---

## D. Лістинг і ревʼю

### D1. Доступ ревʼюера до застосунку з логіном
- [Prepare your app for review (App access)](https://support.google.com/googleplay/android-developer/answer/9859455):
  "If your entire app or parts of your app are restricted based on login credentials … you must provide all required details to enable access to your app."
- У нас вхід через Privy email-OTP — ревʼюер код не отримає. Потрібен тестовий акаунт із фіксованим OTP (Privy dashboard, власник).

### D2. Політика приватності — і в консолі, і в застосунку
- [User Data](https://support.google.com/googleplay/android-developer/answer/10144311):
  "All apps must post a privacy policy link in the designated field within Play Console, and a privacy policy link or text within the app itself";
  до чутливих даних належать "financial and payment information, authentication information";
  розкриття "must be displayed in the normal usage of the app and not require the user to navigate into a menu or settings".
- У нас є `/terms`, сторінки privacy немає. Реферальний антифрод хешує IP/UA — це збір даних, який треба задекларувати.

### D3. Data safety — включно з SDK (Privy, RevenueCat)
- [Data safety form](https://support.google.com/googleplay/android-developer/answer/10787469):
  "All developers that have an app published on Google Play must complete the Data safety form, including apps on closed, open, or production testing tracks";
  "This includes data collected and handled through any third-party libraries or SDKs used in their apps";
  "Apps that don't become compliant are subject to policy enforcement, like blocked updates or removal from Google Play."

### D4. Віковий рейтинг IARC — «simulated gambling» як елемент
- [Content ratings](https://support.google.com/googleplay/android-developer/answer/9859655):
  анкета обовʼязкова; "simulated gambling" — елемент рейтингу (PEGI 12 / IARC 12+);
  "Misrepresentation of your app's content may result in its removal or suspension."
- Прогнози за віртуальні бали чесно тягнуть на «simulated gambling» → рейтинг 12+/Teen. Це не заборона, це рейтинг. Не брехати в анкеті.

### D5. Ревʼю нового акаунта — до 7 днів і більше
- [Publish your app](https://support.google.com/googleplay/android-developer/answer/9859751):
  "For certain developer accounts, we'll take more time to thoroughly review your app … This may result in review times of up to seven days or longer in exceptional cases."
- Новий акаунт = "certain". Сабмітити в production не пізніше 23–24 вересня.

### D6. Target API — з 31 серпня 2026 нові застосунки на API 36
- [Target API level requirements](https://support.google.com/googleplay/android-developer/answer/11926878):
  "Starting August 31, 2026: New apps and app updates must target Android 16 (API level 36) or higher".
- Перевірити `targetSdkVersion` в Expo 57 на першій збірці.

---

## E. Технічно незворотні рішення

### E1. Package name — назавжди
- [Create and set up your app](https://support.google.com/googleplay/android-developer/answer/9859152):
  "Package names for app files are unique and permanent, so please name them carefully. Package names can't be deleted or re-used in the future."
- `fun.hedgeyour.app` для Play вирішується зараз; Seeker-версія отримує інший id (E2).

### E2. Play App Signing — Google підписує APK своїм ключем
- [Play App Signing](https://support.google.com/googleplay/android-developer/answer/9842756):
  "Google uses this key to sign the final APKs delivered to users' devices"; наш ключ — лише "Upload key";
  зміна ключа — "annual key upgrade for all installs on Android 17 (API level 37) and above".
- Наслідок: APK для Seeker dApp Store, підписаний нашим ключем, не встановиться поверх Play-версії з тим самим
  package name (Android забороняє різні підписи для одного пакета). Тому Seeker = окремий applicationId.

---

## Що робити сьогодні

1. Власник: перевірити свою юрособу в [D&B lookup](https://www.dnb.com/duns-number/lookup.html). Є номер → створювати
   **організаційний** акаунт Play (A2) і платіжний профіль (C2) тією ж юрособою. Немає → подати заявку на D-U-N-S
   негайно і паралельно вирішувати, чи є інший стор/акаунт.
2. Без організаційного акаунта (або старого особистого до 13.11.2023) Play до 30 вересня недосяжний (A1).
