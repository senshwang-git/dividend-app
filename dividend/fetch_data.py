"""배당 시뮬레이터 데이터 수집.

universe.json의 종목별 월말 종가·월별 배당(배당락 기준)과 원/달러 환율을
Yahoo Finance(yfinance)에서 받아 docs/dividend/data.json으로 저장한다.
화면의 '데이터 새로고침' 버튼이 GitHub Actions(dividend_data.yml)를 실행해 이 스크립트를 돌린다.

  python dividend/fetch_data.py
"""
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
import yfinance as yf

ROOT = Path(__file__).resolve().parent.parent
UNIVERSE = ROOT / "dividend" / "universe.json"
# 앱 전용 저장소(dividend-app)에서는 DIVIDEND_OUTPUT=site/data.json 으로 실행
OUTPUT = ROOT / os.environ.get("DIVIDEND_OUTPUT", "docs/dividend/data.json")

START = "2010-01"          # 시뮬레이션 데이터 시작 월
FX_TICKER = "KRW=X"        # 1달러당 원화
MAX_FAIL_RATIO = 0.3       # 이 비율 이상 실패하면 기존 data.json을 덮어쓰지 않음


def month_range(start, end):
    return [p.strftime("%Y-%m") for p in pd.period_range(start, end, freq="M")]


def last_complete_month():
    now = pd.Timestamp.now(tz="UTC")
    return (now.to_period("M") - 1).strftime("%Y-%m")


def download(ticker):
    """일별 이력과 Yahoo에 등록된 종목명(티커 확인용)."""
    tk = yf.Ticker(ticker)
    hist = tk.history(start=f"{START}-01", auto_adjust=False, actions=True)
    if hist.empty:
        raise ValueError("가격 데이터 없음")
    hist.index = hist.index.tz_localize(None) if hist.index.tz is not None else hist.index
    meta = getattr(tk, "history_metadata", None) or {}
    return hist, meta.get("longName") or meta.get("shortName") or ""


def latest(hist):
    """가장 최근 거래일 종가와 날짜 — 새로고침 시점의 현재가."""
    close = hist["Close"].dropna()
    return float(close.iloc[-1]), close.index[-1].strftime("%Y-%m-%d")


def to_monthly(hist):
    """일별 이력 → {YYYY-MM: (월말 종가, 해당 월 배당락 합계)}.

    Close는 분할만 반영된(배당 미반영) 종가라 배당을 따로 더해도 이중 계산되지 않는다.
    """
    period = hist.index.to_period("M")
    close = hist["Close"].groupby(period).last()
    divs = hist["Dividends"].groupby(period).sum() if "Dividends" in hist else close * 0
    return {p.strftime("%Y-%m"): (float(close[p]), float(divs.get(p, 0.0))) for p in close.index}


def series_for(monthly, months):
    """전역 월 축(months)에 맞춘 배열. 상장 전 구간은 잘라내고 offset으로 표시."""
    first = next((i for i, m in enumerate(months) if m in monthly), None)
    if first is None:
        raise ValueError("시뮬레이션 기간 내 데이터 없음")
    price, div = [], []
    last_price = None
    for m in months[first:]:
        if m in monthly:
            last_price, d = monthly[m]
        else:
            d = 0.0  # 거래 없는 달은 직전 종가 유지
        price.append(last_price)
        div.append(d)
    return first, price, div


def stats(price, div, months, offset):
    """종목 선택 화면용 요약: 최근 12개월 배당, 수익률, 지급 주기, 5년 배당성장률."""
    ttm = sum(div[-12:])
    last = price[-1]
    pay_months = sorted({int(months[offset + i][5:]) for i in range(max(0, len(div) - 12), len(div)) if div[i] > 0})
    n = len(pay_months)
    freq = "월" if n >= 10 else "분기" if n >= 3 else "반기" if n == 2 else "연" if n == 1 else "-"

    yearly = {}
    for i, d in enumerate(div):
        y = int(months[offset + i][:4])
        yearly[y] = yearly.get(y, 0.0) + d
    end_year = int(months[-1][:4]) - 1  # 마지막 완결 연도
    growth = None
    if yearly.get(end_year, 0) > 0 and yearly.get(end_year - 5, 0) > 0 and int(months[offset][:4]) < end_year - 5:
        growth = (yearly[end_year] / yearly[end_year - 5]) ** (1 / 5) - 1
    return {
        "price": last,
        "dpsTTM": round(ttm, 4),
        "yield": ttm / last if last else 0,
        "freq": freq,
        "payMonths": pay_months,
        "growth5y": growth,
    }


def rnd(values, digits):
    return [round(v, digits) for v in values]


def main():
    universe = json.loads(UNIVERSE.read_text(encoding="utf-8"))["tickers"]
    end = last_complete_month()
    months = month_range(START, end)

    fx_hist, _ = download(FX_TICKER)
    fx_monthly = to_monthly(fx_hist)
    fx_last, fx_date = latest(fx_hist)
    _, fx, _ = series_for(fx_monthly, months)
    if len(fx) != len(months):
        raise SystemExit("환율 데이터가 시작 월부터 존재하지 않습니다")

    tickers, failed = {}, []
    for item in universe:
        t = item["ticker"]
        try:
            hist, yahoo_name = download(t)
            offset, price, div = series_for(to_monthly(hist), months)
            last_price, last_date = latest(hist)
            currency = "KRW" if item["market"] == "KR" else "USD"
            digits = 0 if currency == "KRW" else 4
            price, div = rnd(price, digits), rnd(div, 4)
            st = stats(price, div, months, offset)
            st["price"] = round(last_price, digits)          # 수익률·평가액은 최신 종가 기준
            st["yield"] = st["dpsTTM"] / last_price if last_price else 0
            tickers[t] = {
                **{k: item[k] for k in ("name", "market", "type", "sector", "lag")},
                "popular": bool(item.get("popular")),
                "recommend": item.get("recommend", []),
                "currency": currency,
                "offset": offset,
                "price": price,
                "div": div,
                "stats": st,
                "last": {"price": st["price"], "date": last_date},
                "yahooName": yahoo_name,
            }
            print(f"OK   {t:10s} {item['name']} = {yahoo_name} ({months[offset]}~, {last_date} {st['price']}, 수익률 {st['yield']:.2%})")
        except Exception as e:  # 개별 종목 실패는 건너뛴다
            failed.append(t)
            print(f"FAIL {t:10s} {item['name']}: {e}", file=sys.stderr)

    if len(failed) > len(universe) * MAX_FAIL_RATIO:
        raise SystemExit(f"실패 종목이 너무 많아 저장하지 않음: {failed}")

    out = {
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "start": months[0],
        "end": months[-1],
        "fx": rnd(fx, 2),
        "fxLast": {"rate": round(fx_last, 2), "date": fx_date},
        "tickers": tickers,
        "failed": failed,
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"저장: {OUTPUT} ({len(tickers)}종목, {months[0]}~{months[-1]}, 실패 {len(failed)})")


if __name__ == "__main__":
    main()
