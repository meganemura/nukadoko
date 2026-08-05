Feature: A scenario that never names page never launches a browser

  Scenario: nothing in this scenario destructures page
    Given the step does nothing with the browser

  Scenario: this scenario does destructure page
    Given the step touches the browser directly
