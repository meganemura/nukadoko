Feature: The holders an outline names

  Scenario Outline: <person> opens the settings page after ben signs in
    Given ben signs in
    When <person> opens the settings page
    Then <person>'s display name is "<person>"

    Examples:
      | person |
      | aki    |
      | carol  |
      | ben    |
