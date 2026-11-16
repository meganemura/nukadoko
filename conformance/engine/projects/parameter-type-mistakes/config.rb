Nukadoko.config(
  parameterTypes: [
    { name: "priority", regexp: /高|低/, transformer: ->(s) { s == "高" ? "high" : "low" } },
    { name: "spare", regexp: /予備/ },
  ],
)
