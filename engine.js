// 배당 포트폴리오 시뮬레이션 엔진 (UI 의존성 없는 순수 함수).
// 브라우저(app.js)와 Node 테스트(dividend/engine.test.mjs)에서 같이 쓴다.
//
// 월 단위 처리 순서
//   1) 배당락: 이 달 초 보유 주식 수 × 주당 배당 → lag 개월 뒤 입금 예정으로 등록
//   2) 배당 입금: 원천징수 후 재투자 비율만큼 같은 통화 종목에 재투자, 나머지는 인출
//   3) 납입: 초기자금(첫 달) / 월 납입금(둘째 달부터)을 목표 비중대로 배분, 달러 종목은 환전
//   4) 일시 인출: 비중대로 매도해 원화로 인출 (미국 종목 양도세 반영)
//   5) 매수: 종목별 대기 현금으로 월말 종가에 매수 (국내 정수 주, 미국 소수점 선택)

export const DEFAULT_SETTINGS = {
  initial: 10_000_000,        // 초기 자금 (원)
  monthly: 500_000,           // 월 납입금 (원)
  reinvestRatio: 1,           // 세후 배당 중 재투자 비율 (0~1), 나머지는 인출 (withdrawMonthly가 없을 때)
  withdrawMonthly: null,      // 매달 인출액(원). 주면 비율 대신 이 금액을 배당에서 먼저 꺼내고 남는 배당은 재투자
  withdrawMonthly2: 0,        // switchAfterMonths 이후 매달 인출액
  sellForWithdraw: false,     // 그 달 배당이 인출액보다 적으면 주식을 팔아 채울지
  switchAfterMonths: null,    // 이 개월 수가 지나면 reinvestRatio2로 전환 (null이면 전환 없음)
  reinvestRatio2: 0,
  withdrawals: [],            // [{ month: 시작부터 개월 인덱스, amount: 원 }]
  taxKR: 0.154,               // 국내 배당소득세 (지방세 포함)
  taxUS: 0.15,                // 미국 원천징수 (한미 조세조약)
  fxSpread: 0.0025,           // 환전 수수료(스프레드)
  fractionalUS: true,         // 미국 종목 소수점 매수
  cgtRate: 0.22,              // 해외주식 양도소득세 (지방세 포함)
  cgtDeduction: 2_500_000,    // 해외주식 양도소득 기본공제 (연)
};

export const COMPREHENSIVE_TAX_THRESHOLD = 20_000_000; // 금융소득종합과세 기준 (연)

export function addMonths(ym, n) {
  const [y, m] = ym.split("-").map(Number);
  const k = y * 12 + (m - 1) + n;
  return `${Math.floor(k / 12)}-${String((k % 12) + 1).padStart(2, "0")}`;
}

export function monthIndex(data, ym) {
  const [y0, m0] = data.start.split("-").map(Number);
  const [y, m] = ym.split("-").map(Number);
  return (y - y0) * 12 + (m - m0);
}

// 선택 종목이 모두 상장돼 있는 첫 달
export function earliestCommonStart(data, tickers) {
  let i = 0;
  for (const t of tickers) i = Math.max(i, data.tickers[t].offset);
  return addMonths(data.start, i);
}

// 과거 실제 주가·배당·환율로 시뮬레이션 입력을 만든다.
export function backtestInput(data, tickers, startYM, endYM = data.end) {
  const s = monthIndex(data, startYM);
  const e = monthIndex(data, endYM);
  const months = [];
  for (let i = s; i <= e; i++) months.push(addMonths(data.start, i));
  const series = {};
  for (const t of tickers) {
    const d = data.tickers[t];
    const price = [], div = [];
    for (let i = s; i <= e; i++) {
      const j = i - d.offset;
      price.push(j >= 0 ? d.price[j] : null);
      div.push(j >= 0 ? d.div[j] : 0);
    }
    series[t] = { price, div, market: d.market, lag: d.lag };
  }
  return { months, fx: data.fx.slice(s, e + 1), series };
}

// 최근 12개월 배당 패턴과 가정 성장률로 미래를 투영한 입력을 만든다.
// months(개월 수)를 주면 그만큼, 아니면 years × 12개월. 데이터 마지막 달 다음 달부터 시작한다.
export function projectionInput(data, tickers, { years, months: count, priceGrowth, divGrowth, fx }) {
  const n = count ?? years * 12;
  const months = [];
  for (let k = 1; k <= n; k++) months.push(addMonths(data.end, k));
  const series = {};
  for (const t of tickers) {
    const d = data.tickers[t];
    const last = d.price[d.price.length - 1];
    const recent = d.div.slice(-12);
    while (recent.length < 12) recent.unshift(0);
    const price = [], div = [];
    for (let k = 1; k <= n; k++) {
      price.push(last * Math.pow(1 + priceGrowth, k / 12));
      div.push(recent[(k - 1) % 12] * Math.pow(1 + divGrowth, Math.ceil(k / 12)));
    }
    series[t] = { price, div, market: d.market, lag: d.lag };
  }
  return { months, fx: months.map(() => fx), series };
}

export function simulate(input, weightsIn, settingsIn = {}) {
  const S = { ...DEFAULT_SETTINGS, ...settingsIn };
  const { months, fx, series } = input;
  const tickers = Object.keys(weightsIn).filter((t) => weightsIn[t] > 0 && series[t]);
  const wSum = tickers.reduce((a, t) => a + weightsIn[t], 0) || 1;
  const w = Object.fromEntries(tickers.map((t) => [t, weightsIn[t] / wSum]));
  const isUS = (t) => series[t].market === "US";
  const toKRW = (t, v, i) => (isUS(t) ? v * fx[i] : v);

  // 재투자는 환전 비용이 없도록 같은 통화(시장) 종목끼리 비중대로 나눈다.
  const groupWeights = {};
  for (const mk of ["KR", "US"]) {
    const g = tickers.filter((t) => series[t].market === mk);
    const s = g.reduce((a, t) => a + w[t], 0);
    groupWeights[mk] = g.map((t) => [t, w[t] / s]);
  }

  const shares = Object.fromEntries(tickers.map((t) => [t, 0]));
  const pending = Object.fromEntries(tickers.map((t) => [t, 0])); // 종목별 대기 현금 (해당 통화)
  const costKRW = Object.fromEntries(tickers.map((t) => [t, 0])); // 미국 종목 원화 취득원가
  const receivables = [];
  const withdrawalsAt = new Map();
  for (const wd of S.withdrawals || []) {
    if (wd.amount > 0) withdrawalsAt.set(wd.month, (withdrawalsAt.get(wd.month) || 0) + wd.amount);
  }
  const yearGain = {}, yearCgt = {};

  const rows = [];
  let cumContrib = 0, cumDivNet = 0, cumWithdrawn = 0, cumTax = 0;

  for (let i = 0; i < months.length; i++) {
    const year = months[i].slice(0, 4);
    const switched = S.switchAfterMonths != null && i >= S.switchAfterMonths;
    const ratio = switched ? S.reinvestRatio2 : S.reinvestRatio;
    const fixed = S.withdrawMonthly != null;                       // 금액 인출 모드
    let need = fixed ? (switched ? S.withdrawMonthly2 : S.withdrawMonthly) || 0 : 0;
    const row = {
      month: months[i], fx: fx[i],
      contrib: 0, divGross: 0, divTax: 0, divNet: 0, divReinvest: 0, divWithdraw: 0,
      lumpWithdraw: 0, sellWithdraw: 0, shortfall: 0, cgt: 0, byTicker: {},
    };

    // 1) 배당락
    for (const t of tickers) {
      const dps = series[t].div[i];
      if (dps > 0 && shares[t] > 0) receivables.push({ pay: i + series[t].lag, t, gross: shares[t] * dps });
    }

    // 2) 배당 입금 — 금액 인출 모드는 원화 배당부터 인출액을 채우고 남는 배당을 재투자
    const paid = [];
    for (let r = receivables.length - 1; r >= 0; r--) {
      const rec = receivables[r];
      if (rec.pay !== i) continue;
      receivables.splice(r, 1);
      const { t, gross } = rec;
      const tax = gross * (isUS(t) ? S.taxUS : S.taxKR);
      const net = gross - tax;
      row.divGross += toKRW(t, gross, i);
      row.divTax += toKRW(t, tax, i);
      row.divNet += toKRW(t, net, i);
      row.byTicker[t] = (row.byTicker[t] || 0) + toKRW(t, net, i);
      paid.push({ t, net });
    }
    paid.sort((a, b) => isUS(a.t) - isUS(b.t));
    for (const { t, net } of paid) {
      const rate = isUS(t) ? fx[i] * (1 - S.fxSpread) : 1;      // 해당 통화 → 원화 수령
      let out;
      if (fixed) {
        out = Math.min(net, need / rate);
        need -= out * rate;
      } else out = net * (1 - ratio);
      const re = net - out;
      for (const [t2, gw] of groupWeights[series[t].market]) pending[t2] += re * gw;
      row.divReinvest += toKRW(t, re, i);
      row.divWithdraw += out * rate;
    }

    // 3) 납입
    const contrib = (i === 0 ? S.initial : 0) + (i > 0 ? S.monthly : 0);
    if (contrib > 0) {
      for (const t of tickers) {
        const krw = contrib * w[t];
        pending[t] += isUS(t) ? krw / (fx[i] * (1 + S.fxSpread)) : krw;
      }
      row.contrib = contrib;
    }

    // 4) 목돈 인출 + 배당이 모자란 달의 매도 인출 — 보유 비중대로 팔아 원화로
    const sellFor = (want) => {
      const value = {};
      let total = 0;
      for (const t of tickers) {
        value[t] = toKRW(t, shares[t] * series[t].price[i] + pending[t], i);
        total += value[t];
      }
      const target = Math.min(want, total);
      let got = 0;
      for (const t of tickers) {
        if (!total || !value[t]) continue;
        const p = series[t].price[i];
        const rate = isUS(t) ? fx[i] * (1 - S.fxSpread) : 1; // 해당 통화 → 원화 수령
        let amt = (target * value[t]) / total / rate;        // 해당 통화 기준 필요 금액
        if (pending[t] < amt && shares[t] > 0) {
          const short = amt - pending[t];
          const exact = short / p;
          const sell = Math.min(shares[t], isUS(t) && S.fractionalUS ? exact : Math.ceil(exact - 1e-9));
          if (isUS(t)) {
            const basis = shares[t] > 0 ? (costKRW[t] * sell) / shares[t] : 0;
            costKRW[t] -= basis;
            yearGain[year] = (yearGain[year] || 0) + sell * p * fx[i] - basis;
          }
          shares[t] -= sell;
          pending[t] += sell * p;
        }
        amt = Math.min(amt, pending[t]);
        pending[t] -= amt;
        got += amt * rate;
      }
      return got;
    };
    const lumpGot = (withdrawalsAt.get(i) || 0) > 0 ? sellFor(withdrawalsAt.get(i)) : 0;
    const sellGot = need > 0.5 && S.sellForWithdraw ? sellFor(need) : 0;
    if (lumpGot + sellGot > 0) {
      // 해외주식 양도세: 연간 누적 차익에서 기본공제를 넘는 부분에 대해 매도 시점에 바로 정산
      const due = Math.max(0, (yearGain[year] || 0) - S.cgtDeduction) * S.cgtRate - (yearCgt[year] || 0);
      const cgt = Math.max(0, Math.min(due, lumpGot + sellGot));
      yearCgt[year] = (yearCgt[year] || 0) + cgt;
      row.cgt = cgt;
      const lumpShare = lumpGot / (lumpGot + sellGot);
      row.lumpWithdraw = lumpGot - cgt * lumpShare;
      row.sellWithdraw = sellGot - cgt * (1 - lumpShare);
    }
    if (fixed) row.shortfall = Math.max(0, need - sellGot);

    // 5) 매수
    for (const t of tickers) {
      const p = series[t].price[i];
      if (!(p > 0) || pending[t] <= 0) continue;
      const n = isUS(t) && S.fractionalUS ? pending[t] / p : Math.floor(pending[t] / p + 1e-9);
      if (n <= 0) continue;
      shares[t] += n;
      pending[t] -= n * p;
      if (pending[t] < 1e-9) pending[t] = 0;
      if (isUS(t)) costKRW[t] += n * p * fx[i];
    }

    // 기록
    let mv = 0, cash = 0;
    const holdings = {};
    for (const t of tickers) {
      const v = toKRW(t, shares[t] * series[t].price[i], i);
      mv += v;
      cash += toKRW(t, pending[t], i);
      holdings[t] = { shares: shares[t], value: v };
    }
    cumContrib += row.contrib;
    cumDivNet += row.divNet;
    cumTax += row.divTax + row.cgt;
    cumWithdrawn += row.divWithdraw + row.lumpWithdraw + row.sellWithdraw;
    rows.push({
      ...row, marketValue: mv, cash, balance: mv + cash, holdings,
      cumContrib, cumDivNet, cumWithdrawn, cumTax, wealth: mv + cash + cumWithdrawn,
    });
  }
  return { rows, summary: summarize(rows), years: yearly(rows) };
}

export function summarize(rows) {
  const last = rows[rows.length - 1];
  if (!last) return null;
  const recent = rows.slice(-12);
  const ttmNet = recent.reduce((a, r) => a + r.divNet, 0);
  return {
    balance: last.balance,
    contributed: last.cumContrib,
    withdrawn: last.cumWithdrawn,
    wealth: last.wealth,
    profit: last.wealth - last.cumContrib,
    cumDivNet: last.cumDivNet,
    cumTax: last.cumTax,
    ttmNet,
    monthlyAvg: ttmNet / Math.max(1, recent.length),
    yieldOnCost: last.cumContrib ? ttmNet / last.cumContrib : 0,
    byMonthOfYear: recent.map((r) => ({ month: r.month, net: r.divNet })),
  };
}

export function yearly(rows) {
  const out = [];
  for (const r of rows) {
    const y = r.month.slice(0, 4);
    let cur = out[out.length - 1];
    if (!cur || cur.year !== y) {
      cur = { year: y, months: 0, contrib: 0, divGross: 0, divTax: 0, divNet: 0, divWithdraw: 0, lumpWithdraw: 0, sellWithdraw: 0, cgt: 0 };
      out.push(cur);
    }
    cur.months++;
    for (const k of ["contrib", "divGross", "divTax", "divNet", "divWithdraw", "lumpWithdraw", "sellWithdraw", "cgt"]) cur[k] += r[k];
    cur.endBalance = r.balance;
  }
  for (const y of out) y.comprehensiveTax = y.divGross > COMPREHENSIVE_TAX_THRESHOLD;
  return out;
}

// 내 설정 + 비교용 두 시나리오(전액 재투자 / 전액 인출)를 한 번에 계산
export function compareScenarios(input, weights, settings) {
  const mine = simulate(input, weights, settings);
  const base = { ...settings, switchAfterMonths: null };
  return [
    { key: "mine", label: "내 설정", result: mine },
    { key: "reinvest", label: "전액 재투자", result: simulate(input, weights, { ...base, reinvestRatio: 1 }) },
    { key: "withdraw", label: "전액 인출", result: simulate(input, weights, { ...base, reinvestRatio: 0 }) },
  ];
}

// 계좌별 결과를 월별로 합친다 (같은 기간이어야 함)
const SUM_KEYS = [
  "contrib", "divGross", "divTax", "divNet", "divReinvest", "divWithdraw", "lumpWithdraw", "sellWithdraw", "shortfall", "cgt",
  "marketValue", "cash", "balance", "cumContrib", "cumDivNet", "cumWithdrawn", "cumTax", "wealth",
];
export function combineResults(results) {
  const rows = [];
  const n = results[0]?.rows.length ?? 0;
  for (let i = 0; i < n; i++) {
    const first = results[0].rows[i];
    const row = { month: first.month, fx: first.fx, byTicker: {}, holdings: {} };
    for (const k of SUM_KEYS) row[k] = 0;
    for (const r of results) {
      const x = r.rows[i];
      for (const k of SUM_KEYS) row[k] += x[k];
      for (const [t, v] of Object.entries(x.byTicker)) row.byTicker[t] = (row.byTicker[t] || 0) + v;
      for (const [t, h] of Object.entries(x.holdings)) {
        const cur = (row.holdings[t] ||= { shares: 0, value: 0 });
        cur.shares += h.shares;
        cur.value += h.value;
      }
    }
    rows.push(row);
  }
  return { rows, summary: summarize(rows), years: yearly(rows) };
}
