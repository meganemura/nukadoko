# CI で nukadoko を実行する

これはレシピであって要件ではありません。
`nuka check` と `nuka run` は普通の CLI コマンドで、すべてが保たれていれば `0` で終了し、何かが壊れた瞬間に非ゼロで終了します([README.md](../README.ja.md#running-this-in-ci) と [docs/spec.ja.md](spec.ja.md#cli-summary) の「CLI summary」を参照)。
だからどの CI システムからでも呼び出せます。
このページが埋めるのは 2 行の抜粋には書けないものです。
すなわち、丸ごと 2 つの workflow ファイル(CLI や API のプロジェクトのための 1 つの job と、ブラウザのプロジェクトの workflow)、そのうち 3 行が存在する理由、そして `npx playwright test` から来たプロジェクトが自分の手で足す必要があり、`nuka run` が自分では決してやらない 4 つのことです。

## CLI や API のプロジェクト: job は 1 つ

`nuka init` で準備したプロジェクトには、`nuka run` を実行する `npm run test:scenarios` が既にあります。
対象を渡さない `nuka run` は `featuresDir` を実行します。
何かを実行する前に、その scenario について `nuka check` が報告する内容を報告し、error が 1 つでもあれば何も実行せずに `2` で終了します。
失敗した scenario があれば `1` で終了します。
この 2 つを区別する必要がある job の step は `$?` を読みます。
`2` は、実行できるようになる前に呼び出し方か suite を直すこと(不正なフラグ、不正な config、存在しない対象、`check` のエラー)を意味します。
`1` は、実行されて何かが red になったことを意味します。
そのため、step がブラウザを開かないプロジェクトでは、1 つの job がゲートのすべてです。

```yaml
jobs:
  scenarios:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: 24
      - run: npm ci --ignore-scripts
      - run: npm run test:scenarios
```

`node-version` には nukadoko が動くどのリリースでも指定できます。
22 系なら 22.18 以降、それ以外は 23.6 以降で、フラグなしで `.ts` ファイルを読み込めるリリースです。
これらのファイルでは長期サポートの系列である 24 を使います。

ここではブラウザも Playwright 自体もインストールしません。
`playwright` は nukadoko の optional な peer dependency なので、`npm ci` がそれを入れるのは、自分の `devDependencies` にそれを書いたプロジェクトだけです。
それを書いていないプロジェクトにそれを必要とする step があれば、この job はどの scenario も実行する前に、check で `playwright-missing` として止まります。

単独の `nuka check` には、まだ 2 つの使い道があります。
1 つは `additionalFeatureDirs` で、これを辿るのは `nuka check` と `nuka tend` だけです。
もう 1 つは、run が数秒で終わらないときにも数秒で終わらなければならないゲートです。
このゲートは run と同じ対象、つまりファイルやディレクトリ(`npx nuka check features/checkout`)を受け、それについて run が止まるはずの error を報告します。

## ブラウザのプロジェクト: そのままコピーできる workflow

これは 1 つのファイル、`.github/workflows/nukadoko.yml` です。
すべての push と pull request で `nuka check` を実行し(数秒、ブラウザ不要)、それが通ったら `nuka run` を実行し(実際に実行するゲート)、`nuka tend` を毎週のスケジュールで実行します。
これを実行しろと思い出させるものが他に無いからです。
2 つのコマンドを 2 つの job に分けているので、check が失敗すればブラウザをインストールする前に止まります。
`nuka run` も実行の前に自分の scenario を改めて check します。
その費用は step の discovery 1 回分で、ブラウザは要りません。

ブラウザのプロジェクトは、nukadoko がテストしているバージョンの `playwright` を自分の `devDependencies` に書きます(`npm install -D -E playwright@1.61.1`)。
nukadoko はそれを optional な peer dependency として宣言しており、インストールはしません。
すると下の `npm ci` の行がどの job でもそのパッケージを入れ、ブラウザをダウンロードするのは `run` job だけです。

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
          node-version: 24
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
          node-version: 24
      - run: npm ci --ignore-scripts
      # `nuka run` opens a browser; install it here, not on the `check`
      # job above, which never launches one. `chromium` is
      # `browserType`'s own default (docs/spec.md "Environments and
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
      # Merge/deploy gate: executes, writes step records. Its Markdown
      # run summary appears on this job's summary page by itself, since
      # `nuka run` appends to $GITHUB_STEP_SUMMARY whenever it is set.
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
          node-version: 24
      - run: npm ci --ignore-scripts
      # `nuka tend` reports what is rotting rather than what is broken
      # (docs/spec.md "Tending"); it never gates a PR, which is why it
      # sits on its own schedule rather than beside `check`/`run` above.
      # Every finding is a note, so it exits 0; `--fail-on <code>` turns
      # a chosen note red for a team that wants one to gate.
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

- **`uses:` はタグではなくコミットを名指しします。**
  `@v4` のようなタグは動きます。
  侵害されたメンテナのアカウントは、読み手が workflow ファイルで目にする文字列を変えないまま、そのタグを別のコードへ付け替えられます。
  コミット SHA は同じようには動かないので、上の workflow は SHA を名指しています。
  上の 2 つの SHA は、この文章を書いている時点でそれぞれの action の最新リリースでもあります(`checkout` は v7.0.1、`setup-node` は v7.0.0)。
  これはこのファイルが以前に使っていた `v4` の系列から 3 メジャー先で、固定をやり直すこの機会がそこへ移る潮時でした。
  SHA へ固定することは、動くタグが運んでいた自動の更新と引き換えです。
  ここに書かれたものは自分からピンを進めません。
  誰かが手で進めるか、そのために作られた道具に進めさせる必要があります。
  Dependabot は SHA のピンを更新できます。
  それはいくつかある選択肢の 1 つであって、このレシピが求めるものではありません。
- **`npm ci --ignore-scripts` は上の攻撃が使ったフックを止めます。**
  このリポジトリ自身の `.npmrc` はすでに `ignore-scripts=true` を設定しているので、CI の行に無くてもこの効果はすでにここで効いています。
  それでもこのフラグを行そのものに書くのは、このレシピを別のプロジェクトへコピーする読み手が持っていくのが YAML であって、このリポジトリの `.npmrc` ではないからです。
  行そのものにフラグが無ければ、そのプロジェクトはすべての依存のインストールスクリプトを既定で実行します。
  それは上の攻撃が頼った、まさにその既定です。
- **`permissions: contents: read` は job の中のトークンにできることを絞ります。**
  step が GitHub 自身のトークンで何をできるかは `permissions:` ブロックが決めるものであって、その場その場で決まるものではありません。
  job レベルの `permissions: contents: read` はそのトークンをリポジトリの内容を読むことだけに絞るので、すでに侵害された step であっても、それを使ってコミットを push したり新しい workflow ファイルを書いたりはできません。
  このリポジトリ自身の既定の workflow permission はすでに `read` で、リポジトリのシークレットも 0 件です。
  ですが、このレシピをコピーする読み手が持っていくのは YAML であって、このリポジトリのアカウントレベルの設定ではありません。
  既定が違うリポジトリでは、同じ行をファイル自身に書き込む必要があります。

## `npx playwright test` に対してこれが加える 4 つのこと

すでに動いている Playwright Test の CI 構成から来たチームは、上の大部分をすでに持っています。
変わるのはこの 4 つです。

- **ブラウザのインストール行がエンジンを名指しします。**
  新しいランナー上で `npx playwright test` は `npx playwright install --with-deps` だけで済みます。
  Playwright 自身が、どのブラウザをインストールするかをプロジェクト自身の `playwright.config.ts` から読むからです。
  nukadoko には読み込む先の `playwright.config.ts` がありません。
  代わりに `nukadoko.config.ts` の `browserType` がエンジンを選びます(既定は `"chromium"`)。
  だから上のインストールコマンドはそれを明示的に名指しています。
  firefox と webkit もそれぞれ自分自身のバイナリを必要とします(docs/spec.ja.md の「Environment、secret」を参照)。
  `browserType`(や、それを渡り歩く test matrix)が実際に必要とするものを足してください。
- **テスト対象のアプリは自分の手で起動する必要があります。**
  `playwright test` から来た人がもっとも見落としがちなのがこれです。
  そちらでは `webServer` という設定フィールドが、1 つ目の spec が走るより前に自動でアプリを起動します。
  `nuka run` と `nuka do` は `playwright.config.ts` を一切読みません([docs/migration-playwright-test.ja.md](migration-playwright-test.ja.md) を参照)。
  だから明示の起動 step が無いと、`page` や `request` に触れる最初の step が、何が欠けていたかを名指すことも無いまま `ECONNREFUSED` で失敗します。
- **run が残すものには上限があり、それ以外にはありません。**
  `nuka run` は最新 `retention.runs` 回分の run を保ち、それより古い run を毎回の run の終わりに自分で消します(docs/spec.ja.md の「成果物」を参照)。
  だから永続するランナーでも、`.nukadoko/runs/` と export の出力はその回数ぶんの大きさに留まります。
  決して消さないのは、nukadoko が run ごとのファイル一覧を残すようになる前に書かれた `allure-results/` です。
  GitHub がホストするランナーはジョブごとに新しい仮想マシンなので、そこでは問題になりません。
  セルフホストや、それ以外の理由で永続するランナーでは、それに対して手当てが 2 つあります。
  ジョブの先頭で `rm -rf .nukadoko` するか、`npx nuka clean`(自身の `--help` を参照)を叩くかです。
  後者は同じことをより狭く行います。
- **`nuka tend` は自分自身のトリガーを必要とします。**
  workflow が明示しない限り、これを定期的に走らせるものは何もありません。
  上の `tend` job がそのトリガーで、`check`/`run` の経路からは意図的に外してあります(docs/spec.ja.md の「Tending(手入れ)」を参照)。
  今日対処しなくてよい note が PR を遅くしないためです。

## チームがその上に足すもの

上の workflow がチームに委ねているものが 5 つあります。
どれも小さいものです。

- **pull request のコメントとしての run サマリ。**
  ジョブのサマリページにはすでに表示されますが、レビュアーが読むのは pull request です。
  差分の中の feature とその横のサマリを読み、pull request の承認が sign-off になります(docs/spec.ja.md の「レビュー」を参照)。
  `--summary <path>` は同じ Markdown をファイルにも書き、もう 1 つの step がそれを投稿します。

  ```yaml
  # in the `run` job, which then needs `pull-requests: write` beside
  # `contents: read`
  - run: npx nuka run features/ --summary nukadoko-summary.md
  - name: Comment the run summary on the pull request
    if: always() && github.event_name == 'pull_request' && hashFiles('nukadoko-summary.md') != ''
    env:
      GH_TOKEN: ${{ github.token }}
    run: >-
      gh pr comment ${{ github.event.pull_request.number }}
      --body-file nukadoko-summary.md --edit-last --create-if-none
  ```

  `if: always()` があるのは、レビュアーが最も読む必要があるのが赤い run だからです。
  `--edit-last` は、push のたびにコメントを足すのではなく、前の push が残したコメントを更新します。
  どのサマリも `<!-- nukadoko:run -->` という行で始まるので、ほかのコメントも投稿する step は、代わりにこの目印でこのコメントを見つけられます。
  サマリは何が走ったかを名指しします。
  コミット、environment、ブラウザ、各 scenario の状態と所要時間、失敗した step のエラーの 1 行目(secret はすでに伏せてあります)、そしてそれを再実行するコマンドです(docs/spec.ja.md の「Records」を参照)。
  代償は `pull-requests: write` の権限です。
  suite を走らせるジョブが pull request に書き込めるようになります。
  fork からの pull request は読み取り専用のトークンを受け取るので、そこではこの step は失敗します。
  fork からの pull request を受け付けるチームは、この step を別のジョブに移します。
- **build artifact としての run ディレクトリ。**
  1 回の `nuka run` が計測したものは、すべて 1 つのディレクトリ `.nukadoko/runs/<run_id>/` にあります。
  `run.json`、`summary.md`、そして trace、screenshot、`http.jsonl` を持つ各 step record です(docs/spec.ja.md の「State directory」を参照)。
  `run.json` の中のパスはそのディレクトリからの相対パスなので、ダウンロードした写しもランナーの上のものと同じように読めます。
  `run` ジョブにもう 1 つ step を足すと、それをアップロードできます。

  ```yaml
  - name: Upload the run directory
    if: always()
    uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2
    with:
      name: nukadoko-runs
      path: .nukadoko/runs/
      # `.nukadoko` starts with a dot, and upload-artifact skips every
      # file inside such a directory unless this is set.
      include-hidden-files: true
      if-no-files-found: ignore
      retention-days: 14
  ```

  `if: always()` があるのは、コメントの step と同じ理由です。
  誰かがダウンロードするのは赤い run です。
  GitHub がホストするランナーでは、このディレクトリはこのジョブの run だけを持ちます。
  永続するランナーでは、retention が保ったすべての run を持ちます。
  `nuka do` の record は、その外の `.nukadoko/do/` にあります。
  CI のジョブは `nuka do` を走らせないからです。
  trace はブラウザの cookie を持ち、screenshot は画面に出ていたものを持つので、最初のアップロードの前に誰が artifact を開いてよいかを決めてください(下の「このページが主張しないこと」を参照)。
- **run の結果に基づいて動くスクリプト。**
  失敗した scenario ごとに issue を作る step や、それらを再実行する step は、stderr ではなく `run.json` を読みます。
  `nuka run features/ --json > run.json` がそれを出力し、run はどちらの場合も同じファイルを `.nukadoko/runs/<run_id>/run.json` に書きます。
  その `scenarios` のエントリは、各 scenario の status と、行、status、step record、エラーを持つ step を持ち、失敗した scenario はそれを再実行する `do` コマンドを持ちます(docs/spec.ja.md の「Scenario(スクリプト化された経路)」を参照)。
- **`tend` のジョブへの通知 step。**
  `tend` の finding はどれも note です。
  出力が Actions のタブに留まる週次のジョブは、誰も読まないジョブです。
  人が見る場所へ出力を投稿するか、チームが対処すると決めた note に `--fail-on <code>` を付けます。
- **ランナー自身の速さに合わせた `retention.runs`。**
  既定は最新 20 回の run を残します。
  merge のたびと毎晩に走る永続ランナーは数日で 20 に達し、`nuka tend` と `nuka do --use` は保持された run しか読みません。
  数字を決める前に、1 週間の速さを測ってください。

## このページが主張しないこと

上のどちらの workflow も、GitHub Actions の中で実際に実行してはいません。
このリポジトリの中では、それを実行する手段が無いからです。
代わりに確かめたのは次のことです。
`npm run test:scenarios` は、本パッケージの tarball を新しくインストールした CLI のプロジェクトで、green と red の両方を実行しました。
この YAML は妥当な YAML としてパースできること、そしてこの中の `npx nuka ...` コマンドはすべて(上で使っているディレクトリ形式の `nuka run features/` も、1 つの feature ファイルだけでなく)、実際に `npm install` した本パッケージのコピーに対して実行したことです。
「チームがその上に足すもの」にある pull request のコメント step も実行していません。
その `gh pr comment` のフラグは `gh` 自身のヘルプから読んだもので、実際の pull request に対して試してはいません。
`npx playwright install --with-deps chromium` は自身の `--dry-run` で確かめただけで、最後まで実行してはいません。
`--with-deps` は Linux ランナーの外では何もしないため(このリポジトリには Linux ランナーがありません)、ダウンロード自体はここでは試していません。
上の `uses:` 行にある 2 つのコミット SHA は、GitHub 自身の API に照らして確かめました。
`repos/actions/checkout/git/ref/tags/v7.0.1` と `setup-node` の同等のエンドポイントをそれぞれ 1 回ずつ呼び、それぞれがコメントの主張どおりのコミットを名指ししていて、他の何も指していないことを確かめました。
「チームがその上に足すもの」にある `upload-artifact` の SHA は、`git ls-remote https://github.com/actions/upload-artifact` で確かめました。
タグ `v7.0.2` はそのコミットを名指ししており、これを書いた時点で最新のリリースタグです。
そこにある `action.yml` は、この step が使う入力をすべて宣言しています。
アップロードの step そのものは実行していません。
この workflow は、実際のランナー上で green になるのを見届けたファイルとしてではなく、手を加えるための出発点として読んでください。

ジョブの後で Allure の出力がどこへ行くかについても、このページは何も言いません。
trace と screenshot は伏せられません(docs/spec.ja.md の「Environment、secret」を参照)。
隣の `http.jsonl` は秘密を置き換えてありますが、trace はブラウザ自身の状態を cookie ごと持ち、screenshot は画面に出ていたものをそのまま持ちます。
artifact としてアップロードした run ディレクトリや `allure-results/`、チャットに貼った生成済みレポートは、そのすべてを運びます。
ランナーの中に留めるか、最初のアップロードの前に誰が開いてよいかを決めてください。
