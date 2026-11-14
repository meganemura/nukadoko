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
  spec.files = Dir["lib/**/*.rb", "sig/**/*.rbs", "exe/*", "README.md", "README.ja.md", "LICENSE"]
  spec.bindir = "exe"
  spec.executables = ["nuka"]
  spec.add_dependency "cucumber-cucumber-expressions", "20.1.0"
  spec.add_dependency "cucumber-gherkin", "42.0.1"
  spec.add_dependency "playwright-ruby-client", "1.61.0"
end
