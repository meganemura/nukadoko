Feature: compat basic execution

  Scenario: patterns and a compat-registered custom parameter type
    Given a legacy project "acme" exists
    When a legacy request is made with 3 items
    Then the legacy flag is yes

  Scenario: a Gherkin table arrives as a DataTable
    When a legacy table is provided:
      | name  | age |
      | alice | 30  |
      | bob   | 25  |

  Scenario: a docstring arrives as a plain string
    When a legacy docstring is provided:
      """
      hello docstring
      """
