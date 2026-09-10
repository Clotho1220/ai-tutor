(function (global) {
    "use strict";

    // 課前把「今天到底要做哪幾件事」全部算清楚，做成一份明確的項目清單。
    //
    // 這是計畫驅動架構的核心：決定「下一步做什麼」的責任從模型移回程式，
    // 模型只負責把每一個項目演出來。本模組是純函式，不碰 DOM、不呼叫網路。
    //
    // v3.19 起改成「辨識驅動」的教學模板。起因是實際上課發現孩子聽得懂 swim，
    // 但看到 swim 這個字認不出來——舊模板全程用講解與跟讀，從來沒逼她讀字。
    // 現在每一項都是「先讓她產出，答不出來才逐層給提示」：
    //
    //   word_image          看圖說英文       圖 → 加中文 → 加英文 → 跟讀 → 糾正
    //   word_read           看英文字說意思   字 → 加圖 → 加中文 → 跟讀
    //   pattern_substitute  中翻英代換       每個句型至少三種變化
    //   pattern_respond     聽問題答句子     Can you fly? → No, I can't.
    //
    // 提示階梯直接用「第幾次嘗試」表示，所以執行器不用多一個計數器，
    // 前端也可以依 attempts 自動揭露，不需要模型呼叫額外的工具。

    const REVIEW_UNIT_COUNT = 2;      // 跨單元複習取前兩個單元
    const WEEK_DAYS = 5;
    const SUBSTITUTIONS_PER_PATTERN = 3;   // 使用者要求：每個句型至少練三種
    const RESPOND_PER_DAY = 2;             // 每天的「聽問題答句子」項目數

    function text(value) {
        return String(value == null ? "" : value).trim();
    }

    // 「apple (n.)」→「apple」；比對是否重複時用
    function bareWord(value) {
        return text(value).replace(/\([^)]*\)/g, "").trim().toLowerCase();
    }

    // 把一組項目平均分到 n 天。12 個單字分 5 天 → 每天 2~3 個。
    function spreadAcrossDays(list, days) {
        const items = (list || []).filter(Boolean);
        const buckets = Array.from({ length: days }, () => []);
        items.forEach((item, index) => { buckets[index % days].push(item); });
        return buckets;
    }

    // 連續切塊：教新內容時同一批相關的字要待在一起
    function chunkInOrder(list, parts) {
        const items = (list || []).filter(Boolean);
        const per = Math.ceil(items.length / parts) || 1;
        return Array.from({ length: parts }, (_, i) => items.slice(i * per, (i + 1) * per));
    }

    // 句型輪轉挑選。句型是單元的核心，不能像單字那樣切塊之後某幾天完全沒練到：
    // 只有 1 個句型就每天都練；多個句型則輪流，確保五天內每個都被練過。
    function rotatePick(list, day, count) {
        const items = (list || []).filter(Boolean);
        if (!items.length) return [];
        const take = Math.min(count, items.length);
        return Array.from({ length: take }, (_, i) => items[(day - 1 + i) % items.length]);
    }

    // 句型字串拆成「問句」與「答句」。
    //   "What's your name? / I'm [Name]."           → 問 + 1 個答
    //   "Can you [action]? / Yes, I can. / No, I can't." → 問 + 2 個答
    //   "Subject + be + adjective."                 → 只有一個陳述句，沒有問答形式
    function splitPattern(english) {
        // 只以「空白 + 斜線 + 空白」分隔。句型內部本來就會出現斜線
        // （she/he、his/her、He/She's），用裸斜線切會把問句本身切碎。
        const parts = text(english).split(/\s+\/\s+/).map(part => part.trim()).filter(Boolean);
        const first = parts[0] || text(english);
        if (parts.length < 2) return { ask: first, answers: [], statements: [first] };
        // 問答型：第一段是問句，其餘是答句
        if (/[?？]$/.test(first)) return { ask: first, answers: parts.slice(1), statements: [] };
        // 非問答型（例如兩個祈使句）：每一段各自是一個獨立的練習目標
        return { ask: first, answers: [], statements: parts };
    }

    // 空格的名字對應到哪一種槽位。課本的句型各寫各的（[item]／[noun]／[singular]
    // 都是「一樣東西」），所以要先正規化再比對。
    const SLOT_ALIAS = {
        item: "object", items: "object", noun: "object", nouns: "object",
        thing: "object", things: "object", singular: "object", plural: "object",
        familymember: "person", relationship: "person", someone: "person",
        prep: "preposition", bodypart: "body_part", actioning: "action_ing"
    };

    function slotOf(placeholder) {
        const key = text(placeholder).toLowerCase().replace(/[^a-z]/g, "");
        return SLOT_ALIAS[key] || key;
    }

    // 把單字填進句型的空格。`Can you [action]?` + jump → `Can you jump?`
    //
    // 只填「跟這個句型的槽位相符」的空格。課本有些句型一句裡有兩個不同的空格
    // （`What do you do on [Day]? / I [action] on [Day].` 的槽位是 action），
    // 全部一起換會組出「What do you do on go?」這種句子，而這句會直接進導演指令
    // 唸給孩子聽。填不完整就回空字串，交給模型自己組（第 2 冊的「...」型也一樣）。
    function fillSlot(patternPart, word) {
        const sentence = text(patternPart);
        const value = bareWord(word && word.english);
        if (!sentence || !value || !/\[[^\]]+\]/.test(sentence)) return "";

        const slot = text(word && word.slot);
        const filledNames = new Set();
        let mismatched = false;
        const out = sentence.replace(/\[([^\]]+)\]/g, (whole, name) => {
            // 沒標槽位的字（自訂教材、測試資料）就照舊填，不要因為比對不到而整句放棄
            if (slot && slotOf(name) !== slotOf(slot)) return whole;
            // [singular] 與 [plural] 是同一個槽位的單複數兩型，字要跟著對
            const key = text(name).toLowerCase().replace(/[^a-z]/g, "");
            const wantsPlural = key === "plural" || key === "items";
            if ((key === "singular" || wantsPlural) && !!word.plural !== wantsPlural) {
                mismatched = true;
                return whole;
            }
            filledNames.add(text(name).toLowerCase());
            return value;
        });
        // 兩個不同名字的空格（[subject 1] 或 [subject 2]）要兩個不同的字，
        // 程式只有一個字，全填成一樣會變成「Which do you like, math or math?」
        if (!filledNames.size || filledNames.size > 1) return "";
        if (mismatched || /\[[^\]]+\]/.test(out)) return "";
        // 句型寫的是「a/an」，填完字要挑一個：Is this a/an whale? → Is this a whale?
        return out.replace(/\ba\/an\s+(\w)/gi,
            (whole, first) => (/[aeiou]/i.test(first) ? "an " : "a ") + first);
    }

    // ---------------- 提示階梯 ----------------
    // 每一階就是「第幾次嘗試」。答得出來就直接過，答不出來才往下一階。
    // reveal 告訴前端這一階該讓學生看到什麼。

    // 點選題共用的那段規則。每個階梯都要講一次，模型才不會自己判分或搶著推進。
    const TAP_RULE = "（孩子用點的：畫面上有選項，他會直接點。對錯由系統判定並自動換下一題，你不要判斷對錯、不要呼叫 report_item_result，也不要唸出選項——讀選項是他的工作。）";

    // 圖庫替每個字標了「這張圖適合問哪種問題」，直接拿來當提問方式
    const ASK_BY_TYPE = {
        what_is_this: "What's this?",
        who_is_this: "Who's he? 或 Who's she?（看圖上是男生還是女生）",
        what_is_he_doing: "What's he doing? 或 What's she doing?",
        how_is_he: "How does he feel? 或直接問 Is he happy?（圖是用對比呈現特徵的）",
        where_is_it: "Where is it?",
        where_is_this: "Where is this?",
        read_it: "圖上有字（時間、數字、星期），問 What does it say?"
    };

    function askQuestionFor(word) {
        return ASK_BY_TYPE[text(word.askType)] || ASK_BY_TYPE.what_is_this;
    }

    // 看圖說英文：圖 → 加中文 → 加英文 → 跟讀 → 糾正一次
    function imageLadder(word) {
        return [
            { reveal: { image: true },
              instruction: "只給圖，用英文問「" + askQuestionFor(word) +
                  "」，然後停下來等學員用英文回答。答對就簡短稱讚一句並回報，然後停下來等下一個指令——不要追加例句或造句，也不要反問他任何問題。" },
            { reveal: { image: true, chinese: true },
              instruction: "學員答不出來。把中文意思顯示出來並唸出中文，" +
                  "問他這個東西的英文怎麼說，然後等他回答。" },
            { reveal: { image: true, chinese: true, english: true },
              instruction: "還是答不出來。把英文單字顯示出來，請他自己試著把這個字唸出來，" +
                  "然後等他唸。這一階的重點是讀字，先不要幫他唸。" },
            { reveal: { image: true, chinese: true, english: true },
              instruction: "他讀不出這個字。清楚慢慢地唸一次給他聽，請他跟著唸一次，然後等他唸。" },
            { reveal: { image: true, chinese: true, english: true },
              instruction: "他唸得不夠標準。明確指出是哪個音不對，再示範一次，" +
                  "請他最後再唸一次。這是最後一次糾正，唸完就往下走。" }
        ];
    }

    // 看英文字說意思：字 → 加圖 → 加中文 → 跟讀
    // 這是為了「看得懂聽不懂、看不出意思」設計的反向練習，直接練認字。
    function readLadder(hasTap) {
        if (!hasTap) return [
            { reveal: { english: true },
              instruction: "只顯示這個英文單字，不給圖也不給中文。" +
                  "請學員把這個字唸出來，並說出它的中文意思，然後等他回答。" +
                  "答對就簡短稱讚一句並回報，然後停下來等下一個指令——不要追加例句或造句，也不要反問他任何問題。" },
            { reveal: { english: true, image: true },
              instruction: "他認不出來。把圖顯示出來當提示，再問他一次這個字怎麼唸、是什麼意思。" },
            { reveal: { english: true, image: true, chinese: true },
              instruction: "還是不行。把中文也顯示出來，請他把英文再唸一次，然後等他唸。" },
            { reveal: { english: true, image: true, chinese: true },
              instruction: "清楚唸一次給他聽，請他跟著唸一次。這是最後一階，唸完就往下走。" }
        ];
        // 唸完點中文：先唸這個字，再從三個中文裡點出意思
        return [
            { reveal: { english: true, tap: true },
              instruction: "畫面顯示這個英文單字和三個中文選項。請學員先把這個字唸出來，" +
                  "再點出正確的中文意思，然後結束回合等他做。" + TAP_RULE },
            { reveal: { english: true, image: true, tap: true },
              instruction: "點錯了。把圖顯示出來當提示，請他再唸一次這個字、再點一次中文。" + TAP_RULE },
            { reveal: { english: true, image: true, chinese: true, tap: true },
              instruction: "還是不行。清楚唸一次這個字、說出它的中文意思，" +
                  "請他跟著唸一次再點那個中文。這是最後一階。" + TAP_RULE }
        ];
    }

    // 中翻英（第 1 天）：圖＋中文 → 說英文；說不出來才亮英文字讓他讀
    function zh2enLadder() {
        return [
            { reveal: { image: true, chinese: true },
              instruction: "畫面顯示圖片和中文。用中文問學員這個的英文怎麼說，" +
                  "然後結束回合等他說。答對就簡短稱讚一句並回報，然後停下來等下一個指令——不要追加例句，也不要反問他任何問題。" },
            { reveal: { image: true, chinese: true, english: true },
              instruction: "說不出來。把英文字顯示出來，請他自己把這個字唸出來，然後等他唸。" },
            { reveal: { image: true, chinese: true, english: true },
              instruction: "讀不出來。清楚慢慢地唸一次給他聽，請他跟著唸一次，然後等他唸。" },
            { reveal: { image: true, chinese: true, english: true },
              instruction: "唸得不夠標準。指出是哪個音不對，再示範一次，請他最後再唸一次。" +
                  "這是最後一次糾正，唸完就往下走。" }
        ];
    }

    // 三選一（第 3 天）：畫面顯示三個英文字，AI 說中文，孩子唸出正確的那個。
    // 練的是相似字形的辨識，跟紙本練習卷的第三天同題型。
    function choiceLadder(hasTap) {
        if (hasTap) return [
            { reveal: { english: true, tap: true },
              instruction: "畫面顯示三個英文單字。你用中文說出目標的意思，" +
                  "請學員點出正確的那一個、再把它唸出來，然後結束回合等他做。" + TAP_RULE },
            { reveal: { english: true, image: true, tap: true },
              instruction: "點錯了。把圖顯示出來當提示，請他再點一次、再唸一次。" + TAP_RULE },
            { reveal: { english: true, image: true, chinese: true, tap: true },
              instruction: "還是不行。告訴他正確答案是哪一個並唸給他聽，" +
                  "請他跟著唸一次再點它。這是最後一階。" + TAP_RULE }
        ];
        return [
            { reveal: { english: true },
              instruction: "畫面顯示三個英文單字。你用中文說出目標的意思，" +
                  "請學員從三個字裡唸出正確的那一個，然後等他唸。" +
                  "不要把三個選項唸出來——讀選項是他的工作。" },
            { reveal: { english: true, image: true },
              instruction: "選錯或唸不出來。把圖顯示出來當提示，再請他從三個字裡唸一次正確的。" },
            { reveal: { english: true, image: true, chinese: true },
              instruction: "還是不行。告訴他正確答案是哪一個並唸給他聽，請他跟著唸一次。" +
                  "這是最後一階，唸完就往下走。" }
        ];
    }

    // 填缺漏字母（第 4 天）：畫面顯示 d_s_ 這種遮罩字，孩子說出缺的字母、再唸整個字
    function gapLadder(hasTap) {
        if (hasTap) return [
            { reveal: { image: true, chinese: true, english: true, tap: true },
              instruction: "畫面顯示這個字的挖空版本（缺的字母用底線代替）、圖，" +
                  "以及一排字母。用中文說這個字的意思，請學員照順序點出缺少的字母，" +
                  "再把整個字唸出來，然後結束回合等他做。" +
                  "你自己不要把這個英文字唸出來，也不要說出缺的是哪些字母。" + TAP_RULE },
            { reveal: { image: true, chinese: true, english: true, tap: true },
              instruction: "點錯了。唸出整個字讓他對照，請他再點一次缺少的字母。" + TAP_RULE },
            { reveal: { image: true, chinese: true, english: true, tap: true },
              instruction: "還是不行。你把缺少的字母一個一個唸出來，請他跟著唸再點出來，" +
                  "最後請他唸整個字。這是最後一階。" + TAP_RULE }
        ];
        return [
            { reveal: { image: true, chinese: true, english: true },
              instruction: "畫面顯示這個字的挖空版本（部分字母用底線代替）和圖。" +
                  "用中文說這個字的意思、請學員說出缺少的字母，再把整個字唸出來，然後等他說。" +
                  "你自己不要把這個英文字唸出來——唸出來等於告訴他怎麼拼" +
                  "（2026-09-04 實測 AI 每題都先說「它是 pencil 的意思」）。" +
                  "判斷從寬：他把整個字唸對就算對，不用堅持先講字母。" },
            { reveal: { image: true, chinese: true, english: true },
              instruction: "說不出缺的字母。給他一點提示（例如唸出整個字讓他對照），" +
                  "再請他說一次缺少的字母，然後等他說。" },
            { reveal: { image: true, chinese: true, english: true },
              instruction: "還是不行。你把缺少的字母一個一個唸出來，請他跟著唸，" +
                  "最後請他唸整個字。這是最後一階，唸完就往下走。" }
        ];
    }

    // 拼字：憑記憶拼 → 看著字拼 → AI 示範跟拼
    // 語音轉文字會把逐字母拼讀轉爛（HANDOFF 已知陷阱），所以對錯只能靠
    // 原生音訊模型自己聽，前端不做驗證——與發音判斷同一個信任模式。
    function spellLadder(hasTap) {
        if (hasTap) return [
            { reveal: { image: true, chinese: true, tap: true },
              instruction: "畫面顯示圖、中文，和打散的字母。先請學員說出這個東西的英文，" +
                  "說對後請他照順序把字母點出來，把這個字排出來，然後結束回合等他做。" +
                  "畫面上沒有完整的英文字，這一階練的是記憶。" + TAP_RULE },
            { reveal: { image: true, chinese: true, english: true, tap: true },
              instruction: "排錯了。把英文字顯示出來，請他看著字再排一次。" + TAP_RULE },
            { reveal: { image: true, chinese: true, english: true, tap: true },
              instruction: "還是不行。你一個字母一個字母慢慢唸一次，請他跟著唸、跟著點。" +
                  "這是最後一階。" + TAP_RULE }
        ];
        return [
            { reveal: { image: true, chinese: true },
              instruction: "先請學員說出這個東西的英文，說對後請他憑記憶一個字母一個字母拼出來，" +
                  "然後停下來等他拼。畫面上沒有英文字，這一階練的是記憶。" },
            { reveal: { image: true, chinese: true, english: true },
              instruction: "拼不出來。把英文字顯示出來，請他看著字把字母一個一個唸出來，然後等他唸。" },
            { reveal: { image: true, chinese: true, english: true },
              instruction: "還是不行。你一個字母一個字母慢慢示範拼一次，請他跟著拼一次。" +
                  "這是最後一階，拼完就往下走。" }
        ];
    }

    // 句型代換與對答：原本 + 糾正兩次（使用者要求最多糾正 2 次）
    function sentenceLadder(kind, hasTap) {
        // 對答題點答案：句型給了兩個答句（Yes, I can. ／ No, I can't.），
        // 哪一個對是看圖決定的，點完再說一次。代換題不做（那題要練自己講出來）。
        if (kind === "respond" && hasTap) {
            const withTap = { image: true, english: true, chinese: true, tap: true };
            const withSentence = { image: true, english: true, chinese: true,
                                   tap: true, sentence: true };
            return [
                { reveal: withTap,
                  instruction: "扮演提問的人，用英文把這個問題問出來。畫面上有幾個答句可以點，" +
                      "請學員看圖點出正確的那一句、再用英文說一次，然後結束回合等他做。" +
                      TAP_RULE },
                { reveal: withSentence,
                  instruction: "點錯了。用圖提醒他答案要看圖決定，請他再點一次、再說一次。" +
                      TAP_RULE },
                { reveal: withSentence,
                  instruction: "還是不對。慢慢地把正確的答句說一次，請他跟著說一次再點它。" +
                      "這是最後一階。" + TAP_RULE }
            ];
        }
        // 對答題有情境圖就全程顯示——答案是看圖決定的。
        // 代換題顯示要代換的單字（英文＋中文）：句子結構才是這題要考的，
        // 單字給出來是合理的鷹架；全空白的畫面實測會讓孩子不知道現在在幹嘛。
        // 有對話漫畫時圖全程顯示（沒有圖的項目 revealFor 會自己擋掉）。
        // sentence＝把整句英文壓進漫畫的泡泡裡。第一階不給：那句正是要孩子自己說的，
        // 先寫上去就等於洩答。等到 AI 已經示範過（第二階起）再顯示，當作對照。
        const reveal = { image: true, english: true, chinese: true };
        const shown = { image: true, english: true, chinese: true, sentence: true };
        const first = kind === "respond"
            ? "扮演提問的人，用英文把這個問題問出來，請學員用英文回答，然後等他回答。"
            : "用中文把整句說出來，請學員試著用英文說出來，然後等他說。";
        return [
            { reveal, instruction: first },
            { reveal: shown,
              instruction: "說得不對。明確指出是哪裡不對（用錯的字、少了什麼、順序不對），" +
                  "示範一次正確的句子，請他再說一次，然後等他說。" },
            { reveal: shown,
              instruction: "還是不對。慢慢地再示範一次完整句子，請他跟著說一次。" +
                  "這是第二次糾正，也是最後一次，說完就往下走。" }
        ];
    }

    // ---------------- 點選作答（2026-09-09 使用者定案） ----------------
    // 第 2〜5 天的單字與句子對答改成「畫面上點」：
    //   第 2 天 唸完點中文、第 3 天 點選再唸、第 4 天 點缺的字母、第 5 天 排字母、
    //   對答題點答案。
    //
    // 對錯由程式判定、程式推進，模型只負責出題與回饋。這一來
    // 「拼字用語音辨識不可靠」與「發音正確性偵測不到」這兩個已知限制就繞過去了
    // （孩子唸 a-p-p-l-e 幾乎一定被轉錯，逐字稿根本看不出他拼對沒有）。
    //
    // 第 1 天中翻英與句型代換維持純口說：那兩項要練的是「自己講出來」，
    // 給選項就變成認字題。

    // 固定的洗牌：同一個字每次跑出來的順序都一樣，測試與診斷才對得起來。
    function seededOrder(count, seed) {
        const order = Array.from({ length: count }, (_, i) => i);
        let n = 0;
        for (const ch of text(seed)) n = (n * 31 + ch.charCodeAt(0)) % 100003;
        // 低位元的隨機性很差，取中段的位元；先空轉幾次讓種子散開，
        // 否則三選一的答案會有一半落在中間那格，孩子會學會「猜中間」
        for (let warm = 0; warm < 8; warm++) n = (n * 1103515245 + 12345) % 2147483648;
        for (let i = count - 1; i > 0; i--) {
            n = (n * 1103515245 + 12345) % 2147483648;
            const j = Math.floor(n / 65536) % (i + 1);
            const tmp = order[i]; order[i] = order[j]; order[j] = tmp;
        }
        return order;
    }

    // keepDuplicates：排字母時 apple 的兩個 p 都要在，不能被去重掉
    function tapOptions(labels, seed, keepDuplicates) {
        const list = labels.map(text).filter((label, i, all) =>
            label && (keepDuplicates || all.indexOf(label) === i));
        return seededOrder(list.length, seed).map((from, i) => ({
            id: "o" + (i + 1), label: list[from]
        }));
    }

    function idOf(options, label) {
        const found = (options || []).find(option => option.label === text(label));
        return found ? found.id : "";
    }

    // 單選：點一下就是一次作答
    function pickOne(labels, correct, seed, hint) {
        const options = tapOptions(labels, seed);
        const answer = idOf(options, correct);
        if (!answer || options.length < 2) return null;
        return { mode: "pick", ordered: false, options, answer: [answer], hint };
    }

    // 依序點：字母要一個一個按順序點出來
    function pickOrder(labels, sequence, seed, hint, mode) {
        const options = tapOptions(labels, seed, true);
        // 同一個字母可能出現兩次（apple 的 p），照順序配掉還沒用過的那一個
        const used = new Set();
        const answer = sequence.map(letter => {
            const found = (options || []).find(option =>
                option.label === text(letter) && !used.has(option.id));
            if (found) used.add(found.id);
            return found ? found.id : "";
        });
        if (!answer.length || answer.some(id => !id)) return null;
        return { mode: mode || "order", ordered: true, options, answer, hint };
    }

    // 這一題點對了沒。picked 是已經點下去的 id 陣列（依點的順序）。
    // 回傳 done＝這次作答結束（該報結果了）、correct＝對不對。
    function checkTap(item, picked) {
        const tap = item && item.tap;
        const chosen = (picked || []).filter(Boolean);
        if (!tap || !chosen.length) return { done: false, correct: false };
        if (!tap.ordered) {
            return { done: true, correct: chosen[0] === tap.answer[0] };
        }
        // 依序點：只要有一步點錯就算這次作答失敗，不用等他點完
        const wrong = chosen.some((id, i) => id !== tap.answer[i]);
        if (wrong) return { done: true, correct: false };
        return { done: chosen.length >= tap.answer.length, correct: true };
    }

    function makeItem(item) {
        const ladder = item.ladder || [];
        return Object.assign({
            status: "pending",
            maxAttempts: Math.max(1, ladder.length)
        }, item);
    }

    // ---------------- 各類項目 ----------------

    function imageWordItems(words, idPrefix, sourceLabel) {
        return (words || []).map((word, index) => makeItem({
            id: `${idPrefix}-${index + 1}`,
            type: "word_image",
            target: bareWord(word.english),
            display: text(word.english),
            meaning: text(word.chinese),
            example: text(word.example),
            image: text(word.image),
            askType: text(word.askType),
            source: sourceLabel || "",
            ladder: imageLadder(word)
        }));
    }

    function readWordItems(words, pool, idPrefix, sourceLabel) {
        const meanings = (pool || words || []).map(other => text(other.chinese)).filter(Boolean);
        return (words || []).map((word, index) => {
            const answer = text(word.chinese);
            const others = meanings.filter(meaning => meaning !== answer);
            const tap = pickOne(
                [answer].concat(others.slice(index % Math.max(1, others.length)).slice(0, 2),
                    others.slice(0, 2)).slice(0, 3),
                answer, `${idPrefix}-${index}-${answer}`, "唸完之後，點出它的中文意思");
            return makeItem({
                id: `${idPrefix}-${index + 1}`,
                type: "word_read",
                target: bareWord(word.english),
                display: text(word.english),
                meaning: answer,
                example: text(word.example),
                image: text(word.image),
                source: sourceLabel || "",
                tap,
                ladder: readLadder(!!tap)
            });
        });
    }

    function spellWordItems(words, idPrefix, sourceLabel) {
        return (words || []).map((word, index) => makeItem({
            id: `${idPrefix}-${index + 1}`,
            type: "word_spell",
            target: bareWord(word.english),
            display: text(word.english),
            meaning: text(word.chinese),
            // 給模型的逐字母參考：t-a-b-l-e（判斷與示範都用得到）
            letters: bareWord(word.english).replace(/[^a-z0-9]/g, "").split("").join("-"),
            image: text(word.image),
            source: sourceLabel || "",
            tap: spellTap(word),
            ladder: spellLadder(!!spellTap(word))
        }));
    }

    // 第 5 天排字母：整個字的字母打散，照順序點回來
    function spellTap(word) {
        const letters = bareWord(word.english).replace(/[^a-z0-9]/g, "").split("");
        if (letters.length < 2) return null;
        return pickOrder(letters, letters, "spell-" + letters.join(""),
            "照順序點出字母，把這個字排出來", "spell");
    }

    function zh2enWordItems(words, idPrefix, sourceLabel) {
        return (words || []).map((word, index) => makeItem({
            id: `${idPrefix}-${index + 1}`,
            type: "word_zh2en",
            target: bareWord(word.english),
            display: text(word.english),
            meaning: text(word.chinese),
            example: text(word.example),
            image: text(word.image),
            source: sourceLabel || "",
            ladder: zh2enLadder()
        }));
    }

    // 遮罩字：挖第 2、4 個字母，最多兩格。desk → d_s_、chair → c_a_r、grandfather → g_a_dfather
    // 原本每隔一個字母就挖（grandfather 挖五格），2026-09-04 實測孩子跟模型都被
    // 搞得很累，模型還因為「字母順序不對」連判三次錯。
    const GAP_POSITIONS = [1, 3];
    function maskWord(value) {
        const word = bareWord(value);
        let out = "";
        let alphaIndex = 0;
        for (const ch of word) {
            if (!/[a-z0-9]/.test(ch)) { out += ch; continue; }
            out += GAP_POSITIONS.indexOf(alphaIndex) >= 0 ? "_" : ch;
            alphaIndex += 1;
        }
        return out;
    }

    function missingLetters(value) {
        const word = bareWord(value);
        const missing = [];
        let alphaIndex = 0;
        for (const ch of word) {
            if (!/[a-z0-9]/.test(ch)) continue;
            if (GAP_POSITIONS.indexOf(alphaIndex) >= 0) missing.push(ch);
            alphaIndex += 1;
        }
        return missing.join("-");
    }

    function gapWordItems(words, idPrefix, sourceLabel) {
        return (words || []).map((word, index) => makeItem({
            id: `${idPrefix}-${index + 1}`,
            type: "word_gap",
            target: bareWord(word.english),
            display: maskWord(word.english),          // 畫面顯示挖空版
            answerDisplay: text(word.english),        // 完成卡片顯示完整字
            meaning: text(word.chinese),
            letters: bareWord(word.english).replace(/[^a-z0-9]/g, "").split("").join("-"),
            missing: missingLetters(word.english),
            image: text(word.image),
            source: sourceLabel || "",
            tap: gapTap(word),
            ladder: gapLadder(!!gapTap(word))
        }));
    }

    // 第 4 天點字母：缺的那兩個字母，混進字裡其他字母當誘答，湊到六顆
    function gapTap(word) {
        const letters = bareWord(word.english).replace(/[^a-z0-9]/g, "").split("");
        const missing = missingLetters(word.english).split("-").filter(Boolean);
        if (!missing.length) return null;
        const extras = letters.filter(letter => missing.indexOf(letter) < 0);
        const alphabet = "abcdefghijklmnopqrstuvwxyz".split("");
        const filler = alphabet.filter(letter => letters.indexOf(letter) < 0);
        const pad = extras.concat(filler).slice(0, Math.max(0, 6 - missing.length));
        return pickOrder(missing.concat(pad), missing,
            "gap-" + bareWord(word.english), "點出缺少的字母（照順序）", "letters");
    }

    // 三選一的誘答選項：從同一批字裡輪流取兩個（相同 slot 的字外形與主題最接近）
    function choiceWordItems(words, pool, idPrefix, sourceLabel) {
        const candidates = (pool || []).map(word => bareWord(word.english)).filter(Boolean);
        return (words || []).map((word, index) => {
            const answer = bareWord(word.english);
            const others = candidates.filter(candidate => candidate !== answer);
            const distractors = others.length
                ? [others[index % others.length],
                   others[(index + 1) % others.length]].filter((v, i, a) => a.indexOf(v) === i)
                : [];
            const options = [answer].concat(distractors);
            // 依 index 決定正確答案的位置，避免永遠排第一個
            const rotated = options.map((_, i) => options[(i + index) % options.length]);
            return makeItem({
                id: `${idPrefix}-${index + 1}`,
                type: "word_choice",
                target: answer,
                display: rotated.join("　"),          // 畫面同時顯示三個字
                answerDisplay: text(word.english),
                options: rotated,
                meaning: text(word.chinese),
                image: text(word.image),
                source: sourceLabel || "",
                tap: pickOne(rotated, answer, "choice-" + answer, "點出正確的那個字，再唸一次"),
                ladder: choiceLadder(rotated.length > 1)
            });
        });
    }

    // 句型代換：拿學過的字去換句型裡的空格。
    // 使用者的例子：當週句型 Can you sing?，之前學過 jump → 練 Can you jump?
    //
    // 程式只決定「用哪個字、練幾次」，句子與中文提示交給模型組。
    // 原因是中文的量詞跟著名詞變（一張書桌／一顆蘋果），程式自動組會出錯。
    // ---- 句型對話漫畫（dialogues.json）----
    // 一張圖＝一個句型 × 一個代換字。左上 Gogo 的泡泡、右上小朋友的泡泡都是空白的，
    // 句子要不要壓進泡泡由前端依提示階梯決定（見 bubblesFor）。
    function dialogueFor(dialogues, patternEnglish, word) {
        const pat = text(patternEnglish);
        const key = bareWord(word);
        const samePattern = (dialogues || []).filter(d => text(d.pattern) === pat);
        if (!samePattern.length) return null;
        if (!key) return samePattern[0];
        return samePattern.find(d => bareWord(d.word) === key) || null;
    }

    // 圖上兩個泡泡各要寫什麼。代換題是「孩子自己把句子說出來」，
    // 先寫上去就等於洩答，所以要等提示階梯揭露英文之後才填。
    function bubblesFor(item, reveal) {
        if (!item || !item.image || !item.dialogue) return null;
        const showSentence = !!(reveal && reveal.sentence);
        if (item.type === "pattern_respond") {
            // 問句是 AI 自己會唸出來的，寫在泡泡裡不算洩答；答句要孩子說。
            return { left: text(item.ask), right: showSentence ? text(item.target) : "" };
        }
        if (item.type === "pattern_substitute") {
            return { left: showSentence ? text(item.target) : "", right: "" };
        }
        return null;
    }

    function substituteItems(pattern, words, idPrefix, dialogues) {
        const parts = splitPattern(pattern.english);
        return (words || []).map((word, index) => {
        const dlg = dialogueFor(dialogues, pattern.english, word.english);
        const asked = fillSlot(parts.ask, word) || fillSlot(parts.statements[0], word);
        // 句型裡的擇一（Does she/he want...、She's/He's my...）程式挑不了，
        // 挑錯就變成「She's my grandfather.」。漫畫上畫的是哪一個就用哪一句。
        const eitherOr = /[A-Za-z']+\/[A-Za-z']+/.test(asked);
        // 圖裡演的情境要跟要練的句子是同一句，不然孩子看圖說出來的會是另一句
        const usable = !!dlg && (!asked || eitherOr
            || sameSentence(dlg.ask, asked) || sameSentence(dlg.answer, asked));
        // 代換的空格不一定在問句裡（「What do they want? / They want a/an [item].」練的是
        // 答句），但答句也常留著擇一，所以答句放最後。
        const target = (asked && !eitherOr ? asked : "")
            || (usable ? sentenceWith(dlg, word.english) : "")
            || asked
            || parts.answers.reduce((found, part) => found || fillSlot(part, word), "");
        return makeItem({
            id: `${idPrefix}-${index + 1}`,
            type: "pattern_substitute",
            pattern: text(pattern.english),
            patternNote: text(pattern.chinese),
            slotWord: text(word.english),
            slotMeaning: text(word.chinese),
            // 畫面顯示用：代換的字 + 整句中文（實測只顯示單字時孩子不知道要說哪一句）
            display: bareWord(word.english),
            promptZh: text(pattern.zh) ? text(pattern.zh).replace(/【】/g, text(word.chinese)) : "",
            meaning: text(pattern.zh)
                ? text(pattern.zh).replace(/【】/g, text(word.chinese))
                : text(word.chinese),
            // 三種都組不出來（第 2 冊的「...」型）就留空，交給模型組
            target,
            image: usable ? text(dlg.image) : "",
            dialogue: usable,
            ladder: sentenceLadder("substitute")
        });
        });
    }

    // 漫畫的問句與答句裡，含這個代換字的是哪一句（都沒有就用問句）
    function sentenceWith(dlg, wordEnglish) {
        const key = bareWord(wordEnglish);
        const has = sentence => key && text(sentence).toLowerCase().includes(key);
        if (has(dlg && dlg.answer) && !has(dlg && dlg.ask)) return text(dlg.answer);
        return text(dlg && dlg.ask);
    }

    // 比較兩句英文是不是同一句（忽略大小寫、標點與多餘空白）
    function sameSentence(a, b) {
        const norm = s => text(s).toLowerCase().replace(/[^a-z0-9']+/g, " ").trim();
        return !!norm(a) && norm(a) === norm(b);
    }

    // 聽問題答句子。情境圖的設計原則是「看圖就能決定答案」，
    // 所以有圖的時候答案唯一，判斷得出對錯。
    // 情境圖的 lines 格式："Who's she? — She's my mother. / Who's he? — He's my father."
    // 拆成一組組「問句 — 答句」
    function sceneQAPairs(scene) {
        const pairs = [];
        text(scene && scene.lines).split(/\s+\/\s+/).forEach(chunk => {
            const parts = chunk.split(/\s+[—–-]\s+/).map(part => part.trim()).filter(Boolean);
            if (parts.length < 2) return;
            // 一張圖上可能畫了兩組問答，中間沒有斜線：
            // 「Where are my glasses? — They're in front of the bookcase.
            //   Where's my wallet? — It's behind the sofa.」
            // 用破折號切完，中間那段會是「答句。下一個問句?」，在句尾標點後再切一次。
            let ask = parts[0];
            for (let i = 1; i < parts.length && ask; i++) {
                const both = i < parts.length - 1 && parts[i].match(/^(.*?[.!?])\s+(.+\?)$/);
                pairs.push({ ask, answer: (both ? both[1] : parts[i]).trim() });
                ask = both ? both[2].trim() : "";
            }
        });
        return pairs;
    }

    // 句型的問句開頭（去掉 [空格] 與 she/he 這類擇一）：「Who's she/he?」→ "who s"
    function askHead(ask) {
        return text(ask).toLowerCase().replace(/\[[^\]]*\]/g, " ")
            .replace(/[^a-z0-9']+/g, " ").trim().split(" ").slice(0, 2).join(" ");
    }

    // 找一張「跟這個句型對得上」的情境圖，並回傳圖上那一組問答。
    // 2026-09-03 實測：情境圖原本用索引輪流配，Who's she? 配到男孩的圖、
    // What's that? 配到奶奶的圖（AI 因此教出 It's a grandmother）。
    function sceneForPattern(pattern, scenes) {
        const head = askHead(splitPattern(pattern.english).ask);
        if (!head) return null;
        for (const scene of scenes || []) {
            for (const pair of sceneQAPairs(scene)) {
                if (askHead(pair.ask) === head) return { scene, pair };
            }
        }
        return null;
    }

    function respondItems(pattern, scenes, idPrefix, dialogues) {
        const parts = splitPattern(pattern.english);
        if (!parts.answers.length) return [];
        const matched = sceneForPattern(pattern, scenes);
        // 沒有情境圖時，句型字串本身留著空格：「It's [preposition] the [furniture].」
        // 直接拿來當答案，等於要孩子照著唸空格。對話漫畫的問答是具體的，改用它。
        const concrete = (dialogues || []).find(d => text(d.pattern) === text(pattern.english)
            && !/\[[^\]]*\]/.test(text(d.ask) + text(d.answer)));
        const fallback = !matched && concrete
            ? { ask: text(concrete.ask), answer: text(concrete.answer) }
            : { ask: parts.ask, answer: parts.answers[0] };
        const ask = matched ? matched.pair.ask : fallback.ask;
        const answer = matched ? matched.pair.answer : fallback.answer;
        // 對話漫畫比情境圖更貼題（一張圖就是一組問答），問句與答句都對得上才用，
        // 否則沿用原本的情境圖。
        const dlg = (dialogues || []).find(d => text(d.pattern) === text(pattern.english)
            && sameSentence(d.ask, ask) && sameSentence(d.answer, answer));
        // 點答案：句型本身就給了幾個答句（Yes, I can. ／ No, I can't.），
        // 哪一個對是看圖決定的，正好可以讓孩子點。只有一個答句或答句還帶著
        // 空格的句型就不做，維持純口說。
        const choices = parts.answers.map(text)
            .filter(one => one && !/\[[^\]]*\]/.test(one));
        const tap = choices.length >= 2 && choices.indexOf(text(answer)) >= 0
            ? pickOne(choices, answer, "respond-" + text(pattern.english), "點出正確的回答，再說一次")
            : null;
        return [makeItem({
            id: idPrefix,
            type: "pattern_respond",
            pattern: text(pattern.english),
            ask,
            target: answer,
            tap,
            alternatives: matched ? parts.answers : parts.answers.slice(1),
            // 畫面：英文問句 + 中文回答提示（實測只有圖時孩子不知道該說什麼句子）
            display: ask,
            meaning: text(pattern.answerZh),
            image: dlg ? text(dlg.image) : (matched ? text(matched.scene.image) : ""),
            dialogue: !!dlg,
            sceneLines: matched ? text(matched.scene.lines) : "",
            ladder: sentenceLadder("respond", !!tap)
        })];
    }

    // ---------------- 字母單元（認識 A–Z 與它的發音） ----------------
    // 2026-09-10 使用者定案。跟其他項目最大的不同是**不判對錯、不給評語**：
    // 這是「帶著唸」，不是考試。孩子跟著唸完就往下一張，AI 不要說「你唸得很棒」。
    //
    // 一個字母兩張卡（apple／ant）。第一張帶字母與它的音，第二張只帶例字——
    // 同一個字母的兩張一定排在同一天，不會被切開。
    // 卡面上已經印了字母、英文與中文，所以前端整張顯示就好。

    // 26 個字母分成 5 天，每天連續的一段，天數之間最多差一個
    // （chunkInOrder 會切成 6/6/6/6/2，最後一天只剩兩個字母）。
    function splitEvenly(list, parts) {
        const items = (list || []).filter(Boolean);
        const buckets = [];
        let start = 0;
        for (let i = 0; i < parts; i++) {
            const size = Math.ceil((items.length - start) / (parts - i));
            buckets.push(items.slice(start, start + size));
            start += size;
        }
        return buckets;
    }

    function letterItems(letters, idPrefix) {
        const items = [];
        (letters || []).forEach((entry, letterIndex) => {
            const letter = text(entry.letter);
            const sound = text(entry.sound);
            const soundNote = text(entry.soundNote);
            (entry.words || []).forEach((word, wordIndex) => {
                const english = text(word.english);
                const chinese = text(word.chinese);
                const first = wordIndex === 0;
                // 第一張帶字母與它的音。用例字當錨（apple 開頭的那個音），
                // 例字錨不住的字母（X）才另外說明。
                const anchor = soundNote || `就是「${english}」開頭的那個音`;
                const lead = first
                    ? `畫面上是字母卡。先清楚地唸字母的名字「${letter}」，` +
                      `再用英文發出這個字母最常見的那個音 ${sound}（${anchor}），` +
                      `再唸例字「${english}」（${chinese}），`
                    : `同一個字母「${letter}」的第二張卡。唸例字「${english}」（${chinese}），`;
                items.push(makeItem({
                    id: `${idPrefix}-${letterIndex + 1}-${wordIndex + 1}`,
                    type: "letter_say",
                    letter,
                    sound,
                    soundNote,
                    target: english,
                    // 畫面：卡面上已經有英文與中文，這裡只再大大地秀一次字母。
                    // 發音不印在畫面上（使用者定案：不標注音）——音是用聽的。
                    display: letter,
                    meaning: "",
                    example: chinese,
                    image: text(word.image),
                    // 播放模式要的兩個欄位。2026-09-10 三輪「完全沒聲音」的真正原因就是這裡
                    // 沒帶出來：item.audio 是 undefined，播放器每張卡都靜靜跳到 2.6 秒的安靜。
                    audio: text(word.audio),
                    say: text(word.say),
                    first,
                    maxAttempts: 1,
                    ladder: [{
                        reveal: { image: true, english: true, chinese: true },
                        // 「不評分、不稱讚」那條規則寫在 itemDirective 裡，這裡只講這一步要做什麼
                        instruction: lead + "然後請他跟著唸一次，結束回合等他唸。"
                    }]
                }));
            });
        });
        return items;
    }

    function buildLetterPlan(config, unit, day) {
        const blocks = splitEvenly(unit.letters || [], WEEK_DAYS);
        const today = blocks[day - 1] || [];
        const items = [makeItem({
            id: "opening",
            type: "opening",
            maxAttempts: 1,
            ladder: [{ reveal: {},
                instruction: "開場白：告訴孩子今天要認識哪幾個字母" +
                    (today.length ? `（${today.map(one => text(one.letter)).join("、")}）` : "") +
                    "，說我們會看圖卡、一起唸字母和它的音。" +
                    "最後用英文問「Are you ready?」，然後結束回合等待回答。" +
                    "孩子不管回答什麼都算開場完成，立刻回報。" }]
        })];
        items.push(...letterItems(today, "lt"));
        items.push(makeItem({
            id: "closing",
            type: "closing",
            maxAttempts: 1,
            ladder: [{ reveal: {},
                instruction: "結尾：說今天認識了哪幾個字母，" +
                    "然後說「我們下次再見囉, bye bye!」道別。" }]
        }));
        const counts = items.reduce((acc, item) => {
            acc[item.type] = (acc[item.type] || 0) + 1;
            return acc;
        }, {});
        return {
            version: 2,
            person: text(config.person),
            day,
            unitLabel: `${text(unit.book)} Unit ${unit.num}: ${text(unit.title)}`.trim(),
            reviewUnitLabels: [],
            items,
            counts,
            practiceItemCount: items.filter(item => item.target).length
        };
    }

    // ---------------- 組裝今天的計畫 ----------------

    function build(context) {
        const config = context || {};
        const day = Math.min(WEEK_DAYS, Math.max(1, Number(config.day) || 1));
        const unit = config.unit || {};
        const unitWords = unit.words || [];
        const unitPatterns = unit.patterns || [];
        const unitScenes = unit.scenes || [];
        const unitDialogues = config.dialogues || [];
        const unitLabel = `${text(unit.book)} Unit ${unit.num}: ${text(unit.title)}`.trim();
        // 字母單元走自己的一套：沒有句型、沒有代換，也不判對錯
        if (text(unit.type) === "letters") return buildLetterPlan(config, unit, day);
        const isReviewUnit = text(unit.type) === "review";
        const isFinalDay = day === WEEK_DAYS;

        const items = [];

        // ---- 開場 ----
        items.push(makeItem({
            id: "opening",
            type: "opening",
            maxAttempts: 1,
            ladder: [{ reveal: {},
                instruction: "開場白：先說上一次學了哪些東西，再說今天會學什麼，" +
                    "最後用英文問「Are you ready?」，然後結束回合等待回答。" +
                    "孩子不管回答什麼（Yes、隨便一句話、甚至答非所問）都算開場完成，立刻回報；" +
                    "不要要求他複誦 Yes, I'm ready，也不要自己開始教任何單字或句型——" +
                    "下一個指令會告訴你第一個項目是什麼。" }]
        }));

        // ---- 當天的單字模式（2026-09-01 使用者定案，對齊紙本練習卷的五天題型） ----
        // 單字「不拆天」：每天練整個單元的字，換的是模式：
        //   第 1 天 中翻英 → 第 2 天 英翻中（認字）→ 第 3 天 三選一 →
        //   第 4 天 填缺漏字母 → 第 5 天 拼出單字
        // 跨單元複習的字也跟著當天模式走，整堂課同一種規則。
        const distractorPool = unitWords.concat(unit.phonicsWords || []).concat(
            (config.reviewUnits || []).flatMap(reviewUnit => (reviewUnit && reviewUnit.words) || []));
        const wordItemsForDay = (words, idPrefix, sourceLabel) => {
            switch (day) {
                case 1: return zh2enWordItems(words, idPrefix, sourceLabel);
                case 2: return readWordItems(words, distractorPool, idPrefix, sourceLabel);
                case 3: return choiceWordItems(words, distractorPool, idPrefix, sourceLabel);
                case 4: return gapWordItems(words, idPrefix, sourceLabel);
                default: return spellWordItems(words, idPrefix, sourceLabel);
            }
        };

        // ---- 跨單元複習：前兩個單元的字，用「看英文字」的方式複習 ----
        // 那些字上個月已經看圖學過了，現在要練的是認字。
        // Review 單元本身就是前三個單元的彙整，不再疊這一層。
        const reviewUnits = isReviewUnit
            ? []
            : (config.reviewUnits || []).slice(0, REVIEW_UNIT_COUNT);
        const learned = config.learnedWords || [];

        reviewUnits.forEach((reviewUnit, unitIndex) => {
            if (!reviewUnit) return;
            const label = `${text(reviewUnit.book)} Unit ${reviewUnit.num}`;

            // 教材裡的字 + 上那個單元時延伸教到的字，一起排進複習
            const extras = learned
                .filter(record => text(record.unit).indexOf(label) === 0)
                .filter(record => !(reviewUnit.words || [])
                    .some(word => bareWord(word.english) === bareWord(record.word)))
                .map(record => ({ english: record.word, chinese: record.meaning,
                                  example: record.example, image: "" }));
            const pool = (reviewUnit.words || []).concat(extras);
            const todays = spreadAcrossDays(pool, WEEK_DAYS)[day - 1];
            items.push(...wordItemsForDay(todays, `rv${unitIndex + 1}`, label));
        });

        // ---- 本單元的字：不拆天，每天整個單元照當天模式練 ----
        // 唯一例外是課本的 Review 單元：字數是正課的三倍（20 幾個），
        // 全上會爆掉 15 分鐘上限，仍五天平均攤開、但模式一樣跟著天走。
        // 發音教學的字（Aa apple / ant…）也一起練（使用者 2026-09-03 要求）
        const phonicsWords = unit.phonicsWords || [];
        const unitWordsToday = isReviewUnit
            ? (spreadAcrossDays(unitWords.concat(phonicsWords), WEEK_DAYS)[day - 1] || [])
            : unitWords.concat(phonicsWords);
        items.push(...wordItemsForDay(unitWordsToday, "uw", unitLabel));

        // ---- 句型代換：句型也不拆天，每個句型每天都練 ----
        // 每句型每天 2 種代換；整個單元只有 1 個句型時維持 3 種。
        // Review 單元彙整的句型太多（可達 8 個），仍每天輪 2 個。
        const substitutable = unitPatterns.filter(pattern => text(pattern.slot));
        const todaysPatterns = isReviewUnit
            ? rotatePick(substitutable, day, 2)
            : substitutable;
        const subsPerPattern = substitutable.length === 1 ? SUBSTITUTIONS_PER_PATTERN : 2;

        todaysPatterns.forEach((pattern, patternIndex) => {
            const picked = pickSlotWords(pattern, config, subsPerPattern);
            items.push(...substituteItems(pattern, picked, `sb${patternIndex + 1}`, unitDialogues));
        });

        // ---- 聽問題答句子 ----
        const respondPatterns = rotatePick(unitPatterns, day, RESPOND_PER_DAY);
        respondPatterns.forEach((pattern, patternIndex) => {
            items.push(...respondItems(pattern, unitScenes, `rp${patternIndex + 1}`, unitDialogues));
        });

        // ---- 結尾 ----
        items.push(makeItem({
            id: "closing",
            type: "closing",
            maxAttempts: 1,
            ladder: [{ reveal: {},
                instruction: "結尾：用簡單的話說今天學到了哪些單字和句子，" +
                    "稱讚一件具體做得好的事，然後說「我們下次再見囉, bye bye!」道別。" }]
        }));

        const counts = items.reduce((acc, item) => {
            acc[item.type] = (acc[item.type] || 0) + 1;
            return acc;
        }, {});

        return {
            version: 2,
            person: text(config.person),
            day,
            unitLabel,
            reviewUnitLabels: reviewUnits.filter(Boolean)
                .map(reviewUnit => `${text(reviewUnit.book)} Unit ${reviewUnit.num}`),
            items,
            counts,
            practiceItemCount: items.filter(item => item.target).length
        };
    }

    // 挑代換字：優先用最近學過的（印象還在、能接上），不足才往前找。
    // 一定會包含本單元自己的字，因為課本就是拿那些字在練這個句型。
    function pickSlotWords(pattern, config, count) {
        const slot = text(pattern.slot);
        const unit = config.unit || {};
        const plural = !!(pattern.plural);
        const seen = new Set();
        const fits = word => {
            const key = bareWord(word.english);
            if (!key || seen.has(key)) return false;
            if (text(word.slot) !== slot) return false;
            // 複數句型（What are these?）只收複數形的字，反之亦然，
            // 否則會組出 They're cake 這種錯句
            if (!!word.plural !== plural) return false;
            seen.add(key);
            return true;
        };
        // 本單元的字排前面，接著是離現在最近的複習單元
        const pools = [unit.words || []].concat(
            (config.reviewUnits || []).map(reviewUnit => (reviewUnit && reviewUnit.words) || []));
        const picked = [];
        pools.forEach(pool => {
            (pool || []).forEach(word => {
                if (picked.length < count && fits(word)) picked.push(word);
            });
        });
        return picked;
    }

    // 給課前預覽用的純文字摘要
    function describe(plan) {
        if (!plan || !plan.items) return "";
        const label = {
            opening: "開場", closing: "結尾",
            word_image: "看圖說英文", word_read: "看字說意思", word_spell: "拼單字",
            word_zh2en: "中翻英", word_choice: "三選一", word_gap: "填字母",
            pattern_substitute: "句型代換", pattern_respond: "聽問題答句",
            letter_say: "字母跟讀"
        };
        return plan.items.map((item, index) => {
            const name = label[item.type] || item.type;
            let detail = "";
            if (item.type === "letter_say") {
                detail = `${item.letter}${item.first && item.sound ? ` ${item.sound}` : ""}　` +
                    `${item.target}（${item.example}）` + (item.image ? "" : "　⚠️ 沒有卡");
            } else if (/^word_/.test(item.type)) {
                detail = `${item.display}（${item.meaning}）` +
                    (item.image ? "" : "　⚠️ 沒有圖");
            } else if (item.type === "pattern_substitute") {
                detail = `${item.pattern} ← ${item.slotWord}` +
                    (item.target ? `　→「${item.target}」` : "　（句子由模型組）") +
                    (item.dialogue ? "　🗯️ 對話漫畫" : "　⚠️ 沒有漫畫");
            } else if (item.type === "pattern_respond") {
                const alts = (item.alternatives || []).length
                    ? "／或 " + item.alternatives.join("／") : "";
                detail = `${item.ask} → ${item.target}${alts}` +
                    (item.dialogue ? "　🗯️ 對話漫畫" : (item.image ? "　🖼️ 情境圖" : "　⚠️ 沒有圖"));
            }
            const tap = isTapItem(item) ? "　👆 點選作答" : "";
            return `${index + 1}. [${name}] ${detail}${tap}`.trim();
        }).join("\n");
    }

    // ---------------- 執行器：依計畫逐項推進 ----------------
    // 提示階梯的每一階就是一次嘗試，所以「最多練幾次」與「提示到第幾層」
    // 是同一個計數器。走完最後一階就一定往下一項走，不會卡住。
    function createRunner(plan) {
        const items = ((plan && plan.items) || []).map(item => Object.assign({}, item));
        let cursor = 0;
        let attempts = 0;

        function current() {
            return cursor < items.length ? items[cursor] : null;
        }

        function isFinished() {
            return cursor >= items.length;
        }

        function advance(status) {
            const item = items[cursor];
            if (item) {
                item.status = status;
                item.attemptsUsed = attempts;
            }
            cursor += 1;
            attempts = 0;
            return item;
        }

        // outcome：correct / incorrect / no_response / unknown
        // unknown 用於「模型沒回報，但前端確定發生過一次師生問答」的兜底情境。
        function recordAttempt(outcome) {
            const item = current();
            if (!item) return { advanced: false, finished: true };
            if (outcome === "unknown") {
                // 兜底一律直接前進，不碰提示階梯。實測（2026-08-24 診斷檔）模型的
                // 回報遵從率很低，若把沒回報的問答當「答不出來」去爬梯，
                // 階梯指示都是「他不會，給提示再問一次」——孩子明明答對了
                // 還被重複問同一個字，整堂課變成鬼打牆。
                return { advanced: true, item: advance("done"), next: current(), finished: isFinished() };
            }
            attempts += 1;
            const limit = Math.max(1, Number(item.maxAttempts) || 1);
            if (outcome === "correct") {
                return { advanced: true, item: advance("correct"), next: current(), finished: isFinished() };
            }
            if (attempts >= limit) {
                // 提示階梯走完仍不理想：標記起來供日後複習，但一定要往前走
                const status = outcome === "no_response" ? "no_response"
                    : (outcome === "unknown" ? "done" : "needs_review");
                return { advanced: true, item: advance(status), next: current(), finished: isFinished() };
            }
            return { advanced: false, item, attempts, retry: true, finished: false };
        }

        function skipCurrent(reason) {
            if (isFinished()) return null;
            const item = advance(reason || "skipped");
            return item;
        }

        function progress() {
            return { index: Math.min(cursor, items.length), total: items.length, attempts };
        }

        function snapshot() {
            return items.map(item => ({
                id: item.id, type: item.type, target: item.target || "",
                status: item.status, attemptsUsed: item.attemptsUsed || 0
            }));
        }

        return Object.freeze({ current, isFinished, recordAttempt, skipCurrent, progress, snapshot });
    }

    // 目前這一階要讓學生看到什麼。前端依這個決定圖片、英文、中文的顯示。
    function revealFor(item, attempts) {
        const ladder = (item && item.ladder) || [];
        const step = ladder[Math.min(Math.max(0, Number(attempts) || 0), ladder.length - 1)];
        const reveal = (step && step.reveal) || {};
        const showImage = !!reveal.image && !!text(item && item.image);
        return {
            image: showImage,
            // 對話漫畫的兩個空白泡泡要不要壓字（沒有圖或不是漫畫就是 null）
            bubbles: showImage ? bubblesFor(item, reveal) : null,
            english: !!reveal.english,
            chinese: !!reveal.chinese,
            word: text(item && item.display) || text(item && item.target),
            meaning: text(item && item.meaning),
            picture: text(item && item.image),
            // 這一階要不要給孩子點的選項（不是點選題就是 null）
            tap: reveal.tap && item && item.tap ? item.tap : null
        };
    }

    // 這一項是不是由孩子點選作答的（由程式判分、程式推進）
    function isTapItem(item) {
        return !!(item && item.tap && (item.ladder || []).some(step =>
            step && step.reveal && step.reveal.tap));
    }

    // 把一個項目的「這一階」轉成給模型的具體指示（導演指令的內容）
    function itemDirective(item, progressInfo) {
        if (!item) return "";
        const attempts = (progressInfo && Number(progressInfo.attempts)) || 0;
        const ladder = item.ladder || [];
        const step = ladder[Math.min(attempts, Math.max(0, ladder.length - 1))] || {};
        const position = progressInfo
            ? `Item ${progressInfo.index + 1} of ${progressInfo.total}` +
              (attempts ? `（同一項第 ${attempts + 1} 次）` : "") + "。 "
            : "";

        const bits = [position, text(step.instruction)];
        const revealNow = (step && step.reveal) || {};
        if (item.type === "word_spell") {
            bits.push(` 目標單字：「${item.display || item.target}」`,
                item.meaning ? `，中文是「${item.meaning}」` : "", "。");
            // 第一階不給拼法：給了模型就會先講出來（2026-09-03 填字母題實測）。
            // 這些都是基礎單字，模型自己知道怎麼拼，聽孩子拼完再判斷即可。
            if (attempts >= 1) bits.push(` 正確拼法是「${item.letters}」，示範時以此為準。`);
            else bits.push(" 在孩子自己拼之前，絕對不要說出任何字母或拼法；他拼完你再判斷對不對。");
            bits.push(" 圖片與文字由前端控制顯示，你不用呼叫 show_image。");
        } else if (item.type === "word_choice") {
            bits.push(` 正確答案是「${item.target}」，畫面上的三個選項是：${(item.options || []).join("、")}。`);
            bits.push(item.meaning ? ` 你要用中文說的意思：「${item.meaning}」。` : "");
            bits.push(" 絕對不要把任何選項唸出來——讀出選項並選對是他的工作；" +
                "他唸出其中一個後，你判斷是不是正確答案。");
            bits.push(" 圖片與文字由前端控制顯示，你不用呼叫 show_image。");
        } else if (item.type === "word_gap") {
            bits.push(` 畫面顯示的挖空版是「${item.display}」` +
                (item.meaning ? `，中文是「${item.meaning}」` : "") + "。");
            // 2026-09-04 GPT 實測：孩子說對 grandfather、說對 u t suit 都被判錯，
            // 理由是「沒先講字母」「順序」「多唸了一次字」，一題耗掉三階。
            bits.push(" 判斷標準只有一個：缺的字母說對、或整個字唸對，任一成立就回報 correct。" +
                "字母順序、先講字還是先講字母、多唸了一次字，都不算錯。" +
                "回饋一到兩句就好，不要解釋規則。");
            // 第一階不給答案：實測「填空一開始 AI 就把答案說出來」就是指令把
            // 完整拼法與缺的字母都給了它。模型自己認得這個字，先聽孩子說再判斷。
            if (attempts >= 1) {
                bits.push(` 目標單字是「${item.answerDisplay || item.target}」，完整拼法「${item.letters}」，` +
                    `缺少的字母是「${item.missing}」。`);
            } else {
                bits.push(" 在孩子自己說出缺少的字母之前，絕對不要說出這個字、任何字母或答案；" +
                    "他說完你再判斷對不對。");
            }
            bits.push(" 圖片與文字由前端控制顯示，你不用呼叫 show_image。");
        } else if (item.type === "letter_say") {
            bits.push(` 字母卡上是「${item.letter}」和例字「${item.target}」` +
                (item.example ? `（${item.example}）` : "") + "。");
            // 音要用英文發出來。第一版寫成注音（ㄚ、ㄅ），模型直接把注音當台詞唸，
            // 孩子聽到的是中文的ㄚ而不是 /æ/。
            if (item.first && item.sound) {
                bits.push(` 這個字母最常見的音是 ${item.sound}` +
                    (item.soundNote ? `（${item.soundNote}）` : "") +
                    "。用英文把這個音發出來給他聽，不要用中文或注音代替，也不要把音標唸出來。");
            }
            // 使用者定案：這一項只是帶著唸，不評分也不稱讚。
            // 模型天生會補一句「你唸得很棒」，所以要正面講清楚它該做什麼、只做什麼。
            bits.push(" 你只做兩件事：清楚地唸給他聽、請他跟著唸一次；他唸完就回報 correct 往下一張。" +
                "**不要判斷唸得對不對，不要糾正，不要說「很棒」「你唸得很正確」這類稱讚或評語**，" +
                "也不要造句或多問問題。這一項是帶著唸，不是考試。");
            bits.push(" 圖片與文字由前端控制顯示，你不用呼叫 show_image。");
        } else if (item.type === "word_image" || item.type === "word_read" || item.type === "word_zh2en") {
            bits.push(` 目標單字：「${item.display || item.target}」`);
            // 該藏的資訊不放進指令：中文意思只在「已揭露中文」的階段才給模型。
            // 之前一邊叫模型別說中文、一邊把「中文是你好」塞在指令裡，
            // 2026-08-30 實測模型一開口就先把中文講掉，認字練習整個作廢。
            if (revealNow.chinese && item.meaning) bits.push(`，中文是「${item.meaning}」`);
            bits.push("。");
            if (revealNow.english && item.example) bits.push(` 例句：${item.example}。`);
            const hidden = [];
            if (!revealNow.english) hidden.push("英文唸法");
            if (!revealNow.chinese) hidden.push("中文意思");
            if (hidden.length) bits.push(` 在孩子先開口嘗試之前，絕對不要說出這個字的${hidden.join("和")}——` +
                "他說了之後你再判斷對不對。");
            bits.push(" 圖片與文字由前端控制顯示，你不用呼叫 show_image。");
        } else if (item.type === "pattern_substitute") {
            bits.push(` 句型：「${item.pattern}」。這一次要代換進去的字是「${item.slotWord}」` +
                (item.slotMeaning ? `（${item.slotMeaning}）` : "") + "。");
            if (item.promptZh) bits.push(` 畫面上顯示的中文句子是「${item.promptZh}」，請用這句中文提示學員。`);
            bits.push(item.target
                ? ` 學員要說出來的目標句是「${item.target}」。`
                : " 請你自己把這個字套進句型組成完整的句子，對應畫面上那句中文。");
        } else if (item.type === "pattern_respond") {
            bits.push(` 你要問的問題：「${item.ask}」。學員應該回答「${item.target}」`);
            bits.push((item.alternatives || []).length
                ? `，「${item.alternatives.join("」或「")}」也可以接受。` : "。");
            if (item.sceneLines) {
                bits.push(` 畫面上會顯示這個情境的圖（${item.sceneLines}），` +
                    "答案看圖就能決定，所以請依圖上的情況判斷他答得對不對。");
            }
        }
        return bits.join("");
    }

    global.LessonPlan = Object.freeze({
        build, describe, splitPattern, spreadAcrossDays, chunkInOrder, rotatePick,
        fillSlot, pickSlotWords, sceneForPattern, createRunner, itemDirective, revealFor,
        dialogueFor, bubblesFor, checkTap, isTapItem
    });
})(window);
