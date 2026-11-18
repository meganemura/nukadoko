class TheTenantBreaks < Nukadoko::Step
  description "Use the tenant fixture and fail"
  pattern "the tenant breaks"
  mutates false

  def run(tenant:) = raise("the tenant broke")
end
