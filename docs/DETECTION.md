# 判定方法の詳細

各カテゴリを「何を根拠に」判定しているかの全リスト。
ルールの実体はすべて [`src/rules.js`](../src/rules.js) にあり、このドキュメントはその解説です。

判定は大きく2種類に分かれます。

| 種別 | fetch | 対象 |
|---|---|---|
| **URL判定** | 不要 | URL文字列だけを見て言えること（[`classifier.js`](../src/classifier.js)） |
| **中身判定** | 必要 | リンク先のHTMLを取得して分かること（[`pagesignals.js`](../src/pagesignals.js) / [`paywall.js`](../src/paywall.js)） |

---

## 🔞 アダルト

3系統。どれか1つでも当たれば判定します。

### (a) 既知ドメインリスト — `ADULT_HOSTS`
確実に当たるが、リストにあるものしか当たりません。約45ドメイン。

- 大手チューブ/アグリゲータ: pornhub / xvideos / xnxx / xhamster / chaturbate / onlyfans など
- 日本語圏: missav / javbus / jable / avgle / FANZA / mgstage / caribbeancom など
- 出会い系/ライブチャット: dxlive / pcmax / happymail など

サブドメインは許容します（`jp.pornhub.com` も当たる）。
**同一ドメインで一般向けとアダルトが分かれるサイト**はパス前方一致でも書けます:

```js
"dmm.co.jp"           // DMMは dmm.co.jp=FANZA(R18) / dmm.com=一般 で分かれている
"fc2.com/adult"
"dlsite.com/maniax"
```

### (b) URL内の明示語 — `ADULT_URL_RE`
ホスト名とパスに、アダルト以外の用途がまず考えられない語が入っている場合。

```js
/(^|[.\-\/_])(porn|xxx|hentai|nsfw|sexcam|camgirl|escort|milf|jav|erotic)([.\-\/_]|$)/i
/(^|[.\-\/_])(av(douga|matome|channel)|ero(douga|manga|anime|ge))([.\-\/_]|$)/i
/(エロ|アダルト|無修正|裏動画|出会い系|人妻|素人|巨乳)/
/\.xxx$/i  /\.adult$/i  /\.sex$/i  /\.porn$/i   // アダルト専用TLD
```

英語の語は**区切り文字で挟まれている場合のみ**マッチさせます（`(^|[.\-\/_])…([.\-\/_]|$)`）。
これをやらないと `javascript` の `jav`、`experts` の `expert` のような部分一致で誤爆します。

さらに `SAFE_HOSTS`（大手ドメイン一覧）に載っているサイトでは **(b) を評価しません**。
note.com に「エロ本の話」という記事があってもアダルト判定しない、ということです。

### (c) サイト自身の申告（要fetch）
信頼度が違う2種類に分けてある。

**構造シグナル `ADULT_META_RE`** — `<meta>` タグの中だけを見る。機械可読な宣言なので
どのドメインでも信用してよい。
**URLに何の手掛かりも無い新規ドメインに効く、実質的に一番強い判定。**
`abc-video.site` のような無害に見える名前でも、中身を見れば分かります。

```js
/<meta[^>]+content=["'][^"']*RTA-5042-1996-1400-1577-RTA/i   // RTAラベル（業界標準）
/<meta[^>]+name=["']rating["'][^>]+content=["'](adult|mature|…)/i
```

**本文テキスト `ADULT_TEXT_RE`** — 年齢確認ゲートの文言。URLに手掛かりが無い新規ドメインに
効く強力な判定だが、「年齢確認について解説した記事」にも一致してしまう。
そのため **`SAFE_HOSTS` では評価しない**。

```js
/あなたは18(歳|才)以上ですか/
/18歳未満の(方|かた)(は|の)…(ご遠慮|退出|閲覧できません)/
/(this|the) (site|website) contains adult (content|material)/i
```

> ⚠️ **実際に起きた誤検出**: このプロジェクトのREADMEが「あなたは18歳以上ですか」を
> 例示として含んでいたため、**GitHubのリポジトリページがアダルト判定された**。
> 同時に `<code>isAccessibleForFree:false</code>` に反応して有料判定もされていた。
>
> 対策として (1) 構造シグナルは `<meta>` と JSON-LD ブロックの中だけで探す
> (2) 本文照合の前に `<pre>`/`<code>` を除去する
> (3) テキストベースの判定は `SAFE_HOSTS` では行わない、の3点を入れた。

---

## 📊 広告過多

**広告ネットワークの社数では測れません。** GAM/AdSense を使うサイトは初期HTMLにローダーが
1〜2本あるだけで、広告枠は実行時に生成されるためです。実測でも gigazine は
**2社しか出ないのに枠は12個**ありました。そこで **広告"枠"の数**を主指標にしています。

### 枠の数え方 — `AD_SLOT_PATTERNS`

```js
gptSlotId:  /["'#]?(div-gpt-ad[-_][A-Za-z0-9_-]+)/g   // GAMのスロットID
gptDefine:  /googletag\.defineSlot\s*\(/gi            // GAMのスロット定義
adsense:    /<ins[^>]+adsbygoogle/gi                  // AdSenseの枠
```

スロットIDは `id` 属性とJS内の `defineSlot()` 呼び出しの**両方に出て二重に数えてしまう**ため、
重複排除したID数と defineSlot 呼び出し数の**大きい方**を採り、AdSense の `<ins>` を足します。

```js
枠数 = max(ユニークなスロットID数, defineSlot呼び出し数) + <ins class="adsbygoogle">の数
```

### 閾値 — 実測で決定

| サイト | 広告枠 | 判定 |
|---|---:|---|
| alfalfalfa | 29 | ★ 広告過多 |
| gigazine（記事） | 12 | ★ 広告過多 |
| yurukuyaru | 9 | — |
| 毎日新聞（記事） | 8 | — |
| nlab | 6 | — |
| togetter | 4 | — |
| 朝日（記事） | 2 | — |
| zenn / Yahoo!ニュース / 4gamer | 0 | — |

普通の新聞記事が8枠なので、境界は **10**（`AD_HEAVY_MIN_SLOTS`）。
yurukuyaru(9) は取りこぼしますが、毎日新聞を誤検出しないことを優先しました。

補助として、異なる広告ネットワークが6社以上（`AD_HEAVY_MIN_NETWORKS`）でも判定します。
ネットワークの一覧は `AD_SCRIPT_HOSTS`（約40社。Google系/Criteo/Taboola/Outbrain/
国内のZucks・microad・nend、アダルト系のExoClick・JuicyAds等）。

表示は「多い」と断定せず **`広告枠12個`** のように実数を出します。

---

## 🏭 まとめ/転載

**既知ドメインリストのみ** — `FARM_HOSTS`。ヒューリスティックは使っていません。

```js
"togetter.com", "matome.naver.jp", "curazy.com", "netgeek.biz",
"gogotsu.com", "yurukuyaru.com", "hamusoku.com", "blog.livedoor.jp",
"alfalfalfa.com", "matomedane.jp", …
```

「まとめサイトかどうか」を機械的に判定する信頼できる方法が無いためです。
本文の引用比率などで推定することは可能ですが、**誤ラベルの実害が大きい**（サイトの信用に関わる）ので、
確実に分かっているドメインだけを列挙する方針にしています。

ラベルも「まとめ/転載」という中立表現で、品質の良し悪しは判断していません。

---

## 🚨 連投リンク

**唯一、リンク単体ではなくページ全体を見る判定です。**

バズ投稿のリプ欄に湧く誘導リンクの主な手口は「同じ行き先を別々のアカウントで大量投稿する」こと。
個々のURLは無害に見えても、**同じドメインが複数のポストに出ること自体が事実として異常**です。
文面や言語に依存しないので、文言を変えてくるスパムにも効きます。

- **閾値**: 同一ページ内で3件以上のポストに出現（`SPAM_REPEAT_MIN`）
- **会話ページ限定**: `/status/` を含むURLのみ。TLで人気記事が何度も流れるのは正常なので対象外
- **カウント単位は登録可能ドメイン**: `a1.spam.top` と `a2.spam.top` を同一視。
  ホスト完全一致だとサブドメインを回すだけで回避されるため
- **大手ドメインは除外**: `SAFE_HOSTS` に載るドメインは数えない
- 閾値に達すると、**既に描画済みの過去のポストにも遡って**バッジを付け直す

---

## 🔒 有料記事

3層構造。上ほど信頼度が高く、未登録ドメインでも 1 と 3 だけで判定できます。

### 第1層: 構造シグナル（媒体非依存・確定的） — `PAYWALL_META_RE`
```js
/"isAccessibleForFree"\s*:\s*(false|"false"|"False")/i     // schema.org
/"cssSelector"\s*:\s*"[^"]*(paywall|paid|premium|locked)/i // hasPart.paywalledContent
/<meta[^>]+article:content_tier[^>]+content=["'](locked|metered)["']/i
```

**これらは `<meta>` タグと `<script type="application/ld+json">` ブロックの中でだけ探します。**
文書全体を正規表現でなぞると、ページが構造シグナルの"話をしている"だけで一致してしまうためです
（このリポジトリのREADMEが `isAccessibleForFree:false` と書いていたせいで、GitHubのページが
有料記事と誤判定されました）。宣言は宣言のある場所でだけ探します。

### 第2層: 媒体別CTA — `PAYWALL_SITES[domain].paidRe`
実記事で「有料記事だけに出る」ことを確認した文字列。

| 媒体 | 判定文字列 | 確認 |
|---|---|---|
| 朝日 | `有料会員になると続き` | ✅ |
| 読売 | （JSON-LD で確定） | ✅ |
| 日経 | `この記事は有料会員限定記事です` / `登録すると続きをお読みいただけます` | ✅ 22本 |
| 東洋経済 | `有料会員限定です` | ✅ 12本 |
| ダイヤモンド | `続きを読むには会員登録が必要です` | ✅ 10本 |

### 第3層: 汎用CTA — `GENERIC_PAYWALL_RE`
```js
/ここから先は有料/  /この続きは有料/  /この記事は有料(会員)?記事です/
/続きを読むには[\s\S]{0,20}(会員登録|ログイン|購読|プラン)/
/残り\s*\d[\d,]*\s*文字/                      // 本文末尾の切り詰めマーカー
/Subscribe to (continue|keep) reading/i
```

### 採用してはいけない語
ナビやフッタに**常時出る語**は使えません。無料ページでも誤検出します。

| ❌ 使わない | 理由 |
|---|---|
| 「有料会員」「会員限定」単体 | ヘッダ/フッタ/関連記事ラベルに常時出る |
| 鍵アイコン（`icon__keyGold.svg`） | 朝日では全ページに出る |
| `class="…Paywall…"` | 日経では全記事に出る（JSで出し分ける器） |

採用するのは**本文の続きを塞ぐ固有フレーズ**だけです。

> 「残り<b>436</b>文字」のように**タグを跨ぐ**ケースがあるため、
> 生HTMLとタグ除去後テキストの**両方**で照合しています。

---

## 💰 アフィリエイト

URLパターンのみ。3つの条件形式を組み合わせます — `AFFILIATE_RULES`。

| 形式 | 意味 | 例 |
|---|---|---|
| `hostRe` | ホスト名の正規表現 | `hb.afl.rakuten.co.jp`, `a.r10.to` |
| `param` | クエリパラメータの存在 | Amazon の `?tag=` |
| `paramRe` | パラメータ値の正規表現 | 楽天の `scid=af_...` |
| `paramAny` | いずれかの key / key=value | `affiliate_id`, `utm_medium=affiliate` |

**Amazon は `hostRe` と `param` の両方**を要求します。`amazon.co.jp` へのリンクでも
`?tag=` が無ければアフィリンクではないので、判定しません。

対応ASP: Amazonアソシエイト / 楽天 / A8.net / もしも / バリューコマース / アクセストレード /
afb / felmat / レントラックス / JANet / impact / Awin / CJ / ShareASale

---

## 🔗 短縮URL

**既知ホストリストのみ** — `SHORTENER_HOSTS`（約35ドメイン）。
bit.ly / tinyurl / cutt.ly / lnkd.in / linktr.ee / lit.link / x.gd など。

**`t.co` は含めません。** X の標準ラッパなので、全リンクに付いてしまい情報量がゼロだからです。

短縮URLの**行き先**は別途解決し、着地先で全カテゴリを再判定します。
これにより「短縮の裏に隠れたアダルトサイト」を検出できます。

### 多段中継の追跡
HTTPの30xだけでは足りません。**200を返して小さなHTMLでJSリダイレクトする中継**が使われるためです。

```
is.gd/xxxxx
  → playstone.biz/redirect/…   (206バイト。<input type="hidden" id="redirect_to_url"> に次のURL)
  → applove.info/redirect/…    (239バイト。同上)
  → 実体ページ (18KB)
```

`extractRelayTarget()` が中継ページから次のURLを取り出し、最大4ホップまで追跡します
（`MAX_RELAY_HOPS`）。取得したHTMLが4KB（`RELAY_MAX_BYTES`）を超えたら実体ページとみなして停止し、
ループ検出のため訪問済みURLも記録します。抽出できる形は次の4つ:

1. `<input type="hidden" id="redirect_to_url" value="…">` などの hidden input
2. `<meta http-equiv="refresh" content="0;URL=…">`
3. `location.replace("…")` / `location.href = "…"`
4. 文書内の最初の絶対URL（フォールバック）

---

## 📣 PR/広告リンク

2系統 — `PR_RULES`。

- **プレスリリース配信**: prtimes.jp / atpress.ne.jp / value-press.com / dreamnews.jp
- **広告ネットワーク経由の遷移**: doubleclick.net / taboola.com / outbrain.com /
  popin.cc / logly.co.jp など
- **UTMパラメータ**: `utm_medium=paid` / `cpc` / `display`、`utm_source=taboola` など

「広告経由のリンクである」ことは事実なので判定していますが、内容の良し悪しは判断していません。

---

## 🔑 登録/ログイン必須

「有料」ではなく「**無料だが登録が要る**」ウォール — `LOGIN_WALL_RE`（要fetch）。

```js
/続きを読むには[\s\S]{0,20}無料会員登録/
/無料会員登録(をする|が必要|してください)/
/Sign (in|up) to (continue|read|view)/i
```

**有料判定が取れている場合はこちらを出しません**（有料の方が強い情報のため）。
単なる「ログイン」リンクの存在では判定しません（どのサイトにもあるので）。

---

## 📦 ファイル直ダウンロード

クリックするとファイルが落ちてくる拡張子 — `DOWNLOAD_EXT_RE`。

```js
/\.(apk|exe|dmg|msi|scr|bat|jar|zip|rar|7z|iso)(\?|$)/i
```

パス末尾（またはクエリの直前）で判定します。

---

## ⚠️ 要注意ドメイン

**既定は空リスト** — `CAUTION_HOSTS`。

既知のフィッシング/詐欺の**報告がある**ドメインを手動またはブロックリストから充填する枠です。
ラベルは「要注意(報告あり)」で、「偽サイト」「詐欺」とは断定しません。
誤ラベルは名誉毀損になり得るためです。

> 以前は「不審URL(🧪)」というカテゴリで、IP直リンク・怪しいTLD・ブランドなりすまし等の
> ヒューリスティック判定をしていましたが、**削除しました**。
> 「事実として何が問題か」を利用者に伝えにくく、精度も割に合わなかったためです。
> なりすまし対策はこの `CAUTION_HOSTS` に寄せる方針です。

---

## 判定の適用順序

```
1. URL判定（fetch不要）
   ├─ href（t.co以外）
   └─ 表示テキストから復元したURL
2. 最終URLの解決
   ├─ t.co の中継HTMLから本URLを抽出
   └─ 短縮URLならリダイレクトを追う → 着地先で再度URL判定
3. 中身判定（fetch必要）
   ├─ 有料（3層）
   ├─ 広告枠の計測
   ├─ アダルト自己申告
   └─ 登録ウォール
4. ページ全体の判定
   └─ 連投（同一ドメインの出現ポスト数）
```

結果は6時間キャッシュされます。ただし**取得失敗（fetch-failed / resolve-miss）は
キャッシュしません** — 一時的な失敗が固定化して永久に判定されなくなるのを防ぐためです。
