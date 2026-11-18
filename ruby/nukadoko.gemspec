# frozen_string_literal: true

require_relative "lib/nukadoko/version"

Gem::Specification.new do |spec|
  spec.name = "nukadoko"
  spec.version = Nukadoko::VERSION
  spec.authors = ["meganemura"]
  spec.summary = "Typed step contracts for Gherkin in Ruby, so a scenario can be told wrong before it runs."
  spec.homepage = "https://github.com/meganemura/nukadoko"
  spec.license = "MIT"
  spec.required_ruby_version = ">= 3.4"
  spec.metadata = {
    # Rails Hyperdrive installs skills/ into an app that bundles this gem.
    "hyperdrive_targets" => "*",
    "hyperdrive_artifacts" => "skill"
  }
  spec.files = Dir["lib/**/*.rb", "lib/**/*.json", "sig/**/*.rbs", "exe/*", "skills/**/*", "docs/**/*", "llms.txt", "README.md", "README.ja.md", "CHANGELOG.md", "LICENSE"]
  spec.bindir = "exe"
  spec.executables = ["nuka"]
  spec.add_dependency "cucumber-cucumber-expressions", "20.1.0"
  spec.add_dependency "cucumber-gherkin", "42.0.1"
  spec.add_dependency "playwright-ruby-client", ">= 1.63.0"
end
