# frozen_string_literal: true
# rbs_inline: enabled

# `nuka skill path`: the directory that holds every agent skill this gem
# ships, one absolute path, as the TypeScript engine prints its own. It is
# a fact about the installed nukadoko, the one route sure to match the
# version installed; copying a skill into an agent's own layout is what
# `gh skill install` and the agent's plugin marketplace already do.
#
# The gem ships the skills beside lib/ (bin/stage-shared copies them in
# before `gem build`). A checkout that has not staged them reads the
# repository root's, which are the same files.
module Nukadoko
  module Skill
    module_function

    #: () -> String
    def dir
      here = __dir__.to_s
      staged = File.expand_path("../../skills", here)
      File.directory?(staged) ? staged : File.expand_path("../../../skills", here)
    end

    #: (IO, IO) -> Integer
    def print_path(out, err)
      found = dir
      unless File.directory?(found)
        err.puts "nuka skill: skill source not found at #{found} (a packaging bug, not a project issue)"
        return 1
      end

      out.puts found
      0
    end
  end
end
