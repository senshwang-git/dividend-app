import {
  backtestInput, projectionInput, simulate, combineResults, earliestCommonStart, monthIndex, addMonths, DEFAULT_SETTINGS,
} from "./engine.js";
import {
  ACCOUNTS, allowedIn, dividendTax, isaExitTax, pensionCredit, limitWarnings, ISA_FREE,
} from "./accounts.js";
import { nf, man, won, manNum, pct, cssVar, esc, drawChart, legend } from "./charts.js";

// 흐름: 입력(기간 · 계좌별 금액·종목) → 결과 보기 → 결과 저장 → 저장함에서 다시 보기·비교
// 입력값은 마지막 상태가 자동으로 남고, '내 설정'에 이름을 붙여 저장·불러오기할 수 있다.

// 새로고침 버튼이 실행하는 GitHub 저장소·워크플로
const GH = {
  server: "github", owner: "senshwang-git", repo: "dividend-app", ref: "main",
  workflow: "update.yml", path: "site/data.json",
};
const DRAFT_KEY = "dividend-input-v3";
const SAVED_KEY = "dividend-saved-v1";
const PRESET_KEY = "dividend-presets-v1";
const DATA_CACHE_KEY = "dividend-data-cache-v1";
const SERIES = ["--s1", "--s2", "--s3", "--s4", "--s5", "--s6", "--s7"];
const OTHER = "--s8";
const TABS = ["input", "result", "saved"];
const ACCT_NAME = Object.fromEntries(ACCOUNTS.map((a) => [a.key, a.name]));

// 처음 열었을 때 채워 둘 예시
const exampleAccounts = () => ({
  general: { on: true, initial: 1000, monthly: 30, holdings: [{ t: "SCHD", w: 40 }, { t: "O", w: 30 }, { t: "KO", w: 30 }] },
  isa: { on: true, initial: 1000, monthly: 50, type: "일반형", holdings: [{ t: "105560.KS", w: 40 }, { t: "086790.KS", w: 30 }, { t: "033780.KS", w: 30 }] },
  pension: { on: true, initial: 300, monthly: 50, creditRate: 13.2, holdings: [{ t: "161510.KS", w: 60 }, { t: "279530.KS", w: 40 }] },
});

// 결과에 영향을 주는 입력값 (설정·결과 저장 대상)
const INPUT_KEYS = [
  "accounts", "mode", "startYM", "endYM", "projEndYM", "priceGrowth", "divGrowth", "fxAssume",
  "wdMonthly", "wdSell", "switchOn", "switchYear", "wdMonthly2", "withdrawals", "taxKR", "taxUS", "fxSpread", "fractionalUS",
];

const state = {
  tab: "input",
  example: true,
  presetId: null,         // 마지막으로 불러오거나 저장한 내 설정
  acct: "general",        // 입력 중인 계좌
  accounts: exampleAccounts(),
  mode: "backtest",
  startYM: null,          // 과거: 시작·끝 월 (null이면 기본값)
  endYM: null,
  projEndYM: null,        // 예측: 끝 월
  priceGrowth: 4,
  divGrowth: 5,
  fxAssume: null,
  wdMonthly: 0,           // 일반 계좌 매달 인출액 (만원)
  wdSell: false,          // 배당이 모자란 달엔 주식을 팔아 채움
  switchOn: false,
  switchYear: 10,
  wdMonthly2: 0,          // 중간 변경 후 매달 인출액 (만원)
  withdrawals: [],        // [{ year: n년차, amount: 만원 }] — 일반 계좌
  taxKR: DEFAULT_SETTINGS.taxKR * 100,
  taxUS: DEFAULT_SETTINGS.taxUS * 100,
  fxSpread: DEFAULT_SETTINGS.fxSpread * 100,
  fractionalUS: true,
  divView: "year",
  fMarket: "",
  fSort: "yield",
  fPopular: true,
  query: "",
};
const DRAFT = Object.keys(state).filter((k) => k !== "query" && k !== "tab");

let DATA = null;
let last = null;          // 마지막으로 계산한 결과
let saved = [];           // 저장한 결과
let presets = [];         // 내 설정
let pickerOpen = false;
let pendingDelete = null;
let presetDelete = false;
const $ = (id) => document.getElementById(id);
const latestFx = (d) => d.fxLast?.rate ?? d.fx[d.fx.length - 1];
const clone = (x) => JSON.parse(JSON.stringify(x));
const snapshotInputs = () => clone(Object.fromEntries(INPUT_KEYS.map((k) => [k, state[k]])));
const cur = () => state.accounts[state.acct];
const newId = (p) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// 이전 버전(계좌 구분 없음, 연 단위 기간)으로 저장된 입력값을 지금 형식으로
function normalizeInputs(inp) {
  const x = clone(inp);
  if (!x.accounts && !(x.holdings?.length)) x.accounts = exampleAccounts();
  if (!x.accounts) {
    const base = exampleAccounts();
    x.accounts = {
      general: { on: true, initial: x.initial ?? 0, monthly: x.monthly ?? 0, holdings: x.holdings || [] },
      isa: { ...base.isa, on: false },
      pension: { ...base.pension, on: false },
    };
  }
  if (x.startYM === undefined) x.startYM = x.startYear ? `${x.startYear}-01` : null;
  if (x.endYM === undefined) x.endYM = x.endYear ? `${x.endYear}-12` : null;
  if (x.projEndYM === undefined) x.projEndYM = null;
  if (x.wdMonthly === undefined) { x.wdMonthly = 0; x.wdMonthly2 = 0; x.wdSell = false; }
  delete x.reinvestPct; delete x.reinvestPct2;
  for (const k of ["holdings", "initial", "monthly", "startYear", "endYear", "years"]) delete x[k];
  return x;
}

/* ---------- 저장소: claude.ai 계정(비공개) 우선, 없으면 이 브라우저 ---------- */
const store = {
  kind: "local",
  draftDoc: null,
  runsCol: null,
  presetsCol: null,
  draftTimer: null,

  async connect() {
    const c = window.claude;
    if (!c?.use) return false;
    const [db, user] = await Promise.all([c.use("db"), c.use("user")]);
    if (!db || !user) return false;
    const uid = await user.id().catch(() => null);
    if (!uid) return false;
    const base = `data/users/${uid}`;
    this.draftDoc = db.doc(`${base}/draft`);
    const sim = db.doc(`${base}/sim`);
    this.runsCol = sim.collection("runs");
    this.presetsCol = sim.collection("presets");
    this.kind = "db";
    return true;
  },

  loadLocal() {
    try {
      const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null");
      if (d) applyDraft(d);
      saved = JSON.parse(localStorage.getItem(SAVED_KEY) || "[]");
      presets = JSON.parse(localStorage.getItem(PRESET_KEY) || "[]");
    } catch { /* 저장소를 못 쓰면 기본값 */ }
  },

  // 입력 중인 값은 바뀔 때만 (잠깐 모아서) 저장 — 다음에 열면 이어서 쓴다
  saveDraft() {
    const snap = Object.fromEntries(DRAFT.map((k) => [k, state[k]]));
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(snap)); } catch { /* 무시 */ }
    if (this.kind !== "db") return;
    clearTimeout(this.draftTimer);
    this.draftTimer = setTimeout(() => {
      this.draftDoc.set({ state: clone(snap), savedAt: Date.now() }).catch(() => {});
    }, 1500);
  },

  async put(kind, item) {
    if (this.kind === "db") return (kind === "run" ? this.runsCol : this.presetsCol).doc(item.id).set(item);
    const list = kind === "run" ? saved : presets;
    const i = list.findIndex((x) => x.id === item.id);
    if (i >= 0) list[i] = item; else list.push(item);
    this.saveLocal();
    kind === "run" ? renderSaved() : renderPresets();
  },

  async remove(kind, id) {
    if (this.kind === "db") return (kind === "run" ? this.runsCol : this.presetsCol).doc(id).delete();
    if (kind === "run") saved = saved.filter((x) => x.id !== id); else presets = presets.filter((x) => x.id !== id);
    this.saveLocal();
    kind === "run" ? renderSaved() : renderPresets();
  },

  saveLocal() {
    try {
      localStorage.setItem(SAVED_KEY, JSON.stringify(saved));
      localStorage.setItem(PRESET_KEY, JSON.stringify(presets));
    } catch { /* 무시 */ }
  },
};

function applyDraft(d) {
  const n = normalizeInputs(d);
  for (const k of DRAFT) if (k in n) state[k] = n[k];
}

async function connectAccount() {
  if (!(await store.connect())) { renderStoreNote(); return; }
  try {
    const snap = await store.draftDoc.get();
    if (snap.exists && snap.data()?.state) {
      applyDraft(snap.data().state);
      renderInputs();
    }
  } catch { /* 입력값을 못 읽어도 저장함은 쓸 수 있다 */ }
  const onErr = (err) => showStatus(`저장한 내용을 불러오지 못했습니다 (${err.code}). 페이지를 다시 열어 보세요.`, true);
  store.runsCol.onSnapshot((qs) => { saved = qs.docs.map((d) => ({ ...d.data(), id: d.id })); renderSaved(); }, onErr);
  store.presetsCol.onSnapshot((qs) => { presets = qs.docs.map((d) => ({ ...d.data(), id: d.id })); renderPresets(); }, onErr);
  renderStoreNote();
}

function renderStoreNote() {
  const where = store.kind === "db"
    ? "내 claude.ai 계정에 저장되어 다른 기기에서도 보이고, 다른 사람에게는 보이지 않습니다."
    : "이 기기의 이 브라우저에만 남습니다. 브라우저 데이터를 지우면 사라집니다.";
  $("store-note").textContent = `저장한 결과는 ${where}`;
  $("backup-card").hidden = store.kind === "db";
  $("preset-store").textContent = `입력값은 자동으로 이어지고, 저장한 설정은 ${where}`;
}

/* ---------- 데이터: 묶음 파일 → 캐시 → GitHub 최신본 ---------- */
function setData(d, { cache = true } = {}) {
  DATA = d;
  if (cache) try { localStorage.setItem(DATA_CACHE_KEY, JSON.stringify(d)); } catch { /* 용량 초과 등 무시 */ }
  const asof = d.fxLast?.date || d.end;
  $("data-asof").textContent = `${asof.slice(5).replace("-", "/")} 시세`;
  $("data-date").textContent = `${asof} 기준 · ${Object.keys(d.tickers).length}종목`;
}

async function loadData() {
  let bundled = null, cached = null;
  try {
    const res = await fetch("data.json", { cache: "no-cache" });
    if (res.ok) bundled = await res.json();
  } catch { /* 아래에서 처리 */ }
  try { cached = JSON.parse(localStorage.getItem(DATA_CACHE_KEY) || "null"); } catch { /* 무시 */ }
  const best = [bundled, cached].filter(Boolean).sort((a, b) => (a.generated < b.generated ? 1 : -1))[0];
  if (best) setData(best, { cache: best !== bundled });
  return !!best;
}

// get_file_contents 결과에서 파일 본문 꺼내기 (resource 블록 또는 JSON 텍스트 블록)
function fileText(result) {
  for (const b of result?.content || []) {
    if (b.type === "resource" && typeof b.resource?.text === "string") return b.resource.text;
  }
  for (const b of result?.content || []) {
    if (b.type === "text" && b.text.trim().startsWith("{")) return b.text;
  }
  if (typeof result?.payload === "object" && result.payload?.tickers) return JSON.stringify(result.payload);
  throw { code: "bad_file", message: "파일 내용을 읽지 못했습니다" };
}

async function pullLatest(mcp, { fresh = false } = {}) {
  const r = await mcp.callTool(GH.server, "get_file_contents",
    { owner: GH.owner, repo: GH.repo, path: GH.path, ref: `refs/heads/${GH.ref}` },
    { cache: fresh ? false : { staleTime: 60_000 } });
  const d = JSON.parse(fileText(r));
  if (!d?.tickers || !d.generated) throw { code: "bad_file", message: "데이터 형식이 올바르지 않습니다" };
  if (!DATA || d.generated > DATA.generated) {
    setData(d);
    renderInputs();
    return true;
  }
  return false;
}

function mcpMessage(e) {
  switch (e?.code) {
    case "needs_reauth": return "GitHub 연결이 만료됐습니다. claude.ai 설정 → 커넥터에서 GitHub를 다시 연결해 주세요.";
    case "server_not_connected":
    case "selection_required": return "GitHub 커넥터가 연결돼 있지 않습니다. claude.ai 설정 → 커넥터에서 GitHub를 추가해 주세요.";
    case "not_in_manifest": return "이 페이지에 GitHub 사용을 허용하지 않았습니다. 페이지의 권한 메뉴에서 허용한 뒤 다시 눌러 주세요.";
    case "blocked_by_policy":
    case "approval_required": return "조직 정책으로 GitHub 실행이 막혀 있습니다.";
    case "server_unavailable": return "GitHub가 잠시 응답하지 않습니다. 조금 뒤 다시 눌러 주세요.";
    case "tool_error": return `GitHub 오류: ${e.message}. 저장소의 기본 브랜치(main)에 배당 통장이 병합돼 있어야 합니다.`;
    case "run_failed": return "시세 수집 작업이 실패했습니다.";
    case "timeout": return "수집이 아직 끝나지 않았습니다. 1~2분 뒤 다시 눌러 주세요.";
    default: return `새로고침하지 못했습니다 (${e?.message || e?.code || "알 수 없는 오류"}).`;
  }
}

let refreshing = false;
async function refreshData() {
  if (refreshing) return;
  const mcp = window.claude?.use ? await window.claude.use("mcp") : null;
  if (!mcp) {
    // GitHub 커넥터를 쓸 수 없는 화면(GitHub Pages 등): 저장된 파일만 다시 읽는다
    const ok = await loadData();
    renderInputs();
    showStatus(ok ? `최신 시세 파일을 다시 불러왔습니다 (${DATA.fxLast?.date || DATA.end} 기준). 시세는 평일 하루 두 번 자동으로 갱신됩니다.` : "데이터를 불러오지 못했습니다.", !ok);
    return;
  }
  refreshing = true;
  $("refresh").setAttribute("aria-busy", "true");
  const t0 = Date.now();
  try {
    showStatus("최신 시세 수집을 시작합니다. 1~2분 걸립니다.");
    await mcp.callTool(GH.server, "actions_run_trigger",
      { method: "run_workflow", owner: GH.owner, repo: GH.repo, workflow_id: GH.workflow, ref: GH.ref }, { cache: false });
    let run = null;
    for (let i = 0; i < 45; i++) {
      await new Promise((r) => setTimeout(r, i < 3 ? 6000 : 5000));
      const res = await mcp.callTool(GH.server, "actions_list", {
        method: "list_workflow_runs", owner: GH.owner, repo: GH.repo, resource_id: GH.workflow,
        perPage: 5, workflow_runs_filter: { branch: GH.ref, event: "workflow_dispatch" },
      }, { cache: false });
      const runs = res.payload?.workflow_runs || [];
      run = runs.find((x) => Date.parse(x.created_at) >= t0 - 60_000) || null;
      const sec = Math.round((Date.now() - t0) / 1000);
      showStatus(run ? `시세 수집 중… ${sec}초 (${run.status === "queued" ? "대기" : "진행"} 중)` : `수집 작업을 기다리는 중… ${sec}초`);
      if (run?.status === "completed") break;
    }
    if (!run || run.status !== "completed") throw { code: "timeout" };
    if (run.conclusion !== "success") throw { code: "run_failed", url: run.html_url };
    showStatus("수집 완료. 새 데이터를 불러오는 중…");
    await new Promise((r) => setTimeout(r, 3000)); // 커밋 반영 대기
    const changed = await pullLatest(mcp, { fresh: true });
    showStatus(changed ? `${DATA.fxLast?.date || DATA.end} 시세로 갱신했습니다.` : "이미 최신 데이터입니다.");
  } catch (e) {
    showStatus(mcpMessage(e) + (e?.url ? ` <a href="${esc(e.url)}" target="_blank" rel="noopener">실행 기록 보기</a>` : ""), true, true);
  } finally {
    refreshing = false;
    $("refresh").setAttribute("aria-busy", "false");
  }
}

function showStatus(msg, isErr = false, html = false) {
  $("status-wrap").hidden = false;
  $("status").classList.toggle("err", isErr);
  if (html) $("status-text").innerHTML = msg; else $("status-text").textContent = msg;
}


/* ---------- 계산 ---------- */
const ymText = (ym) => `${ym.slice(0, 4)}년 ${Number(ym.slice(5))}월`;
const clampYM = (ym, lo, hi) => (ym < lo ? lo : ym > hi ? hi : ym);

// 켜져 있고 금액·종목이 있는 계좌 (계좌에 못 담는 종목은 뺀다)
function activeAccounts(inp) {
  return ACCOUNTS.map((a) => {
    const cfg = inp.accounts[a.key];
    const hs = (cfg?.holdings || []).filter((h) => DATA.tickers[h.t] && h.w > 0 && !allowedIn(a.key, DATA.tickers[h.t]));
    return { ...a, cfg, hs };
  }).filter((a) => a.cfg?.on && a.hs.length && (a.cfg.initial > 0 || a.cfg.monthly > 0));
}

// 실제 계산에 쓸 기간
function periodOf(inp, tickers) {
  if (inp.mode === "backtest") {
    const earliest = earliestCommonStart(DATA, tickers);
    const def = addMonths(DATA.end, -119);
    const start = clampYM(inp.startYM || (def > earliest ? def : earliest), earliest, DATA.end);
    const end = clampYM(inp.endYM || DATA.end, start, DATA.end);
    return { start, end, earliest, min: earliest, max: DATA.end };
  }
  const start = addMonths(DATA.end, 1);
  const max = addMonths(DATA.end, 480);
  const end = clampYM(inp.projEndYM || addMonths(DATA.end, 240), start, max);
  return { start, end, min: start, max };
}

function baseSettings(inp, months) {
  return {
    withdrawMonthly: (inp.wdMonthly || 0) * 1e4,
    sellForWithdraw: !!inp.wdSell,
    switchAfterMonths: inp.switchOn ? inp.switchYear * 12 : null,
    withdrawMonthly2: (inp.wdMonthly2 || 0) * 1e4,
    withdrawals: inp.withdrawals
      .filter((w) => w.amount > 0 && w.year >= 1 && w.year * 12 - 1 < months.length)
      .map((w) => ({ month: w.year * 12 - 1, amount: w.amount * 1e4 })),
    taxKR: inp.taxKR / 100,
    taxUS: inp.taxUS / 100,
    fxSpread: inp.fxSpread / 100,
    fractionalUS: inp.fractionalUS,
  };
}

// 계좌별 설정: ISA·연금은 배당을 계좌 안에서 세금 없이 전부 재투자, 목돈 인출은 일반 계좌만
function accountSettings(a, base, variant) {
  const s = { ...base, initial: a.cfg.initial * 1e4, monthly: a.cfg.monthly * 1e4, ...dividendTax(a.key, base) };
  const ratioMode = { withdrawMonthly: null, switchAfterMonths: null };
  if (a.key !== "general") return { ...s, ...ratioMode, reinvestRatio: 1, withdrawals: [] };
  if (variant === "reinvest") return { ...s, ...ratioMode, reinvestRatio: 1 };
  if (variant === "withdraw") return { ...s, ...ratioMode, reinvestRatio: 0 };
  return s;
}

// 입력값 → 결과. 입력이 부족하면 이유 문자열
function compute(inp) {
  const accts = activeAccounts(inp);
  if (!accts.length) return "계좌를 하나 이상 켜고 금액과 종목을 정해 주세요.";
  const tickers = [...new Set(accts.flatMap((a) => a.hs.map((h) => h.t)))];
  const p = periodOf(inp, tickers);
  const n = monthIndex({ start: p.start }, p.end) + 1;
  const input = inp.mode === "backtest"
    ? backtestInput(DATA, tickers, p.start, p.end)
    : projectionInput(DATA, tickers, {
      months: n, priceGrowth: inp.priceGrowth / 100, divGrowth: inp.divGrowth / 100, fx: inp.fxAssume || latestFx(DATA),
    });
  const base = baseSettings(inp, input.months);
  const run = (variant) => {
    const per = accts.map((a) => ({
      key: a.key, cfg: a.cfg,
      result: simulate(input, Object.fromEntries(a.hs.map((h) => [h.t, h.w])), accountSettings(a, base, variant)),
    }));
    return { per, result: combineResults(per.map((x) => x.result)) };
  };
  const variants = [["mine", "내 설정"], ["reinvest", "전액 재투자"], ["withdraw", "배당 전액 인출"]];
  const scen = variants.map(([key, label]) => ({ key, label, ...run(key) }));
  const period = { ...p, label: `${input.months[0]} ~ ${input.months.at(-1)} ${inp.mode === "backtest" ? "실제" : "예측"}` };
  return { inputs: inp, input, period, tickers, accounts: scen[0].per, scen };
}

// 계좌별 정산: ISA 해지세, 연금 세액공제, 일반 계좌 종합과세 해
function accountExtras(per, inp) {
  return per.map(({ key, cfg, result }) => {
    const s = result.summary;
    const x = { key, summary: s, years: result.years };
    if (key === "isa") x.isa = isaExitTax(s, cfg.type);
    if (key === "pension") x.credit = pensionCredit(result.years, (cfg.creditRate ?? 13.2) / 100);
    if (key === "general") x.comp = result.years.filter((y) => y.comprehensiveTax).map((y) => y.year);
    x.limits = limitWarnings(key, result.years);
    return x;
  });
}

const wdText = (v) => (v ? man(v * 1e4) : "0원");

// 입력 조건 요약: 첫 줄은 기간·금액·배당 처리, 둘째 줄부터 계좌별 종목
function describe(inp, periodLabel) {
  const accts = ACCOUNTS.filter((a) => inp.accounts[a.key]?.on);
  const money = accts.map((a) => {
    const c = inp.accounts[a.key];
    return `${a.name} ${man(c.initial * 1e4)}${c.monthly ? `+월 ${man(c.monthly * 1e4)}` : ""}`;
  }).join(", ");
  const div = inp.switchOn
    ? `일반 계좌 매달 ${wdText(inp.wdMonthly)} → ${inp.switchYear}년 후 매달 ${wdText(inp.wdMonthly2)}${inp.wdSell ? "(모자라면 매도)" : ""}`
    : inp.wdMonthly ? `일반 계좌 매달 ${wdText(inp.wdMonthly)} 인출${inp.wdSell ? "(모자라면 매도)" : ""}` : "배당 전부 재투자";
  const wd = inp.withdrawals.filter((w) => w.amount > 0).map((w) => `${w.year}년차 ${man(w.amount * 1e4)} 인출`);
  const lines = accts.map((a) => {
    const hs = inp.accounts[a.key].holdings.filter((h) => h.w > 0);
    const total = hs.reduce((s, h) => s + h.w, 0) || 1;
    return `${a.name}: ${hs.map((h) => `${DATA?.tickers[h.t]?.name || h.t} ${Math.round((h.w / total) * 100)}%`).join(", ") || "종목 없음"}`;
  });
  return [[periodLabel, money, div, ...wd].join(" · "), ...lines].join("\n");
}

function run() {
  const r = compute(snapshotInputs());
  if (typeof r === "string") { $("go-hint").textContent = r; return; }
  r.example = state.example;
  last = r;
  $("save-name").value = "";
  $("save-msg").textContent = "";
  setTab("result");
}

function isStale() {
  return last && JSON.stringify(last.inputs) !== JSON.stringify(snapshotInputs());
}

function renderRunHead() {
  const stale = isStale();
  $("run-source").textContent = stale ? "입력이 바뀌었습니다 · 아래는 이전 조건의 결과" : `입력한 조건 · ${DATA.fxLast?.date || DATA.end} 데이터`;
  $("edit-input").textContent = stale ? "다시 계산" : "입력 수정";
  $("run-summary").innerHTML = esc(describe(last.inputs, last.period.label)).replaceAll("\n", "<br>");
}

/* ---------- 결과 렌더 ---------- */
function setStripSim(s) {
  $("strip-balance").textContent = s ? man(s.balance) : "-";
  $("strip-monthly").textContent = s ? man(s.monthlyAvg) : "-";
  $("strip-withdrawn").textContent = s ? man(s.withdrawn) : "-";
}

function renderResults() {
  const r = last;
  $("run-head").hidden = !r;
  $("result-body").hidden = !r;
  $("result-empty").hidden = !!r;
  if (!r) { setStripSim(null); return; }
  renderRunHead();
  const mine = r.scen[0].result;
  const s = mine.summary, rows = mine.rows;
  const nYears = (rows.length / 12).toFixed(rows.length % 12 ? 1 : 0);
  const extras = accountExtras(r.accounts, r.inputs);
  const isaTax = extras.find((x) => x.key === "isa")?.isa?.tax || 0;
  const credit = extras.find((x) => x.key === "pension")?.credit || 0;
  setStripSim(s);

  const tag = r.example ? " · 예시 설정" : "";
  $("hero-label").textContent = `${r.period.label} · ${nYears}년 뒤 전체 잔액${tag}`;
  $("hero-balance").textContent = won(s.balance);
  $("hero-sub").innerHTML = [
    ["넣은 돈", man(s.contributed)],
    ["찾은 돈", man(s.withdrawn)],
    ["손익", (s.profit >= 0 ? "+" : "") + man(s.profit)],
  ].map(([k, v]) => `<span>${k} <b class="num">${v}</b></span>`).join("");

  $("kpis").innerHTML = [
    ["최근 12개월 세후 배당", man(s.ttmNet), `월평균 ${man(s.monthlyAvg)}`],
    ["넣은 돈 대비 배당률", pct(s.yieldOnCost, 2), "최근 12개월 세후 기준"],
    ["누적 세후 배당", man(s.cumDivNet), `그중 인출 ${man(rows.reduce((a, x) => a + x.divWithdraw, 0))}`],
    ["낸 세금", man(s.cumTax), `${isaTax ? `ISA 해지 시 +${man(isaTax)}` : "배당세 + 해외 양도세"}${credit ? ` · 연금 공제 ${man(credit)}` : ""}`],
  ].map(([k, v, e]) => `<div class="kpi"><small>${k}</small><span class="num">${v}</span><em>${e}</em></div>`).join("");

  const warns = [];
  const comp = extras.find((x) => x.key === "general")?.comp || [];
  if (comp.length) warns.push(`${comp.join(", ")}년 일반 계좌 세전 배당이 2,000만원을 넘습니다. 금융소득종합과세 대상이 되어 세금이 더 나올 수 있습니다.`);
  for (const x of extras) warns.push(...x.limits);
  if (r.inputs.mode === "backtest" && r.inputs.startYM && r.period.start > r.inputs.startYM) {
    warns.push(`선택한 종목 중 상장이 가장 늦은 종목 때문에 ${r.period.start}부터 계산했습니다.`);
  }
  const noDiv = r.tickers.filter((t) => !(DATA.tickers[t].stats.dpsTTM > 0)).map((t) => DATA.tickers[t].name);
  if (noDiv.length) warns.push(`최근 12개월 배당 기록이 없는 종목: ${noDiv.join(", ")} (데이터 누락일 수 있음)`);
  const skipped = [];
  for (const a of ACCOUNTS) {
    const c = r.inputs.accounts[a.key];
    if (!c?.on) continue;
    for (const h of c.holdings) {
      const d = DATA.tickers[h.t];
      if (!d) skipped.push(`${a.name} ${h.t}(데이터 없음)`);
      else if (allowedIn(a.key, d)) skipped.push(`${a.name} ${d.name}`);
    }
  }
  if (skipped.length) warns.push(`계좌 규칙상 제외한 종목: ${skipped.join(", ")}`);
  $("warnings").innerHTML = warns.map((w) => `<div class="pill">${esc(w)}</div>`).join("");

  renderAccountCard(extras);

  const labels = rows.map((x) => x.month);
  const yearTick = (l, i) => (l.endsWith("-01") || i === 0 ? `'${l.slice(2, 4)}` : "");
  const sparseYearTick = rows.length > 120 ? (l) => (Number(l.slice(0, 4)) % 2 === 0 && l.endsWith("-01") ? `'${l.slice(2, 4)}` : "") : yearTick;

  const balSeries = [
    { name: "전체 잔액", color: "--s1", values: rows.map((x) => x.balance) },
    { name: "잔액 + 찾은 돈", color: "--s2", values: rows.map((x) => x.wealth) },
    { name: "넣은 돈 누적", color: "--s8", dash: true, values: rows.map((x) => x.cumContrib) },
  ];
  legend($("lg-balance"), balSeries);
  drawChart($("ch-balance"), { labels, series: balSeries, xTick: sparseYearTick });

  const scenSeries = r.scen.map((sc, k) => ({ name: sc.label, color: SERIES[k], values: sc.result.rows.map((x) => x.balance) }));
  legend($("lg-scen"), scenSeries);
  drawChart($("ch-scen"), { labels, series: scenSeries, xTick: sparseYearTick });
  $("tb-scen").innerHTML =
    `<tr><th>방식</th><th>잔액</th><th>찾은 돈</th><th>합계</th><th>월 배당</th></tr>` +
    r.scen.map((sc, k) => {
      const x = sc.result.summary;
      return `<tr><td class="name"><span class="dot" style="background:${cssVar(SERIES[k])}"></span>${sc.label}</td><td>${man(x.balance)}</td><td>${man(x.withdrawn)}</td><td>${man(x.wealth)}</td><td>${man(x.monthlyAvg)}</td></tr>`;
    }).join("");

  renderDividendChart(r, mine);

  const cal = s.byMonthOfYear;
  const calMax = Math.max(...cal.map((c) => c.net), 1);
  $("cal").innerHTML = cal.map((c) => {
    const a = c.net / calMax;
    const bg = c.net > 0 ? `background:color-mix(in srgb, var(--s1) ${Math.round(12 + a * 50)}%, var(--surface))` : "";
    return `<div class="${c.net > 0 ? "on" : ""}" style="${bg}"><small>${Number(c.month.slice(5))}월</small><span class="num">${c.net > 0 ? man(c.net) : "–"}</span></div>`;
  }).join("");

  const compYears = new Set(comp);
  $("tb-year").innerHTML =
    `<tr><th>연도</th><th>납입</th><th>세전 배당</th><th>세금</th><th>세후 배당</th><th>인출</th><th>연말 잔액</th></tr>` +
    mine.years.map((y) => `<tr class="${compYears.has(y.year) ? "flag" : ""}"><td>${y.year}${y.months < 12 ? `<small> (${y.months}개월)</small>` : ""}</td><td>${manNum(y.contrib)}</td><td>${manNum(y.divGross)}</td><td>${manNum(y.divTax + y.cgt)}</td><td>${manNum(y.divNet)}</td><td>${manNum(y.divWithdraw + y.lumpWithdraw + y.sellWithdraw)}</td><td>${manNum(y.endBalance)}</td></tr>`).join("");

  renderWithdrawTable(rows);

  // 종목별 현황: 계좌별로
  let holdRows = "";
  for (const { key, result } of r.accounts) {
    const lastRow = result.rows.at(-1);
    const cumBy = {};
    for (const x of result.rows) for (const [t, v] of Object.entries(x.byTicker)) cumBy[t] = (cumBy[t] || 0) + v;
    for (const [t, h] of Object.entries(lastRow.holdings)) {
      const d = DATA.tickers[t];
      const sh = d.market === "US" ? h.shares.toFixed(r.inputs.fractionalUS ? 2 : 0) : nf.format(Math.round(h.shares));
      holdRows += `<tr><td class="name"><span class="acct-tag">${ACCT_NAME[key]}</span>${esc(d.name)}</td><td>${sh}주</td><td>${man(h.value)}</td><td>${pct(mine.rows.at(-1).marketValue ? h.value / mine.rows.at(-1).marketValue : 0, 0)}</td><td>${man(cumBy[t] || 0)}</td></tr>`;
    }
  }
  $("tb-hold").innerHTML =
    `<tr><th>종목</th><th>보유</th><th>평가액</th><th>비중</th><th>누적 세후 배당</th></tr>` + holdRows +
    `<tr><td class="name">대기 현금</td><td></td><td>${man(mine.rows.at(-1).cash)}</td><td></td><td></td></tr>`;

  $("assumptions").innerHTML = [
    r.inputs.mode === "backtest"
      ? "과거 실제 월말 종가에 매수하고, 배당은 배당락 월의 보유 주식 수로 계산해 종목별 평균 지급 시차 뒤에 입금된다고 봤습니다. 환율은 해당 월말 원/달러 환율입니다."
      : "예측 결과는 가정입니다. 환율은 고정, 모든 종목에 같은 성장률을 적용했습니다.",
    `매매 수수료는 넣지 않았고, 환전할 때마다 ${r.inputs.fxSpread}%를 뗍니다.`,
    "ISA·연금 계좌의 배당은 계좌 안에서 세금 없이 재투자했고, 연금 수령 시 연금소득세와 IRP 위험자산 한도는 반영하지 않았습니다.",
    "국내 주식 매매차익은 비과세(대주주 제외)로, 일반 계좌의 국내 상장 해외 ETF 매매차익 과세는 반영하지 않았습니다.",
    `데이터: Yahoo Finance, ${(DATA.fxLast?.date || DATA.generated.slice(0, 10))} 기준. 국내 종목은 배당 이력 일부가 빠져 있을 수 있습니다.`,
  ].join(" ");
}

// 인출이 있었던 달마다 배당에서 찾은 돈·주식을 팔아 찾은 돈(목돈 포함)과 부족분, 연도별 소계·누적
function renderWithdrawTable(rows) {
  const out = (x) => x.divWithdraw + x.lumpWithdraw + x.sellWithdraw;
  const months = rows.filter((x) => out(x) > 0.5 || x.shortfall > 0.5);
  const total = rows.reduce((a, x) => a + out(x), 0);
  if (!months.length) {
    $("wd-head").textContent = "";
    $("tb-wd").innerHTML = "";
    $("wd-foot").textContent = "인출한 달이 없습니다. 입력 탭의 '배당금 처리 · 목돈 인출'에서 매달 인출액이나 목돈 인출을 넣으면 여기에 달마다 찾은 돈이 나옵니다.";
    return;
  }
  const recent = rows.slice(-12).reduce((a, x) => a + out(x), 0);
  $("wd-head").textContent = `최근 12개월 월평균 ${man(recent / Math.min(12, rows.length))}`;
  const n = (v) => nf.format(Math.round(v));
  let html = `<tr><th>월</th><th>배당에서</th><th>매도·목돈</th><th>합계(원)</th></tr>`;
  let cum = 0, year = null, ySum = 0;
  const sub = () => (year ? `<tr class="sub"><td>${year}년</td><td colspan="2">누적 ${man(cum)}</td><td>${man(ySum)}</td></tr>` : "");
  for (const x of months) {
    const y = x.month.slice(0, 4);
    if (y !== year) { html += sub(); year = y; ySum = 0; }
    const t = out(x), sold = x.lumpWithdraw + x.sellWithdraw;
    cum += t; ySum += t;
    const short = x.shortfall > 0.5 ? `<br><small class="short">부족 ${n(x.shortfall)}</small>` : "";
    html += `<tr><td>${x.month}</td><td>${x.divWithdraw > 0.5 ? n(x.divWithdraw) : "–"}</td><td>${sold > 0.5 ? n(sold) : "–"}</td><td>${n(t)}${short}</td></tr>`;
  }
  html += sub();
  $("tb-wd").innerHTML = html;
  const shortMonths = rows.filter((x) => x.shortfall > 0.5);
  const shortSum = shortMonths.reduce((a, x) => a + x.shortfall, 0);
  $("wd-foot").textContent = [
    `총 ${months.filter((x) => out(x) > 0.5).length}개월, ${man(total)} 인출.`,
    shortMonths.length ? `배당이 모자라 목표만큼 못 찾은 달 ${shortMonths.length}개월(모자란 돈 ${man(shortSum)}). '배당이 모자란 달엔 주식을 팔아 채우기'를 켜면 매달 같은 금액을 찾습니다.` : "",
    "배당에서 찾은 돈은 일반 계좌의 세후 배당(미국 배당은 환전 수수료 뺀 원화), 매도·목돈은 양도세를 뺀 실수령액입니다.",
  ].filter(Boolean).join(" ");
}

function renderAccountCard(extras) {
  $("tb-acct").innerHTML =
    `<tr><th>계좌</th><th>넣은 돈</th><th>잔액</th><th>찾은 돈</th><th>월 배당</th><th>배당 세금</th></tr>` +
    extras.map((x) => {
      const s = x.summary;
      return `<tr><td class="name">${ACCT_NAME[x.key]}</td><td>${man(s.contributed)}</td><td>${man(s.balance)}</td><td>${man(s.withdrawn)}</td><td>${man(s.monthlyAvg)}</td><td>${man(s.cumTax)}</td></tr>`;
    }).join("");
  const notes = [];
  for (const x of extras) {
    if (x.key === "general") notes.push(`<b>일반</b> 배당을 받을 때마다 국내 15.4%, 미국 15%를 원천징수했습니다.`);
    if (x.key === "isa") {
      const free = ISA_FREE[last.inputs.accounts.isa.type] ?? ISA_FREE.일반형;
      notes.push(`<b>ISA</b> 순이익 ${man(x.isa.profit)} 중 비과세 한도 ${man(free)}를 넘는 ${man(x.isa.taxable)}에 9.9%를 매기면, 해지할 때 세금은 약 <b>${man(x.isa.tax)}</b>, 실수령은 약 ${man(x.summary.balance - x.isa.tax)}입니다.`);
    }
    if (x.key === "pension") {
      const rate = last.inputs.accounts.pension.creditRate ?? 13.2;
      notes.push(`<b>연금</b> 납입액(연 900만원까지)의 ${rate}%를 연말정산 때 돌려받아 기간 동안 약 <b>${man(x.credit)}</b>입니다. 이 환급금은 잔액에 넣지 않았습니다. 55세 이후 연금으로 받을 때 연금소득세 3.3~5.5%가 붙습니다.`);
    }
  }
  $("acct-notes").innerHTML = notes.map((n) => `<p class="hint" style="margin:0">${n}</p>`).join("");
}

function renderDividendChart(r, mine) {
  const rows = mine.rows;
  const order = r.tickers;
  const main = order.slice(0, SERIES.length);
  const rest = order.slice(SERIES.length);
  const byYear = state.divView === "year";
  const buckets = [];
  for (const x of rows) {
    const key = byYear ? x.month.slice(0, 4) : x.month;
    let b = buckets.at(-1);
    if (!b || b.key !== key) buckets.push((b = { key, v: {} }));
    for (const [t, v] of Object.entries(x.byTicker)) b.v[t] = (b.v[t] || 0) + v;
  }
  const series = main.map((t, k) => ({ name: DATA.tickers[t].name, color: SERIES[k], values: buckets.map((b) => b.v[t] || 0) }));
  if (rest.length) series.push({ name: "기타", color: OTHER, values: buckets.map((b) => rest.reduce((a, t) => a + (b.v[t] || 0), 0)) });
  legend($("lg-div"), series);
  const labels = buckets.map((b) => (byYear ? `${b.key}년` : b.key));
  const xTick = byYear
    ? (l, i) => (buckets.length > 12 && i % 2 ? "" : `'${l.slice(2, 4)}`)
    : (l) => (l.endsWith("-01") ? `'${l.slice(2, 4)}` : "");
  drawChart($("ch-div"), { labels, series, kind: "bar", xTick });
  setSeg($("div-view"), state.divView);
}



/* ---------- 계좌 · 종목 ---------- */
const ACCT_RULE = {
  general: "국내·미국 모든 종목. 배당을 받을 때 세금(국내 15.4%, 미국 15%)을 뗍니다. 아래 배당금 처리·목돈 인출이 적용됩니다.",
  isa: "국내 상장 종목만(미국 배당은 국내 상장 ETF로). 배당은 세금 없이 계좌 안에서 재투자하고, 해지할 때 순이익 중 비과세 한도 초과분에 9.9%. 납입 한도 연 2,000만원·총 1억원.",
  pension: "국내 상장 ETF·리츠만(연금저축·IRP). 배당은 과세 이연으로 재투자, 납입액 연 900만원까지 세액공제. 납입 한도 연 1,800만원.",
};

function renderAccountTabs() {
  $("acct-tabs").innerHTML = ACCOUNTS.map((a) => {
    const c = state.accounts[a.key];
    const sub = c.on ? `${man(c.initial * 1e4)}+월 ${man(c.monthly * 1e4)}` : "사용 안 함";
    return `<button type="button" role="tab" data-acct="${a.key}" aria-selected="${a.key === state.acct}" class="${c.on ? "" : "off"}"><b>${a.name}</b><small>${sub}</small></button>`;
  }).join("");
  const on = ACCOUNTS.filter((a) => state.accounts[a.key].on);
  const ti = on.reduce((s, a) => s + state.accounts[a.key].initial, 0);
  const tm = on.reduce((s, a) => s + state.accounts[a.key].monthly, 0);
  $("acct-total").textContent = on.length ? `합계 ${man(ti * 1e4)} + 월 ${man(tm * 1e4)}` : "";
}

function renderAccount() {
  const a = ACCOUNTS.find((x) => x.key === state.acct);
  const c = cur();
  renderAccountTabs();
  $("acct-on").checked = c.on;
  $("acct-on-label").textContent = `${a.long} 사용`;
  $("acct-body").hidden = !c.on;
  $("acct-rule").textContent = ACCT_RULE[a.key];
  for (const id of ["initial", "monthly"]) if (document.activeElement !== $(id)) $(id).value = c[id];
  if (a.key === "isa") {
    $("acct-extra").innerHTML = `<div class="field"><span class="lab">ISA 유형 <span class="hint">비과세 한도</span></span>
      <div class="seg" id="isa-type">${["일반형", "서민형"].map((t) => `<button type="button" data-v="${t}" aria-pressed="${c.type === t}">${t} ${man(ISA_FREE[t])}</button>`).join("")}</div></div>`;
  } else if (a.key === "pension") {
    $("acct-extra").innerHTML = `<div class="field"><span class="lab">세액공제율 <span class="hint">총급여 5,500만원 이하면 16.5%</span></span>
      <div class="seg" id="credit-rate">${[13.2, 16.5].map((r) => `<button type="button" data-v="${r}" aria-pressed="${(c.creditRate ?? 13.2) === r}">${r}%</button>`).join("")}</div></div>`;
  } else $("acct-extra").innerHTML = "";
  $("f-market").hidden = a.key !== "general";
  renderHoldings();
  renderPicks();
}

function renderHoldings() {
  const c = cur();
  const total = c.holdings.reduce((a, h) => a + (Number(h.w) || 0), 0);
  $("holdings").innerHTML = c.holdings.length
    ? c.holdings.map((h, i) => {
        const d = DATA.tickers[h.t];
        const name = d ? d.name : h.t;
        const bad = d ? allowedIn(state.acct, d) : "데이터 없음";
        const meta = d ? `${h.t.replace(".KS", "")} · ${d.market === "KR" ? "국내" : "미국"} · 수익률 ${pct(d.stats.yield)}` : "데이터 없음";
        const share = total ? h.w / total : 0;
        return `<div class="holding">
          <div class="who"><b>${esc(name)}</b><small>${esc(bad ? `${meta} · ${bad}` : meta)}</small></div>
          <button class="x" type="button" data-del="${i}" aria-label="${esc(name)} 빼기">×</button>
          <div class="ctrl">
            <input type="range" min="0" max="100" step="1" value="${h.w}" data-w="${i}" aria-label="${esc(name)} 비중">
            <div class="inp"><input type="number" inputmode="numeric" min="0" max="100" value="${h.w}" data-wn="${i}" aria-label="${esc(name)} 비중 숫자"><span>%</span></div>
          </div>
          <div class="amt" style="grid-column:1/-1">처음 ${man(c.initial * 1e4 * share)} · 월 ${man(c.monthly * 1e4 * share)}</div>
        </div>`;
      }).join("")
    : `<p class="empty">아래 ‘종목 추가’로 이 계좌에 담을 종목을 고르세요.</p>`;
  const tEl = $("weight-total");
  tEl.className = `total ${total && Math.round(total) !== 100 ? "bad" : ""}`;
  tEl.innerHTML = `<span>비중 합계</span><b class="num">${total}%${total && Math.round(total) !== 100 ? " → 비율대로 환산" : ""}</b>`;
}

function renderPicks() {
  const q = state.query.trim().toLowerCase();
  const held = new Set(cur().holdings.map((h) => h.t));
  const market = state.acct === "general" ? state.fMarket : "";
  const list = Object.entries(DATA.tickers)
    .filter(([t, d]) => !allowedIn(state.acct, d) && (!market || d.market === market) && (!state.fPopular || q || d.popular)
      && (!q || t.toLowerCase().includes(q) || d.name.toLowerCase().includes(q)))
    .sort(([, a], [, b]) => state.fSort === "growth" ? (b.stats.growth5y ?? -9) - (a.stats.growth5y ?? -9) : b.stats.yield - a.stats.yield);
  $("picks").innerHTML = list.map(([t, d]) => {
    const on = held.has(t);
    const months = Array.from({ length: 12 }, (_, m) => `<i class="${d.stats.payMonths.includes(m + 1) ? "on" : ""}"></i>`).join("");
    return `<div class="pick">
      <div class="who"><b>${esc(d.name)}${d.popular ? '<span class="pop">인기</span>' : ""}</b>
        <div class="meta"><span>${esc(t.replace(".KS", ""))} · ${d.type}</span><span class="yield">${d.stats.dpsTTM > 0 ? pct(d.stats.yield) : "배당 기록 없음"}</span><span>${d.stats.freq}배당</span>
        ${d.stats.growth5y != null ? `<span>5년 성장 ${pct(d.stats.growth5y)}</span>` : ""}
        <span class="months" title="배당락 월">${months}</span></div>
      </div>
      <button class="add" type="button" data-pick="${esc(t)}" aria-pressed="${on}">${on ? "담김" : "담기"}</button>
    </div>`;
  }).join("") || `<p class="empty">${state.fPopular && !q ? "인기 TOP30 중 이 계좌에 담을 수 있는 종목이 없습니다. 인기 TOP30 필터를 꺼 보세요." : "검색 결과가 없습니다."}</p>`;
  setSeg($("f-market"), state.fMarket);
  setSeg($("f-sort"), state.fSort);
  $("f-popular").setAttribute("aria-pressed", String(state.fPopular));
}

/* ---------- 내 설정 저장 · 불러오기 ---------- */
function renderPresets() {
  const list = [...presets].sort((a, b) => b.savedAt - a.savedAt);
  const sel = $("preset-sel");
  const curId = list.some((p) => p.id === sel.value) ? sel.value : state.presetId;
  sel.innerHTML = list.length
    ? list.map((p) => `<option value="${esc(p.id)}" ${p.id === curId ? "selected" : ""}>${esc(p.name)}</option>`).join("")
    : `<option value="">저장한 설정 없음</option>`;
  sel.disabled = !list.length;
  $("preset-load").disabled = !list.length;
  const active = presets.find((p) => p.id === state.presetId);
  const dirty = active && JSON.stringify(normalizeInputs(active.inputs)) !== JSON.stringify(snapshotInputs());
  $("preset-note").textContent = active ? `지금: ${active.name}${dirty ? " (수정됨)" : ""}` : "";
  $("preset-del").hidden = !list.length;
  $("preset-del").textContent = presetDelete ? "정말 삭제" : "삭제";
  $("preset-del").className = presetDelete ? "danger" : "btn";
}

async function savePreset(ev) {
  ev.preventDefault();
  const name = $("preset-name").value.trim() || presets.find((p) => p.id === state.presetId)?.name || "내 설정";
  const same = presets.find((p) => p.name === name);
  const item = { id: same?.id || newId("p"), name, savedAt: Date.now(), inputs: snapshotInputs() };
  $("preset-save").disabled = true;
  try {
    await store.put("preset", item);
    state.presetId = item.id;
    state.example = false;
    store.saveDraft();
    $("preset-name").value = "";
    $("preset-msg").textContent = same ? `‘${name}’ 설정을 지금 값으로 덮어썼습니다.` : `‘${name}’ 설정을 저장했습니다.`;
    renderPresets();
  } catch (err) {
    $("preset-msg").textContent = err?.code === "invalid_argument" ? "보기 권한만 있어 저장할 수 없습니다." : `저장하지 못했습니다 (${err?.code || err}).`;
  } finally {
    $("preset-save").disabled = false;
  }
}

function loadPreset() {
  const p = presets.find((x) => x.id === $("preset-sel").value);
  if (!p) return;
  const inp = normalizeInputs(p.inputs);
  for (const k of INPUT_KEYS) if (k in inp) state[k] = clone(inp[k]);
  state.presetId = p.id;
  state.example = false;
  presetDelete = false;
  renderInputs();
  store.saveDraft();
  $("preset-msg").textContent = `‘${p.name}’ 설정을 불러왔습니다.`;
}

async function deletePreset() {
  const id = $("preset-sel").value;
  if (!id) return;
  if (!presetDelete) { presetDelete = true; renderPresets(); return; }
  presetDelete = false;
  const name = presets.find((p) => p.id === id)?.name;
  try {
    await store.remove("preset", id);
    if (state.presetId === id) state.presetId = null;
    $("preset-msg").textContent = `‘${name}’ 설정을 삭제했습니다.`;
  } catch (err) {
    $("preset-msg").textContent = `삭제하지 못했습니다 (${err?.code || err}).`;
  }
  renderPresets();
}

/* ---------- 백업 (브라우저 저장일 때) ---------- */
function saveBackup() {
  const body = { app: "dividend-tongjang", version: 1, exportedAt: new Date().toISOString(), draft: Object.fromEntries(DRAFT.map((k) => [k, state[k]])), presets, saved };
  const blob = new Blob([JSON.stringify(body)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `배당통장-백업-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  $("backup-msg").textContent = `설정 ${presets.length}개, 저장한 결과 ${saved.length}개를 파일로 저장했습니다.`;
}

async function loadBackup(file) {
  try {
    const body = JSON.parse(await file.text());
    if (body.app !== "dividend-tongjang") throw new Error("배당 통장 백업 파일이 아닙니다");
    const merge = (cur, add) => [...cur.filter((x) => !add.some((y) => y.id === x.id)), ...add];
    presets = merge(presets, body.presets || []);
    saved = merge(saved, body.saved || []);
    if (body.draft) applyDraft(body.draft);
    store.saveLocal();
    store.saveDraft();
    renderInputs();
    renderSaved();
    $("backup-msg").textContent = `불러왔습니다: 설정 ${body.presets?.length || 0}개, 저장한 결과 ${body.saved?.length || 0}개.`;
  } catch (e) {
    $("backup-msg").textContent = `불러오지 못했습니다: ${e.message}`;
  }
}

/* ---------- 결과 저장 · 저장함 ---------- */
async function saveRun(ev) {
  ev.preventDefault();
  if (!last) return;
  const s = last.scen[0].result.summary;
  const name = $("save-name").value.trim() || `${last.accounts.map((a) => ACCT_NAME[a.key]).join("·")} · ${last.period.label}`;
  const pick = (x) => Object.fromEntries(["balance", "contributed", "withdrawn", "wealth", "profit", "ttmNet", "monthlyAvg", "cumDivNet", "cumTax", "yieldOnCost"].map((k) => [k, x[k]]));
  const runDoc = {
    id: newId("r"), name, savedAt: Date.now(),
    dataAsOf: DATA.fxLast?.date || DATA.end,
    inputs: last.inputs,
    period: last.period.label,
    summary: pick(s),
    accounts: last.accounts.map((a) => ({ key: a.key, ...pick(a.result.summary) })),
    scenarios: last.scen.map((sc) => ({ label: sc.label, balance: sc.result.summary.balance, withdrawn: sc.result.summary.withdrawn, monthlyAvg: sc.result.summary.monthlyAvg })),
    years: last.scen[0].result.years.map((y) => ({ year: y.year, contrib: y.contrib, divNet: y.divNet, endBalance: y.endBalance })),
  };
  $("save").disabled = true;
  try {
    await store.put("run", runDoc);
    $("save-msg").textContent = `‘${name}’을(를) 저장함에 저장했습니다.`;
    $("save-name").value = "";
  } catch (err) {
    $("save-msg").textContent = err?.code === "invalid_argument"
      ? "보기 권한만 있어 저장할 수 없습니다."
      : `저장하지 못했습니다 (${err?.code || err}). 다시 눌러 주세요.`;
  } finally {
    $("save").disabled = false;
  }
}

function renderSaved() {
  const list = [...saved].sort((a, b) => b.savedAt - a.savedAt);
  $("t-saved").lastChild.textContent = list.length ? `저장함 ${list.length}` : "저장함";
  $("compare-card").hidden = list.length < 2;
  if (list.length >= 2) {
    $("compare").innerHTML = `<tr><th>이름</th><th>최종 잔액</th><th>월 배당</th><th>넣은 돈</th><th>찾은 돈</th><th>기간</th></tr>` +
      list.map((x) => `<tr><td class="name">${esc(x.name)}</td><td>${man(x.summary.balance)}</td><td>${man(x.summary.monthlyAvg)}</td><td>${man(x.summary.contributed)}</td><td>${man(x.summary.withdrawn)}</td><td>${esc(x.period)}</td></tr>`).join("");
  }
  $("saved-list").innerHTML = list.length
    ? list.map((x) => {
        const d = new Date(x.savedAt);
        const when = `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}`;
        const inp = normalizeInputs(x.inputs);
        const [cond, ...accLines] = describe(inp, x.period).split("\n");
        const confirm = pendingDelete === x.id
          ? `<button class="btn" type="button" data-cancel>취소</button><button class="danger" type="button" data-confirm="${esc(x.id)}">삭제</button>`
          : `<button class="btn" type="button" data-del="${esc(x.id)}">삭제</button><button class="primary" type="button" data-open="${esc(x.id)}">불러오기</button>`;
        return `<article class="saved">
          <div class="saved-top"><b>${esc(x.name)}</b><small>${when} 저장</small></div>
          <p class="saved-cond">${esc(cond)}</p>
          <div class="tickers">${accLines.map((l) => `<span>${esc(l)}</span>`).join("")}</div>
          <div class="saved-figs">
            <div><small>최종 잔액</small><span class="num">${man(x.summary.balance)}</span></div>
            <div><small>월 배당(세후)</small><span class="num">${man(x.summary.monthlyAvg)}</span></div>
            <div><small>넣은 돈</small><span class="num">${man(x.summary.contributed)}</span></div>
          </div>
          <p class="hint" style="margin:0">${x.dataAsOf} 데이터 기준 결과. 불러오면 입력값을 채우고 지금 데이터로 다시 계산합니다.</p>
          <div class="saved-actions">${confirm}</div>
        </article>`;
      }).join("")
    : `<div class="card empty">아직 저장한 결과가 없습니다.<br>결과 화면에서 이름을 붙여 저장하면 여기에 모입니다.</div>`;
}

function openSaved(id) {
  const x = saved.find((s) => s.id === id);
  if (!x) return;
  const inp = normalizeInputs(x.inputs);
  for (const k of INPUT_KEYS) if (k in inp) state[k] = clone(inp[k]);
  state.example = false;
  renderInputs();
  store.saveDraft();
  run();
}

/* ---------- 입력 탭 ---------- */
const NUM_FIELDS = ["priceGrowth", "divGrowth", "fxAssume", "wdMonthly", "wdMonthly2", "switchYear", "taxKR", "taxUS", "fxSpread"];

function ymSelects(prefix, ym, p, disabled) {
  const y0 = Number(p.min.slice(0, 4)), y1 = Number(p.max.slice(0, 4));
  const y = Number(ym.slice(0, 4)), m = Number(ym.slice(5));
  $(`${prefix}Y`).innerHTML = Array.from({ length: y1 - y0 + 1 }, (_, k) => y0 + k)
    .map((v) => `<option value="${v}" ${v === y ? "selected" : ""}>${v}년</option>`).join("");
  $(`${prefix}M`).innerHTML = Array.from({ length: 12 }, (_, k) => k + 1)
    .map((v) => `<option value="${v}" ${v === m ? "selected" : ""}>${v}월</option>`).join("");
  $(`${prefix}Y`).disabled = disabled;
  $(`${prefix}M`).disabled = disabled;
}

function renderPeriod() {
  setSeg($("mode"), state.mode);
  $("projection-box").hidden = state.mode !== "projection";
  const accts = activeAccounts(snapshotInputs());
  const tickers = [...new Set(accts.flatMap((a) => a.hs.map((h) => h.t)))];
  if (!tickers.length) {
    $("period-note").textContent = "계좌에 종목을 담으면 고를 수 있는 기간이 나옵니다.";
    return;
  }
  const p = periodOf(state, tickers);
  ymSelects("start", p.start, p, state.mode === "projection");
  ymSelects("end", p.end, p, false);
  const n = monthIndex({ start: p.start }, p.end) + 1;
  const len = `${Math.floor(n / 12)}년${n % 12 ? ` ${n % 12}개월` : ""}`;
  $("period-note").textContent = state.mode === "backtest"
    ? `${ymText(p.start)} ~ ${ymText(p.end)} (${len}). 담은 종목 기준 ${ymText(p.min)}부터 ${ymText(p.max)}까지 고를 수 있습니다.`
    : `${ymText(p.start)}(다음 달)부터 ${ymText(p.end)}까지 ${len}. 최대 40년.`;
}

function readYM(prefix) {
  return `${$(`${prefix}Y`).value}-${String($(`${prefix}M`).value).padStart(2, "0")}`;
}

function renderFolds() {
  $("wdSell").checked = state.wdSell;
  $("switchOn").checked = state.switchOn;
  $("switch-box").hidden = !state.switchOn;
  $("fractionalUS").checked = state.fractionalUS;
  const wd = state.withdrawals.filter((w) => w.amount > 0).length;
  const monthly = state.wdMonthly || (state.switchOn && state.wdMonthly2) ? `월 ${wdText(state.wdMonthly)}${state.switchOn ? `→${wdText(state.wdMonthly2)}` : ""} 인출` : "전부 재투자";
  $("div-summary").textContent = `${monthly}${wd ? ` · 목돈 ${wd}건` : ""}`;
  $("tax-summary").textContent = `${state.taxKR}% · ${state.taxUS}% · 환전 ${state.fxSpread}%`;
  renderWithdrawals();
}

function renderWithdrawals() {
  $("wd-list").innerHTML = state.withdrawals.length
    ? state.withdrawals.map((w, i) => `<div class="wd-row">
        <div class="inp"><input type="number" inputmode="numeric" min="1" max="40" value="${w.year}" data-wy="${i}" aria-label="인출 시점 년차"><span>년차</span></div>
        <div class="inp"><input type="number" inputmode="numeric" min="0" step="100" value="${w.amount}" data-wa="${i}" aria-label="인출 금액"><span>만원</span></div>
        <button class="x" type="button" data-wdel="${i}" aria-label="인출 삭제">×</button>
      </div>`).join("")
    : `<p class="hint">추가된 인출이 없습니다.</p>`;
}

function updateGo() {
  const r = activeAccounts(snapshotInputs()).length ? null : "계좌를 하나 이상 켜고 금액과 종목을 정해 주세요.";
  $("go-hint").textContent = r || (state.example ? "예시 값이 채워져 있습니다. 바꾼 뒤 결과를 확인하세요." : "");
  $("run").disabled = !!r;
}

function renderInputs() {
  if (state.fxAssume == null) state.fxAssume = Math.round(latestFx(DATA));
  if (!ACCOUNTS.some((a) => a.key === state.acct)) state.acct = "general";
  for (const id of NUM_FIELDS) if (document.activeElement !== $(id)) $(id).value = state[id];
  renderAccount();
  renderPeriod();
  renderFolds();
  renderPresets();
  $("picker").hidden = !pickerOpen;
  $("picker-toggle").setAttribute("aria-expanded", String(pickerOpen));
  $("picker-toggle").textContent = pickerOpen ? "종목 찾기 닫기" : "+ 종목 추가";
  updateGo();
}

/* ---------- 공통 ---------- */
function setSeg(el, v) {
  el.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === v)));
}

function setTab(tab, { keepScroll = false } = {}) {
  state.tab = TABS.includes(tab) ? tab : "input";
  for (const t of TABS) {
    $(`tab-${t}`).hidden = t !== state.tab;
    $(`t-${t}`).setAttribute("aria-selected", String(t === state.tab));
  }
  if (state.tab === "result") renderResults();
  if (state.tab === "saved") { pendingDelete = null; renderSaved(); }
  if (!keepScroll) window.scrollTo({ top: 0 });
}

// 입력이 바뀔 때: 화면 갱신 + 초안 저장
function changed({ account = false, holdings = false, picks = false, period = false, folds = false } = {}) {
  state.example = false;
  if (account) renderAccount();
  else {
    if (holdings) { renderHoldings(); renderAccountTabs(); }
    if (picks) renderPicks();
  }
  if (period) renderPeriod();
  if (folds) renderFolds();
  updateGo();
  renderPresets();
  store.saveDraft();
}

function bind() {
  document.querySelector(".tabs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-tab]");
    if (b) setTab(b.dataset.tab);
  });
  $("refresh").addEventListener("click", refreshData);
  $("status-close").addEventListener("click", () => ($("status-wrap").hidden = true));
  $("run").addEventListener("click", run);
  $("edit-input").addEventListener("click", () => (isStale() ? run() : setTab("input")));
  $("save-form").addEventListener("submit", saveRun);
  $("div-view").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    state.divView = b.dataset.v;
    if (last) renderDividendChart(last, last.scen[0].result);
    store.saveDraft();
  });

  // 내 설정
  $("preset-form").addEventListener("submit", savePreset);
  $("preset-load").addEventListener("click", loadPreset);
  $("preset-del").addEventListener("click", deletePreset);
  $("preset-sel").addEventListener("change", () => { presetDelete = false; renderPresets(); });

  // 백업
  $("backup-save").addEventListener("click", saveBackup);
  $("backup-file").addEventListener("change", (e) => { const f = e.target.files?.[0]; if (f) loadBackup(f); e.target.value = ""; });

  // 저장함
  $("saved-list").addEventListener("click", async (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.open) openSaved(t.dataset.open);
    else if (t.dataset.del) { pendingDelete = t.dataset.del; renderSaved(); }
    else if (t.hasAttribute("data-cancel")) { pendingDelete = null; renderSaved(); }
    else if (t.dataset.confirm) {
      const id = t.dataset.confirm;
      pendingDelete = null;
      try { await store.remove("run", id); }
      catch (err) { showStatus(`삭제하지 못했습니다 (${err?.code || err}).`, true); renderSaved(); }
    }
  });

  // 계좌
  $("acct-tabs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-acct]");
    if (!b) return;
    state.acct = b.dataset.acct;
    renderAccount();
    store.saveDraft();
  });
  $("acct-on").addEventListener("change", (e) => { cur().on = e.target.checked; changed({ account: true, period: true }); });
  $("acct-extra").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.closest("#isa-type")) cur().type = b.dataset.v;
    if (b.closest("#credit-rate")) cur().creditRate = Number(b.dataset.v);
    changed({ account: true });
  });
  for (const id of ["initial", "monthly"]) {
    $(id).addEventListener("input", (e) => {
      const v = e.target.value === "" ? 0 : Number(e.target.value);
      if (!Number.isFinite(v)) return;
      cur()[id] = Math.max(0, v);
      changed({ holdings: true });
    });
  }

  // 종목
  $("picker-toggle").addEventListener("click", () => {
    pickerOpen = !pickerOpen;
    $("picker").hidden = !pickerOpen;
    $("picker-toggle").setAttribute("aria-expanded", String(pickerOpen));
    $("picker-toggle").textContent = pickerOpen ? "종목 찾기 닫기" : "+ 종목 추가";
    if (pickerOpen) $("search").focus({ preventScroll: true });
  });
  $("holdings").addEventListener("input", (e) => {
    const i = e.target.dataset.w ?? e.target.dataset.wn;
    if (i == null) return;
    const hs = cur().holdings;
    hs[i].w = Math.max(0, Math.min(100, Number(e.target.value) || 0));
    if (e.target.dataset.w != null) {
      const num = $("holdings").querySelector(`[data-wn="${i}"]`);
      if (num) num.value = hs[i].w;
      const total = hs.reduce((a, h) => a + h.w, 0);
      $("weight-total").innerHTML = `<span>비중 합계</span><b class="num">${total}%</b>`;
    }
    changed();
  });
  $("holdings").addEventListener("change", () => changed({ holdings: true, period: true }));
  $("holdings").addEventListener("click", (e) => {
    const i = e.target.dataset.del;
    if (i == null) return;
    cur().holdings.splice(Number(i), 1);
    changed({ holdings: true, picks: true, period: true });
  });
  $("equalize").addEventListener("click", () => {
    const hs = cur().holdings;
    const n = hs.length;
    if (!n) return;
    const base = Math.floor(100 / n);
    hs.forEach((h, i) => (h.w = base + (i < 100 - base * n ? 1 : 0)));
    changed({ holdings: true });
  });
  $("search").addEventListener("input", (e) => { state.query = e.target.value; renderPicks(); });
  $("f-market").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { state.fMarket = b.dataset.v; renderPicks(); store.saveDraft(); } });
  $("f-sort").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { state.fSort = b.dataset.v; renderPicks(); store.saveDraft(); } });
  $("f-popular").addEventListener("click", () => { state.fPopular = !state.fPopular; renderPicks(); store.saveDraft(); });
  $("picks").addEventListener("click", (e) => {
    const t = e.target.closest("[data-pick]")?.dataset.pick;
    if (!t) return;
    const hs = cur().holdings;
    const i = hs.findIndex((h) => h.t === t);
    if (i >= 0) hs.splice(i, 1);
    else hs.push({ t, w: hs.length ? Math.round(100 / (hs.length + 1)) : 100 });
    changed({ holdings: true, picks: true, period: true });
  });

  // 기간
  $("mode").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (b) { state.mode = b.dataset.v; changed({ period: true }); }
  });
  for (const id of ["startY", "startM"]) $(id).addEventListener("change", () => { state.startYM = readYM("start"); changed({ period: true }); });
  for (const id of ["endY", "endM"]) {
    $(id).addEventListener("change", () => {
      if (state.mode === "backtest") state.endYM = readYM("end"); else state.projEndYM = readYM("end");
      changed({ period: true });
    });
  }

  // 배당·세금
  for (const id of NUM_FIELDS) {
    $(id).addEventListener("input", (e) => {
      const v = e.target.value === "" ? 0 : Number(e.target.value);
      if (!Number.isFinite(v)) return;
      state[id] = v;
      changed({ folds: ["taxKR", "taxUS", "fxSpread", "wdMonthly", "wdMonthly2", "switchYear"].includes(id) });
    });
  }
  $("wdSell").addEventListener("change", (e) => { state.wdSell = e.target.checked; changed({ folds: true }); });
  $("switchOn").addEventListener("change", (e) => { state.switchOn = e.target.checked; changed({ folds: true }); });
  $("fractionalUS").addEventListener("change", (e) => { state.fractionalUS = e.target.checked; changed(); });
  $("wd-add").addEventListener("click", () => {
    const lastYear = state.withdrawals.at(-1)?.year ?? 4;
    state.withdrawals.push({ year: lastYear + 1, amount: 1000 });
    changed({ folds: true });
  });
  $("wd-list").addEventListener("input", (e) => {
    const { wy, wa } = e.target.dataset;
    if (wy != null) state.withdrawals[wy].year = Math.max(1, Number(e.target.value) || 1);
    if (wa != null) state.withdrawals[wa].amount = Math.max(0, Number(e.target.value) || 0);
    changed();
  });
  $("wd-list").addEventListener("change", () => renderFolds());
  $("wd-list").addEventListener("click", (e) => {
    const i = e.target.dataset.wdel;
    if (i == null) return;
    state.withdrawals.splice(Number(i), 1);
    changed({ folds: true });
  });

  let rw = 0;
  window.addEventListener("resize", () => {
    clearTimeout(rw);
    rw = setTimeout(() => state.tab === "result" && renderResults(), 150);
  });
}

async function main() {
  store.loadLocal();
  renderStoreNote();
  if (!(await loadData())) {
    $("data-asof").textContent = "데이터 없음";
    $("tab-input").innerHTML = `<div class="card empty">data.json을 불러오지 못했습니다.<br>상단의 새로고침 버튼으로 GitHub에서 받아 오세요.</div>`;
    $("refresh").addEventListener("click", () => refreshData().then(() => DATA && location.reload()));
    return;
  }
  $("search").value = state.query;
  bind();
  renderInputs();
  renderSaved();
  setTab("input", { keepScroll: true });
  // 계정 저장소 연결 → 입력 초안·내 설정·저장한 결과 불러오기, 이어서 GitHub의 최신 데이터 확인
  connectAccount();
  if (window.claude?.use) {
    window.claude.use("mcp").then((mcp) => mcp && pullLatest(mcp).catch(() => { /* 묶음 데이터로 계속 */ })).catch(() => {});
  }
}

main();
