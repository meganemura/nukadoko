# CI で nukadoko を実行する

これはレシピであって要件ではありません。
`nuka check` と `nuka run` は普通の CLI コマンドで、すべてが保たれていれば `0` で終了し、何かが壊れた瞬間に非ゼロで終了します([README.md](../README.ja.md#running-this-in-ci) と [docs/spec.ja.md](spec.ja.md#cli-summary) の「CLI summary」を参照)。
だからどの CI システムからでも呼び出せます。
このページが埋めるのは 2 行の抜粋には書けないもの、すなわち丸ごと 1 つの workflow ファイルと、`npx playwright test` から来たプロジェクトが自分の手で足す必要がある、そして `nuka run` が自分では決してやらない 4 つのことです。

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
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      # PR gate: static, seconds, no browser. Put this on every PR; it can
      # fail before anything runs.
      - run: npx nuka check

  run:
    if: github.event_name != 'schedule'
    needs: check
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
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
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      # `nuka tend` reports what is rotting rather than what is broken
      # (docs/spec.md "Tending"); it never gates a PR, which is why it
      # sits on its own schedule rather than beside `check`/`run` above.
      # It exits non-zero only for a sign-off that no longer matches the
      # code it froze; every other finding is a note.
      - run: npx nuka tend
```

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
- **積み上がるものを消す何かが要ります。** `nuka run` は step record と scenario record を書き込みますし、それ自身と `nuka do`/session の利用は `.nukadoko/cache/` の下にもファイルを残します。
  そのどれも自動では消えません(docs/spec.ja.md の「成果物」を参照)。
  GitHub がホストするランナーはジョブごとに新しい仮想マシンなので、そこでは自然に積み上がることはありません。
  セルフホストや、それ以外の理由で永続するランナーでは積み上がるので、2 つのどちらかの手当てが要ります。
  ジョブの先頭で `rm -rf .nukadoko` するか、`npx nuka clean`(まさにこの理由のために足されたコマンド。自身の `--help` を参照)を叩くかです。
  後者は同じことをより狭く行い、そのランナー上でまだ生きている `nuka session` があれば、それを理由に丸ごと拒否します。
- **`nuka tend` は自分自身のトリガーを必要とします。** workflow が明示しない限り、これを定期的に走らせるものは何もありません。
  上の `tend` job がそのトリガーで、`check`/`run` の経路からは意図的に外してあります(docs/spec.ja.md の「Tending(手入れ)」を参照)。
  今日対処しなくてよい note が PR を遅くしないためです。

## このページが主張しないこと

上の workflow は GitHub Actions の中で実際に実行してはいません。
このリポジトリの中では、それを実行する手段が無いからです。
代わりに確かめたのは次のことです。
この YAML は妥当な YAML としてパースできること、そしてこの中の `npx nuka ...` コマンドはすべて(上で使っているディレクトリ形式の `nuka run features/` も、1 つの feature ファイルだけでなく)、実際に `npm install` した本パッケージのコピーに対して実行したこと(`nuka clean` の live session 拒否や、`nuka accept` を実行した瞬間に `feature-never-signed` の finding が消えることも含めて)です。
`npx playwright install --with-deps chromium` は自身の `--dry-run` で確かめただけで、最後まで実行してはいません。
`--with-deps` は Linux ランナーの外では何もしないため(このリポジトリには Linux ランナーがありません)、ダウンロード自体はここでは試していません。
この workflow は、実際のランナー上で green になるのを見届けたファイルとしてではなく、手を加えるための出発点として読んでください。
