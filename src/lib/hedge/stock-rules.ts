// Life-situation → tokenized-stock hedges (Stocklana). PURE and client-importable: no prisma, no
// env, no node built-ins — only constants from ../config. The table is the product's opinion about
// which stock a life cost maps to; the matcher is deliberately dumb (token hits, no ML) so the same
// text always yields the same cards and the demo is reproducible offline.
//
// ponytail: "I work at Amazon" hits tech_job AND shopping → two cards; a brand-vs-employer
// disambiguation is the upgrade path.

import { HEDGE_STOCK_MAX_CATEGORIES } from "../config";

export type StockCategory =
  | "travel"
  | "driving"
  | "rides"
  | "housing"
  | "groceries"
  | "energy"
  | "healthcare"
  | "tech_job"
  | "crypto"
  | "streaming"
  | "shopping"
  | "dining"
  | "market";

export interface StockTrigger {
  symbol: string;
  dir: "up" | "down";
  thresholdBp: number;
}

export interface StockRule {
  category: StockCategory;
  emoji: string;
  label: string;
  chipQuery: string; // the EN phrase a UI chip searches
  keywords: string[]; // lowercase source strings; "stem*" = prefix match on one token; a multi-word entry = phrase (consecutive tokens), weight = its token count
  tickers: string[]; // preference order; resolved at runtime elsewhere
  pctBp: number; // of the stated amount
  copy: { withAmount: string; noAmount: string; spotted?: string }; // slots {amount} {ticker} {change} {distance} {period}
  trigger?: StockTrigger;
}

export const STOCK_RULES: readonly StockRule[] = [
  {
    category: "travel",
    emoji: "✈️",
    label: "Flights",
    chipQuery: "flights",
    keywords: [
      "flight", "flights", "flying", "fly", "plane", "airfare", "airline", "airlines", "airport",
      "trip", "vacation", "holiday", "travel", "traveling", "travelling", "hotel", "hotels",
      "airbnb", "plane tickets", "air tickets",
      "полет*", "перелет*", "самолет*", "авиабилет*", "авиа", "отпуск*", "путешеств*", "лечу",
      "летим", "летаю", "отель", "отели", "гостиниц*",
      "політ", "переліт", "перельот*", "літак*", "авіаквит*", "відпустк*", "подорож*", "летимо",
      "готел*",
      "fligth", "flgiht", "flite", "travle", "vacaton",
    ],
    tickers: ["DALx", "UALx", "LUVx", "AAx", "ABNBx", "MARx"],
    pctBp: 1000,
    copy: {
      withAmount: "You're spending {amount} on flights {period}. Hedge your travel costs with {ticker}.",
      noAmount: "Flying soon? Airlines pocket the fare — own a slice of it: {ticker}.",
    },
  },
  {
    category: "driving",
    emoji: "⛽",
    label: "Driving",
    chipQuery: "driving",
    keywords: [
      "gas", "gasoline", "petrol", "fuel", "diesel", "drive", "driving", "drove", "car", "commute",
      "commuting", "mileage", "miles", "km", "pump", "road trip", "fill up", "gas station",
      "бензин*", "топлив*", "заправ*", "машин*", "авто", "автомобил*", "езжу", "еду", "вожу",
      "пробег", "километр*", "дизел*", "солярк*",
      "пальн*", "палив*", "їжджу", "їду", "воджу", "пробіг", "кілометр*", "автомобіл*",
      "gasolene", "petrl", "deisel", "fule", "milage",
    ],
    tickers: ["XOMx", "CVXx", "XLEx", "XOPx", "COPx"],
    pctBp: 1000,
    copy: {
      withAmount: "Fuel eats {amount} {period}. {ticker} earns when the pump price climbs — a fuel-cost hedge, loosely.",
      noAmount: "You drive {distance}. {ticker} moves with crude — consider it a fuel-cost hedge.",
      spotted: "Energy stocks just jumped {change}. You drive {distance}. Consider {ticker} as a fuel-cost hedge.",
    },
    trigger: { symbol: "XLEx", dir: "up", thresholdBp: 500 },
  },
  {
    category: "rides",
    emoji: "🚕",
    label: "Rides",
    chipQuery: "uber rides",
    keywords: [
      "uber", "lyft", "taxi", "taxis", "cab", "cabs", "rideshare", "ride share", "rides", "bolt",
      "такси", "убер",
      "таксі",
    ],
    tickers: ["UBERx"],
    pctBp: 1000,
    copy: {
      withAmount: "{amount} {period} on rides. {ticker} skims every fare — skim back.",
      noAmount: "Taxi a lot? {ticker} skims every fare — skim back.",
    },
  },
  {
    category: "housing",
    emoji: "🏠",
    label: "Rent",
    chipQuery: "rent",
    keywords: [
      "rent", "renting", "lease", "landlord", "apartment", "apartments", "flat", "mortgage",
      "housing", "condo", "tenant", "home loan", "house payment",
      "аренд*", "снимаю", "съем", "съемн*", "квартир*", "ипотек*", "жиль*", "хозяин", "хозяйк*",
      "комнат*",
      "оренд*", "винайм*", "знімаю", "іпотек*", "житл*", "кімнат*",
      "morgage", "mortage", "appartment", "apartement", "landord",
    ],
    tickers: ["INVHx", "ESSx", "MAAx", "Ox", "PLDx", "VICIx"],
    pctBp: 1000,
    copy: {
      withAmount: "Rent's {amount} {period}. Landlords collect it — own a slice of the landlord: {ticker}.",
      noAmount: "Renting? Landlords collect it — own a slice of the landlord: {ticker}.",
    },
  },
  {
    category: "groceries",
    emoji: "🛒",
    label: "Groceries",
    chipQuery: "groceries",
    keywords: [
      "groceries", "grocery", "food", "supermarket", "supermarkets", "walmart", "costco", "kroger",
      "eggs", "milk", "bread", "produce", "pantry", "food prices", "food bill",
      "продукт*", "еда", "еды", "супермаркет*", "магазин*", "ашан", "пятерочк*", "перекресток",
      "яйца", "молоко", "хлеб",
      "продукти", "продуктів", "їжа", "їжу", "атб", "сільпо", "харч*", "яйця", "хліб",
      "grocieries", "grocries", "grocerys", "supermarkt",
    ],
    tickers: ["WMTx", "KRx", "KOx", "PEPx", "ADMx", "GISx"],
    pctBp: 1000,
    copy: {
      withAmount: "{amount} {period} at the checkout. The grocer keeps the margin — {ticker} is the other side of that receipt.",
      noAmount: "Grocery bill creeping? The grocer keeps the margin — {ticker} is the other side of the receipt.",
    },
  },
  {
    category: "energy",
    emoji: "🔌",
    label: "Power bill",
    chipQuery: "electricity bill",
    keywords: [
      "electricity", "electric", "utility", "utilities", "heating", "kwh", "thermostat",
      "electric bill", "power bill", "gas bill", "energy bill", "air conditioning",
      "электричеств*", "электроэнерг*", "свет", "коммуналк*", "коммунальн*", "отоплени*", "квт",
      "електрик*", "електроенерг*", "світло", "комуналк*", "комунальн*", "опаленн*",
      "electricty", "electrisity", "utillity", "utilites",
    ],
    tickers: ["NEEx", "DUKx", "SOx", "AEPx", "XELx"],
    pctBp: 1000,
    copy: {
      withAmount: "Power bill {amount} {period}. Utilities are regulated to earn on it — {ticker} is who you pay.",
      noAmount: "Power bill creeping? Utilities are regulated to earn on it — {ticker} is who you pay.",
    },
  },
  {
    category: "healthcare",
    emoji: "💊",
    label: "Health",
    chipQuery: "health costs",
    keywords: [
      "insurance", "premium", "premiums", "doctor", "doctors", "hospital", "medical", "pharmacy",
      "prescription", "prescriptions", "meds", "medication", "medications", "dentist", "dental",
      "copay", "deductible", "health", "healthcare", "therapy", "clinic", "health insurance",
      "врач*", "больниц*", "лекарств*", "аптек*", "страховк*", "медстрах*", "лечени*",
      "стоматолог*", "зубы", "здоровь*", "таблетк*", "клиник*",
      "лікар*", "лікарн*", "ліки", "ліків", "страхуванн*", "лікуванн*", "зуби", "здоров*",
      "пігулк*", "клінік*",
      "medecine", "perscription", "prescripton", "insurence", "docter",
    ],
    tickers: ["UNHx", "CVSx", "CIx", "LLYx", "PFEx", "JNJx"],
    pctBp: 1000,
    copy: {
      withAmount: "{amount} {period} on health costs. Insurers and pharma are the other side — {ticker}.",
      noAmount: "Health costs adding up? Insurers and pharma are the other side — {ticker}.",
    },
  },
  {
    category: "tech_job",
    emoji: "💻",
    label: "Tech job",
    chipQuery: "my tech job",
    keywords: [
      "job", "salary", "paycheck", "employer", "software", "engineer", "developer", "programmer",
      "coder", "startup", "layoffs", "layoff", "rsu", "rsus", "equity", "tech", "faang",
      "work at", "i work", "my job", "laid off", "stock options", "big tech", "software engineer",
      "работаю в", "работа", "работу", "зарплат*", "работодател*", "айти", "айтишник*",
      "программист*", "разработчик*", "стартап*", "увольнен*", "сокращен*", "опцион*",
      "працюю в", "робот*", "роботодав*", "айті", "айтішник*", "програміст*", "розробник*",
      "звільненн*", "скороченн*",
      "sofware", "enginer", "programer", "salery",
    ],
    tickers: ["SGOVx", "VOOx", "SPYx"],
    pctBp: 200,
    copy: {
      withAmount: "Your paycheck already rides on tech. Don't double down — park 2% of it outside: {ticker}.",
      noAmount: "Your paycheck already rides on tech. Don't double down — park a slice outside it: {ticker}.",
      spotted: "Tech is off {change} today. If your paycheck is tech, here's the boring side: {ticker}.",
    },
    trigger: { symbol: "QQQx", dir: "down", thresholdBp: 300 },
  },
  {
    category: "crypto",
    emoji: "₿",
    label: "Crypto bag",
    chipQuery: "my crypto bag",
    keywords: [
      "bitcoin", "btc", "ethereum", "eth", "ether", "solana", "sol", "crypto", "cryptocurrency",
      "altcoin", "altcoins", "alts", "memecoin", "memecoins", "bag", "bags", "hodl", "hodling",
      "degen", "portfolio", "tokens", "coins", "my bag",
      "биткоин*", "биткойн*", "битк*", "эфир*", "солан*", "крипт*", "альт*", "мемкоин*", "холд*",
      "портфел*", "монет*", "токен*",
      "біткоїн*", "біткоін*", "ефір*", "альти", "мемкоїн*", "монети",
      "bitcion", "bitcoing", "etherium", "solona", "cryto", "cripto",
    ],
    tickers: ["GLDx", "SGOVx", "SLVx"],
    pctBp: 1000,
    copy: {
      withAmount: "{amount} in crypto. Gold is the old hard money — it zigs when crypto zags, sometimes. Hedge 10% with {ticker}.",
      noAmount: "Holding a crypto bag? Gold is the old hard money — hedge a slice with {ticker}.",
      spotted: "Bitcoin's having a day ({change} on BITXx). Holding a bag? Gold is the classic other side — {ticker}.",
    },
    trigger: { symbol: "BITXx", dir: "down", thresholdBp: 500 },
  },
  {
    category: "streaming",
    emoji: "📺",
    label: "Subscriptions",
    chipQuery: "streaming subscriptions",
    keywords: [
      "netflix", "disney", "hbo", "spotify", "subscription", "subscriptions", "streaming",
      "youtube", "cable", "hulu", "paramount", "disney plus", "prime video", "apple tv",
      "нетфликс*", "подписк*", "стриминг*", "кинопоиск*", "ютуб*", "спотифай*", "окко", "иви",
      "нетфлікс*", "підписк*", "стрімінг*", "спотіфай*", "мегого",
      "netflx", "netfilx", "subscribtion", "subsciption", "spotfy",
    ],
    tickers: ["NFLXx", "DISx", "WBDx", "ROKUx"],
    pctBp: 1000,
    copy: {
      withAmount: "{amount} {period} in subscriptions. Every price hike lands in {ticker}'s revenue — own the hike.",
      noAmount: "Subscriptions piling up? Every price hike lands in {ticker}'s revenue — own the hike.",
    },
  },
  {
    category: "shopping",
    emoji: "📦",
    label: "Shopping",
    chipQuery: "online shopping",
    keywords: [
      "amazon", "shopping", "shein", "temu", "aliexpress", "ebay", "delivery", "deliveries",
      "orders", "ordering", "parcels", "packages", "coupang", "online shopping", "amazon prime",
      "амазон*", "шопинг*", "шоппинг*", "заказ*", "посылк*", "доставк*", "алиэкспресс*", "али",
      "озон", "вайлдберриз*", "вб", "шейн",
      "шопінг*", "замовленн*", "замовля*", "посилк*", "аліекспрес*", "розетк*", "шеїн",
      "amazn", "amazone", "shoping", "aliexpres",
    ],
    tickers: ["AMZNx", "SHEINx", "CPNGx", "WMTx"],
    pctBp: 1000,
    copy: {
      withAmount: "{amount} {period} on orders. {ticker} takes a cut of every checkout — take one back.",
      noAmount: "Ordering a lot? {ticker} takes a cut of every checkout — take one back.",
    },
  },
  {
    category: "dining",
    emoji: "☕",
    label: "Coffee & dining",
    chipQuery: "coffee and eating out",
    keywords: [
      "coffee", "starbucks", "latte", "cappuccino", "cafe", "restaurant", "restaurants", "takeout",
      "takeaway", "mcdonald*", "chipotle", "lunch", "lunches", "dinner", "dinners", "doordash",
      "brunch", "eating out", "eat out", "fast food", "food delivery", "uber eats",
      "кофе", "кофейн*", "старбакс*", "латте", "ресторан*", "кафе", "макдональдс*", "макдак*",
      "обед*", "ужин*", "фастфуд*", "бургер*", "пицц*", "доставка еды",
      "кава", "кавярн*", "лате", "обід*", "піц*", "доставка їжі",
      "starbuck", "resturant*", "restraunt*", "cofee", "coffe", "cappucino",
    ],
    tickers: ["SBUXx", "MCDx", "CMGx", "DASHx", "YUMx"],
    pctBp: 1000,
    copy: {
      withAmount: "{amount} {period} on coffee and eating out. {ticker} is the other side of the counter.",
      noAmount: "Coffee and takeout adding up? {ticker} is the other side of the counter.",
    },
  },
  {
    category: "market",
    emoji: "📈",
    label: "Everything's pricier",
    chipQuery: "cost of living",
    keywords: [
      "inflation", "expensive", "pricier", "savings", "retirement", "pension", "invest",
      "investing", "prices", "cost of living", "everything costs", "getting expensive",
      "price hikes",
      "инфляци*", "цены", "дорожа*", "сбережени*", "накоплени*", "пенси*", "инвестир*",
      "інфляці*", "ціни", "дорожч*", "заощадженн*", "пенсі*", "інвест*",
    ],
    tickers: ["VOOx", "SPYx", "VTIx", "SGOVx"],
    pctBp: 500,
    copy: {
      withAmount: "{amount} {period} and everything costs more. Owning the index is the blunt answer — {ticker}.",
      noAmount: "Everything costs more. Owning the index is the blunt answer — {ticker}, a slice at a time.",
      spotted: "Stocks are off {change} today — the index is on sale, if you believe in tomorrow. {ticker}.",
    },
    trigger: { symbol: "SPYx", dir: "down", thresholdBp: 200 },
  },
];

export interface WalletStockRule {
  asset: "BTC" | "ETH" | "SOL" | "SPL";
  tickers: string[];
  copy: string;
}

export const WALLET_STOCK_RULES: readonly WalletStockRule[] = [
  {
    asset: "BTC",
    tickers: ["GLDx", "SLVx"],
    copy: "Your wallet holds {amount} of BTC — hedge 10% with {ticker}. Gold is the old hard money; it zigs when crypto zags, sometimes.",
  },
  {
    asset: "ETH",
    tickers: ["GLDx", "SGOVx"],
    copy: "Your wallet holds {amount} of ETH. A slice of hard money that isn't a chain: {ticker}.",
  },
  {
    asset: "SOL",
    tickers: ["SGOVx", "SPYx"],
    copy: "Your wallet holds {amount} of SOL. The boring side of the barbell — ~10% into T-bills: {ticker}.",
  },
  {
    asset: "SPL",
    tickers: ["SGOVx"],
    copy: "{amount} in long-tail tokens. Park ~10% in T-bills ({ticker}) — the one leg that doesn't move with the tail.",
  },
];

// Lowercase → remove ' and ’ → NFD → strip combining marks (so ё→е, й→и) → split on non-letter/digit.
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/['’]/g, "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);
}

// Precomputed at module init so both sides of the match agree on normalization.
interface CompiledKeyword {
  tokens: string[];
  stem: string | null; // set when the source keyword ended with "*" and is a single token
  weight: number;
}

interface CompiledRule {
  rule: StockRule;
  keywords: CompiledKeyword[];
}

const COMPILED: CompiledRule[] = STOCK_RULES.map((rule) => ({
  rule,
  keywords: rule.keywords.map((k) => {
    const isStem = k.endsWith("*");
    const src = isStem ? k.slice(0, -1) : k;
    const tokens = tokenize(src);
    return {
      tokens,
      stem: isStem && tokens.length === 1 ? tokens[0]! : null,
      weight: tokens.length,
    };
  }),
}));

export interface RuleHit {
  rule: StockRule;
  hits: number;
  confidence: number; // display only
}

export function matchStockRules(
  text: string,
  ctx?: { amountCents?: number | null; distanceKm?: number | null },
): RuleHit[] {
  const tokens = tokenize(text);
  const out: RuleHit[] = [];

  for (const { rule, keywords } of COMPILED) {
    let hits = 0;
    for (const kw of keywords) {
      if (kw.tokens.length === 0) continue;
      if (kw.stem !== null) {
        for (const t of tokens) if (t.startsWith(kw.stem)) hits += 1;
      } else if (kw.tokens.length === 1) {
        const w = kw.tokens[0]!;
        for (const t of tokens) if (t === w) hits += 1;
      } else {
        const n = kw.tokens.length;
        for (let i = 0; i + n <= tokens.length; i++) {
          let ok = true;
          for (let j = 0; j < n; j++) {
            if (tokens[i + j] !== kw.tokens[j]) {
              ok = false;
              break;
            }
          }
          if (ok) hits += n;
        }
      }
    }
    if (rule.category === "driving" && ctx?.distanceKm != null && ctx.distanceKm > 0) hits += 2;
    if (hits > 0) out.push({ rule, hits, confidence: Math.min(1, 0.6 + 0.2 * hits) });
  }

  out.sort((a, b) => (b.hits - a.hits) || (STOCK_RULES.indexOf(a.rule) - STOCK_RULES.indexOf(b.rule)));
  const capped = out.slice(0, HEDGE_STOCK_MAX_CATEGORIES);

  if (capped.length === 0 && ctx?.amountCents != null && ctx.amountCents > 0) {
    const market = STOCK_RULES.find((r) => r.category === "market")!;
    return [{ rule: market, hits: 0, confidence: 0.6 }];
  }
  return capped;
}

export function ruleByCategory(c: string): StockRule | null {
  return STOCK_RULES.find((r) => r.category === c) ?? null;
}

export function evalTriggers(changeBp: Record<string, number>): { rule: StockRule; changeBp: number }[] {
  const out: { rule: StockRule; changeBp: number }[] = [];
  for (const rule of STOCK_RULES) {
    const t = rule.trigger;
    if (!t) continue;
    const change = changeBp[t.symbol];
    if (change == null) continue;
    const fires = t.dir === "up" ? change >= t.thresholdBp : change <= -t.thresholdBp;
    if (fires) out.push({ rule, changeBp: change });
  }
  return out;
}

export function renderCopy(
  tpl: string,
  slots: Partial<Record<"amount" | "ticker" | "change" | "distance" | "period", string>>,
): string {
  const defaults: Record<string, string> = {
    distance: "a fair bit",
    amount: "some",
    period: "",
    change: "",
  };
  let out = tpl;
  for (const key of ["amount", "ticker", "change", "distance", "period"] as const) {
    const v = slots[key] ?? defaults[key] ?? "";
    out = out.split(`{${key}}`).join(v);
  }
  out = out.replace(/ {2,}/g, " ");
  out = out.replace(/ ([.,;!?])/g, "$1");
  return out.trim();
}

export function fmtChange(bp: number): string {
  const pct = bp / 100;
  const sign = pct >= 0 ? "+" : "−";
  return `${sign}${Math.abs(pct).toFixed(1)}%`;
}

export function fmtPeriod(p: string | null | undefined): string {
  if (p === "month") return "this month";
  if (p === "week") return "this week";
  if (p === "year") return "this year";
  return "";
}

export function fmtDistance(km: number, p: string | null | undefined): string {
  const base = `~${km.toLocaleString("en-US")} km`;
  if (p === "month") return `${base}/month`;
  if (p === "week") return `${base}/week`;
  return base;
}
