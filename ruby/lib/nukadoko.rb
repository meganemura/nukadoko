# frozen_string_literal: true
# rbs_inline: enabled

require "json"
require_relative "nukadoko/version"
require_relative "nukadoko/project_files"
require_relative "nukadoko/spaces"
require_relative "nukadoko/js_pattern"
require_relative "nukadoko/schema"
require_relative "nukadoko/step"
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
require_relative "nukadoko/program"
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
  #: (**untyped) -> Hash[Symbol, untyped]
  def self.program(**options) = (@program = options)
  #: () -> Hash[Symbol, untyped]
  def self.program_options = @program || {}
  #: (**untyped) -> Hash[Symbol, untyped]
  def self.config(**options) = (@config = options)
  #: () -> Hash[Symbol, untyped]
  def self.config_options = @config || {}
end
