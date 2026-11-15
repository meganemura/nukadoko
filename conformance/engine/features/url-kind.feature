Feature: an is-a url claim takes what a browser takes

  The TypeScript engine reads a URL with the WHATWG URL parser, which a browser uses.
  A path, a query, and a fragment can hold any text, a host can hold letters of any script, and the parser refuses a missing host, a port past 65535, an address that does not parse, and a label that decodes to no letter.

  Scenario: a URL holds where a browser takes it, and breaks where a browser refuses it
    Given the project "url-kind"
    When nuka runs "run --no-check --json"
    Then it exits with 1
    And the summary is
      """
      <!-- nukadoko:run -->
      # nukadoko run failed: 5 criteria, 1 held, 4 failed

      | verdict | criterion | head default |
      | --- | --- | --- |
      | held | `features/url.feature:3` texts a browser takes as a URL | pass |
      | failed | `features/url.feature:12` a port past 65535 | fail@13 |
      | failed | `features/url.feature:15` an IPv4 address with a part past 255 | fail@16 |
      | failed | `features/url.feature:18` a label that decodes to no letter | fail@19 |
      | failed | `features/url.feature:21` no host | fail@22 |

      - `features/url.feature:12` a port past 65535: a claim broke at line 13 in default
        - step "the value '"http://example.com:99999/"' is a "url"": `claim broken: "http://example.com:99999/" (observe:value as json) is-a "url" (sentence:kind)`; record `steps/step-<id>`
      - `features/url.feature:15` an IPv4 address with a part past 255: a claim broke at line 16 in default
        - step "the value '"http://1.2.3.256/"' is a "url"": `claim broken: "http://1.2.3.256/" (observe:value as json) is-a "url" (sentence:kind)`; record `steps/step-<id>`
      - `features/url.feature:18` a label that decodes to no letter: a claim broke at line 19 in default
        - step "the value '"http://xn--abc.例え/"' is a "url"": `claim broken: "http://xn--abc.例え/" (observe:value as json) is-a "url" (sentence:kind)`; record `steps/step-<id>`
      - `features/url.feature:21` no host: a claim broke at line 22 in default
        - step "the value '"http://user@/"' is a "url"": `claim broken: "http://user@/" (observe:value as json) is-a "url" (sentence:kind)`; record `steps/step-<id>`

      ## What this run does not show

      Each item below is something the verdicts above do not cover, listed under its kind in run.json's `limits`.

      - **Static check skipped** (`check-skipped`): the run started with `nuka run --no-check`, so no finding of `nuka check` held it back; do: `nuka check`

      - commit: unknown (no git state was readable when the run started)
      - environment: default
      - browser: none launched
      - selection: full
      - nukadoko: <version>
      - run: run-<id>
      - started <time>, finished <time> (<duration>)

      ## Claims

      Each line is one claim of a Then: the actual value and where it came from, how it was compared, the expected value and where it came from, whether it held, and the recorded channel that holds the actual value (`measured: none` when no channel does, or when another channel holds the same number). An expected value an earlier step returned or `observe` read gets the same, as `expected measured`.

      - `features/url.feature:4` the value '"https://example.com/パス"' is a "url"
        - "https://example.com/パス" (observe:value as json) is-a "url" (sentence:kind) held; measured: none
      - `features/url.feature:5` the value '"http://例え.jp/"' is a "url"
        - "http://例え.jp/" (observe:value as json) is-a "url" (sentence:kind) held; measured: none
      - `features/url.feature:6` the value '"http:///example.com"' is a "url"
        - "http:///example.com" (observe:value as json) is-a "url" (sentence:kind) held; measured: none
      - `features/url.feature:7` the value '"http://example.com/a{b}#c\|d"' is a "url"
        - "http://example.com/a{b}#c\|d" (observe:value as json) is-a "url" (sentence:kind) held; measured: none
      - `features/url.feature:8` the value '"http://[::1]:8080/"' is a "url"
        - "http://[::1]:8080/" (observe:value as json) is-a "url" (sentence:kind) held; measured: none
      - `features/url.feature:9` the value '"http://xn--r8jz45g.例え/"' is a "url"
        - "http://xn--r8jz45g.例え/" (observe:value as json) is-a "url" (sentence:kind) held; measured: none
      - `features/url.feature:10` the value '"http://0x7f.1/"' is a "url"
        - "http://0x7f.1/" (observe:value as json) is-a "url" (sentence:kind) held; measured: none
      - `features/url.feature:13` the value '"http://example.com:99999/"' is a "url"
        - "http://example.com:99999/" (observe:value as json) is-a "url" (sentence:kind) broken; measured: none
      - `features/url.feature:16` the value '"http://1.2.3.256/"' is a "url"
        - "http://1.2.3.256/" (observe:value as json) is-a "url" (sentence:kind) broken; measured: none
      - `features/url.feature:19` the value '"http://xn--abc.例え/"' is a "url"
        - "http://xn--abc.例え/" (observe:value as json) is-a "url" (sentence:kind) broken; measured: none
      - `features/url.feature:22` the value '"http://user@/"' is a "url"
        - "http://user@/" (observe:value as json) is-a "url" (sentence:kind) broken; measured: none

      ## Rerun a failed scenario

      ```sh
      nuka run features/url.feature:12
      nuka run features/url.feature:15
      nuka run features/url.feature:18
      nuka run features/url.feature:21
      ```
      """
