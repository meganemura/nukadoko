---
run_id: run-fixture-0001
commit: abc1234
feature: features/checkout.feature
scenarios:
  - name: create and close a project
---

## The scenario as it ran

```gherkin
Feature: Projects

  Scenario: create and close a project
    Given a project "acme" exists
    Then the project is closed
```
