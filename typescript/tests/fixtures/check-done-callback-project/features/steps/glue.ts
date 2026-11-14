import {
  After,
  AfterAll,
  AfterStep,
  Before,
  BeforeAll,
  Given,
  When,
} from "../../nukadoko-compat-shim.js";

// Scenario hooks are called with one HookParameter. Two declared
// parameters is cucumber-js's done() signal. One or zero is not.
Before(function () {
  return undefined;
});

Before(function (scenario) {
  return scenario;
});

Before(function (scenario, done) {
  done(scenario);
});

After(function (scenario) {
  return scenario;
});

After(function (scenario, done) {
  done(scenario);
});

AfterStep(function (scenario, done) {
  done(scenario);
});

// Run-scope hooks are called with zero arguments, so any declared
// parameter is the done() signal. A zero-parameter hook that returns
// "pending" is a different failure, and only a run can see the return.
BeforeAll(function () {
  return undefined;
});

BeforeAll(function (done) {
  done();
});

AfterAll(function () {
  return "pending";
});

AfterAll(function (done) {
  done();
});

// One capture, plus a done() parameter the executor never passes.
Given("a user {string} exists", function (name, done) {
  done(name);
});

// No captures. The only parameter is done().
When("a legacy step expects a done callback", function (done) {
  done();
});

// The docstring is the one argument nukadoko passes. done() is the extra.
Given("a note:", function (doc, done) {
  done(doc);
});

// The table is the one argument. This length matches, so it is not a
// done() callback.
Given("these rows:", function (table) {
  return table;
});

// The capture fills the only parameter.
Given("a user {string} is recorded", function (name) {
  return name;
});

Given(/a regexp user "(.*)" exists/, function (name, done) {
  done(name);
});

Given("a user {string} owns {int} items", function (name, count) {
  return [name, count];
});

// Registered, never matched. Arity depends on the matched line, so check
// stays silent until a feature line actually selects this step.
Given("nobody calls {string}", function (name, done) {
  done(name);
});

When("a step returns pending", function () {
  return "pending";
});

// Both match "ambiguous thing". The run fails as ambiguous before either
// function is called, so the done() parameter is not a check finding.
Given("ambiguous thing", function (done) {
  done();
});

Given(/ambiguous thing/, function () {
  return undefined;
});
