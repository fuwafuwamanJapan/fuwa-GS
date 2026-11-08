// ============================================================
// ユニーオイル日進五色園SS ハイオク・灯油価格 取得スクリプト
// fuwa-gs ver 2.1.0
//
// 役割: gogo.gs から価格を取り、data/prices.json を更新する（約200日分）
// 実行: GitHub Actions（update-prices.yml）が毎朝実行する
//       手元で試す場合: node fetch-prices.js
// 動作: Node.js 20 以上。外部ライブラリは使わない
//
// ver 2.1.0 の変更点:
//   ・価格履歴ページの投稿も取り込む（店舗トップより古い投稿があるため）
//   ・保持期間を60日から約200日に延長（半年分の推移を保つため）
//
// ver 2.0.1 の変更点（GitHub Actions で HTTP 403 になる対策）:
//   ・取得を curl 優先に変更（ブラウザ風UA・ヘッダ付き）。Node標準の
//     fetch は通信の特徴でbot判定されやすいため、失敗時の予備にした
//   ・失敗したら間を空けて再試行する（curl → fetch → curl）
//   ・HTTPエラー時に、応答本文の冒頭をエラー文へ含める（原因切り分け用）
// ============================================================

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const SHOP_URL = 'https://gogo.gs/shop/2313000034';                  // ユニーオイル日進五色園SS
const PRICE_URL = 'https://gogo.gs/shop/price/2313000034';           // 同 価格履歴ページ（古い投稿）
const AVERAGE_HIGH_OCTANE_URL = 'https://gogo.gs/ranking/average/1'; // ハイオク 平均
const AVERAGE_KEROSENE_URL = 'https://gogo.gs/ranking/average/3';    // 灯油 平均
const OUT_FILE = path.join(__dirname, 'data', 'prices.json');
const KEEP_DAYS = 200;
const TIMEOUT_MS = 20000;

// ---------- 共通 ----------

// 今日の日付（日本時間）yyyy-mm-dd
function todayJst() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

// 文字列を正の数にする（取れなければ null）
function toNumber(text) {
  const n = Number(String(text).replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function ymd(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// ---------- 取得 ----------

// ブラウザに寄せたリクエスト情報（bot判定を避けるため）
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BROWSER_HEADERS = [
  ['Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'],
  ['Accept-Language', 'ja,en;q=0.9'],
  ['Referer', 'https://gogo.gs/'],
];

// エラー文に付ける応答本文の冒頭（空白を詰めて短くする）
function snippet(text) {
  return String(text).replace(/\s+/g, ' ').trim().slice(0, 160);
}

// curl で取得する（GitHub Actions の ubuntu には標準で入っている）
async function fetchViaCurl(url) {
  const args = ['-sS', '-L', '--compressed', '--max-time', '25', '-A', BROWSER_UA];
  for (const [k, v] of BROWSER_HEADERS) args.push('-H', `${k}: ${v}`);
  args.push('-w', '\n__STATUS__%{http_code}', url);
  const { stdout } = await execFileAsync('curl', args, { maxBuffer: 8 * 1024 * 1024 });
  const marker = '\n__STATUS__';
  const idx = stdout.lastIndexOf(marker);
  const body = idx >= 0 ? stdout.slice(0, idx) : stdout;
  const status = idx >= 0 ? Number(stdout.slice(idx + marker.length)) : 0;
  if (status !== 200) throw new Error(`HTTP ${status}（curl）: ${snippet(body)}`);
  return body;
}

// Node標準の fetch で取得する（curl が無い環境向けの予備）
async function fetchViaFetch(url) {
  const headers = { 'User-Agent': BROWSER_UA };
  for (const [k, v] of BROWSER_HEADERS) headers[k] = v;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const body = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}（fetch）: ${snippet(body)}`);
  return body;
}

// curl → fetch → curl の順に、間を空けて試す
async function fetchHtml(url) {
  const attempts = [fetchViaCurl, fetchViaFetch, fetchViaCurl];
  let lastErr = null;
  for (let i = 0; i < attempts.length; i++) {
    try {
      return await attempts[i](url);
    } catch (e) {
      lastErr = e;
      if (i < attempts.length - 1) {
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }
  throw lastErr;
}

// ---------- 解析 ----------

// 店舗ページ上部の「現金価格」カード（現在の価格と確認日）
function parseShopCash(html) {
  const start = html.indexOf('現金価格');
  if (start < 0) return null;
  const memberIdx = html.indexOf('会員価格', start);
  const section = html.slice(start, memberIdx > start ? memberIdx : start + 20000);
  const cardRe = /<p class="text-xs">([^<]+)<\/p>\s*<p class="number text-3xl my-3">([\d,]+)<\/p>[\s\S]{0,600}?<p class="text-sm">([^<]*確認)<\/p>/g;
  const out = { regular: null, highOctane: null, diesel: null, kerosene18l: null, confirmedLabel: null };
  let found = false;
  let m;
  while ((m = cardRe.exec(section)) !== null) {
    const label = m[1];
    const price = toNumber(m[2]);
    if (price === null) continue;
    found = true;
    if (label === 'レギュラー') out.regular = price;
    else if (label === 'ハイオク') { out.highOctane = price; out.confirmedLabel = m[3].trim(); }
    else if (label === '軽油') out.diesel = price;
    else if (label === '灯油') out.kerosene18l = price;
  }
  return found ? out : null;
}

// 1投稿の中から燃料の価格を1つ取り出す
function fuelPrice(block, label) {
  const re = new RegExp('>' + label + '</div>[\\s\\S]{0,400}?text-lg[^>]*>\\s*([\\d,]+)');
  const m = block.match(re);
  return m ? toNumber(m[1]) : null;
}

// 価格投稿の履歴（現金フリーの行のみ）。ページに並んでいる順のまま返す
function parseShopHistory(html) {
  const rows = [];
  const tableRe = /<table class="my-1" id="p\d+">[\s\S]*?<\/table>/g;
  let m;
  while ((m = tableRe.exec(html)) !== null) {
    const block = m[0];
    if (!block.includes('現金フリー')) continue;
    const dm = block.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})/);
    if (!dm) continue;
    rows.push({
      date: ymd(dm[1], dm[2], dm[3]),
      regular: fuelPrice(block, 'レギュラー'),
      highOctane: fuelPrice(block, 'ハイオク'),
      diesel: fuelPrice(block, '軽油'),
      kerosene18l: fuelPrice(block, '灯油'),
    });
  }
  return rows;
}

// 都道府県平均ページ（全国平均＋愛知県）
function parseAverages(html, fuelLabel) {
  const start = html.indexOf('全国のガソリン平均価格');
  if (start < 0) return null;
  const section = html.slice(start, start + 20000);
  const nat = section.match(new RegExp('>' + fuelLabel + '<\\/p>[\\s\\S]{0,300}?<p class="price[^"]*">([\\d,]+(?:\\.\\d+)?)<\\/p>'));
  const dm = section.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  const ai = html.match(/>\s*愛知県\s*<\/a><\/td>\s*<td[^>]*>\s*([\d,]+(?:\.\d+)?)/);
  if (!nat || !dm || !ai) return null;
  const national = toNumber(nat[1]);
  const aichi = toNumber(ai[1]);
  if (national === null || aichi === null) return null;
  return { date: ymd(dm[1], dm[2], dm[3]), national, aichi };
}

// ---------- 保存データ ----------

function loadExisting() {
  try {
    const json = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
    return Array.isArray(json.history) ? json : { history: [] };
  } catch {
    return { history: [] }; // 初回、または壊れている場合は新しく作る
  }
}

// ---------- 本体 ----------

async function main() {
  const attemptedAt = new Date().toISOString();
  const data = loadExisting();
  const byDate = new Map(data.history.map((r) => [r.date, r]));
  const notes = [];      // 取れなかった項目
  const okSources = [];  // 取れた項目

  // 1日分の値を書き込む。取れた値だけ上書きし、取れなかった値は前の値を残す
  const setDay = (date, values) => {
    let rec = byDate.get(date);
    if (!rec) {
      rec = {
        date,
        uniHighOctane: null, uniRegular: null, uniDiesel: null, uniKerosene18l: null,
        nationalHighOctane: null, aichiHighOctane: null,
        nationalKerosene18l: null, aichiKerosene18l: null,
        confirmedLabel: null, fetchedAt: null,
      };
      byDate.set(date, rec);
    }
    for (const [key, value] of Object.entries(values)) {
      if (value !== null && value !== undefined) rec[key] = value;
    }
    rec.fetchedAt = attemptedAt;
  };

  // 1つの取得結果を処理し、成功・失敗を記録する
  const report = (name, res, apply) => {
    if (res.status !== 'fulfilled') {
      notes.push(`${name}: 取得失敗（${res.reason.message}）`);
      return;
    }
    if (apply(res.value)) okSources.push(name);
    else notes.push(`${name}: 解析できず`);
  };

  // 4つのページを同時に取りに行く
  const [shopRes, priceRes, hoRes, keRes] = await Promise.allSettled([
    fetchHtml(SHOP_URL),
    fetchHtml(PRICE_URL),
    fetchHtml(AVERAGE_HIGH_OCTANE_URL),
    fetchHtml(AVERAGE_KEROSENE_URL),
  ]);

  report('ハイオク平均', hoRes, (html) => {
    const avg = parseAverages(html, 'ハイオク');
    if (!avg) return false;
    setDay(avg.date, { nationalHighOctane: avg.national, aichiHighOctane: avg.aichi });
    return true;
  });

  report('灯油平均', keRes, (html) => {
    const avg = parseAverages(html, '灯油');
    if (!avg) return false;
    setDay(avg.date, { nationalKerosene18l: avg.national, aichiKerosene18l: avg.aichi });
    return true;
  });

  // 価格履歴ページの投稿（店舗トップより古い分。店舗ページ側の値で後から上書きされる）
  report('価格履歴ページ', priceRes, (html) => {
    const history = parseShopHistory(html);
    const firstByDate = new Map();
    for (const h of history) {
      if (!firstByDate.has(h.date)) firstByDate.set(h.date, h);
    }
    for (const h of firstByDate.values()) {
      setDay(h.date, {
        uniHighOctane: h.highOctane, uniRegular: h.regular,
        uniDiesel: h.diesel, uniKerosene18l: h.kerosene18l,
      });
    }
    return firstByDate.size > 0;
  });

  report('店舗ページ', shopRes, (html) => {
    const history = parseShopHistory(html);
    // 同じ日に投稿が複数あるときは、ページの一番上の投稿（新しいものと想定）を採用する
    const firstByDate = new Map();
    for (const h of history) {
      if (!firstByDate.has(h.date)) firstByDate.set(h.date, h);
    }
    for (const h of firstByDate.values()) {
      setDay(h.date, {
        uniHighOctane: h.highOctane, uniRegular: h.regular,
        uniDiesel: h.diesel, uniKerosene18l: h.kerosene18l,
      });
    }
    // 現在の「現金価格」は、最新の投稿日（投稿がなければ今日）に入れる
    const cash = parseShopCash(html);
    const latest = firstByDate.size > 0 ? [...firstByDate.keys()].sort().pop() : todayJst();
    if (cash) {
      setDay(latest, {
        uniHighOctane: cash.highOctane, uniRegular: cash.regular,
        uniDiesel: cash.diesel, uniKerosene18l: cash.kerosene18l,
        confirmedLabel: cash.confirmedLabel,
      });
    }
    return cash !== null || firstByDate.size > 0;
  });

  // どれも取れなければ、保存データは書き換えずに終了（失敗として記録）
  if (okSources.length === 0) {
    console.error('すべての取得に失敗しました:\n' + notes.join('\n'));
    process.exitCode = 1;
    return;
  }

  // 日付順に並べて、直近200日分だけ残す
  const history = [...byDate.values()]
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .slice(-KEEP_DAYS);

  const out = {
    updated_at: attemptedAt,
    last_attempt: { at: attemptedAt, ok: okSources, notes },
    history,
  };

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2) + '\n', 'utf8');

  console.log(`取得できた項目: ${okSources.join(' / ')}`);
  if (notes.length > 0) console.log(`取得できなかった項目: ${notes.join(' / ')}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
