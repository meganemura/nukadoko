# frozen_string_literal: true

require "json"
require_relative "nukadoko/version"
require_relative "nukadoko/schema"
require_relative "nukadoko/step"
require_relative "nukadoko/pattern"
require_relative "nukadoko/features"
require_relative "nukadoko/claims"
require_relative "nukadoko/check"
require_relative "nukadoko/fixtures"
require_relative "nukadoko/program"
require_relative "nukadoko/table"
require_relative "nukadoko/run"
require_relative "nukadoko/signature"

module Nukadoko
  def self.program(**options) = (@program = options)
  def self.program_options = @program || {}
  def self.config(**options) = (@config = options)
  def self.config_options = @config || {}
end
