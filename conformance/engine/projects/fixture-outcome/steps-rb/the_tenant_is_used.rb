class TheTenantIsUsed < Nukadoko::Step
  description "Use the tenant fixture and nothing else"
  pattern "the tenant is used"
  mutates false

  def run(tenant:) = nil
end
