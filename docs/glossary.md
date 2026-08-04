# nukadoko 用語集

これは英語の技術語と日本語訳の対応表であり、日本語で書かれている。
読者は README.ja.md / docs/spec.ja.md / docs/migration.ja.md を書く人、レビューする人である。
ここに載っているのは、この 3 ファイルで実際に使われている訳語であって、ここで新しく訳語を発明したものではない。
網羅は目的にしていない。
迷ったときに引ける最小限だけを載せている。

## 1. 英語の技術語 → 日本語訳

- **acceptance criteria → 受け入れ基準**
  以前は「受け入れ条件」と表記が割れていたが、現在は 3 ファイルとも「受け入れ基準」に統一されている(2026-08-04 時点で「受け入れ条件」の残存は確認できなかった)。
- **validated / validation → バリデーション(済み)**
  3 ファイルの大多数の用例がこちら。
  docs/migration.ja.md にだけ「検証(済み)」という表記が同じ意味で混在している(下の「不一致」を参照)。
- **Problem → 課題**
- **Running(scenario の実行を指す節タイトル)→ 実行**
- **Tending → 手入れ**
  「ぬか床は毎日手入れをすれば熟成し、放っておけば死ぬ」という比喩と対になっている。
- **rot / rotting → 腐る、腐敗**
- **mature(tended daily it matures)→ 熟成する**
- **deviation → 逸脱**
- **chain / chaining → 連鎖**
- **declare / declaration → 宣言**
- **contract → 契約**
- **vocabulary → 語彙**
- **promote / promoted → 昇格させる、昇格した**
- **refuse / reject → 拒否する**
  この 2 つの英語は日本語では区別されず、どちらも「拒否する」に訳されている。
- **measure / measurement → 計測**
- **bind / bound → 束ねる / 結び付ける(意味で使い分ける)**
  scenario の中で「その step が前方に置かれている」ことを言うときは「束ねる」。
  pattern を feature の行に、capture を schema のキーに、といった対応関係を作ることを言うときは「結び付ける」。
  英語では同じ bind だが日本語では別の行為として読めるほうがよいので、この使い分けは意図的なものであり、統一しない。

## 2. 英語のまま残している語

以下は、日本語の文中でもローマ字表記のまま使われている語である。

- **step**: Gherkin の行、`defineStep` で定義される単位そのものを指すドメイン語であり、訳すと概念との結び付きが失われる。
- **receipt**: nukadoko 固有の中核データ構造で、`receipt.json` と直接対応する。
- **scenario**: Gherkin の `Scenario:` キーワードと直接対応する。
- **agent**: 「エージェント」等に訳すと、このツールが第一の読者と位置づける AI agent という専門的な語感が薄れる。
- **feature**: `.feature` ファイル、`Feature:` キーワードと直接対応する。
- **pattern**: step 定義の `pattern` / `patterns` フィールド名と直接対応する場面では常に英語のまま。
  「パターンマッチング」のような一般的な文脈ではカタカナの「パターン」も使われており、これはフィールド名としての `pattern` とは別の使われ方である。
- **environment**: `environment` / `--env`、config の `environments` と直接対応する。
- **session**: `session` / `--session`、`nuka session` コマンドと直接対応する。
- **secret**: `secrets` config、`{{secret.NAME}}` token と直接対応する。
- **compat**: `nukadoko/compat` という実在のサブパス名そのもの。
- **evidence**: receipt の `evidence` フィールドと直接対応する。
- **trace**: Playwright の trace(`trace.zip`)という具体物を指す。
- **World**: cucumber-js 由来の `this` オブジェクトの正式名称で、固有名詞的に大文字のまま使われる。
- **hook / pickle / glue / gate / observed / provenance / chain**: いずれも cucumber/gherkin のドメイン語、または receipt のフィールド名に直接対応する語として英語のまま使われている。
- **mutate / mutates**: `mutates` フィールド名と地続きの動詞としても、常に英語のまま(「状態を mutate する」のように文中でも活用させずに使われる)。
- **sign-off**: `nuka accept` が書く記録の呼び名で、常にハイフン付きの英語のまま。
- **harness**: docs/spec.ja.md と docs/migration.ja.md では英語のまま残っているが、README.ja.md だけがカタカナの「ハーネス」に訳している(下の「不一致」を参照)。

## 3. 識別子・API 名

`defineStep`、`from`、`mutates`、`ctx`、`nuka check` のようなコード識別子・CLI コマンド名は、常に原文のスペルのまま、コードとして(バッククォート付きで)書かれる。
これは「2. 英語のまま残している語」とは理由が別で、語彙としての選択ではなく、実際にそのままのスペルで動くコードだからである。
この規則自体に例外はなく、対応表としての一覧は作っていない。

## 4. 見出しの扱いの規則

3 ファイルの見出しは、ファイルごとに異なる一貫したルールに従っており、単一の規則では説明できない。

- **README.ja.md**: すべての見出し(16 個)を README.md と同じ英語のまま残し、見出し直下に太字の日本語訳を本文の 1 行目として置く、という書式が一律に適用されている。
  例外はない。
- **docs/spec.ja.md**: 見出しごとに扱いが混在する。
  「nukadoko とは」「課題」「キーワードの意味論」「実行」「受け入れループ」「ロードマップ」「実装ノート」は完全に日本語化されている。
  「Context API」「Receipt」「Session、environment、secret」「State directory」「Sign-off」「Allure emitter」「Messages emitter」「CLI summary」は完全に英語のまま残っている。
  これらはいずれも、上の「2. 英語のまま残している語」に載っている語(receipt、session、environment、secret、sign-off など)がそのまま見出しの主題になっているケースである。
  「Compat steps(移行の扉)」「Scenario(スクリプト化された経路)」「Self-healing(監査付き)」「Tending(手入れ)」「Out of scope(正直な限界)」は、英語の用語のあとに丸括弧で日本語の言い換えを添える形になっている。
  「型付き step」「step の連鎖」「単体 step(agent の経路)」は、見出し全体としては日本語に訳されており、その中に step / agent という「2. 英語のまま残している語」の単語がそのまま混ざっている(これは直前の丸括弧併記のパターンとは別物で、括弧の中身も含めて全訳されている)。
- **docs/migration.ja.md**: 見出しはおおむね日本語化されるが、「Stage 0」「Stage 1」「Stage 1.5」「Stage 2」という段階ラベルは英語のまま数字付きで残り、そのあとに続く説明部分だけが日本語化される。
  「ダッシュボードは `nuka check`」のように、コマンド名がコードスパンのまま見出しに埋め込まれる例もある。

リードの想定では「説明的な句は日本語化、データ構造名・API 名は英語のまま、コマンド名に対応する概念名は英語+日本語の併記」だったが、実際の分布はこれとは違う。
特に、丸括弧併記が付く見出し(Compat steps、Scenario、Self-healing、Tending、Out of scope)のうち、実際に `nuka` のコマンド名と 1 対 1 で対応するのは Tending(`nuka tend`)だけであり、他の 4 つはコマンド名と対応しない概念・セクション名である。
また Tending の丸括弧「(手入れ)」は docs/spec.md(英語原文)には存在せず、日本語版側だけで追加されている。
実態に近い言い方をすると、丸括弧併記は「コマンド名との対応」ではなく「独立した見出しとして立つ英語の術語に、日本語話者向けの短い言い換えを添えるかどうかの個別判断」に見える。

### 新しい見出しを足すとき

上は現状の記述であって、規範ではない。
新しく見出しを足すときは、以下に従うこと。

- **README.ja.md**: 英語のまま残し、直下に太字の日本語訳を本文 1 行目として置く。
  この書式は 16 個すべてに例外なく適用されているので、破らない。
- **docs/spec.ja.md**: 見出しの主題が「2. 英語のまま残している語」に載っている語なら、英語のまま残す。
  説明的な句なら日本語化する。
  どちらとも言い切れない英語の術語が単独で立つ場合だけ、丸括弧で短い日本語の言い換えを添える。
- **docs/migration.ja.md**: 日本語化する。
  ただし「Stage N」のような段階ラベルと、コードスパンで書かれたコマンド名はそのまま残す。

ファイルごとに規則が違うのは歴史的な経緯であって、意図された設計ではない。
統一する価値はあるが、既存の見出しを動かすとリンクのアンカーが壊れるので、まとめてやるときに一度で行うこと。
