Feature: nuka report --format messages writes a run as the TypeScript engine does

  nuka report --format messages writes one run as a cucumber-messages stream, one envelope per line, so a formatter, a JUnit step, or an HTML report that reads cucumber's protocol keeps working.
  A claim step's claims ride as an attachment of their own media type, and what the verdict table says of a criterion as a test case attachment.
  A line no step matches is UNDEFINED, and the steps after it are SKIPPED.

  Scenario: a judged claim and the verdict of each criterion ride as attachments
    Given the project "judgments"
    When nuka runs "run"
    And nuka runs "report --format messages --out messages.ndjson"
    Then it exits with 0
    And the messages stream in "messages.ndjson" is
      """
      {"meta":"<meta>"}
      {"source":{"data":"Feature: Greeting\n\n  Scenario: a first-time visitor is greeted\n    When I ask for the greeting\n    Then the greeting reads as \"friendly to a first-time visitor\"\n\n  Scenario: a cart total is shown\n    When a cart holds 3 items\n    Then the total reads as \"a small number\"\n","mediaType":"text/x.cucumber.gherkin+plain","uri":"features/greeting.feature"}}
      {"gherkinDocument":{"comments":[],"feature":{"children":[{"scenario":{"description":"","examples":[],"id":"id-1","keyword":"Scenario","location":{"column":3,"line":3},"name":"a first-time visitor is greeted","steps":[{"id":"id-2","keyword":"When ","keywordType":"Action","location":{"column":5,"line":4},"text":"I ask for the greeting"},{"id":"id-3","keyword":"Then ","keywordType":"Outcome","location":{"column":5,"line":5},"text":"the greeting reads as \"friendly to a first-time visitor\""}],"tags":[]}},{"scenario":{"description":"","examples":[],"id":"id-4","keyword":"Scenario","location":{"column":3,"line":7},"name":"a cart total is shown","steps":[{"id":"id-5","keyword":"When ","keywordType":"Action","location":{"column":5,"line":8},"text":"a cart holds 3 items"},{"id":"id-6","keyword":"Then ","keywordType":"Outcome","location":{"column":5,"line":9},"text":"the total reads as \"a small number\""}],"tags":[]}}],"description":"","keyword":"Feature","language":"en","location":{"column":1,"line":1},"name":"Greeting","tags":[]},"uri":"features/greeting.feature"}}
      {"pickle":{"astNodeIds":["id-1"],"id":"id-7","language":"en","location":{"column":3,"line":3},"name":"a first-time visitor is greeted","steps":[{"astNodeIds":["id-2"],"id":"id-8","text":"I ask for the greeting","type":"Action"},{"astNodeIds":["id-3"],"id":"id-9","text":"the greeting reads as \"friendly to a first-time visitor\"","type":"Outcome"}],"tags":[],"uri":"features/greeting.feature"}}
      {"pickle":{"astNodeIds":["id-4"],"id":"id-10","language":"en","location":{"column":3,"line":7},"name":"a cart total is shown","steps":[{"astNodeIds":["id-5"],"id":"id-11","text":"a cart holds 3 items","type":"Action"},{"astNodeIds":["id-6"],"id":"id-12","text":"the total reads as \"a small number\"","type":"Outcome"}],"tags":[],"uri":"features/greeting.feature"}}
      {"testRunStarted":{"timestamp":"<time>"}}
      {"testCase":{"id":"id-13","pickleId":"id-7","testSteps":[{"id":"id-14","pickleStepId":"id-8"},{"id":"id-15","pickleStepId":"id-9"}]}}
      {"testCaseStarted":{"attempt":0,"id":"id-16","testCaseId":"id-13","timestamp":"<time>"}}
      {"testStepStarted":{"testCaseStartedId":"id-16","testStepId":"id-14","timestamp":"<time>"}}
      {"testStepFinished":{"testCaseStartedId":"id-16","testStepId":"id-14","testStepResult":{"duration":"<time>","status":"PASSED"},"timestamp":"<time>"}}
      {"testStepStarted":{"testCaseStartedId":"id-16","testStepId":"id-15","timestamp":"<time>"}}
      {"attachment":{"body":{"attempts":1,"claims":[{"actual":"Welcome! Make yourself at home.","actual_from":"from:run-greet@4.stdout as text","compare":"judged-as","expected":"friendly to a first-time visitor","expected_from":"sentence:quality","expected_text":"\"friendly to a first-time visitor\"","measured":{"channel":"observed.processes[0].stdout","step_record_id":"step-<id>"},"outcome":"for-judgment","view":"text"}],"observation":"observed"},"contentEncoding":"IDENTITY","fileName":"claims.json","mediaType":"application/vnd.nukadoko.claims+json","testCaseStartedId":"id-16","testStepId":"id-15"}}
      {"testStepFinished":{"testCaseStartedId":"id-16","testStepId":"id-15","testStepResult":{"duration":"<time>","status":"PASSED"},"timestamp":"<time>"}}
      {"attachment":{"body":{"reason":"passes in default","verdict":"held"},"contentEncoding":"IDENTITY","fileName":"verdict.json","mediaType":"application/vnd.nukadoko.verdict+json","testCaseStartedId":"id-16"}}
      {"testCaseFinished":{"testCaseStartedId":"id-16","timestamp":"<time>","willBeRetried":false}}
      {"testCase":{"id":"id-17","pickleId":"id-10","testSteps":[{"id":"id-18","pickleStepId":"id-11"},{"id":"id-19","pickleStepId":"id-12"}]}}
      {"testCaseStarted":{"attempt":0,"id":"id-20","testCaseId":"id-17","timestamp":"<time>"}}
      {"testStepStarted":{"testCaseStartedId":"id-20","testStepId":"id-18","timestamp":"<time>"}}
      {"testStepFinished":{"testCaseStartedId":"id-20","testStepId":"id-18","testStepResult":{"duration":"<time>","status":"PASSED"},"timestamp":"<time>"}}
      {"testStepStarted":{"testCaseStartedId":"id-20","testStepId":"id-19","timestamp":"<time>"}}
      {"attachment":{"body":{"attempts":1,"claims":[{"actual":12,"actual_from":"from:a-cart@8.total","compare":"judged-as","expected":"a small number","expected_from":"sentence:quality","expected_text":"\"a small number\"","measured":null,"outcome":"for-judgment"}],"observation":"observed"},"contentEncoding":"IDENTITY","fileName":"claims.json","mediaType":"application/vnd.nukadoko.claims+json","testCaseStartedId":"id-20","testStepId":"id-19"}}
      {"testStepFinished":{"testCaseStartedId":"id-20","testStepId":"id-19","testStepResult":{"duration":"<time>","status":"PASSED"},"timestamp":"<time>"}}
      {"attachment":{"body":{"reason":"passes in default","verdict":"held"},"contentEncoding":"IDENTITY","fileName":"verdict.json","mediaType":"application/vnd.nukadoko.verdict+json","testCaseStartedId":"id-20"}}
      {"testCaseFinished":{"testCaseStartedId":"id-20","timestamp":"<time>","willBeRetried":false}}
      {"testRunFinished":{"success":false,"timestamp":"<time>"}}
      """

  Scenario: a line no step matches is undefined, and the steps after it are skipped
    Given the project "broken"
    When nuka runs "run --no-check"
    And nuka runs "report --format messages --out messages.ndjson"
    Then it exits with 0
    And the messages stream in "messages.ndjson" is
      """
      {"meta":"<meta>"}
      {"source":{"data":"Feature: bad\n\n  Scenario: a line no step matches\n    Then nothing matches this line\n","mediaType":"text/x.cucumber.gherkin+plain","uri":"features/bad.feature"}}
      {"gherkinDocument":{"comments":[],"feature":{"children":[{"scenario":{"description":"","examples":[],"id":"id-1","keyword":"Scenario","location":{"column":3,"line":3},"name":"a line no step matches","steps":[{"id":"id-2","keyword":"Then ","keywordType":"Outcome","location":{"column":5,"line":4},"text":"nothing matches this line"}],"tags":[]}}],"description":"","keyword":"Feature","language":"en","location":{"column":1,"line":1},"name":"bad","tags":[]},"uri":"features/bad.feature"}}
      {"pickle":{"astNodeIds":["id-1"],"id":"id-3","language":"en","location":{"column":3,"line":3},"name":"a line no step matches","steps":[{"astNodeIds":["id-2"],"id":"id-4","text":"nothing matches this line","type":"Outcome"}],"tags":[],"uri":"features/bad.feature"}}
      {"source":{"data":"Feature: good\n\n  Scenario: good\n    Then 1 is below 10\n","mediaType":"text/x.cucumber.gherkin+plain","uri":"features/good.feature"}}
      {"gherkinDocument":{"comments":[],"feature":{"children":[{"scenario":{"description":"","examples":[],"id":"id-5","keyword":"Scenario","location":{"column":3,"line":3},"name":"good","steps":[{"id":"id-6","keyword":"Then ","keywordType":"Outcome","location":{"column":5,"line":4},"text":"1 is below 10"}],"tags":[]}}],"description":"","keyword":"Feature","language":"en","location":{"column":1,"line":1},"name":"good","tags":[]},"uri":"features/good.feature"}}
      {"pickle":{"astNodeIds":["id-5"],"id":"id-7","language":"en","location":{"column":3,"line":3},"name":"good","steps":[{"astNodeIds":["id-6"],"id":"id-8","text":"1 is below 10","type":"Outcome"}],"tags":[],"uri":"features/good.feature"}}
      {"testRunStarted":{"timestamp":"<time>"}}
      {"testCase":{"id":"id-9","pickleId":"id-3","testSteps":[{"id":"id-10","pickleStepId":"id-4"}]}}
      {"testCaseStarted":{"attempt":0,"id":"id-11","testCaseId":"id-9","timestamp":"<time>"}}
      {"testStepStarted":{"testCaseStartedId":"id-11","testStepId":"id-10","timestamp":"<time>"}}
      {"testStepFinished":{"testCaseStartedId":"id-11","testStepId":"id-10","testStepResult":{"duration":"<time>","message":"No step definition matches \"nothing matches this line\"","status":"UNDEFINED"},"timestamp":"<time>"}}
      {"attachment":{"body":{"reason":"stopped at line 4 in default before a claim there was judged","verdict":"failed"},"contentEncoding":"IDENTITY","fileName":"verdict.json","mediaType":"application/vnd.nukadoko.verdict+json","testCaseStartedId":"id-11"}}
      {"testCaseFinished":{"testCaseStartedId":"id-11","timestamp":"<time>","willBeRetried":false}}
      {"testCase":{"id":"id-12","pickleId":"id-7","testSteps":[{"id":"id-13","pickleStepId":"id-8"}]}}
      {"testCaseStarted":{"attempt":0,"id":"id-14","testCaseId":"id-12","timestamp":"<time>"}}
      {"testStepStarted":{"testCaseStartedId":"id-14","testStepId":"id-13","timestamp":"<time>"}}
      {"attachment":{"body":{"attempts":1,"claims":[{"actual":1,"actual_from":"observe:value","compare":"less-than","expected":10,"expected_from":"sentence:b","expected_text":"10","measured":null,"outcome":"held"}],"observation":"observed"},"contentEncoding":"IDENTITY","fileName":"claims.json","mediaType":"application/vnd.nukadoko.claims+json","testCaseStartedId":"id-14","testStepId":"id-13"}}
      {"testStepFinished":{"testCaseStartedId":"id-14","testStepId":"id-13","testStepResult":{"duration":"<time>","status":"PASSED"},"timestamp":"<time>"}}
      {"attachment":{"body":{"reason":"passes in default","verdict":"held"},"contentEncoding":"IDENTITY","fileName":"verdict.json","mediaType":"application/vnd.nukadoko.verdict+json","testCaseStartedId":"id-14"}}
      {"testCaseFinished":{"testCaseStartedId":"id-14","timestamp":"<time>","willBeRetried":false}}
      {"testRunFinished":{"success":false,"timestamp":"<time>"}}
      """
