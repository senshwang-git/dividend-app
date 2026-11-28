// 계좌 종류별 규칙 (일반 · ISA · 연금). 2026년 세법 기준 근사치.
//   일반: 배당 원천징수(국내 15.4%, 미국 15%), 금융소득종합과세 대상
//   ISA(중개형): 국내 상장 종목만, 계좌 안 배당은 비과세로 재투자,
//               해지 시 순이익 중 비과세 한도(일반형 200만원, 서민형 400만원) 초과분 9.9% 분리과세,
//               납입 한도 연 2,000만원 · 총 1억원
//   연금(연금저축·IRP): 국내 상장 ETF·리츠만, 계좌 안 배당은 과세 이연으로 재투자,
//               납입액 연 900만원까지 세액공제(13.2% 또는 16.5%), 납입 한도 연 1,800만원,
//               연금 수령 시 연금소득세 3.3~5.5%

export const ACCOUNTS = [
  { key: "general", name: "일반", long: "일반 계좌" },
  { key: "isa", name: "ISA", long: "ISA (중개형)" },
  { key: "pension", name: "연금", long: "연금저축·IRP" },
];

export const ISA_FREE = { 일반형: 2_000_000, 서민형: 4_000_000 };
export const ISA_TAX = 0.099;
export const ISA_YEAR_LIMIT = 20_000_000;
export const ISA_TOTAL_LIMIT = 100_000_000;
export const PENSION_YEAR_LIMIT = 18_000_000;
export const PENSION_CREDIT_CAP = 9_000_000;

// 이 계좌에 담을 수 있는 종목인지. 안 되면 이유 문자열
export function allowedIn(key, d) {
  if (key === "isa" && d.market !== "KR") return "ISA에는 국내 상장 종목만 담을 수 있습니다";
  if (key === "pension" && (d.market !== "KR" || !["ETF", "리츠"].includes(d.type))) return "연금 계좌에는 국내 상장 ETF·리츠만 담을 수 있습니다";
  return null;
}

// 계좌 안에서 배당에 바로 붙는 세금
export function dividendTax(key, { taxKR, taxUS }) {
  return key === "general" ? { taxKR, taxUS } : { taxKR: 0, taxUS: 0 };
}

// 계좌를 정리할 때(ISA 해지) 내는 세금 추정
export function isaExitTax(summary, type = "일반형") {
  const profit = summary.balance + summary.withdrawn - summary.contributed;
  const taxable = Math.max(0, profit - (ISA_FREE[type] ?? ISA_FREE.일반형));
  return { profit, taxable, tax: taxable * ISA_TAX };
}

// 연금 납입 세액공제 (연도별 납입액 → 연말정산 환급액 합계)
export function pensionCredit(years, rate = 0.132) {
  return years.reduce((a, y) => a + Math.min(y.contrib, PENSION_CREDIT_CAP) * rate, 0);
}

// 연도별 납입이 한도를 넘는지
export function limitWarnings(key, years) {
  const out = [];
  if (key === "isa") {
    // 한도는 이월되므로 누적 한도(가입 연차 × 2,000만원, 최대 1억원)와 비교
    let cum = 0;
    years.forEach((y, k) => {
      cum += y.contrib;
      const cap = Math.min(ISA_YEAR_LIMIT * (k + 1), ISA_TOTAL_LIMIT);
      if (cum > cap + 1) out.push(`${y.year}년까지 ISA 납입 누적 ${Math.round(cum / 1e4).toLocaleString()}만원이 한도(${Math.round(cap / 1e4).toLocaleString()}만원)를 넘습니다`);
    });
  }
  if (key === "pension") {
    for (const y of years) if (y.contrib > PENSION_YEAR_LIMIT + 1) out.push(`${y.year}년 연금 납입 ${Math.round(y.contrib / 1e4).toLocaleString()}만원이 연 한도 1,800만원을 넘습니다`);
  }
  return out.slice(0, 1);
}
