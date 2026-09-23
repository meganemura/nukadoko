# CI で nukadoko を実行する

これはレシピであって要件ではありません。
`nuka check` と `nuka run` は普通の CLI コマンドで、すべてが保たれていれば `0` で終了し、何かが壊れた瞬間に非ゼロで終了します([README.md](../README.ja.md#running-this-in-ci) と [docs/spec.ja.md](spec.ja.md#cli-summary) の「CLI summary」を参照)。
だからどの CI システムからでも呼び出せます。
このページが埋めるのは 2 行の抜粋には書けないもの、すなわち丸ごと 1 つの workflow ファイルと、そのうち 3 行が存在する理由と、`npx playwright test` から来たプロジェクトが自分の手で足す必要がある、そして `nuka run` が自分では決してやらない 4 つのことです。

## そのままコピーできる workflow

これは 1 つのファイル、`.github/workflows/nukadoko.yml` です。
すべての push と pull request で `nuka check` を実行し(数秒、ブラウザ不要)、それが通ったら `nuka run` を実行し(実際に実行するゲート)、`nuka tend` を毎週のスケジュールで実行します。
これを実行しろと思い出させるものが他に無いからです。

```yaml
name: nukadoko

on:
  push:
    branches: [main]
  pull_request:
  schedule:
    # Weekly is a starting point, not a rule: pick whatever cadence a
    # human will actually read the output on.
    - cron: "0 6 * * 1"

jobs:
  check:
    if: github.event_name != 'schedule'
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: 20
      - run: npm ci --ignore-scripts
      # PR gate: static, seconds, no browser. Put this on every PR; it can
      # fail before anything runs.
      - run: npx nuka check

  run:
    if: github.event_name != 'schedule'
    needs: check
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: 20
      - run: npm ci --ignore-scripts
      # `nuka run` opens a browser; install it here, not on the `check`
      # job above, which never launches one. `chromium` is
      # `browserType`'s own default (docs/spec.md "Sessions, environments,
      # secrets"); add `firefox`/`webkit` too if `browserType` names one
      # of them. `--with-deps` is a Linux-runner requirement: without it,
      # Playwright's own browser binary is present but missing the system
      # libraries it needs to actually launch.
      - run: npx playwright install --with-deps chromium
      # `nuka run` never reads playwright.config.ts, so its own
      # `webServer` field never starts anything (unlike `npx playwright
      # test`, which does): start the app under test by hand, or a step
      # that calls `page`/`request` fails with ECONNREFUSED before it
      # gets anywhere near a real assertion. Replace both the start
      # command and the health check below with this project's own.
      - name: Start the app under test
        run: |
          npm run start &
          for i in $(seq 1 30); do
            curl -sf http://localhost:3000/ && break
            sleep 1
          done
      # Merge/deploy gate: executes, writes step records.
      - run: npx nuka run features/

  tend:
    if: github.event_name == 'schedule'
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: 20
      - run: npm ci --ignore-scripts
      # `nuka tend` reports what is rotting rather than what is broken
      # (docs/spec.md "Tending"); it never gates a PR, which is why it
      # sits on its own schedule rather than beside `check`/`run` above.
      # It exits non-zero only for a sign-off that no longer matches the
      # code it froze; every other finding is a note.
      - run: npx nuka tend
```

## 上の workflow が action を固定し、インストールスクリプトを止め、権限を絞る理由

2026 年 8 月、広く使われている npm パッケージ群が複数、侵害されました。
攻撃の経路は `package.json` の `preinstall` フックから始まりました。
これは `npm install` を実行した瞬間に npm が自動で実行するもので、誰もそのパッケージ自身のコードを 1 行も読まないうちに動きます。
このフックは 200 を超えるファイルパスを走査して、AWS の認証情報、GitHub の個人アクセストークン、npm のトークン、SSH 鍵を探し、見つけたものをプロジェクトの外のサーバへ送りました。
盗んだ GitHub トークンを使って、同じ攻撃はさらに `.github/workflows/` へ workflow を注入しました。
その workflow は `toJSON(secrets)` でリポジトリのシークレットをすべて読み、その結果をビルドの artifact へ書き込むものでした。

上の workflow の 3 行が、その経路の 3 つの部分にそれぞれ答えます。

- **`uses:` はタグではなくコミットを名指しします。** `@v4` のようなタグは動きます。
  侵害されたメンテナのアカウントは、読み手が workflow ファイルで目にする文字列を変えないまま、そのタグを別のコードへ付け替えられます。
  コミット SHA は同じようには動かないので、上の workflow は SHA を名指しています。
  上の 2 つの SHA は、この文章を書いている時点でそれぞれの action の最新リリースでもあります(`checkout` は v7.0.1、`setup-node` は v7.0.0)。
  これはこのファイルが以前に使っていた `v4` の系列から 3 メジャー先で、固定をやり直すこの機会がそこへ移る潮時でした。
  SHA へ固定することは、動くタグが運んでいた自動の更新と引き換えです。
  ここに書かれたものは自分からピンを進めません。
  誰かが手で進めるか、そのために作られた道具に進めさせる必要があります。
  Dependabot は SHA のピンを更新できます。
  それはいくつかある選択肢の 1 つであって、このレシピが求めるものではありません。
- **`npm ci --ignore-scripts` は上の攻撃が使ったフックを止めます。** このリポジトリ自身の `.npmrc` はすでに `ignore-scripts=true` を設定しているので、CI の行に無くてもこの効果はすでにここで効いています。
  それでもこのフラグを行そのものに書くのは、このレシピを別のプロジェクトへコピーする読み手が持っていくのが YAML であって、このリポジトリの `.npmrc` ではないからです。
  行そのものにフラグが無ければ、そのプロジェクトはすべての依存のインストールスクリプトを既定で実行します。
  それは上の攻撃が頼った、まさにその既定です。
- **`permissions: contents: read` は job の中のトークンにできることを絞ります。** step が GitHub 自身のトークンで何をできるかは `permissions:` ブロックが決めるものであって、その場その場で決まるものではありません。
  job レベルの `permissions: contents: read` はそのトークンをリポジトリの内容を読むことだけに絞るので、すでに侵害された step であっても、それを使ってコミットを push したり新しい workflow ファイルを書いたりはできません。
  このリポジトリ自身の既定の workflow permission はすでに `read` で、リポジトリのシークレットも 0 件です。
  ですが、このレシピをコピーする読み手が持っていくのは YAML であって、このリポジトリのアカウントレベルの設定ではありません。
  既定が違うリポジトリでは、同じ行をファイル自身に書き込む必要があります。

## `npx playwright test` に対してこれが加える 4 つのこと

すでに動いている Playwright Test の CI 構成から来たチームは、上の大部分をすでに持っています。
変わるのはこの 4 つです。

- **ブラウザのインストール行がエンジンを名指しします。** 新しいランナー上で `npx playwright test` は `npx playwright install --with-deps` だけで済みます。
  Playwright 自身が、どのブラウザをインストールするかをプロジェクト自身の `playwright.config.ts` から読むからです。
  nukadoko には読み込む先の `playwright.config.ts` がありません。
  代わりに `nukadoko.config.ts` の `browserType` がエンジンを選びます(既定は `"chromium"`)。
  だから上のインストールコマンドはそれを明示的に名指しています。
  firefox と webkit もそれぞれ自分自身のバイナリを必要とします(docs/spec.ja.md の「Session、environment、secret」を参照)。
  `browserType`(や、それを渡り歩く test matrix)が実際に必要とするものを足してください。
- **テスト対象のアプリは自分の手で起動する必要があります。** `playwright test` から来た人がもっとも見落としがちなのがこれです。
  そちらでは `webServer` という設定フィールドが、1 つ目の spec が走るより前に自動でアプリを起動します。
  `nuka run` と `nuka do` は `playwright.config.ts` を一切読みません([docs/migration-playwright-test.ja.md](migration-playwright-test.ja.md) を参照)。
  だから明示の起動 step が無いと、`page` や `request` に触れる最初の step が、何が欠けていたかを名指すことも無いまま `ECONNREFUSED` で失敗します。
- **run が残すものには上限があり、それ以外にはありません。** `nuka run` は最新 `retention.runs` 回分の run を保ち、それより古い run を毎回の run の終わりに自分で消します(docs/spec.ja.md の「成果物」を参照)。
  だから永続するランナーでも、`.nukadoko/records/` と export の出力はその回数ぶんの大きさに留まります。
  決して消さないのは `.nukadoko/cache/`(`nuka do`/session の利用が残す session ファイル)と、nukadoko が run ごとのファイル一覧を残すようになる前に書かれた `allure-results/` です。
  GitHub がホストするランナーはジョブごとに新しい仮想マシンなので、そこではどちらも問題になりません。
  セルフホストや、それ以外の理由で永続するランナーでは、その 2 つに対して手当てが 2 つあります。
  ジョブの先頭で `rm -rf .nukadoko` するか、`npx nuka clean`(自身の `--help` を参照)を叩くかです。
  後者は同じことをより狭く行い、そのランナー上でまだ生きている `nuka session` があれば、それを理由に丸ごと拒否します。
- **`nuka tend` は自分自身のトリガーを必要とします。** workflow が明示しない限り、これを定期的に走らせるものは何もありません。
  上の `tend` job がそのトリガーで、`check`/`run` の経路からは意図的に外してあります(docs/spec.ja.md の「Tending(手入れ)」を参照)。
  今日対処しなくてよい note が PR を遅くしないためです。

## チームがその上に足すもの

上の workflow がチームに委ねているものが 3 つあります。どれも小さいものです。

- **PR が触った feature すべてに sign-off が在ることを確かめる PR の検査。**
  `feature-never-signed` は `nuka tend` の note です。週次で、終了コードを赤にすることはありません。
  だから `nuka accept` 無しで merge された feature は、誰かがその note を読むまで署名されないままです。
  PR のジョブが自分でその問いを立てられます。

  ```sh
  for f in $(git diff --name-only origin/main...HEAD -- 'features/**/*.feature'); do
    ls "${f%.feature}".*.md >/dev/null 2>&1 || { echo "no sign-off beside $f"; exit 1; }
  done
  ```

  record の名前は feature のベース名で始まります(docs/spec.ja.md の「Sign-off」を参照)。この検査が知る必要があるのはそれだけです。
  PR が触った feature だけでなくすべての feature に署名を求めるチームは、そのジョブで代わりに `npx nuka tend --fail-on feature-never-signed` を回します。
- **`tend` のジョブへの通知 step。**
  終了コードを赤にする finding は、古くなった sign-off record の 1 つだけです。
  Actions のタブでだけ赤くなる週次のジョブは、誰も読まないジョブです。
- **ランナー自身の速さに合わせた `retention.runs`。**
  既定は最新 20 回の run を残します。
  merge のたびと毎晩に走る永続ランナーは数日で 20 に達し、`nuka accept` は保持された run しか読みません。
  数字を決める前に、1 週間の速さを測ってください。

## このページが主張しないこと

上の workflow は GitHub Actions の中で実際に実行してはいません。
このリポジトリの中では、それを実行する手段が無いからです。
代わりに確かめたのは次のことです。
この YAML は妥当な YAML としてパースできること、そしてこの中の `npx nuka ...` コマンドはすべて(上で使っているディレクトリ形式の `nuka run features/` も、1 つの feature ファイルだけでなく)、実際に `npm install` した本パッケージのコピーに対して実行したこと(`nuka clean` の live session 拒否や、`nuka accept` を実行した瞬間に `feature-never-signed` の finding が消えることも含めて)です。
`npx playwright install --with-deps chromium` は自身の `--dry-run` で確かめただけで、最後まで実行してはいません。
`--with-deps` は Linux ランナーの外では何もしないため(このリポジトリには Linux ランナーがありません)、ダウンロード自体はここでは試していません。
上の `uses:` 行にある 2 つのコミット SHA は、GitHub 自身の API に照らして確かめました。
`repos/actions/checkout/git/ref/tags/v7.0.1` と `setup-node` の同等のエンドポイントをそれぞれ 1 回ずつ呼び、それぞれがコメントの主張どおりのコミットを名指ししていて、他の何も指していないことを確かめました。
この workflow は、実際のランナー上で green になるのを見届けたファイルとしてではなく、手を加えるための出発点として読んでください。

ジョブの後で Allure の出力がどこへ行くかについても、このページは何も言いません。
trace と screenshot は伏せられません(docs/spec.ja.md の「Sessions, environments, secrets」を参照)。
隣の `http.jsonl` は秘密を置き換えてありますが、trace はブラウザ自身の状態を cookie ごと持ち、screenshot は画面に出ていたものをそのまま持ちます。
artifact としてアップロードした `allure-results/` や、チャットに貼った生成済みレポートは、そのすべてを運びます。
ランナーの中に留めるか、最初のアップロードの前に誰が開いてよいかを決めてください。
