# frozen_string_literal: true
# rbs_inline: enabled

require "json"
require_relative "nukadoko/version"
require_relative "nukadoko/project_files"
require_relative "nukadoko/error_frames"
require_relative "nukadoko/spaces"
require_relative "nukadoko/js_pattern"
require_relative "nukadoko/schema"
require_relative "nukadoko/step"
require_relative "nukadoko/states"
require_relative "nukadoko/changed_files"
require_relative "nukadoko/pattern"
require_relative "nukadoko/features"
require_relative "nukadoko/codes"
require_relative "nukadoko/selection"
require_relative "nukadoko/js_json"
require_relative "nukadoko/claims"
require_relative "nukadoko/claim_sides"
require_relative "nukadoko/aria_snapshot"
require_relative "nukadoko/judgments"
require_relative "nukadoko/judgment_file"
require_relative "nukadoko/report_run"
require_relative "nukadoko/report_messages"
require_relative "nukadoko/report_allure"
require_relative "nukadoko/measured"
require_relative "nukadoko/literal"
require_relative "nukadoko/claim_line"
require_relative "nukadoko/claim_check"
require_relative "nukadoko/claim_check_run"
require_relative "nukadoko/check"
require_relative "nukadoko/trace"
require_relative "nukadoko/trace_actions"
require_relative "nukadoko/step_fixtures"
require_relative "nukadoko/fixtures"
require_relative "nukadoko/http_recording"
require_relative "nukadoko/secrets"
require_relative "nukadoko/env_check"
require_relative "nukadoko/command"
require_relative "nukadoko/project_fixtures"
require_relative "nukadoko/parts"
require_relative "nukadoko/poll"
require_relative "nukadoko/claim_rules"
require_relative "nukadoko/definition"
require_relative "nukadoko/vocabulary"
require_relative "nukadoko/program_shape"
require_relative "nukadoko/program"
require_relative "nukadoko/project_program"
require_relative "nukadoko/parameter_types"
require_relative "nukadoko/table"
require_relative "nukadoko/order"
require_relative "nukadoko/run_record"
require_relative "nukadoko/criteria"
require_relative "nukadoko/base"
require_relative "nukadoko/tree_passes"
require_relative "nukadoko/walk"
require_relative "nukadoko/walk_files"
require_relative "nukadoko/run"
require_relative "nukadoko/summary"
require_relative "nukadoko/verdict"
require_relative "nukadoko/signature"
require_relative "nukadoko/scaffold"
require_relative "nukadoko/init"
require_relative "nukadoko/skill"

module Nukadoko
  # What a program file of a release before the program moved into the
  # config calls. Only a `--base` ref still holds one, and the run reads it
  # in a process of its own (Engine::ProjectProgram.elsewhere).
  #: (**untyped) -> Hash[Symbol, untyped]
  def self.program(**options) = (@legacy_program = options)
  #: () -> Hash[Symbol, untyped]?
  def self.legacy_program = @legacy_program
  # The program under test of the project whose config load_project read.
  #: () -> Hash[Symbol, untyped]
  def self.program_options = @program_options || {}

  # Loads the config of the project at `root`, and reads its program.
  #: (String) -> void
  def self.load_project(root)
    config = File.join(root, Engine::CONFIG)
    @legacy_program = nil
    load config if File.exist?(config)
    Engine::ParameterTypes.read(config_options[:parameterTypes])
    @program_options = Engine::ProjectProgram.read(root)
  end

  #: (**untyped) -> Hash[Symbol, untyped]
  def self.config(**options) = (@config = options)
  #: () -> Hash[Symbol, untyped]
  def self.config_options = @config || {}
end
