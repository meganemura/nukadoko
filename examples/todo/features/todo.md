# Todo list

> The same acceptance criteria as `todo.feature`, written as a Markdown oath.
> A blockquote is narration. A sentence outside one is a step.

## Adding a todo makes it visible in the list

Given a todo titled "Buy milk" is added.
Then the todo list includes "Buy milk".

## Completing a todo marks it done

Given a todo titled "Walk the dog" is added.
When the todo titled "Walk the dog" is completed.
Then the todo titled "Walk the dog" is marked done.

## Adding several todos at once

Given the following todos are added.

| title |
| --- |
| Water the plants |
| Read a book |

Then the todo list includes "Water the plants".
And the todo list includes "Read a book".

## Adding a todo from an outline row

Given a todo titled "<title>" is added.
Then the todo list includes "<title>".

| title |
| --- |
| Buy milk |
