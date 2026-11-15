# frozen_string_literal: true
# rbs_inline: enabled

# The names of the files a project keeps nukadoko's settings in, one place
# for every part of the engine that reads, writes, or names them.
module Nukadoko
  module Engine
    CONFIG = "nukadoko.config.rb"
    PROGRAM = "nukadoko.program.rb"
  end
end
