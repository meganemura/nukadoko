import { experimental_defineRelation, experimental_relationEntry } from "nukadoko";
import addTodo from "../steps/add-todo.ts";
import listIncludes from "../steps/todo-list-includes.ts";

// A request-only relation. Check reads `source`. It does not call `follow`
// or `relate`, and it does not run either step.
export default experimental_defineRelation({
  name: "add then listed",
  source: [experimental_relationEntry(addTodo, { title: "milk" })],
  follow: () => [experimental_relationEntry(listIncludes, { title: "milk" })],
  relate: (sourceResults, followResults) => sourceResults[0].title.length > 0 && followResults[0].found,
});
