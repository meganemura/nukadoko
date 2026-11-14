// The CLI README.md's "Beside your unit tests" walkthrough adds a scenario
// to: it prints a greeting for the name it is given.
const [name] = process.argv.slice(2);
if (!name) {
  console.error("usage: greet <name>");
  process.exit(2);
}
console.log(`Hello, ${name}!`);
