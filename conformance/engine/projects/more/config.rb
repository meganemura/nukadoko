require "set"

Nukadoko.fixture(:store) { |use| use.(Set.new) }
Nukadoko.fixture(:shared, scope: :process) { |use, store:| use.(store) }
Nukadoko.fixture(:left) { |use, right:| use.(right) }
Nukadoko.fixture(:right) { |use, left:| use.(left) }
