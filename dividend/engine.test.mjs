// 시뮬레이션 엔진 테스트:  node --test dividend/engine.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { simulate, backtestInput, projectionInput, compareScenarios, addMonths } from "../site/engine.js";

const NO_FEES = { fxSpread: 0, monthly: 0 };

// 2020-01부터 n개월, 고정 가격과 지정 월 배당을 갖는 합성 데이터
function makeData(n, tickers, fx = 1000) {
  const out = { start: "2020-01", end: addMonths("2020-01", n - 1), fx: Array(n).fill(fx), tickers: {} };
  for (const [t, d] of Object.entries(tickers)) {
    const price = Array.from({ length: n }, (_, i) => (typeof d.price === "function" ? d.price(i) : d.price));
    const div = Array.from({ length: n }, (_, i) => (d.divMonths.includes((i % 12) + 1) ? d.dps : 0));
    out.tickers[t] = { market: d.market, lag: d.lag, offset: 0, price, div };
  }
  return out;
}

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test("국내 연배당: 4개월 뒤 입금, 15.4% 원천징수, 전액 인출", () => {
  const data = makeData(24, { KR1: { market: "KR", lag: 4, price: 10_000, dps: 500, divMonths: [12] } });
  const input = backtestInput(data, ["KR1"], "2020-01");
  const { rows, summary } = simulate(input, { KR1: 1 }, { ...NO_FEES, initial: 1_000_000, reinvestRatio: 0 });
  const apr = rows.find((r) => r.month === "2021-04");
  close(apr.divGross, 50_000);
  close(apr.divTax, 7_700);
  close(apr.divWithdraw, 42_300);
  assert.equal(rows.filter((r) => r.divGross > 0).length, 1); // 2021-12 배당은 기간 밖(2022-04)에 입금
  close(summary.balance, 1_000_000);
  close(summary.wealth, 1_042_300);
});

test("국내 재투자는 정수 주만 사고 남은 돈은 대기 현금", () => {
  const data = makeData(24, { KR1: { market: "KR", lag: 4, price: 10_000, dps: 500, divMonths: [12] } });
  const { rows } = simulate(backtestInput(data, ["KR1"], "2020-01"), { KR1: 1 }, { ...NO_FEES, initial: 1_000_000 });
  const apr = rows.find((r) => r.month === "2021-04");
  assert.equal(apr.holdings.KR1.shares, 104);
  close(apr.cash, 2_300);
});

test("미국 배당: 15% 원천징수, 환율 적용, 환전 수수료", () => {
  const data = makeData(12, { US1: { market: "US", lag: 0, price: 10, dps: 1, divMonths: [3, 6, 9, 12] } }, 1000);
  const input = backtestInput(data, ["US1"], "2020-01");
  const { rows } = simulate(input, { US1: 1 }, { monthly: 0, fxSpread: 0.01, initial: 1_010_000, reinvestRatio: 0 });
  close(rows[0].holdings.US1.shares, 100);          // 1,010,000 / (1000 × 1.01) = 1000달러
  const mar = rows[2];
  close(mar.divGross, 100_000);
  close(mar.divTax, 15_000);
  close(mar.divWithdraw, 85 * 1000 * 0.99);         // 원화 인출 시에도 스프레드
});

test("전환: 12개월 재투자 후 인출", () => {
  const data = makeData(36, { US1: { market: "US", lag: 0, price: 10, dps: 1, divMonths: [3, 6, 9, 12] } });
  const { rows } = simulate(backtestInput(data, ["US1"], "2020-01"), { US1: 1 },
    { ...NO_FEES, initial: 1_000_000, reinvestRatio: 1, switchAfterMonths: 12, reinvestRatio2: 0 });
  assert.ok(rows.slice(0, 12).every((r) => r.divWithdraw === 0));
  assert.ok(rows.slice(12).filter((r) => r.divNet > 0).every((r) => r.divReinvest === 0 && r.divWithdraw > 0));
  const sharesAfter = rows[11].holdings.US1.shares;
  assert.ok(sharesAfter > 100);
  close(rows[35].holdings.US1.shares, sharesAfter);
});

test("일시 인출: 미국 종목 차익 250만원 초과분 22% 양도세", () => {
  // 10달러 → 20달러, 1,000만원 투자 후 1,000만원 인출 → 차익 500만원, 과세 250만원 × 22%
  const data = makeData(12, { US1: { market: "US", lag: 0, price: (i) => (i < 6 ? 10 : 20), dps: 0, divMonths: [] } });
  const { rows, summary } = simulate(backtestInput(data, ["US1"], "2020-01"), { US1: 1 },
    { ...NO_FEES, initial: 10_000_000, withdrawals: [{ month: 6, amount: 10_000_000 }] });
  close(rows[6].cgt, 550_000, 1e-3);
  close(rows[6].lumpWithdraw, 9_450_000, 1e-3);
  close(summary.balance, 10_000_000, 1e-3);
});

test("자산 보존: 배당·가격 변동이 없으면 잔액 = 누적 납입", () => {
  const data = makeData(60, {
    KR1: { market: "KR", lag: 1, price: 7_300, dps: 0, divMonths: [] },
    US1: { market: "US", lag: 0, price: 33.3, dps: 0, divMonths: [] },
  });
  const { summary } = simulate(backtestInput(data, ["KR1", "US1"], "2020-01"), { KR1: 1, US1: 1 },
    { fxSpread: 0, initial: 3_000_000, monthly: 200_000 });
  close(summary.balance, summary.contributed, 1e-3);
});

test("예측 모드와 시나리오 비교", () => {
  const data = makeData(24, { US1: { market: "US", lag: 0, price: 10, dps: 0.25, divMonths: [3, 6, 9, 12] } });
  const input = projectionInput(data, ["US1"], { years: 10, priceGrowth: 0.05, divGrowth: 0.05, fx: 1300 });
  assert.equal(input.months.length, 120);
  assert.equal(input.months[0], "2022-01");
  const [mine, reinvest, withdraw] = compareScenarios(input, { US1: 1 }, { initial: 10_000_000, monthly: 0, reinvestRatio: 0.5 });
  assert.equal(mine.key, "mine");
  assert.ok(reinvest.result.summary.balance > mine.result.summary.balance);
  assert.ok(mine.result.summary.balance > withdraw.result.summary.balance);
  assert.ok(withdraw.result.summary.withdrawn > mine.result.summary.withdrawn);
});

test("계좌 합산: 월별 금액과 종목별 배당을 더한다", async () => {
  const { combineResults } = await import("../site/engine.js");
  const data = makeData(12, {
    KR1: { market: "KR", lag: 0, price: 10_000, dps: 100, divMonths: [6] },
    US1: { market: "US", lag: 0, price: 10, dps: 0.1, divMonths: [6] },
  });
  const input = backtestInput(data, ["KR1", "US1"], "2020-01");
  const a = simulate(input, { KR1: 1 }, { ...NO_FEES, initial: 1_000_000, taxKR: 0 });
  const b = simulate(input, { KR1: 1, US1: 1 }, { ...NO_FEES, initial: 2_000_000 });
  const c = combineResults([a, b]);
  close(c.summary.contributed, 3_000_000);
  close(c.rows[11].balance, a.rows[11].balance + b.rows[11].balance);
  close(c.rows[5].byTicker.KR1, a.rows[5].byTicker.KR1 + b.rows[5].byTicker.KR1);
  close(c.rows[11].holdings.KR1.shares, a.rows[11].holdings.KR1.shares + b.rows[11].holdings.KR1.shares);
  assert.equal(c.years.length, 1);
});

test("계좌 규칙: ISA 해지세, 연금 세액공제, 담을 수 있는 종목", async () => {
  const { isaExitTax, pensionCredit, allowedIn, limitWarnings } = await import("../site/accounts.js");
  close(isaExitTax({ balance: 15_000_000, withdrawn: 0, contributed: 10_000_000 }).tax, 3_000_000 * 0.099);
  close(isaExitTax({ balance: 15_000_000, withdrawn: 0, contributed: 10_000_000 }, "서민형").tax, 1_000_000 * 0.099);
  close(pensionCredit([{ contrib: 12_000_000 }, { contrib: 6_000_000 }], 0.165), (9_000_000 + 6_000_000) * 0.165);
  assert.ok(allowedIn("isa", { market: "US", type: "ETF" }));
  assert.equal(allowedIn("isa", { market: "KR", type: "주식" }), null);
  assert.ok(allowedIn("pension", { market: "KR", type: "주식" }));
  assert.equal(allowedIn("pension", { market: "KR", type: "ETF" }), null);
  assert.equal(limitWarnings("isa", [{ year: "2026", contrib: 20_000_000 }, { year: "2027", contrib: 25_000_000 }]).length, 1);
  assert.equal(limitWarnings("pension", [{ year: "2026", contrib: 18_000_000 }]).length, 0);
});

test("예측 기간을 개월 수로 지정", () => {
  const data = makeData(24, { US1: { market: "US", lag: 0, price: 10, dps: 0.25, divMonths: [3, 6, 9, 12] } });
  const input = projectionInput(data, ["US1"], { months: 7, priceGrowth: 0, divGrowth: 0, fx: 1300 });
  assert.equal(input.months.length, 7);
  assert.equal(input.months.at(-1), "2022-07");
});

test("매달 금액 인출: 배당에서 먼저, 모자라면 그대로 두거나 주식을 팔아 채운다", () => {
  // 1,000만원(1,000주 × 1만원), 3·6·9·12월 주당 500원 배당(세금 0) → 분기마다 50만원
  const data = makeData(12, { KR1: { market: "KR", lag: 0, price: 10_000, dps: 500, divMonths: [3, 6, 9, 12] } });
  const input = backtestInput(data, ["KR1"], "2020-01");
  const base = { ...NO_FEES, initial: 10_000_000, taxKR: 0, withdrawMonthly: 200_000 };
  const a = simulate(input, { KR1: 1 }, base);
  close(a.rows[2].divWithdraw, 200_000);              // 배당 50만 중 20만 인출
  close(a.rows[2].divReinvest, 300_000);              // 나머지 30만 재투자
  close(a.rows[3].shortfall, 200_000);                // 배당 없는 달은 부족
  close(a.summary.withdrawn, 4 * 200_000);
  const b = simulate(input, { KR1: 1 }, { ...base, sellForWithdraw: true });
  close(b.rows[3].sellWithdraw, 200_000);             // 주식 20주를 팔아 채움
  close(b.rows[3].shortfall, 0);
  close(b.summary.withdrawn, 12 * 200_000);          // 첫 달은 매수 전 대기 현금에서 인출
  const c = simulate(input, { KR1: 1 }, { ...base, withdrawMonthly: 0, switchAfterMonths: 6, withdrawMonthly2: 100_000 });
  close(c.rows[5].divWithdraw, 0);
  close(c.rows[8].divWithdraw, 100_000);
});
