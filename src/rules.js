// rules.js — 判定ルールの一元管理
// すべて ES module。background(service worker)からも、node製テストからもimportできる。
// 将来は remote(GitHub等)から同形式のJSONを取得して上書きする想定（updateRulesFromRemote参照）。
//
// 設計原則（全カテゴリ共通）:
//   1. 断定しない。ラベルは事実ベースの中立表現（例「アダルト」「広告スクリプト多数」）。
//   2. 誤検出より取りこぼしを選ぶ。迷ったら判定しない（unknown＝バッジ無し）。
//   3. 大手/正規ドメインは SAFE_HOSTS でヒューリスティック(連投等)の対象外にする。

// ------------------------------------------------------------------
// 0) 除外リスト（連投などのヒューリスティックを適用しないドメイン）
//    ※ 有料/アフィ判定など「事実ベース」の判定はここに載っていても実施する。
// ------------------------------------------------------------------
export const SAFE_HOSTS = [
  // プラットフォーム
  "x.com", "twitter.com", "t.co", "youtube.com", "youtu.be", "instagram.com",
  "tiktok.com", "facebook.com", "threads.net", "reddit.com", "github.com",
  "note.com", "zenn.dev", "qiita.com", "hatenablog.com", "hatena.ne.jp",
  "wikipedia.org", "google.com", "apple.com", "microsoft.com", "amazon.co.jp",
  "amazon.com", "rakuten.co.jp", "yahoo.co.jp", "nicovideo.jp", "pixiv.net",
  "spotify.com", "soundcloud.com", "twitch.tv", "discord.com", "notion.so",
  // 報道・出版
  "asahi.com", "yomiuri.co.jp", "mainichi.jp", "sankei.com", "nikkei.com",
  "tokyo-np.co.jp", "toyokeizai.net", "diamond.jp", "gendai.media",
  "jbpress.ismedia.jp", "nhk.or.jp", "nhk.jp", "kyodo.co.jp", "jiji.com",
  "itmedia.co.jp", "impress.co.jp", "cnet.com", "bbc.com", "nytimes.com",
  "reuters.com", "bloomberg.com", "wsj.com", "ft.com", "theguardian.com",
  // 公的機関
  "go.jp", "lg.jp", "ac.jp", "gov", "or.jp"
];

// ------------------------------------------------------------------
// 1) アフィリエイトリンク（URLパターンだけで判定。fetch不要）
//    host: ホスト名の部分一致 / param: クエリパラメータの存在 / pathRe: パス正規表現
// ------------------------------------------------------------------
export const AFFILIATE_RULES = [
  { id: "amazon-tag",     label: "Amazonアソシエイト", hostRe: /(^|\.)amazon\.(co\.jp|com)$/, param: "tag" },
  { id: "amazon-short",   label: "Amazon短縮",         hostRe: /(^|\.)(amzn\.to|amzn\.asia)$/ },
  { id: "rakuten-afl",    label: "楽天アフィリエイト",  hostRe: /(^|\.)(hb\.afl\.rakuten\.co\.jp|a\.r10\.to|affiliate\.rakuten\.co\.jp)$/ },
  { id: "rakuten-scid",   label: "楽天アフィリエイト",  paramRe: { scid: /^af_/ } },
  { id: "a8",             label: "A8.net",             hostRe: /(^|\.)(a8\.net|px\.a8\.net)$/ },
  { id: "moshimo",        label: "もしもアフィリエイト", hostRe: /(^|\.)(moshimo\.com|af\.moshimo\.com)$/ },
  { id: "valuecommerce",  label: "バリューコマース",     hostRe: /(^|\.)(valuecommerce\.com|dals\.valuecommerce\.com|ck\.jp\.ap\.valuecommerce\.com)$/ },
  { id: "linksynergy",    label: "Rakuten Advertising", hostRe: /(^|\.)linksynergy\.com$/ },
  { id: "accesstrade",    label: "アクセストレード",     hostRe: /(^|\.)(accesstrade\.net|h\.accesstrade\.net)$/ },
  { id: "afb",            label: "afb",                hostRe: /(^|\.)(afi-b\.com|t\.afi-b\.com)$/ },
  { id: "felmat",         label: "felmat",             hostRe: /(^|\.)felmat\.net$/ },
  { id: "rentracks",      label: "レントラックス",       hostRe: /(^|\.)rentracks\.jp$/ },
  { id: "janet",          label: "JANet",              hostRe: /(^|\.)j-a-net\.jp$/ },
  { id: "linkshare",      label: "LinkShare",          hostRe: /(^|\.)linksynergy\.jp$/ },
  { id: "smartc",         label: "Circuit X",          hostRe: /(^|\.)ck\.jp\.ap\.valuecommerce\.com$/ },
  { id: "impact",         label: "impact.com",         hostRe: /(^|\.)(impact\.com|7eer\.net|evyy\.net|ojrq\.net)$/ },
  { id: "awin",           label: "Awin",               hostRe: /(^|\.)(awin1\.com|zenaps\.com)$/ },
  { id: "cj",             label: "CJ Affiliate",       hostRe: /(^|\.)(anrdoezrs\.net|dpbolvw\.net|jdoqocy\.com|kqzyfj\.com|tkqlhce\.com)$/ },
  { id: "shareasale",     label: "ShareASale",         hostRe: /(^|\.)shareasale\.com$/ },
  { id: "generic-aff",    label: "アフィリエイト(汎用)", paramAny: ["affiliate_id", "aff_id", "utm_medium=affiliate", "utm_medium=aff", "assistclickid"] }
];

// ------------------------------------------------------------------
// 2) 短縮URL（行き先が隠れている）。t.coはX標準ラッパのため既定で除外。
// ------------------------------------------------------------------
export const SHORTENER_HOSTS = [
  "bit.ly", "ow.ly", "buff.ly", "tinyurl.com", "goo.gl", "is.gd", "cutt.ly",
  "rebrand.ly", "lnkd.in", "dlvr.it", "ift.tt", "trib.al", "shorturl.at", "j.mp",
  "s.id", "rb.gy", "shrtco.de", "urlz.fr", "v.gd", "t.ly", "1lnk.to", "shorturl.gg",
  "linktr.ee", "lit.link", "bit.do", "soo.gd", "clik.cc", "tiny.cc", "short.gy",
  "onelink.to", "ur0.cc", "ur0.link", "x.gd", "0mm.jp", "s.gd"
];

// ------------------------------------------------------------------
// 3) PR/広告記事・広告ネットワーク経由（URLで事実判定できるものだけ）
// ------------------------------------------------------------------
export const PR_RULES = [
  { id: "prtimes", label: "プレスリリース", hostRe: /(^|\.)(prtimes\.jp|atpress\.ne\.jp|value-press\.com|dreamnews\.jp)$/ },
  { id: "utm-pr",  label: "PR/広告",        paramAny: ["utm_medium=affiliate", "utm_medium=paid", "utm_medium=cpc", "utm_medium=display", "utm_source=taboola", "utm_source=outbrain"] },
  // 広告ネットワーク/ネイティブ広告(Outbrain/Taboola等)の遷移リンク＝"広告経由"であることは事実
  { id: "adnet",   label: "広告リンク",      hostRe: /(^|\.)(doubleclick\.net|googlesyndication\.com|googleadservices\.com|outbrain\.com|taboola\.com|adnxs\.com|popin\.cc|logly\.co\.jp|zucks\.net|i-mobile\.co\.jp|microad\.jp|geniee\.co\.jp)$/ }
];

// ------------------------------------------------------------------
// 4) まとめ/転載サイト（既知ドメインの中立ラベル。リモート/ユーザーで拡充する前提）
//    ※ 品質の断定は避け、"まとめ/転載" という中立表現にとどめる。
// ------------------------------------------------------------------
export const FARM_HOSTS = [
  "togetter.com", "min.togetter.com", "matome.naver.jp", "curazy.com",
  "netgeek.biz", "gogotsu.com", "yurukuyaru.com", "hamusoku.com",
  "blog.livedoor.jp", "2chmatomech.doorblog.jp", "matomedane.jp",
  "newsokunomoral.blog.jp", "alfalfalfa.com", "kaigainohannoublog.blog55.fc2.com"
];

// ------------------------------------------------------------------
// 5) 要注意ドメイン（既知のフィッシング/詐欺"報告"があるもの。中立に「要注意」と表示）
//    ※ 既定は空。公開ブロックリスト由来のドメインやユーザー追加で充填する。
//    ※ "偽/詐欺" と断定せず、あくまで「報告あり＝注意」に留める（誤ラベルの実害・名誉毀損リスク回避）。
// ------------------------------------------------------------------
export const CAUTION_HOSTS = [
  // 例) "example-scam.com"
];

// ------------------------------------------------------------------
// 6) アダルト（バズ投稿のリプ欄に湧く誘導リンク対策）
//    ※ 「エロ＝悪」ではない。ラベルは中立に「アダルト」。ユーザーが開く前に分かればよい。
//    ※ 判定は (a) 既知ドメイン (b) ホスト名/パスの明示的な語 の2系統。
//       (b) は誤爆しやすいので「明示的な語」に限定し、SAFE_HOSTS は対象外にする。
// ------------------------------------------------------------------
export const ADULT_HOSTS = [
  // 大手チューブ/アグリゲータ
  "pornhub.com", "xvideos.com", "xnxx.com", "xhamster.com", "youporn.com",
  "redtube.com", "spankbang.com", "eporner.com", "tnaflix.com", "beeg.com",
  "chaturbate.com", "stripchat.com", "bongacams.com", "cam4.com", "onlyfans.com",
  "fansly.com", "erome.com", "motherless.com", "rule34.xxx", "e-hentai.org",
  "nhentai.net", "hanime.tv", "hitomi.la", "hentaihaven.xxx",
  // 日本語圏
  "missav.com", "missav.ws", "javbus.com", "javlibrary.com", "supjav.com",
  "jable.tv", "avgle.com", "fc2.com/adult", "adult.contents.fc2.com",
  "dmm.co.jp", "fanza.com", "sokmil.com", "mgstage.com",   // dmm.co.jp=FANZA(R18)／dmm.com=一般
  "caribbeancom.com", "1pondo.tv", "heyzo.com", "tokyo-hot.com", "10musume.com",
  "pcolle.com", "ci-en.dlsite.com", "dlsite.com/maniax", "getchu.com",
  // 出会い系/ライブチャット
  "dxlive.com", "j-live.tv", "livedoor-chat.com", "happymail.co.jp",
  "pcmax.jp", "wakuwakumail.com", "jmty-adult.com"
];

// ホスト名・パスに現れる明示的なアダルト語（英日）。SAFE_HOSTS では評価しない。
export const ADULT_URL_RE = [
  /(^|[.\-\/_])(porn|xxx|hentai|nsfw|sexcam|camgirl|escort|milf|jav|erotic)([.\-\/_]|$)/i,
  /(^|[.\-\/_])(av(douga|matome|channel)|ero(douga|manga|anime|ge))([.\-\/_]|$)/i,
  /(エロ|アダルト|無修正|裏動画|出会い系|人妻|素人|巨乳)/,
  /\.xxx$/i,   // .xxx はスポンサードTLD＝アダルト用途に限定されている
  /\.adult$/i, /\.sex$/i, /\.porn$/i
];

// アダルトの自己申告は2種類に分けて扱う。信頼度がまったく違うため。
//
// (1) 構造シグナル: <meta> タグの中だけを見る。サイトが機械可読な形で宣言したもの。
//     文章中にたまたま同じ語が出ることが無いので、どのドメインでも信用してよい。
export const ADULT_META_RE = [
  /<meta[^>]+content=["'][^"']*RTA-5042-1996-1400-1577-RTA/i,      // RTAラベル(業界標準)
  /<meta[^>]+name=["']rating["'][^>]+content=["'](adult|mature|RTA-[^"']*)["']/i,
  /<meta[^>]+name=["']rating["'][^>]+content=["']restricted\s+to\s+adults["']/i
];

// (2) 本文テキスト: 年齢確認ゲートの文言。URLに手掛かりが無い新規ドメインに効く強力な判定だが、
//     「年齢確認について解説した記事」のような無関係なページにも一致してしまう。
//     そのため SAFE_HOSTS（大手/正規ドメイン）では評価しない。
//     ※ このプロジェクト自身のREADMEが「あなたは18歳以上ですか」を含んでいて、
//        GitHubのリポジトリページがアダルト判定される誤検出が実際に起きた。
export const ADULT_TEXT_RE = [
  /18歳未満の(方|かた)(は|の)[\s\S]{0,20}(ご遠慮|退出|閲覧できません|入場できません)/,
  /あなたは18(歳|才)以上ですか/,
  /(成人|アダルト)コンテンツが含まれ/,
  /I am (over |at least )?18( years)?( old)?[\s\S]{0,20}(enter|continue)/i,
  /(this|the) (site|website) contains adult (content|material)/i,
  /you must be (at least )?(18|21)( years)?( old)?[\s\S]{0,40}enter/i
];

// ------------------------------------------------------------------
// 7) （旧「不審URL」カテゴリはここにあった）
//    IP直リンク/怪しいTLD/なりすまし等のヒューリスティックで判定していたが、
//    「事実として何が問題か」を利用者に伝えにくく、値するほどの精度も出なかったため削除した。
//    なりすまし対策は 5) CAUTION_HOSTS（既知の報告があるドメイン）で扱う方針。
// ------------------------------------------------------------------

// 直接ダウンロードさせる拡張子（クリック＝ファイル取得になるもの）
export const DOWNLOAD_EXT_RE = /\.(apk|exe|dmg|msi|scr|bat|jar|zip|rar|7z|iso)(\?|$)/i;

// ------------------------------------------------------------------
// 8) 広告量の計測（fetchしたHTMLに含まれる広告ネットワーク参照を数える）
//    ※ 「広告が多い」は主観なので、閾値越えのときだけ件数を添えて事実として出す。
// ------------------------------------------------------------------
export const AD_SCRIPT_HOSTS = [
  "googlesyndication.com", "doubleclick.net", "googleadservices.com",
  "googletagservices.com", "adnxs.com", "adsrvr.org", "criteo.com", "criteo.net",
  "rubiconproject.com", "pubmatic.com", "openx.net", "casalemedia.com",
  "taboola.com", "outbrain.com", "popin.cc", "logly.co.jp", "zucks.net",
  "i-mobile.co.jp", "microad.jp", "genieesspv.jp", "fout.jp", "yieldone.com",
  "ad-stir.com", "nend.net", "amoad.com", "smartnews-ads.com", "unrulymedia.com",
  "teads.tv", "smartadserver.com", "33across.com", "sharethrough.com",
  "indexww.com", "media.net", "adroll.com", "propellerads.com", "exoclick.com",
  "juicyads.com", "trafficjunky.com", "poptm.com", "adcash.com"
];

// 広告"枠"の数え方。
// 重要: 広告ネットワークの社数では測れない。GAM/AdSenseを使うサイトは初期HTMLに
//       ローダーが1〜2本あるだけで、枠は実行時に大量生成されるため。
//       実測でも gigazine は 2社しか出ないのに枠は12個ある。枠の数が実態に近い。
export const AD_SLOT_PATTERNS = {
  // GAM(Google Ad Manager)のスロットID。id属性とJS内の両方に出るので重複排除して数える
  gptSlotId:  /["'#]?(div-gpt-ad[-_][A-Za-z0-9_-]+)/g,
  gptDefine:  /googletag\.defineSlot\s*\(/gi,
  adsense:    /<ins[^>]+adsbygoogle/gi
};

// 閾値（実測値に基づく）:
//   gigazine記事 12枠 / alfalfalfa 29枠 → 広告過多
//   毎日新聞記事 8枠 / yurukuyaru 9枠 / nlab 6枠 / togetter 4枠 / 朝日記事 2枠 → 出さない
// 普通の新聞記事(8枠)を超える 10 を境界にする。取りこぼす側に倒してある。
export const AD_HEAVY_MIN_SLOTS = 10;
export const AD_HEAVY_MIN_NETWORKS = 6;   // 異なる広告ネットワークの数（補助）

// ------------------------------------------------------------------
// 9) 有料記事（背景fetchした生HTML/テキストに対して判定）
//    domain: 対象ドメイン / paidRe: 有料CTA正規表現(いずれか一致で有料)
//    confirmed: 実記事で確認済みか
//    対象外(動的ペイウォール等)は enabled:false で unknown 運用
// ------------------------------------------------------------------

// 媒体非依存の構造シグナル（schema.org / メタタグ）。最も信頼度が高い。
export const PAYWALL_META_RE = [
  { re: /"isAccessibleForFree"\s*:\s*(false|"false"|"False")/i, id: "jsonld:isAccessibleForFree=false" },
  { re: /isAccessibleForFree"?\s*:\s*false/i,                   id: "jsonld:isAccessibleForFree=false" },
  { re: /"cssSelector"\s*:\s*"[^"]*(paywall|paid|premium|locked)/i, id: "jsonld:hasPart.paywalledContent" },
  { re: /<meta[^>]+(property|name)=["']article:content_tier["'][^>]+content=["'](locked|metered)["']/i, id: "meta:article:content_tier=locked" },
  { re: /<meta[^>]+(property|name)=["'](article:opinion|lp:type)["'][^>]*paywall/i, id: "meta:paywall" }
];

// 全社共通で拾う汎用の有料CTA。
// 重要: 関連記事の「有料」ラベルやナビ文言と混ざる語（例: 単独の「有料会員記事」「会員限定」）は
//       無料ページにも出るため採用しない。本文の"続きを塞ぐ"固有フレーズだけに限定する。
export const GENERIC_PAYWALL_RE = [
  /有料会員になると続き/,
  /この記事は有料(会員)?記事です/,        // "です"付きの明示CTAに限定
  /ここから先は有料/,
  /この続きは有料/,
  /続きを読むには[\s\S]{0,20}(会員登録|ログイン|購読|プラン)/,
  /記事の続きをお読みいただくには/,
  /ログインして(続きを|全文を)/,
  /残り\s*\d[\d,]*\s*文字/,                // ※タグstrip後テキストに適用（本文末尾の truncation）
  // 英語圏の明示CTA（"Already a subscriber?" 等は無料ページにも出るため不採用）
  /Subscribe to (continue|keep) reading/i,
  /(This|The) (article|story|content) is (only )?(available )?(for|to) subscribers/i,
  /Register to (continue|keep) reading/i,
  /To continue reading[^.]{0,30}subscri/i
];

// 「有料」ではなく「無料だが登録/ログインが必須」を表すCTA。
// paid が取れなかったときだけ 登録必須 として出す（paidの方が強い）。
export const LOGIN_WALL_RE = [
  /続きを読むには[\s\S]{0,20}無料会員登録/,
  /無料会員登録(をする|が必要|してください)/,
  /(ログイン|会員登録)(が必要です|してください)[\s\S]{0,10}(全文|続き)/,
  /Sign (in|up) to (continue|read|view)/i,
  /Create a free account to (continue|read)/i
];

export const PAYWALL_SITES = {
  "asahi.com": {
    enabled: true, confirmed: true,
    // 有料記事のみに出るCTA文だけで判定。
    // ※ icon__keyGold.svg / alt="有料会員記事" は関連記事一覧として全ページに出るノイズなので使わない。
    paidRe: [/有料会員になると続き/],
    note: "実記事で確認済み。CTA文『有料会員になると続き…』が有料記事のみに出る。鍵アイコンは全ページに出るため不採用。"
  },
  "yomiuri.co.jp": {
    enabled: true, confirmed: true,
    paidRe: [], // JSON-LD isAccessibleForFree:false で確定判定。テキスト「会員限定」は無料ページにも出るので使わない
    note: "実記事で確認済み。JSON-LD isAccessibleForFree:false が有料記事のみに出る（無料記事はフラグ無し）。"
  },
  "mainichi.jp": {
    enabled: true, confirmed: false,
    paidRe: [/ここから有料/],   // 単独「有料記事」は関連ラベルと混ざるため不採用
    note: "未確認。JSON-LD＋汎用＋暫定CTAでカバー。実記事で要確認。"
  },
  "sankei.com": {
    enabled: true, confirmed: false, paidRe: [],
    note: "未検証。汎用でカバー、要確認。"
  },
  "nikkei.com": {
    enabled: true, confirmed: true,
    // 実記事22本で確認済み。有料17/無料5 に正しく分離できた。
    // 有料記事のみ「登録すると続きをお読みいただけます」＋「残り○○文字」がサーバー側HTMLに出る
    // （文字数は記事ごとに異なる＝実際の本文切り詰め。定型文ではない）。無料記事には一切出ない。
    // ※「有料会員」「会員限定」単体はナビ/フッタに常時出るノイズなので使わない。
    // ※ class="…Paywall…" のコンテナは全記事に出る（JSで出し分ける器）ので使わない。
    paidRe: [/この記事は有料会員限定記事です/, /登録すると続きをお読みいただけます/],
    note: "実記事22本で確認済み(有料17/無料5)。以前は enabled:false で全く判定していなかったが、" +
          "サーバー側HTMLに有料マーカーが出ることを実測で確認したため有効化した。"
  },
  "tokyo-np.co.jp": {
    enabled: true, confirmed: false, paidRe: [],
    note: "未検証。汎用でカバー、要確認。"
  },
  "toyokeizai.net": {
    enabled: true, confirmed: true, paidRe: [/有料会員限定です/],
    note: "実記事12本で確認済み。有料のみ『有料会員限定です』＋『残り○文字』、無料は両方無し（誤爆ゼロ）。"
  },
  "diamond.jp": {
    enabled: true, confirmed: true, paidRe: [/続きを読むには会員登録が必要です/],
    note: "実記事10本で確認済み。有料のみ『続きを読むには会員登録が必要です』＋top『有料会員限定』、無料は両方無し。"
  },
  "gendai.media": {
    enabled: true, confirmed: false, paidRe: [],
    note: "トップ10本すべて無料＝有料密度が低い媒体。有料が出れば汎用CTAでカバー。優先度低。"
  },
  "jbpress.ismedia.jp": {
    enabled: true, confirmed: false, paidRe: [/会員登録(無料)?で続き/],
    note: "未検証。JSON-LD＋汎用＋暫定でカバー。要確認。"
  }
};

// 対象ドメイン（content scriptがこのどれかへのリンクだけ有料判定に回す）
export const PAYWALL_DOMAINS = Object.keys(PAYWALL_SITES);

// domainのマッチ（サブドメイン許容）
export function matchPaywallSite(hostname) {
  const h = hostname.toLowerCase();
  for (const d of PAYWALL_DOMAINS) {
    if (h === d || h.endsWith("." + d)) return { domain: d, ...PAYWALL_SITES[d] };
  }
  return null;
}

// ------------------------------------------------------------------
// 10) 連投スパム検出のパラメータ（同一ページ内で同じリンクが何件のポストに出たら疑うか）
// ------------------------------------------------------------------
export const SPAM_REPEAT_MIN = 3;   // リプ欄で同一ホストがこの件数以上のポストに出たら「連投」

// ------------------------------------------------------------------
// 11) 判定カテゴリの定義（表示名・既定ON/OFF）。popupの設定UIもこれを元に描画する。
// ------------------------------------------------------------------
export const CATEGORIES = [
  { kind: "paid",      label: "有料記事",       default: true,  needsFetch: true  },
  { kind: "affiliate", label: "アフィリンク",   default: true,  needsFetch: false },
  { kind: "shortener", label: "短縮URL",        default: true,  needsFetch: false },
  { kind: "pr",        label: "PR/広告リンク",  default: true,  needsFetch: false },
  { kind: "farm",      label: "まとめ/転載",    default: true,  needsFetch: false },
  { kind: "adult",     label: "アダルト",       default: true,  needsFetch: false },
  { kind: "spam",      label: "連投リンク",     default: true,  needsFetch: false },
  { kind: "download",  label: "ファイル直DL",   default: true,  needsFetch: false },
  { kind: "caution",   label: "要注意ドメイン", default: true,  needsFetch: false },
  { kind: "ads",       label: "広告過多",       default: true,  needsFetch: true  },
  { kind: "login",     label: "登録/ログイン必須", default: true, needsFetch: true }
];

export const DEFAULT_SETTINGS = {
  ...Object.fromEntries(CATEGORIES.map(c => ["cat_" + c.kind, c.default])),
  badgeStyle: "cover",   // バッジの見せ方 cover(画像を赤で覆う) | pill(画像の上に小さく重ねる)
  deepScan: true,        // リンク先を背景取得して有料/広告過多/登録必須/短縮の先を判定
  maxBadges: 3           // 1ポストに出すバッジの最大数
};
