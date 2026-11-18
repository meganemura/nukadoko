Nukadoko.config(
  program: lambda do
    {
      setup: ->(world) { File.write("setup.txt", "set up #{world.name} #{world.tree}\n") },
      environments: {
        default: { version: -> { "1.2.3" } },
        remote: { url: ->(world) { "http://localhost:9/#{world.name}" } },
        failing: { setup: ->(_world) { raise "no seed data" } },
        lost: { version: -> { raise "no version endpoint" } },
      },
    }
  end,
)
