/**
 * AI Tutor 學習進度同步後端（Google Apps Script）
 * =================================================
 * 用途：讓多支手機共用同一份學習紀錄（誰學過哪些字、上到哪個單元第幾天）。
 *
 * 部署方式見 SETUP-SYNC.md。重點：
 *   執行身分 = 我（你自己）      → 手機端完全不需要登入 Google
 *   誰可以存取 = 任何人          → 手機端才連得上（網址本身即權杖）
 *
 * 因為「任何人有網址就能呼叫」，下面用 SECRET 當通關密語再擋一層。
 * 請把 SECRET 改成你自己的一串字，並在 App 的「⚙️ 設定」填一樣的值。
 */

const SECRET = '請改成你自己的通關密語';   // ← 務必修改，並與 App 設定一致

// 三個工作表：vocab（單字）、practice（句子練習）、state（設定與進度）
const VOCAB_SHEET = 'vocab';
const PRACTICE_SHEET = 'practice';
const STATE_SHEET = 'state';
const VOCAB_HEADER = ['person', 'word', 'meaning', 'example', 'firstDate', 'lastDate', 'count', 'unit'];
const PRACTICE_HEADER = ['person', 'id', 'date', 'kind', 'original', 'suggestion', 'focus', 'unit', 'mode', 'firstPracticedAt', 'lastPracticedAt', 'count'];

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents || '{}');
    if (req.secret !== SECRET) return json({ ok: false, error: 'bad secret' });

    if (req.action === 'pull') return json({ ok: true, data: readAll_() });
    if (req.action === 'push') return json({ ok: true, data: merge_(req.data || {}) });
    if (req.action === 'openaiClientSecret') return json({ ok: true, data: openaiClientSecret_(req.data || {}) });
    if (req.action === 'newsTopics') return json({ ok: true, data: newsTopics_() });
    return json({ ok: false, error: 'unknown action' });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

// ---------- OpenAI Realtime 短效憑證 ----------
// 正式 API Key 只放在 Apps Script「指令碼屬性」的 OPENAI_API_KEY，絕不傳到網頁。
function openaiClientSecret_(input) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('OPENAI_API_KEY');
  if (!apiKey) throw new Error('尚未在指令碼屬性設定 OPENAI_API_KEY');

  const allowedModels = ['gpt-realtime-2.1-mini', 'gpt-realtime'];
  const allowedVoices = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar'];
  const model = allowedModels.indexOf(String(input.model || '')) >= 0 ? String(input.model) : 'gpt-realtime-2.1-mini';
  const voice = allowedVoices.indexOf(String(input.voice || '')) >= 0 ? String(input.voice) : 'marin';
  const learner = String(input.learnerId || 'family-learner').slice(0, 100);
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, SECRET + '|' + learner);
  const safetyId = digest.map(function(byte) { return ('0' + ((byte + 256) % 256).toString(16)).slice(-2); }).join('');

  const response = UrlFetchApp.fetch('https://api.openai.com/v1/realtime/client_secrets', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: 'Bearer ' + apiKey,
      'OpenAI-Safety-Identifier': safetyId
    },
    payload: JSON.stringify({
      session: {
        type: 'realtime',
        model: model,
        audio: { output: { voice: voice } }
      }
    }),
    muteHttpExceptions: true
  });
  const status = response.getResponseCode();
  const body = response.getContentText();
  if (status < 200 || status >= 300) throw new Error('OpenAI 憑證請求失敗 (' + status + '): ' + body.slice(0, 300));
  return JSON.parse(body);
}

// ---------- 近期新聞題材 ----------
// Realtime 模型本身沒有內建網頁搜尋；由後端讀取 Google News RSS，再把標題交給 Tutor 討論。
function newsTopics_() {
  const feeds = [
    { region: '台灣', url: 'https://news.google.com/rss?hl=zh-TW&gl=TW&ceid=TW:zh-Hant' },
    { region: '國際', url: 'https://news.google.com/rss/headlines/section/topic/WORLD?hl=zh-TW&gl=TW&ceid=TW:zh-Hant' }
  ];
  const topics = [];
  feeds.forEach(function(feed) {
    const response = UrlFetchApp.fetch(feed.url, { muteHttpExceptions: true });
    if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) return;
    const document = XmlService.parse(response.getContentText());
    const channel = document.getRootElement().getChild('channel');
    if (!channel) return;
    channel.getChildren('item').slice(0, 5).forEach(function(item) {
      topics.push({
        region: feed.region,
        title: String(item.getChildText('title') || '').slice(0, 180),
        publishedAt: String(item.getChildText('pubDate') || ''),
        link: String(item.getChildText('link') || '')
      });
    });
  });
  return { fetchedAt: new Date().toISOString(), topics: topics };
}

// 方便你用瀏覽器打開網址確認部署成功
function doGet() {
  return json({ ok: true, msg: 'AI Tutor sync is running.' });
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function sheet_(name, header) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    if (header) sh.appendRow(header);
  }
  return sh;
}

// ---------- 讀取 ----------
function readAll_() {
  return { schemaVersion: 2, vocab: readVocab_(), practice: readPractice_(), profiles: readState_() };
}

function readVocab_() {
  const sh = sheet_(VOCAB_SHEET, VOCAB_HEADER);
  const rows = sh.getDataRange().getValues();
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r[0] || !r[1]) continue;
    out.push({
      person: String(r[0]), word: String(r[1]), meaning: String(r[2] || ''),
      example: String(r[3] || ''), firstDate: fmtDate_(r[4]), lastDate: fmtDate_(r[5]),
      count: Number(r[6] || 1), unit: String(r[7] || '')
    });
  }
  return out;
}

function readPractice_() {
  const sh = sheet_(PRACTICE_SHEET, PRACTICE_HEADER);
  const rows = sh.getDataRange().getValues();
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r[0] || !r[1] || !r[5]) continue;
    out.push({
      person: String(r[0]), id: String(r[1]), date: fmtDate_(r[2]), kind: String(r[3] || 'corrected'),
      original: String(r[4] || ''), suggestion: String(r[5] || ''), focus: String(r[6] || ''),
      unit: String(r[7] || ''), mode: String(r[8] || 'lesson'),
      firstPracticedAt: Number(r[9] || 0), lastPracticedAt: Number(r[10] || 0), count: Number(r[11] || 1)
    });
  }
  return out;
}

function readState_() {
  const sh = sheet_(STATE_SHEET, ['person', 'json', 'updatedAt']);
  const rows = sh.getDataRange().getValues();
  const out = {};
  for (let i = 1; i < rows.length; i++) {
    if (!rows[i][0]) continue;
    try { out[String(rows[i][0])] = JSON.parse(rows[i][1] || '{}'); } catch (e) {}
  }
  return out;
}

// 試算表可能把日期存成 Date 物件，統一輸出 YYYY-MM-DD
function fmtDate_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Taipei', 'yyyy-MM-dd');
  return String(v || '');
}

// ---------- 合併寫入（兩支手機各自累積，這裡取聯集） ----------
function merge_(incoming) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);            // 兩支手機同時上傳時排隊，避免覆蓋
  try {
    mergeVocab_(incoming.vocab || []);
    mergePractice_(incoming.practice || []);
    mergeState_(incoming.profiles || {});
    return readAll_();             // 回傳合併後的完整資料，讓手機端對齊
  } finally {
    lock.releaseLock();
  }
}

function mergePractice_(incoming) {
  const sh = sheet_(PRACTICE_SHEET, PRACTICE_HEADER);
  const existing = readPractice_();
  const key = item => String(item.person) + '||' + String(item.id);
  const map = {};
  existing.forEach(item => { map[key(item)] = item; });

  incoming.forEach(item => {
    if (!item || !item.person || !item.id || !item.suggestion) return;
    const k = key(item);
    const cur = map[k];
    if (!cur) {
      map[k] = item;
    } else {
      // 同一筆練習可能由兩支手機同步回來：取較大的次數，避免重複灌水
      cur.count = Math.max(Number(cur.count || 1), Number(item.count || 1));
      cur.firstPracticedAt = Math.min(Number(cur.firstPracticedAt || item.firstPracticedAt || 0), Number(item.firstPracticedAt || cur.firstPracticedAt || 0));
      cur.lastPracticedAt = Math.max(Number(cur.lastPracticedAt || 0), Number(item.lastPracticedAt || 0));
      cur.original = cur.original || item.original || '';
      cur.suggestion = cur.suggestion || item.suggestion || '';
      cur.focus = cur.focus || item.focus || '';
      cur.unit = cur.unit || item.unit || '';
      cur.date = cur.date || item.date || '';
      cur.kind = cur.kind || item.kind || 'corrected';
      cur.mode = cur.mode || item.mode || 'lesson';
    }
  });

  const list = Object.keys(map).map(k => map[k]);
  list.sort((a, b) => (a.person + a.date + a.id).localeCompare(b.person + b.date + b.id));
  sh.clear();
  sh.appendRow(PRACTICE_HEADER);
  if (list.length) {
    sh.getRange(2, 1, list.length, PRACTICE_HEADER.length).setValues(list.map(item => [
      item.person, item.id, item.date, item.kind, item.original, item.suggestion, item.focus,
      item.unit, item.mode, item.firstPracticedAt, item.lastPracticedAt, item.count
    ]));
  }
}

function mergeVocab_(incoming) {
  const sh = sheet_(VOCAB_SHEET, VOCAB_HEADER);
  const existing = readVocab_();
  const key = v => String(v.person) + '||' + String(v.word).toLowerCase();
  const map = {};
  existing.forEach(v => { map[key(v)] = v; });

  incoming.forEach(v => {
    if (!v || !v.person || !v.word) return;
    const k = key(v);
    const cur = map[k];
    if (!cur) {
      map[k] = v;
    } else {
      // 同一個字：次數取大、第一次學取早、最後一次取晚、缺的欄位補上
      cur.count = Math.max(Number(cur.count || 1), Number(v.count || 1));
      if (v.firstDate && (!cur.firstDate || v.firstDate < cur.firstDate)) cur.firstDate = v.firstDate;
      if (v.lastDate && (!cur.lastDate || v.lastDate > cur.lastDate)) cur.lastDate = v.lastDate;
      cur.meaning = cur.meaning || v.meaning || '';
      cur.example = cur.example || v.example || '';
      cur.unit = cur.unit || v.unit || '';
    }
  });

  const list = Object.keys(map).map(k => map[k]);
  list.sort((a, b) => (a.person + a.firstDate).localeCompare(b.person + b.firstDate));

  sh.clear();
  sh.appendRow(VOCAB_HEADER);
  if (list.length) {
    sh.getRange(2, 1, list.length, VOCAB_HEADER.length).setValues(
      list.map(v => [v.person, v.word, v.meaning, v.example, v.firstDate, v.lastDate, v.count, v.unit]));
  }
}

function mergeState_(incoming) {
  const sh = sheet_(STATE_SHEET, ['person', 'json', 'updatedAt']);
  const existing = readState_();
  Object.keys(incoming).forEach(person => {
    const inc = incoming[person] || {};
    const cur = existing[person];
    // 設定類（程度、聲音、單元、進度）以「較新的更新時間」為準
    if (!cur || Number(inc.updatedAt || 0) >= Number(cur.updatedAt || 0)) existing[person] = inc;
  });

  const rows = Object.keys(existing).map(p => [p, JSON.stringify(existing[p]), new Date()]);
  sh.clear();
  sh.appendRow(['person', 'json', 'updatedAt']);
  if (rows.length) sh.getRange(2, 1, rows.length, 3).setValues(rows);
}
