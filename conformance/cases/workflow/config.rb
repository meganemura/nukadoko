require_relative "src/signup"

Nukadoko.fixture(:store) { |use| use.(Signup::Store.new) }
